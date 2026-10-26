// Microbenchmark: WebGPU texture → CPU readback throughput with N in flight.
async function gpuReadBench({ width, height, bytesPerPixel = 4, frames = 300, inFlight = 3 }) {
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' })
  if (!adapter) throw new Error('WebGPU adapter unavailable')
  const device = await adapter.requestDevice()
  const adapterInfo = adapter.info ? `${adapter.info.vendor} ${adapter.info.architecture} ${adapter.info.description}` : 'unknown'

  // Readback of a W×(1.5H)/4 RGBA texture == NV12 byte size when bytesPerPixel=1.5.
  const texWidth = bytesPerPixel === 4 ? width : width / 4
  const texHeight = bytesPerPixel === 4 ? height : (height * 3) / 2
  const bytesPerRow = Math.ceil((texWidth * 4) / 256) * 256
  const size = bytesPerRow * texHeight
  const texture = device.createTexture({
    size: [texWidth, texHeight],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
  })
  const buffers = Array.from({ length: inFlight }, () =>
    device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
  )
  const host = new Uint8Array(size)
  const pending = []

  const started = performance.now()
  for (let i = 0; i < frames; i += 1) {
    const buffer = buffers[i % inFlight]
    if (pending.length >= inFlight) await pending.shift()
    const encoder = device.createCommandEncoder()
    // Clear to a varying color so the GPU does real work each frame.
    encoder
      .beginRenderPass({
        colorAttachments: [{ view: texture.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [i / frames, 0.5, 0.2, 1] }],
      })
      .end()
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [texWidth, texHeight])
    device.queue.submit([encoder.finish()])
    pending.push(
      buffer.mapAsync(GPUMapMode.READ).then(() => {
        host.set(new Uint8Array(buffer.getMappedRange()))
        buffer.unmap()
      }),
    )
  }
  await Promise.all(pending)
  const seconds = (performance.now() - started) / 1000
  device.destroy()
  return {
    adapterInfo,
    readbackMB: Number((size / 1e6).toFixed(1)),
    fps: Number((frames / seconds).toFixed(1)),
    gbPerSecond: Number(((size * frames) / seconds / 1e9).toFixed(2)),
  }
}

module.exports = { gpuReadBench }
