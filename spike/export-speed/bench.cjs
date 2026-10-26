// Renderer side: demux → VideoDecoder → Canvas 2D (video + overlay) →
// VideoEncoder → MP4 mux streamed to disk. Reports timings to main.
const fs = require('node:fs')
const path = require('node:path')
const { ipcRenderer } = require('electron')
const MB = require('./node_modules/mediabunny/dist/bundles/mediabunny.cjs')
const { createOverlay } = require('./overlay.cjs')
const { createGlCompositor } = require('./glCompositor.cjs')
const { createNv12Compositor } = require('./glNv12.cjs')
const { createWebGpuNv12Compositor } = require('./webgpuNv12.cjs')

const CSV_PATH = path.join(__dirname, '../../sample-data/3.csv')
/** Telemetry time shown at video t=0 (mid-session, so the gauges move). */
const TELEMETRY_OFFSET = 240
const MAX_QUEUE = 8

const ENCODE_CODECS = {
  // High profile, level 5.2: covers 4K60.
  avc: { mime: 'avc1.640034', mux: 'avc' },
  hevc: { mime: 'hvc1.1.6.L156.B0', mux: 'hevc' },
}

function nextEvent(target, name) {
  return new Promise((resolve) => target.addEventListener(name, resolve, { once: true }))
}

async function run(job) {
  if (job.mode === 'gpuread') {
    const { gpuReadBench } = require('./gpuRead.cjs')
    return { ...job, ...(await gpuReadBench(job)) }
  }
  // Stream byte ranges from disk; camera files can be many GB.
  const handle = await fs.promises.open(job.input, 'r')
  const fileSize = (await handle.stat()).size
  const input = new MB.Input({
    formats: MB.ALL_FORMATS,
    source: new MB.CustomSource({
      getSize: () => fileSize,
      async read(start, end) {
        const bytes = new Uint8Array(end - start)
        await handle.read(bytes, 0, bytes.byteLength, start)
        return bytes
      },
      dispose: () => handle.close(),
      maxCacheSize: 64 * 1024 * 1024,
      prefetchProfile: 'fileSystem',
    }),
  })
  const track = await input.getPrimaryVideoTrack()
  const decoderConfig = await track.getDecoderConfig()
  const width = track.codedWidth
  const height = track.codedHeight
  const sink = new MB.EncodedPacketSink(track)
  const decodeSupport = await VideoDecoder.isConfigSupported({ ...decoderConfig, hardwareAcceleration: job.decodeHw })
  if (!decodeSupport.supported) {
    return { ...job, skipped: `decoder config unsupported (${decoderConfig.codec}, ${job.decodeHw})` }
  }

  // Optional window: start at the key packet before job.startSeconds and stop
  // after job.durationSeconds. Timestamps are rebased so output starts at 0.
  async function* windowChunks() {
    const startPacket = job.startSeconds ? await sink.getKeyPacket(job.startSeconds) : await sink.getFirstPacket()
    const base = startPacket.timestamp
    const end = job.durationSeconds ? base + job.durationSeconds : Infinity
    for await (const packet of sink.packets(startPacket)) {
      if (packet.timestamp >= end) break
      yield new EncodedVideoChunk({
        type: packet.type,
        timestamp: Math.round((packet.timestamp - base) * 1e6),
        duration: Math.round(packet.duration * 1e6),
        data: packet.data,
      })
    }
  }

  const pipelined = job.compositor === 'nv12-async'
  const nv12 = job.compositor?.startsWith('nv12') ? createNv12Compositor(width, height, pipelined) : null
  let encodedNv12 = 0
  const encodeNv12 = ({ data, timestamp, duration }) => {
    const composed = new VideoFrame(data, {
      format: 'NV12',
      codedWidth: width,
      codedHeight: height,
      timestamp,
      duration: duration ?? undefined,
      colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false },
    })
    encoder.encode(composed, { keyFrame: encodedNv12 % Math.round(job.fps * 2) === 0 })
    composed.close()
    encodedNv12 += 1
  }
  const gl = job.compositor === 'gl' ? createGlCompositor(width, height) : null
  const canvas = gl ? gl.canvas : new OffscreenCanvas(width, height)
  const ctx = gl ? null : canvas.getContext('2d', { alpha: false, desynchronized: true })
  const overlay = createOverlay(CSV_PATH, width, height)
  const composeFrame = (frame) => {
    const time = TELEMETRY_OFFSET + frame.timestamp / 1e6
    if (gl) {
      gl.overlayCtx.clearRect(0, 0, width, height)
      overlay.draw(gl.overlayCtx, time)
      gl.compose(frame)
    } else {
      ctx.drawImage(frame, 0, 0)
      overlay.draw(ctx, time)
    }
  }

  let frames = 0
  let drawMs = 0
  let firstError = null
  const fail = (error) => {
    firstError ??= error
  }

  let encoder = null
  let output = null
  let packetSource = null
  let muxChain = Promise.resolve()
  let fd = null
  const encodeConfig = job.encode
    ? {
        codec: ENCODE_CODECS[job.encode].mime,
        width,
        height,
        bitrate: job.bitrate,
        framerate: job.fps,
        hardwareAcceleration: job.hw,
        latencyMode: 'quality',
        avc: job.encode === 'avc' ? { format: 'avc' } : undefined,
        hevc: job.encode === 'hevc' ? { format: 'hevc' } : undefined,
      }
    : null

  if (encodeConfig) {
    const support = await VideoEncoder.isConfigSupported(encodeConfig)
    if (!support.supported) {
      return { ...job, skipped: `encoder config unsupported (${job.encode}, ${job.hw})` }
    }
    fd = fs.openSync(job.output, 'w')
    const writable = new WritableStream({
      write(chunk) {
        fs.writeSync(fd, chunk.data, 0, chunk.data.byteLength, chunk.position)
      },
    })
    output = new MB.Output({
      format: new MB.Mp4OutputFormat({ fastStart: false }),
      target: new MB.StreamTarget(writable),
    })
    packetSource = new MB.EncodedVideoPacketSource(ENCODE_CODECS[job.encode].mux)
    output.addVideoTrack(packetSource, { frameRate: job.fps })
    await output.start()
    encoder = new VideoEncoder({
      output(chunk, meta) {
        const packet = MB.EncodedPacket.fromEncodedChunk(chunk)
        muxChain = muxChain.then(() => packetSource.add(packet, meta)).catch(fail)
      },
      error: fail,
    })
    encoder.configure(encodeConfig)
  }

  if (job.mode === 'encode-cpu') {
    // Encoder ceiling for CPU-memory NV12 input (no decode, no GPU work).
    const data = new Uint8Array((width * height * 3) / 2).fill(128)
    const started = performance.now()
    const total = job.fps * 30
    for (let i = 0; i < total; i += 1) {
      while (encoder.encodeQueueSize >= MAX_QUEUE) await nextEvent(encoder, 'dequeue')
      data[i % data.length] = i & 255
      const frame = new VideoFrame(data, {
        format: 'NV12',
        codedWidth: width,
        codedHeight: height,
        timestamp: Math.round((i * 1e6) / job.fps),
        duration: Math.round(1e6 / job.fps),
      })
      encoder.encode(frame, { keyFrame: i % Math.round(job.fps * 2) === 0 })
      frame.close()
      frames += 1
    }
    await encoder.flush()
    await muxChain
    await output.finalize()
    fs.closeSync(fd)
    const elapsed = (performance.now() - started) / 1000
    return {
      ...job,
      width,
      height,
      frames,
      seconds: Number(elapsed.toFixed(2)),
      throughputFps: Number((frames / elapsed).toFixed(1)),
      realtime: Number((frames / elapsed / job.fps).toFixed(2)),
    }
  }

  if (job.compositor === 'webgpu') {
    const gpu = await createWebGpuNv12Compositor(width, height, {
      skipOverlayUpload: job.skipOverlayUpload,
      bitmapUpload: job.bitmapUpload,
      cpuOverlay: job.cpuOverlay,
      rects: job.tinyOverlay
        ? [{ x: 0, y: 0, w: 64, h: 64 }]
        : job.atlas
          ? overlay.widgets.map((widget) => widget.rect)
          : undefined,
    })
    const drawOverlay = (time) => {
      const ctx2d = gpu.overlayCtx
      ctx2d.clearRect(0, 0, gpu.atlasWidth, gpu.atlasHeight)
      if (job.tinyOverlay) {
        ctx2d.fillStyle = '#2dd4bf'
        ctx2d.fillRect(8, 8, 48, (time * 10) % 48)
        return
      }
      if (!job.atlas) {
        overlay.draw(ctx2d, time)
        return
      }
      overlay.widgets.forEach((widget, i) => {
        const { rect, atlasX, atlasY } = gpu.atlas[i]
        ctx2d.save()
        ctx2d.beginPath()
        ctx2d.rect(atlasX, atlasY, rect.w, rect.h)
        ctx2d.clip()
        ctx2d.translate(atlasX - rect.x, atlasY - rect.y)
        widget.draw(ctx2d, time)
        ctx2d.restore()
      })
    }
    const decoded = []
    let wake = null
    const notify = () => {
      wake?.()
      wake = null
    }
    const webgpuDecoder = new VideoDecoder({
      output(frame) {
        decoded.push(frame)
        notify()
      },
      error(error) {
        fail(error)
        notify()
      },
    })
    webgpuDecoder.configure({ ...decoderConfig, hardwareAcceleration: job.decodeHw })
    const packets = windowChunks()
    let inputDone = false
    let flushDone = false
    const pending = []
    const encodeReady = async (promise) => {
      const nv12Frame = await promise
      if (job.skipEncode) {
        nv12Frame.close()
        frames += 1
        return
      }
      while (encoder.encodeQueueSize >= MAX_QUEUE) await nextEvent(encoder, 'dequeue')
      encoder.encode(nv12Frame, { keyFrame: frames % Math.round(job.fps * 2) === 0 })
      nv12Frame.close()
      frames += 1
    }

    let stage = 'start'
    let lastFrames = -1
    const watchdog = setInterval(() => {
      if (frames === lastFrames) {
        fail(new Error(`stalled at ${stage}: ${JSON.stringify({ frames, decoded: decoded.length, pending: pending.length, decodeQueue: webgpuDecoder.decodeQueueSize, encodeQueue: encoder.encodeQueueSize, inputDone, flushDone })}`))
        notify()
      }
      lastFrames = frames
    }, 10_000)

    const started = performance.now()
    while (!firstError) {
      stage = 'feed'
      while (!inputDone && webgpuDecoder.decodeQueueSize < 4 && decoded.length < 3) {
        const next = await packets.next()
        if (next.done) {
          inputDone = true
          webgpuDecoder.flush().then(() => {
            flushDone = true
            notify()
          }, fail)
          break
        }
        webgpuDecoder.decode(next.value)
      }
      if (decoded.length === 0) {
        if (flushDone) break
        stage = 'wait-decoded'
        // Decoders may hold several packets before the first output, so a
        // drained input queue must also wake us to keep feeding.
        await Promise.race([
          new Promise((resolve) => {
            wake = resolve
          }),
          ...(inputDone ? [] : [nextEvent(webgpuDecoder, 'dequeue')]),
        ])
        continue
      }
      const frame = decoded.shift()
      stage = 'encode-ready'
      if (pending.length >= 3) await encodeReady(pending.shift())
      stage = 'submit'
      const t0 = performance.now()
      drawOverlay(TELEMETRY_OFFSET + frame.timestamp / 1e6)
      drawMs += performance.now() - t0
      pending.push(gpu.submit(frame).finally(() => frame.close()))
    }
    stage = 'drain'
    if (!firstError) for (const promise of pending) await encodeReady(promise)
    clearInterval(watchdog)
    if (firstError) throw firstError
    await encoder.flush()
    await muxChain
    await output.finalize()
    fs.closeSync(fd)
    const elapsed = (performance.now() - started) / 1000
    webgpuDecoder.close()
    encoder.close()
    gpu.destroy()
    if (firstError) throw firstError
    return {
      ...job,
      width,
      height,
      sourceCodec: decoderConfig.codec,
      frames,
      seconds: Number(elapsed.toFixed(2)),
      throughputFps: Number((frames / elapsed).toFixed(1)),
      realtime: Number((frames / elapsed / job.fps).toFixed(2)),
      drawMsPerFrame: Number((drawMs / Math.max(frames, 1)).toFixed(2)),
      outputBytes: fs.statSync(job.output).size,
    }
  }

  let readback = null
  let pendingCopy = Promise.resolve()
  const decoder = new VideoDecoder({
    output(frame) {
      if (job.mode === 'transcode') {
        // Encoder throughput ceiling: decoded frame straight to encoder.
        encoder.encode(frame, { keyFrame: frames % Math.round(job.fps * 2) === 0 })
      } else if (job.mode === 'snapshot') {
        // Cost of pulling the composed canvas back to CPU memory.
        composeFrame(frame)
        const composed = new VideoFrame(canvas, { timestamp: frame.timestamp })
        readback ??= new Uint8Array(composed.allocationSize())
        const t0 = performance.now()
        pendingCopy = pendingCopy.then(() =>
          composed.copyTo(readback).then(() => {
            drawMs += performance.now() - t0
            composed.close()
          }),
        )
      } else if (nv12) {
        const t0 = performance.now()
        nv12.overlayCtx.clearRect(0, 0, width, height)
        overlay.draw(nv12.overlayCtx, TELEMETRY_OFFSET + frame.timestamp / 1e6)
        const ready = nv12.render(frame)
        drawMs += performance.now() - t0
        if (!pipelined) encodeNv12({ data: nv12.nv12, timestamp: frame.timestamp, duration: frame.duration })
        else if (ready) encodeNv12(ready)
      } else if (job.mode !== 'decode') {
        const t0 = performance.now()
        composeFrame(frame)
        drawMs += performance.now() - t0
        if (encoder) {
          const composed = new VideoFrame(canvas, {
            timestamp: frame.timestamp,
            duration: frame.duration ?? undefined,
          })
          encoder.encode(composed, { keyFrame: frames % Math.round(job.fps * 2) === 0 })
          composed.close()
        }
      }
      frame.close()
      frames += 1
    },
    error: fail,
  })
  decoder.configure({ ...decoderConfig, hardwareAcceleration: job.decodeHw })

  const started = performance.now()
  for await (const chunk of windowChunks()) {
    if (firstError) break
    while (decoder.decodeQueueSize >= MAX_QUEUE || (encoder && encoder.encodeQueueSize >= MAX_QUEUE)) {
      await Promise.race([
        nextEvent(decoder, 'dequeue'),
        ...(encoder ? [nextEvent(encoder, 'dequeue')] : []),
      ])
    }
    decoder.decode(chunk)
  }
  await decoder.flush()
  await pendingCopy
  if (pipelined) for (const ready of nv12.drain()) encodeNv12(ready)
  if (encoder) {
    await encoder.flush()
    await muxChain
    await output.finalize()
    fs.closeSync(fd)
  }
  const elapsed = (performance.now() - started) / 1000
  decoder.close()
  encoder?.close()
  if (firstError) throw firstError

  return {
    ...job,
    width,
    height,
    sourceCodec: decoderConfig.codec,
    frames,
    seconds: Number(elapsed.toFixed(2)),
    throughputFps: Number((frames / elapsed).toFixed(1)),
    realtime: Number((frames / elapsed / job.fps).toFixed(2)),
    drawMsPerFrame: Number((drawMs / Math.max(frames, 1)).toFixed(2)),
    fencesNotReady: nv12?.notReady,
    glTimings: nv12 ? Object.fromEntries(Object.entries(nv12.timings).map(([k, v]) => [k, k === 'frames' ? v : Number((v / nv12.timings.frames).toFixed(2))])) : undefined,
    outputBytes: job.encode ? fs.statSync(job.output).size : undefined,
  }
}

const job = JSON.parse(decodeURIComponent(location.hash.slice(1)))
globalThis.PROFILE_GL = Boolean(job.profile)
run(job)
  .then((result) => ipcRenderer.send('result', result))
  .catch((error) => ipcRenderer.send('result', { ...job, error: String(error?.stack ?? error) }))
