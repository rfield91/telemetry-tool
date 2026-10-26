// WebGPU compositor: decoded VideoFrame (zero-copy external texture) + Canvas
// 2D overlay → one render pass that composites and packs NV12 into a
// (W/4)×(1.5H) rgba8 target → async readback → NV12 VideoFrame for the encoder.
const SHADER = /* wgsl */ `
@group(0) @binding(0) var video: texture_external;
@group(0) @binding(1) var overlay: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
struct Params {
  size: vec2f,       // frame W, H
  atlasSize: vec2f,  // overlay texture W, H
  count: vec4u,      // x = number of rects, y = 1 if overlay is straight alpha
  rects: array<vec4f, 16>,     // frame-space x, y, w, h
  atlasPos: array<vec4f, 16>,  // atlas-space x, y (zw unused)
}
@group(0) @binding(3) var<uniform> params: Params;

fn overlayAt(px: vec2f) -> vec4f {
  for (var i = 0u; i < params.count.x; i++) {
    let r = params.rects[i];
    if (px.x >= r.x && px.y >= r.y && px.x < r.x + r.z && px.y < r.y + r.w) {
      let atlasPx = params.atlasPos[i].xy + (px - r.xy);
      let o = textureSampleLevel(overlay, samp, atlasPx / params.atlasSize, 0.0);
      // count.y == 1: straight alpha from getImageData; premultiply here.
      return select(o, vec4f(o.rgb * o.a, o.a), params.count.y == 1u);
    }
  }
  return vec4f(0.0);
}

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

fn rgbAt(px: vec2f) -> vec3f {
  let v = textureSampleBaseClampToEdge(video, samp, px / params.size).rgb;
  let o = overlayAt(px);
  return o.rgb + v * (1.0 - o.a); // overlay is premultiplied
}
fn luma(c: vec3f) -> f32 { return 16.0 / 255.0 + dot(c, vec3f(0.1826, 0.6142, 0.0620)); }
fn chroma(c: vec3f) -> vec2f {
  return vec2f(
    128.0 / 255.0 + dot(c, vec3f(-0.1006, -0.3386, 0.4392)),
    128.0 / 255.0 + dot(c, vec3f(0.4392, -0.3989, -0.0403)));
}

@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let ox = floor(pos.x);
  let oy = floor(pos.y);
  if (oy < params.size.y) {
    let x = ox * 4.0;
    return vec4f(
      luma(rgbAt(vec2f(x + 0.5, oy + 0.5))),
      luma(rgbAt(vec2f(x + 1.5, oy + 0.5))),
      luma(rgbAt(vec2f(x + 2.5, oy + 0.5))),
      luma(rgbAt(vec2f(x + 3.5, oy + 0.5))));
  }
  let j = oy - params.size.y;
  // Sampling on the corner between 2×2 pixels averages them (linear filter).
  let a = chroma(rgbAt(vec2f(ox * 4.0 + 1.0, j * 2.0 + 1.0)));
  let b = chroma(rgbAt(vec2f(ox * 4.0 + 3.0, j * 2.0 + 1.0)));
  return vec4f(a, b);
}
`

async function createWebGpuNv12Compositor(width, height, options = {}, inFlight = 3) {
  if (width % 4 !== 0 || height % 2 !== 0) throw new Error('NV12 path needs W%4==0, H%2==0')
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' })
  if (!adapter) throw new Error('WebGPU adapter unavailable')
  const device = await adapter.requestDevice()

  const module = device.createShaderModule({ code: SHADER })
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
    primitive: { topology: 'triangle-list' },
  })
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
  // Atlas: widget rects laid out left-to-right in one row. Without rects the
  // whole frame is a single "widget" (full-frame overlay upload).
  const rects = options.rects ?? [{ x: 0, y: 0, w: width, h: height }]
  if (rects.length > 16) throw new Error('At most 16 overlay rects')
  let cursor = 0
  const atlas = rects.map((rect) => {
    const entry = { rect, atlasX: cursor, atlasY: 0 }
    cursor += rect.w + 2 // gap stops linear filtering bleeding between widgets
    return entry
  })
  const atlasWidth = Math.max(1, cursor)
  const atlasHeight = Math.max(...rects.map((rect) => rect.h))

  const params = new ArrayBuffer(16 + 16 + 256 + 256)
  new Float32Array(params, 0, 4).set([width, height, atlasWidth, atlasHeight])
  new Uint32Array(params, 16, 4).set([atlas.length, options.cpuOverlay ? 1 : 0, 0, 0])
  const rectData = new Float32Array(params, 32, 64)
  const posData = new Float32Array(params, 288, 64)
  atlas.forEach(({ rect, atlasX, atlasY }, i) => {
    rectData.set([rect.x, rect.y, rect.w, rect.h], i * 4)
    posData.set([atlasX, atlasY, 0, 0], i * 4)
  })
  const sizeBuffer = device.createBuffer({ size: params.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  device.queue.writeBuffer(sizeBuffer, 0, params)

  const overlayCanvas = new OffscreenCanvas(atlasWidth, atlasHeight)
  // cpuOverlay: software-backed canvas, read with getImageData (straight
  // alpha) and uploaded with writeTexture; the shader premultiplies.
  const overlayCtx = overlayCanvas.getContext('2d', { willReadFrequently: Boolean(options.cpuOverlay) })
  const overlayTexture = device.createTexture({
    size: [atlasWidth, atlasHeight],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  })

  const packedWidth = width / 4
  const packedHeight = (height * 3) / 2
  const packedTexture = device.createTexture({
    size: [packedWidth, packedHeight],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  })
  const packedView = packedTexture.createView()
  // Rows are padded to 256 bytes; the NV12 VideoFrame layout uses the stride.
  const bytesPerRow = Math.ceil(width / 256) * 256
  const readbackSize = bytesPerRow * packedHeight
  const slots = Array.from({ length: inFlight }, () => ({
    buffer: device.createBuffer({ size: readbackSize, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
    busy: Promise.resolve(),
  }))
  let submitted = 0
  const layout = [
    { offset: 0, stride: bytesPerRow },
    { offset: bytesPerRow * height, stride: bytesPerRow },
  ]

  return {
    overlayCtx,
    atlas,
    atlasWidth,
    atlasHeight,
    /**
     * Composite `videoFrame` with the current overlay canvas. Resolves (in
     * submission order) with an NV12 VideoFrame once the readback lands.
     * The caller closes `videoFrame` after the promise settles.
     */
    async submit(videoFrame) {
      const slot = slots[submitted % inFlight]
      submitted += 1
      await slot.busy

      if (options.cpuOverlay) {
        const pixels = overlayCtx.getImageData(0, 0, atlasWidth, atlasHeight)
        device.queue.writeTexture(
          { texture: overlayTexture },
          pixels.data,
          { bytesPerRow: atlasWidth * 4 },
          [atlasWidth, atlasHeight],
        )
      } else if (!options.skipOverlayUpload) {
        device.queue.copyExternalImageToTexture(
          { source: options.bitmapUpload ? overlayCanvas.transferToImageBitmap() : overlayCanvas },
          { texture: overlayTexture, premultipliedAlpha: true },
          [atlasWidth, atlasHeight],
        )
      }
      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: device.importExternalTexture({ source: videoFrame }) },
          { binding: 1, resource: overlayTexture.createView() },
          { binding: 2, resource: sampler },
          { binding: 3, resource: { buffer: sizeBuffer } },
        ],
      })
      const encoder = device.createCommandEncoder()
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: packedView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
      })
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, bindGroup)
      pass.draw(3)
      pass.end()
      encoder.copyTextureToBuffer({ texture: packedTexture }, { buffer: slot.buffer, bytesPerRow }, [packedWidth, packedHeight])
      device.queue.submit([encoder.finish()])

      const { timestamp, duration } = videoFrame
      const result = slot.buffer.mapAsync(GPUMapMode.READ).then(() => {
        const nv12 = new VideoFrame(new Uint8Array(slot.buffer.getMappedRange()), {
          format: 'NV12',
          codedWidth: width,
          codedHeight: height,
          layout,
          timestamp,
          duration: duration ?? undefined,
          colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false },
        })
        slot.buffer.unmap()
        return nv12
      })
      slot.busy = result.then(() => undefined)
      return result
    },
    destroy() {
      device.destroy()
    },
  }
}

module.exports = { createWebGpuNv12Compositor }
