import type { Rect } from '../project/schema'
import type { Ctx2D } from '../widgets/types'
import { packAtlas } from './plan'

/**
 * Composites the overlay onto decoded video frames and returns frames ready
 * for the encoder. Browser/worker only (WebCodecs, WebGPU, OffscreenCanvas).
 */
export interface Compositor {
  kind: 'webgpu' | 'canvas2d'
  /**
   * Draw `drawOverlay` over `frame` (scaled to the output size). Resolves,
   * in submission order, with a new frame stamped `timestamp`/`duration`
   * (µs). The caller closes both frames.
   */
  compose(
    frame: VideoFrame,
    drawOverlay: (ctx: Ctx2D, place?: (id: string) => { x: number; y: number } | undefined) => void,
    timestamp: number,
    duration: number,
  ): Promise<VideoFrame>
  destroy(): void
}

const BT709 = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false } as const

/** Draw the frame and overlay on a canvas; the encoder converts to YUV. */
export function createCanvasCompositor(width: number, height: number): Compositor {
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })
  if (!ctx) throw new Error('Canvas 2D is unavailable')
  return {
    kind: 'canvas2d',
    async compose(frame, drawOverlay, timestamp, duration) {
      ctx.drawImage(frame, 0, 0, width, height)
      drawOverlay(ctx)
      return new VideoFrame(canvas, { timestamp, duration })
    },
    destroy() {},
  }
}

const MAX_RECTS = 32

// WebGPU flag values from the spec (TypeScript's DOM lib declares the types but not these constants).
const BUFFER = { MAP_READ: 0x1, COPY_DST: 0x8, UNIFORM: 0x40 }
const TEXTURE = { COPY_SRC: 0x1, COPY_DST: 0x2, TEXTURE_BINDING: 0x4, RENDER_ATTACHMENT: 0x10 }
const MAP_READ = 0x1

const SHADER = /* wgsl */ `
@group(0) @binding(0) var video: texture_external;
@group(0) @binding(1) var overlay: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
struct Params {
  size: vec2f,       // output W, H
  atlasSize: vec2f,  // overlay atlas W, H
  count: vec4u,      // x = number of rects
  rects: array<vec4f, ${MAX_RECTS}>,     // output-frame x, y, w, h
  atlasPos: array<vec4f, ${MAX_RECTS}>,  // atlas x, y (zw unused)
}
@group(0) @binding(3) var<uniform> params: Params;

fn overlayAt(px: vec2f) -> vec4f {
  for (var i = 0u; i < params.count.x; i++) {
    let r = params.rects[i];
    if (px.x >= r.x && px.y >= r.y && px.x < r.x + r.z && px.y < r.y + r.w) {
      let atlasPx = params.atlasPos[i].xy + (px - r.xy);
      return textureSampleLevel(overlay, samp, atlasPx / params.atlasSize, 0.0);
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
  return o.rgb + v * (1.0 - o.a); // the overlay is premultiplied
}
// BT.709 limited range.
fn luma(c: vec3f) -> f32 { return 16.0 / 255.0 + dot(c, vec3f(0.1826, 0.6142, 0.0620)); }
fn chroma(c: vec3f) -> vec2f {
  return vec2f(
    128.0 / 255.0 + dot(c, vec3f(-0.1006, -0.3386, 0.4392)),
    128.0 / 255.0 + dot(c, vec3f(0.4392, -0.3989, -0.0403)));
}

// The target is (W/4)×(1.5H) rgba8: the top H rows hold four Y samples per
// texel, the rest two interleaved UV pairs per texel (NV12).
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

/**
 * WebGPU compositor: the decoded frame is a zero-copy external texture, the
 * overlay is drawn into a small atlas (one slot per widget), and one pass
 * composites, scales and packs NV12, read back asynchronously.
 */
export async function createWebGpuCompositor(
  width: number,
  height: number,
  widgets: Array<{ id: string; rect: Rect }>,
  inFlight = 3,
): Promise<Compositor> {
  if (width % 4 !== 0 || height % 2 !== 0) throw new Error('NV12 output needs a width divisible by 4 and an even height')
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu
  const adapter = await gpu?.requestAdapter({ powerPreference: 'high-performance' })
  if (!adapter) throw new Error('WebGPU is unavailable')
  const device = await adapter.requestDevice()

  const module = device.createShaderModule({ code: SHADER })
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
    primitive: { topology: 'triangle-list' },
  })
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })

  // Too many widgets for the uniform array: upload the whole frame instead.
  const slots = widgets.length <= MAX_RECTS ? widgets : [{ id: '*', rect: { x: 0, y: 0, w: width, h: height } }]
  const atlas = packAtlas(slots.map((w) => w.rect))
  const positions = new Map(slots.map((w, i) => [w.id, atlas.entries[i]!.atlas]))
  const fullFrame = slots[0]?.id === '*'

  const params = new ArrayBuffer(32 + MAX_RECTS * 16 * 2)
  new Float32Array(params, 0, 4).set([width, height, atlas.width, atlas.height])
  new Uint32Array(params, 16, 4).set([slots.length, 0, 0, 0])
  const rectData = new Float32Array(params, 32, MAX_RECTS * 4)
  const posData = new Float32Array(params, 32 + MAX_RECTS * 16, MAX_RECTS * 4)
  slots.forEach(({ rect }, i) => {
    const at = atlas.entries[i]!.atlas
    rectData.set([rect.x, rect.y, rect.w, rect.h], i * 4)
    posData.set([at.x, at.y, 0, 0], i * 4)
  })
  const paramBuffer = device.createBuffer({ size: params.byteLength, usage: BUFFER.UNIFORM | BUFFER.COPY_DST })
  device.queue.writeBuffer(paramBuffer, 0, params)

  const overlayCanvas = new OffscreenCanvas(atlas.width, atlas.height)
  const overlayCtx = overlayCanvas.getContext('2d')
  if (!overlayCtx) throw new Error('Canvas 2D is unavailable')
  const overlayTexture = device.createTexture({
    size: [atlas.width, atlas.height],
    format: 'rgba8unorm',
    usage: TEXTURE.TEXTURE_BINDING | TEXTURE.COPY_DST | TEXTURE.RENDER_ATTACHMENT,
  })
  const overlayView = overlayTexture.createView()

  const packedWidth = width / 4
  const packedHeight = (height * 3) / 2
  const packed = device.createTexture({
    size: [packedWidth, packedHeight],
    format: 'rgba8unorm',
    usage: TEXTURE.RENDER_ATTACHMENT | TEXTURE.COPY_SRC,
  })
  const packedView = packed.createView()
  // Buffer rows are padded to 256 bytes; the NV12 frame layout uses that stride.
  const bytesPerRow = Math.ceil(width / 256) * 256
  const readbacks = Array.from({ length: inFlight }, () => ({
    buffer: device.createBuffer({ size: bytesPerRow * packedHeight, usage: BUFFER.COPY_DST | BUFFER.MAP_READ }),
    busy: Promise.resolve(),
  }))
  const layout = [
    { offset: 0, stride: bytesPerRow },
    { offset: bytesPerRow * height, stride: bytesPerRow },
  ]
  let submitted = 0
  let lost: string | null = null
  void device.lost.then((info) => {
    lost = info.message || 'GPU device lost'
  })

  return {
    kind: 'webgpu',
    async compose(frame, drawOverlay, timestamp, duration) {
      if (lost) throw new Error(lost)
      const slot = readbacks[submitted % inFlight]!
      submitted += 1
      await slot.busy

      overlayCtx.clearRect(0, 0, atlas.width, atlas.height)
      drawOverlay(overlayCtx, fullFrame ? undefined : (id) => positions.get(id))
      device.queue.copyExternalImageToTexture(
        { source: overlayCanvas },
        { texture: overlayTexture, premultipliedAlpha: true },
        [atlas.width, atlas.height],
      )
      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: device.importExternalTexture({ source: frame }) },
          { binding: 1, resource: overlayView },
          { binding: 2, resource: sampler },
          { binding: 3, resource: { buffer: paramBuffer } },
        ],
      })
      const commands = device.createCommandEncoder()
      const pass = commands.beginRenderPass({
        colorAttachments: [{ view: packedView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
      })
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, bindGroup)
      pass.draw(3)
      pass.end()
      commands.copyTextureToBuffer({ texture: packed }, { buffer: slot.buffer, bytesPerRow }, [packedWidth, packedHeight])
      device.queue.submit([commands.finish()])

      const result = slot.buffer.mapAsync(MAP_READ).then(() => {
        const nv12 = new VideoFrame(new Uint8Array(slot.buffer.getMappedRange()), {
          format: 'NV12',
          codedWidth: width,
          codedHeight: height,
          layout,
          timestamp,
          duration,
          colorSpace: BT709,
        })
        slot.buffer.unmap()
        return nv12
      })
      slot.busy = result.then(
        () => undefined,
        () => undefined,
      )
      return result
    },
    destroy() {
      device.destroy()
    },
  }
}
