import { font, MUTED, PANEL_FILL, TEXT } from './draw'
import type { WidgetDefinition } from './types'

export interface GMeterStyle {
  [key: string]: unknown
  /** Plot radius in g. */
  maxG: number
  accent: string
  trailSeconds: number
  /** Logger axis conventions differ; flip so right turns go right. */
  invertLateral: boolean
  invertLongitudinal: boolean
}

const DESIGN = 320
const PLOT_RADIUS = 120
const TRAIL_STEP = 0.05

/** Friction circle: lateral vs longitudinal g with a fading trail. */
export const gMeterWidget: WidgetDefinition<GMeterStyle> = {
  type: 'gMeter',
  label: 'G-meter',
  inputs: [
    { name: 'lateral', label: 'Lateral g', channel: 'lateralAccel' },
    { name: 'longitudinal', label: 'Longitudinal g', channel: 'longitudinalAccel' },
  ],
  aspect: 1,
  defaultStyle(data) {
    let peak = 0
    for (const input of ['lateral', 'longitudinal']) {
      const series = data.series(input)
      if (!series) continue
      for (let i = 0; i < series.times.length; i += 10) {
        peak = Math.max(peak, Math.abs(data.valueAt(input, series.times[i]!) ?? 0))
      }
    }
    // Ignore single-sample spikes by capping at a sensible car range.
    const maxG = Math.min(2.5, Math.max(1, Math.ceil(peak * 2) / 2))
    return { maxG, accent: '#a78bfa', trailSeconds: 1, invertLateral: false, invertLongitudinal: false }
  },
  drawStatic(ctx, size, style) {
    const s = Math.min(size.width, size.height) / DESIGN
    const cx = size.width / 2
    const cy = size.height / 2
    ctx.fillStyle = PANEL_FILL
    ctx.beginPath()
    ctx.arc(cx, cy, 156 * s, 0, Math.PI * 2)
    ctx.fill()

    ctx.strokeStyle = 'rgba(255,255,255,0.22)'
    ctx.lineWidth = 2 * s
    ctx.fillStyle = MUTED
    ctx.font = font(13 * s, 600)
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    for (let g = 0.5; g <= style.maxG + 1e-9; g += 0.5) {
      const r = (g / style.maxG) * PLOT_RADIUS * s
      ctx.beginPath()
      ctx.arc(cx, cy, r, 0, Math.PI * 2)
      ctx.stroke()
      if (Number.isInteger(g)) ctx.fillText(`${g}g`, cx + r * 0.71 + 4 * s, cy - r * 0.71)
    }
    ctx.beginPath()
    ctx.moveTo(cx - PLOT_RADIUS * s, cy)
    ctx.lineTo(cx + PLOT_RADIUS * s, cy)
    ctx.moveTo(cx, cy - PLOT_RADIUS * s)
    ctx.lineTo(cx, cy + PLOT_RADIUS * s)
    ctx.stroke()
  },
  drawDynamic(ctx, size, style, data) {
    const s = Math.min(size.width, size.height) / DESIGN
    const cx = size.width / 2
    const cy = size.height / 2
    const scale = (PLOT_RADIUS * s) / style.maxG
    const sx = style.invertLateral ? -1 : 1
    const sy = style.invertLongitudinal ? -1 : 1
    const clampPoint = (lat: number, lon: number) => {
      const r = Math.hypot(lat, lon)
      const k = r > style.maxG * 1.1 ? (style.maxG * 1.1) / r : 1
      return { x: cx + sx * lat * k * scale, y: cy - sy * lon * k * scale }
    }

    const steps = Math.round(style.trailSeconds / TRAIL_STEP)
    for (let k = steps; k >= 1; k -= 1) {
      const t = data.time - k * TRAIL_STEP
      const lat = data.valueAt('lateral', t)
      const lon = data.valueAt('longitudinal', t)
      if (lat === null || lon === null) continue
      const p = clampPoint(lat, lon)
      ctx.globalAlpha = 0.5 * (1 - k / (steps + 1))
      ctx.fillStyle = style.accent
      ctx.beginPath()
      ctx.arc(p.x, p.y, 5 * s, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1

    const lat = data.value('lateral')
    const lon = data.value('longitudinal')
    if (lat === null || lon === null) return
    const p = clampPoint(lat, lon)
    ctx.fillStyle = style.accent
    ctx.strokeStyle = TEXT
    ctx.lineWidth = 2.5 * s
    ctx.beginPath()
    ctx.arc(p.x, p.y, 11 * s, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()

    ctx.fillStyle = TEXT
    ctx.font = font(22 * s, 700)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(`${Math.hypot(lat, lon).toFixed(2)} g`, cx, cy + 140 * s)
  },
}
