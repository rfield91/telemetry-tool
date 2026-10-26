import { Film, Table2 } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { OverlayRenderer } from '../../core/widgets/renderer'
import { openTelemetry, openVideo } from '../actions'
import { LayoutEditor } from './LayoutEditor'
import { player } from '../player'
import { runtimeStore, useActivePair, useProject, useRuntime } from '../state'

interface PerfStats {
  drawMs: number
  maxDrawMs: number
  fps: number
  dropped: number
}

const TIME_PUBLISH_MS = 100

/**
 * The preview: video with the overlay canvas on top. While the video plays,
 * the overlay redraws on every presented frame (requestVideoFrameCallback)
 * using that frame's exact media time.
 */
export function Stage() {
  const { video, session, time } = useActivePair()
  const showPerf = useRuntime((s) => s.showStats)
  const widgets = useProject((s) => s.project.layout.widgets)
  const containerRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef(new OverlayRenderer())
  const [box, setBox] = useState({ width: 0, height: 0 })
  const [perf, setPerf] = useState<PerfStats | null>(null)
  const [videoError, setVideoError] = useState<string | null>(null)

  const aspect = video ? video.probe.video.width / video.probe.video.height : 16 / 9

  // Latest values for the frame loop, without restarting it on every change.
  const latest = useRef({ widgets, session, time })
  latest.current = { widgets, session, time }
  const stats = useRef({ drawTotal: 0, drawMax: 0, draws: 0, frames: 0, since: performance.now(), lastPublish: 0 })

  useLayoutEffect(() => {
    const element = containerRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry!.contentRect
      const fitWidth = Math.min(width, height * aspect)
      setBox({ width: Math.floor(fitWidth), height: Math.floor(fitWidth / aspect) })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [aspect])

  const draw = (videoTime: number) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const width = Math.round(box.width * dpr)
    const height = Math.round(box.height * dpr)
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    const ctx = canvas.getContext('2d')
    if (!ctx || width === 0) return
    ctx.clearRect(0, 0, width, height)
    const { widgets: current, session: currentSession, time: map } = latest.current
    rendererRef.current.render(ctx, { width, height }, current, currentSession ?? null, map.toData(videoTime))

    const s = stats.current
    s.drawTotal += rendererRef.current.lastFrameMs
    s.drawMax = Math.max(s.drawMax, rendererRef.current.lastFrameMs)
    s.draws += 1
    const now = performance.now()
    if (now - s.lastPublish > TIME_PUBLISH_MS) {
      s.lastPublish = now
      runtimeStore.setState({ time: videoTime })
    }
  }
  const drawRef = useRef(draw)
  drawRef.current = draw

  // Keep the player in sync with what is loaded.
  useEffect(() => {
    player.attach(video ? videoRef.current : null)
    player.duration = video?.probe.duration ?? session?.duration ?? 0
    player.fps = video?.probe.video.fps ?? 30
    setVideoError(null)
  }, [video, session])

  // Per-frame redraw while the video presents frames.
  useEffect(() => {
    const element = videoRef.current
    if (!video || !element) return
    let handle = 0
    const onFrame: VideoFrameRequestCallback = (_now, metadata) => {
      stats.current.frames += 1
      drawRef.current(metadata.mediaTime)
      handle = element.requestVideoFrameCallback(onFrame)
    }
    handle = element.requestVideoFrameCallback(onFrame)
    return () => element.cancelVideoFrameCallback(handle)
  }, [video])

  // Virtual clock ticks when there is no video.
  useEffect(() => {
    if (video) return
    return player.onTick(() => {
      stats.current.frames += 1
      drawRef.current(player.time)
    })
  }, [video])

  // Redraw on anything else that changes the picture while paused.
  useEffect(() => {
    drawRef.current(player.time)
  }, [widgets, session, time, box])

  // Performance readout, twice a second.
  useEffect(() => {
    if (!showPerf) return
    const timer = setInterval(() => {
      const s = stats.current
      const now = performance.now()
      const quality = videoRef.current?.getVideoPlaybackQuality?.()
      setPerf({
        drawMs: s.draws ? s.drawTotal / s.draws : 0,
        maxDrawMs: s.drawMax,
        fps: (s.frames * 1000) / (now - s.since),
        dropped: quality?.droppedVideoFrames ?? 0,
      })
      Object.assign(s, { drawTotal: 0, drawMax: 0, draws: 0, frames: 0, since: now })
    }, 500)
    return () => clearInterval(timer)
  }, [showPerf])

  return (
    <div ref={containerRef} className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden">
      {!video && !session && <EmptyState />}
      <div
        className={`relative overflow-hidden rounded-md bg-black ${!video && !session ? 'hidden' : ''}`}
        style={{ width: box.width, height: box.height }}
      >
        {video && (
          <video
            ref={videoRef}
            key={video.url}
            src={video.url}
            className="absolute inset-0 h-full w-full"
            preload="auto"
            playsInline
            onLoadedData={() => drawRef.current(player.time)}
            onSeeked={() => drawRef.current(player.time)}
            onError={() =>
              setVideoError(
                'This video could not be played. HEVC needs hardware decoding support in Windows (GPU driver or the HEVC Video Extensions).',
              )
            }
          />
        )}
        <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />
        {session && <LayoutEditor width={box.width} height={box.height} />}
        {videoError && (
          <div className="absolute inset-x-6 top-6 rounded-md border border-danger/40 bg-surface/95 p-3 text-[13px] text-fg">
            {videoError}
          </div>
        )}
        {showPerf && perf && (
          <dl className="pointer-events-none absolute right-2 top-2 grid grid-cols-[auto_auto] gap-x-3 rounded-md bg-black/75 px-2.5 py-1.5 font-mono text-[11px] leading-4 tabular text-fg-muted">
            <dt className="text-fg-subtle">overlay</dt>
            <dd className="text-right">
              {perf.drawMs.toFixed(2)} ms <span className="text-fg-subtle">avg</span> {perf.maxDrawMs.toFixed(2)}{' '}
              <span className="text-fg-subtle">max</span>
            </dd>
            <dt className="text-fg-subtle">frames</dt>
            <dd className="text-right">
              {perf.fps.toFixed(1)} fps{video ? ` · ${perf.dropped} dropped` : ''}
            </dd>
          </dl>
        )}
      </div>
    </div>
  )
}

function EmptyState() {
  const tile =
    'flex flex-1 flex-col items-start gap-3 rounded-lg border border-line bg-surface p-5 text-left transition-colors hover:border-line-strong hover:bg-raised'
  return (
    <div className="absolute inset-0 grid place-items-center p-8">
      <div className="w-full max-w-xl">
        <h2 className="text-lg font-semibold text-fg">Start with your footage and data</h2>
        <p className="mt-1 text-fg-muted">
          Add an in-car video and the logger file from the same session. You can also drop files anywhere in the window.
        </p>
        <div className="mt-6 flex gap-3">
          <button type="button" className={tile} onClick={() => void openVideo()}>
            <Film size={20} className="text-accent" aria-hidden />
            <span>
              <span className="block font-medium text-fg">Add video</span>
              <span className="mt-0.5 block text-xs text-fg-subtle">MP4 or MOV, any length</span>
            </span>
          </button>
          <button type="button" className={tile} onClick={() => void openTelemetry()}>
            <Table2 size={20} className="text-accent" aria-hidden />
            <span>
              <span className="mt-0 block font-medium text-fg">Add data</span>
              <span className="mt-0.5 block text-xs text-fg-subtle">AiM, Solostorm or any CSV with a time column</span>
            </span>
          </button>
        </div>
      </div>
    </div>
  )
}
