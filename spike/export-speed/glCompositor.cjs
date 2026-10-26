// WebGL2 compositor: video frame texture + premultiplied overlay texture,
// drawn into a GL canvas so `new VideoFrame(canvas)` stays GPU-backed.
const VERTEX = `#version 300 es
in vec2 pos;
out vec2 uv;
void main() {
  uv = vec2(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  gl_Position = vec4(pos, 0.0, 1.0);
}`

const FRAGMENT = `#version 300 es
precision mediump float;
in vec2 uv;
uniform sampler2D tex;
out vec4 color;
void main() { color = texture(tex, uv); }`

function compile(gl, type, source) {
  const shader = gl.createShader(type)
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader))
  }
  return shader
}

function createGlCompositor(width, height) {
  const canvas = new OffscreenCanvas(width, height)
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false })
  if (!gl) throw new Error('WebGL2 unavailable')

  const program = gl.createProgram()
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX))
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT))
  gl.linkProgram(program)
  gl.useProgram(program)

  const buffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  const loc = gl.getAttribLocation(program, 'pos')
  gl.enableVertexAttribArray(loc)
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)

  const makeTexture = () => {
    const texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return texture
  }
  const videoTexture = makeTexture()
  const overlayTexture = makeTexture()

  const overlayCanvas = new OffscreenCanvas(width, height)
  const overlayCtx = overlayCanvas.getContext('2d')

  gl.viewport(0, 0, width, height)
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

  return {
    canvas,
    overlayCtx,
    /** Draw video frame then the current overlay canvas on top. */
    compose(videoFrame) {
      gl.disable(gl.BLEND)
      gl.bindTexture(gl.TEXTURE_2D, videoTexture)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoFrame)
      gl.drawArrays(gl.TRIANGLES, 0, 3)

      gl.enable(gl.BLEND)
      gl.bindTexture(gl.TEXTURE_2D, overlayTexture)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, overlayCanvas)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    },
  }
}

module.exports = { createGlCompositor }
