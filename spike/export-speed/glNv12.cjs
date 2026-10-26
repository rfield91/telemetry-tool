// WebGL2 compositor that outputs NV12 bytes for the encoder.
// Pass 1: video + overlay → RGBA composite texture (row 0 = image top).
// Pass 2: composite → packed NV12 in an RGBA8 target of (W/4) × (1.5H):
//   rows [0,H)   hold 4 luma bytes per texel,
//   rows [H,1.5H) hold U,V,U,V for two chroma samples per texel.
// readPixels then yields a ready-to-encode NV12 buffer (BT.709 limited).
const VERTEX = `#version 300 es
in vec2 pos;
void main() { gl_Position = vec4(pos, 0.0, 1.0); }`

const COMPOSE = `#version 300 es
precision highp float;
uniform sampler2D tex;
uniform vec2 size;
out vec4 color;
void main() { color = texture(tex, gl_FragCoord.xy / size); }`

const PACK = `#version 300 es
precision highp float;
uniform sampler2D rgb;
uniform vec2 size; // source W, H
out vec4 color;
float luma(vec3 c) { return 16.0/255.0 + dot(c, vec3(0.1826, 0.6142, 0.0620)); }
vec2 chroma(vec3 c) {
  return vec2(
    128.0/255.0 + dot(c, vec3(-0.1006, -0.3386, 0.4392)),
    128.0/255.0 + dot(c, vec3(0.4392, -0.3989, -0.0403)));
}
vec3 at(vec2 px) { return texture(rgb, px / size).rgb; }
void main() {
  float ox = floor(gl_FragCoord.x);
  float oy = floor(gl_FragCoord.y);
  if (oy < size.y) {
    float x = ox * 4.0;
    color = vec4(
      luma(at(vec2(x + 0.5, oy + 0.5))),
      luma(at(vec2(x + 1.5, oy + 0.5))),
      luma(at(vec2(x + 2.5, oy + 0.5))),
      luma(at(vec2(x + 3.5, oy + 0.5))));
  } else {
    float j = oy - size.y;
    // Sample between 2×2 source pixels; LINEAR filtering averages them.
    vec2 a = chroma(at(vec2(ox * 4.0 + 1.0, j * 2.0 + 1.0)));
    vec2 b = chroma(at(vec2(ox * 4.0 + 3.0, j * 2.0 + 1.0)));
    color = vec4(a, b);
  }
}`

function compile(gl, type, source) {
  const shader = gl.createShader(type)
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader))
  }
  return shader
}

function link(gl, fragment) {
  const program = gl.createProgram()
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX))
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragment))
  gl.bindAttribLocation(program, 0, 'pos')
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program))
  }
  return program
}

function createNv12Compositor(width, height, pipelined = false) {
  if (width % 4 !== 0 || height % 2 !== 0) throw new Error('NV12 path needs W%4==0, H%2==0')
  const canvas = new OffscreenCanvas(1, 1)
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false })
  if (!gl) throw new Error('WebGL2 unavailable')

  const compose = link(gl, COMPOSE)
  const pack = link(gl, PACK)

  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

  const makeTexture = (w, h) => {
    const texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    if (w) gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h)
    return texture
  }
  const videoTexture = makeTexture()
  const overlayTexture = makeTexture()
  const compositeTexture = makeTexture(width, height)
  const packedTexture = makeTexture(width / 4, (height * 3) / 2)

  const fbo = (texture) => {
    const framebuffer = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
    return framebuffer
  }
  const compositeFbo = fbo(compositeTexture)
  const packedFbo = fbo(packedTexture)

  const overlayCanvas = new OffscreenCanvas(width, height)
  const overlayCtx = overlayCanvas.getContext('2d')
  const nv12 = new Uint8Array((width * height * 3) / 2)

  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

  const RING = 3
  const ring = Array.from({ length: RING }, () => {
    const pbo = gl.createBuffer()
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo)
    gl.bufferData(gl.PIXEL_PACK_BUFFER, nv12.byteLength, gl.STREAM_READ)
    return { pbo, fence: null, timestamp: 0, duration: 0 }
  })
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
  let issued = 0
  let collected = 0
  let notReady = 0
  const collect = () => {
    const slot = ring[collected % RING]
    // Fence status only updates between tasks in WebGL, so don't spin on it;
    // getBufferSubData blocks briefly if the copy (RING-1 frames old) isn't done.
    if (gl.getSyncParameter(slot.fence, gl.SYNC_STATUS) !== gl.SIGNALED) notReady += 1
    gl.deleteSync(slot.fence)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo)
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, nv12)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    collected += 1
    return { data: nv12, timestamp: slot.timestamp, duration: slot.duration }
  }

  return {
    overlayCtx,
    nv12,
    /** Composite and pack; fills `nv12` synchronously. */
    timings: { video: 0, overlay: 0, pack: 0, frames: 0 },
    get notReady() {
      return notReady
    },
    render(videoFrame) {
      const profile = globalThis.PROFILE_GL
      let mark = performance.now()
      const lap = (key) => {
        if (!profile) return
        gl.finish()
        const now = performance.now()
        this.timings[key] += now - mark
        mark = now
      }
      this.timings.frames += 1
      gl.bindFramebuffer(gl.FRAMEBUFFER, compositeFbo)
      gl.viewport(0, 0, width, height)
      gl.useProgram(compose)
      gl.uniform2f(gl.getUniformLocation(compose, 'size'), width, height)

      gl.disable(gl.BLEND)
      gl.bindTexture(gl.TEXTURE_2D, videoTexture)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoFrame)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      lap('video')

      gl.enable(gl.BLEND)
      gl.bindTexture(gl.TEXTURE_2D, overlayTexture)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, overlayCanvas)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      lap('overlay')

      gl.disable(gl.BLEND)
      gl.bindFramebuffer(gl.FRAMEBUFFER, packedFbo)
      gl.viewport(0, 0, width / 4, (height * 3) / 2)
      gl.useProgram(pack)
      gl.uniform2f(gl.getUniformLocation(pack, 'size'), width, height)
      gl.bindTexture(gl.TEXTURE_2D, compositeTexture)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      if (!pipelined) {
        gl.readPixels(0, 0, width / 4, (height * 3) / 2, gl.RGBA, gl.UNSIGNED_BYTE, nv12)
        lap('pack')
        return null
      }
      // Async: readPixels into a pixel-pack buffer, collect RING-1 frames later.
      const slot = ring[issued % RING]
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo)
      gl.readPixels(0, 0, width / 4, (height * 3) / 2, gl.RGBA, gl.UNSIGNED_BYTE, 0)
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
      slot.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
      slot.timestamp = videoFrame.timestamp
      slot.duration = videoFrame.duration
      gl.flush()
      issued += 1
      const ready = issued - collected >= RING ? collect() : null
      lap('pack')
      return ready
    },
    /** Remaining pipelined frames, oldest first. */
    *drain() {
      while (collected < issued) yield collect()
    },
  }
}

module.exports = { createNv12Compositor }
