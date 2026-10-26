import { useEffect, useRef } from 'react'
import { sampleAt, type Series } from '../../core/data/series'

const WINDOW_SECONDS = 5
const POINTS = 160

function cssColor(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/**
 * Data yaw vs camera yaw around the playhead, at the current offset. Both
 * traces are normalised (and the camera's sign matched), so a correct
 * offset shows them lying on top of each other.
 */
export function SyncPlot({
  logger,
  camera,
  toData,
  videoTime,
  sign,
}: {
  logger: Series
  camera: Series
  /** Video time → data time at the current sync. */
  toData: (videoTime: number) => number
  videoTime: number
  sign: number
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)

    const times = Array.from({ length: POINTS }, (_, i) => videoTime - WINDOW_SECONDS + (2 * WINDOW_SECONDS * i) / (POINTS - 1))
    const data = times.map((t) => sampleAt(logger, toData(t)))
    const video = times.map((t) => {
      const value = sampleAt(camera, t)
      return value === null ? null : sign * value
    })
    const scaleOf = (values: Array<number | null>) => {
      let peak = 0
      for (const v of values) if (v !== null) peak = Math.max(peak, Math.abs(v))
      return peak > 1e-6 ? peak : 1
    }
    const mid = height / 2
    const trace = (values: Array<number | null>, color: string, lineWidth: number) => {
      const scale = scaleOf(values)
      ctx.strokeStyle = color
      ctx.lineWidth = lineWidth
      ctx.lineJoin = 'round'
      ctx.beginPath()
      let started = false
      values.forEach((v, i) => {
        if (v === null) {
          started = false
          return
        }
        const x = (i / (POINTS - 1)) * width
        const y = mid - (v / scale) * (height / 2 - 6)
        if (started) ctx.lineTo(x, y)
        else ctx.moveTo(x, y)
        started = true
      })
      ctx.stroke()
    }

    ctx.strokeStyle = cssColor('--color-line')
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, mid)
    ctx.lineTo(width, mid)
    ctx.stroke()

    // Data is out of range outside its own duration; show nothing there.
    const end = logger.times[logger.times.length - 1] ?? 0
    trace(
      data.map((v, i) => (toData(times[i]!) < 0 || toData(times[i]!) > end ? null : v)),
      cssColor('--color-fg'),
      1.5,
    )
    trace(video, cssColor('--color-info'), 1.5)

    ctx.strokeStyle = cssColor('--color-accent')
    ctx.beginPath()
    ctx.moveTo(width / 2, 0)
    ctx.lineTo(width / 2, height)
    ctx.stroke()
  }, [logger, camera, toData, videoTime, sign])

  return (
    <figure className="mt-3">
      <canvas ref={canvasRef} className="h-20 w-full rounded-md bg-canvas" aria-label="Turn rate from data and camera around the playhead" />
      <figcaption className="mt-1.5 flex items-center gap-3 text-[11px] text-fg-subtle">
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-3 rounded bg-fg" aria-hidden /> Data
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-3 rounded bg-info" aria-hidden /> Camera
        </span>
        <span className="ml-auto">±{WINDOW_SECONDS} s around playhead</span>
      </figcaption>
    </figure>
  )
}
