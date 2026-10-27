import {
  ALL_FORMATS,
  CustomSource,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  type InputAudioTrack,
  type StreamTargetChunk,
} from 'mediabunny'
import type { TelemetrySession } from '../data/import'
import type { RandomAccessFile } from '../media/file'
import type { ExportSettings, WidgetInstance } from '../project/schema'
import { widgetBox, OverlayRenderer } from '../widgets/renderer'
import { WIDGETS } from '../widgets/registry'
import { createCanvasCompositor, createWebGpuCompositor, type Compositor } from './compositor'
import { totalDuration, type Segment } from './plan'

/**
 * Export: demux → hardware decode → composite overlay → hardware encode →
 * MP4 mux, with AAC audio copied through. Runs in a worker; file access is
 * injected so the same code serves Electron and the browser harness.
 */

export interface WriteTarget {
  write(position: number, bytes: Uint8Array): Promise<void>
}

export interface ExportJob {
  source: RandomAccessFile
  target: WriteTarget
  segments: Segment[]
  size: { width: number; height: number }
  codec: ExportSettings['codec']
  /** Bits per second. */
  bitrate: number
  includeAudio: boolean
  widgets: WidgetInstance[]
  session: TelemetrySession | null
  /** video time = offset + data time × (1 + drift) */
  sync: { offset: number; drift: number }
  /** Force the Canvas 2D compositor (WebGPU is tried first otherwise). */
  compositor?: 'auto' | 'canvas2d'
}

export interface ExportProgress {
  framesDone: number
  framesTotal: number
  elapsedSeconds: number
}

export interface ExportStats {
  frames: number
  /** Seconds of output video. */
  duration: number
  elapsedSeconds: number
  codec: ExportSettings['codec']
  compositor: Compositor['kind']
  audio: boolean
  bytes: number
  warnings: string[]
}

const CODEC_STRINGS: Record<ExportSettings['codec'], string> = {
  // Main profile, level 5.2 / High profile, level 5.2: up to 4K60.
  hevc: 'hvc1.1.6.L156.B0',
  avc: 'avc1.640034',
}
const MAX_ENCODE_QUEUE = 8
const MAX_DECODED = 4
const MAX_IN_FLIGHT = 3
/** Decode past a segment's end so reordered (B-)frames before it still arrive. */
const DECODE_MARGIN = 0.5
const PROGRESS_MS = 250
const BT709 = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false } as const

function nextEvent(target: EventTarget, name: string) {
  return new Promise<void>((resolve) => target.addEventListener(name, () => resolve(), { once: true }))
}

export class ExportCancelled extends Error {
  constructor() {
    super('Export cancelled')
  }
}

/** Encoder config for the requested codec, falling back to the other one. */
async function chooseEncoder(job: ExportJob, fps: number, warnings: string[]) {
  const order: Array<ExportSettings['codec']> = job.codec === 'hevc' ? ['hevc', 'avc'] : ['avc', 'hevc']
  for (const codec of order) {
    for (const hardwareAcceleration of ['prefer-hardware', 'no-preference'] as const) {
      const config: VideoEncoderConfig = {
        codec: CODEC_STRINGS[codec],
        width: job.size.width,
        height: job.size.height,
        bitrate: job.bitrate,
        framerate: fps,
        hardwareAcceleration,
        latencyMode: 'quality',
        ...(codec === 'avc' ? { avc: { format: 'avc' } } : {}),
        ...(codec === 'hevc' ? ({ hevc: { format: 'hevc' } } as object) : {}),
      }
      const support = await VideoEncoder.isConfigSupported(config).catch(() => ({ supported: false }))
      if (support.supported) {
        if (codec !== job.codec) warnings.push(`${job.codec === 'hevc' ? 'HEVC' : 'H.264'} encoding isn't available here, so the video is ${codec === 'hevc' ? 'HEVC' : 'H.264'}.`)
        return { codec, config }
      }
    }
  }
  throw new Error('No H.264 or HEVC video encoder is available on this computer.')
}

export async function runExport(
  job: ExportJob,
  options: { signal?: AbortSignal; onProgress?: (progress: ExportProgress) => void } = {},
): Promise<ExportStats> {
  const { signal, onProgress } = options
  const started = performance.now()
  const warnings: string[] = []
  const checkCancelled = () => {
    if (signal?.aborted) throw new ExportCancelled()
  }

  const input = new Input({
    formats: ALL_FORMATS,
    source: new CustomSource({
      getSize: () => job.source.size,
      read: async (start, end) => (await job.source.readRanges([{ offset: start, length: end - start }]))[0]!,
      maxCacheSize: 64 * 1024 * 1024,
      prefetchProfile: 'network',
    }),
  })
  const videoTrack = await input.getPrimaryVideoTrack()
  if (!videoTrack) throw new Error('This file has no video track.')
  const decoderConfig = await videoTrack.getDecoderConfig()
  if (!decoderConfig) throw new Error("This video's codec can't be decoded here.")
  const decodeSupport = await VideoDecoder.isConfigSupported({ ...decoderConfig, hardwareAcceleration: 'prefer-hardware' })
  if (!decodeSupport.supported) throw new Error(`Can't decode ${decoderConfig.codec} video on this computer.`)
  const stats = await videoTrack.computePacketStats(120)
  const fps = stats.averagePacketRate > 0 ? stats.averagePacketRate : 30
  const frameDuration = Math.round(1e6 / fps)
  const keyInterval = Math.max(1, Math.round(fps * 2))

  const encoderChoice = await chooseEncoder(job, fps, warnings)

  // Output, written in 16 MiB chunks.
  let bytes = 0
  const writable = new WritableStream<StreamTargetChunk>({
    async write(chunk) {
      await job.target.write(chunk.position, chunk.data)
      bytes = Math.max(bytes, chunk.position + chunk.data.byteLength)
    },
  })
  const format = new Mp4OutputFormat({ fastStart: false })
  const output = new Output({ format, target: new StreamTarget(writable, { chunked: true }) })
  const videoSource = new EncodedVideoPacketSource(encoderChoice.codec)
  output.addVideoTrack(videoSource, { frameRate: fps })

  let audioTrack: InputAudioTrack | null = null
  let audioSource: EncodedAudioPacketSource | null = null
  let audioConfig: AudioDecoderConfig | null = null
  if (job.includeAudio) {
    audioTrack = await input.getPrimaryAudioTrack()
    const codec = audioTrack?.codec
    if (audioTrack && codec && format.getSupportedAudioCodecs().includes(codec)) {
      audioConfig = await audioTrack.getDecoderConfig()
      audioSource = new EncodedAudioPacketSource(codec)
      output.addAudioTrack(audioSource)
    } else if (audioTrack) {
      warnings.push(`The ${codec ?? 'unknown'} audio can't be copied into an MP4, so the export has no sound.`)
      audioTrack = null
    }
  }
  await output.start()

  // Overlay and compositor.
  const renderer = new OverlayRenderer()
  const drawn = job.widgets.filter((w) => !w.hidden && WIDGETS[w.type])
  const boxes = drawn
    .map((w) => {
      const box = widgetBox(w, job.size.width, job.size.height)
      const x = Math.max(0, box.x)
      const y = Math.max(0, box.y)
      return { id: w.id, rect: { x, y, w: Math.min(job.size.width, box.x + box.width) - x, h: Math.min(job.size.height, box.y + box.height) - y } }
    })
    .filter((b) => b.rect.w >= 4 && b.rect.h >= 4)
  let compositor: Compositor
  if (job.compositor === 'canvas2d') {
    compositor = createCanvasCompositor(job.size.width, job.size.height)
  } else {
    try {
      compositor = await createWebGpuCompositor(job.size.width, job.size.height, boxes)
    } catch (error) {
      warnings.push(`GPU compositing is unavailable (${error instanceof Error ? error.message : String(error)}); using the slower Canvas 2D path.`)
      compositor = createCanvasCompositor(job.size.width, job.size.height)
    }
  }
  const toData = (videoTime: number) => (videoTime - job.sync.offset) / (1 + job.sync.drift)

  // Pipeline state.
  let failure: unknown = null
  const fail = (error: unknown) => {
    failure ??= error
    notify()
  }
  let wake: (() => void) | null = null
  const notify = () => {
    wake?.()
    wake = null
  }
  const decoded: VideoFrame[] = []
  let videoChain = Promise.resolve()
  let audioChain = Promise.resolve()

  const encoder = new VideoEncoder({
    output(chunk, meta) {
      const packet = EncodedPacket.fromEncodedChunk(chunk)
      // Tag the stream BT.709 so players don't have to guess.
      const tagged =
        meta?.decoderConfig && !meta.decoderConfig.colorSpace?.primaries
          ? { ...meta, decoderConfig: { ...meta.decoderConfig, colorSpace: BT709 } }
          : meta
      videoChain = videoChain.then(() => videoSource.add(packet, tagged)).catch(fail)
    },
    error: fail,
  })
  encoder.configure(encoderChoice.config)
  const decoder = new VideoDecoder({
    output(frame) {
      decoded.push(frame)
      notify()
    },
    error: fail,
  })
  decoder.configure({ ...decoderConfig, hardwareAcceleration: 'prefer-hardware' })

  const framesTotal = Math.max(1, Math.round(totalDuration(job.segments) * fps))
  let framesDone = 0
  let lastProgress = 0
  const pending: Array<Promise<VideoFrame>> = []
  const encodeNext = async () => {
    const frame = await pending.shift()!
    try {
      while (encoder.encodeQueueSize >= MAX_ENCODE_QUEUE) await nextEvent(encoder, 'dequeue')
      encoder.encode(frame, { keyFrame: framesDone % keyInterval === 0 })
    } finally {
      frame.close()
    }
    framesDone += 1
    const now = performance.now()
    if (onProgress && now - lastProgress > PROGRESS_MS) {
      lastProgress = now
      onProgress({ framesDone, framesTotal, elapsedSeconds: (now - started) / 1000 })
    }
  }

  const videoSink = new EncodedPacketSink(videoTrack)
  const audioSink = audioTrack ? new EncodedPacketSink(audioTrack) : null
  let audioMetaSent = false

  try {
    let outputBase = 0
    for (const segment of job.segments) {
      // Audio packets for this segment, copied as they're needed.
      let audioPackets: AsyncGenerator<EncodedPacket, void> | null = null
      let audioNext: EncodedPacket | null = null
      if (audioSink && audioSource) {
        const first = (await audioSink.getPacket(segment.start)) ?? (await audioSink.getFirstPacket())
        if (first) {
          audioPackets = audioSink.packets(first)
          audioNext = (await audioPackets.next()).value ?? null
        }
      }
      const pumpAudio = async (until: number) => {
        while (audioPackets && audioNext && audioNext.timestamp < Math.min(until, segment.end)) {
          const at = outputBase + audioNext.timestamp - segment.start
          if (at >= 0) {
            const packet = audioNext.clone({ timestamp: at })
            const meta = audioMetaSent ? undefined : { decoderConfig: audioConfig ?? undefined }
            audioMetaSent = true
            audioChain = audioChain.then(() => audioSource!.add(packet, meta)).catch(fail)
          }
          audioNext = (await audioPackets.next()).value ?? null
        }
      }

      const start = (await videoSink.getKeyPacket(segment.start)) ?? (await videoSink.getFirstPacket())
      if (!start) break
      const packets = videoSink.packets(start)
      let inputDone = false
      let flushed = false
      while (true) {
        checkCancelled()
        if (failure) throw failure
        while (!inputDone && decoder.decodeQueueSize < 4 && decoded.length < MAX_DECODED) {
          const next = await packets.next()
          if (next.done || next.value.timestamp >= segment.end + DECODE_MARGIN) {
            inputDone = true
            void packets.return(undefined)
            decoder.flush().then(() => {
              flushed = true
              notify()
            }, fail)
            break
          }
          const packet = next.value
          decoder.decode(
            new EncodedVideoChunk({
              type: packet.type,
              timestamp: Math.round(packet.timestamp * 1e6),
              duration: Math.round(packet.duration * 1e6),
              data: packet.data,
            }),
          )
        }
        if (decoded.length === 0) {
          if (flushed) break
          // Decoders hold several packets before the first output, so a
          // drained input queue must also wake the loop to keep feeding.
          await Promise.race([
            new Promise<void>((resolve) => {
              wake = resolve
            }),
            ...(inputDone ? [] : [nextEvent(decoder, 'dequeue')]),
          ])
          continue
        }

        const frame = decoded.shift()!
        const time = frame.timestamp / 1e6
        if (time < segment.start - 1e-6 || time >= segment.end) {
          frame.close()
          continue
        }
        if (pending.length >= MAX_IN_FLIGHT) await encodeNext()
        const timestamp = Math.round((outputBase + time - segment.start) * 1e6)
        const dataTime = toData(time)
        pending.push(
          compositor
            .compose(
              frame,
              (ctx, place) => renderer.render(ctx, job.size, drawn, job.session, dataTime, place && ((w) => place(w.id))),
              timestamp,
              frame.duration ?? frameDuration,
            )
            .finally(() => frame.close()),
        )
        await pumpAudio(time + 1)
      }
      while (pending.length) await encodeNext()
      await pumpAudio(Infinity)
      void audioPackets?.return(undefined)
      outputBase += segment.end - segment.start
    }

    checkCancelled()
    await encoder.flush()
    await videoChain
    await audioChain
    if (failure) throw failure
    await output.finalize()
    onProgress?.({ framesDone, framesTotal: framesDone, elapsedSeconds: (performance.now() - started) / 1000 })
    return {
      frames: framesDone,
      duration: totalDuration(job.segments),
      elapsedSeconds: (performance.now() - started) / 1000,
      codec: encoderChoice.codec,
      compositor: compositor.kind,
      audio: audioMetaSent,
      bytes,
      warnings,
    }
  } catch (error) {
    await output.cancel().catch(() => undefined)
    throw error
  } finally {
    for (const frame of decoded.splice(0)) frame.close()
    await Promise.allSettled(pending.splice(0).map((p) => p.then((f) => f.close())))
    if (decoder.state !== 'closed') decoder.close()
    if (encoder.state !== 'closed') encoder.close()
    compositor.destroy()
    input.dispose()
  }
}
