import { font, formatValue, fraction, MUTED, niceMax, niceStep, PANEL_FILL, TEXT, TRACK_FILL } from './draw'
import type { WidgetDefinition } from './types'

export interface GaugeStyle {
  [key: string]: unknown
  label: string
  min: number
  max: number
  accent: string
  decimals: number
}

const DESIGN = 320
const START = (150 * Math.PI) / 180
const SWEEP = (240 * Math.PI) / 180
const ARC_RADIUS = 118

function angleFor(value: number, style: GaugeStyle) {
  return START + SWEEP * fraction(value, style.min, style.max)
}

/** Round dial with a value arc, needle and digital readout. */
export const gaugeWidget: WidgetDefinition<GaugeStyle> = {
  type: 'gauge',
  label: 'Dial gauge',
  inputs: [{ name: 'value', label: 'Value', channel: 'speed' }],
  aspect: 1,
  styleFields: [
    { key: 'label', label: 'Label', kind: 'text' },
    { key: 'accent', label: 'Colour', kind: 'color' },
    { key: 'min', label: 'Minimum', kind: 'number' },
    { key: 'max', label: 'Maximum', kind: 'number' },
    { key: 'decimals', label: 'Decimals', kind: 'number', min: 0, max: 3, step: 1 },
  ],
  defaultStyle(data) {
    const series = data.series('value')
    let max = 0
    if (series) {
      for (let i = 0; i < series.times.length; i += 20) {
        max = Math.max(max, data.valueAt('value', series.times[i]!) ?? 0)
      }
    }
    return { label: 'SPEED', min: 0, max: niceMax(max * 1.05 || 100), accent: '#2dd4bf', decimals: 0 }
  },
  drawStatic(ctx, size, style, data) {
    const s = Math.min(size.width, size.height) / DESIGN
    const cx = size.width / 2
    const cy = size.height / 2
    ctx.fillStyle = PANEL_FILL
    ctx.beginPath()
    ctx.arc(cx, cy, 156 * s, 0, Math.PI * 2)
    ctx.fill()

    ctx.lineCap = 'round'
    ctx.lineWidth = 14 * s
    ctx.strokeStyle = TRACK_FILL
    ctx.beginPath()
    ctx.arc(cx, cy, ARC_RADIUS * s, START, START + SWEEP)
    ctx.stroke()

    const step = niceStep(style.max - style.min)
    ctx.strokeStyle = 'rgba(255,255,255,0.75)'
    ctx.fillStyle = MUTED
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = font(17 * s, 600)
    for (let v = style.min, i = 0; v <= style.max + 1e-9; v += step / 2, i += 1) {
      const major = i % 2 === 0
      const a = angleFor(v, style)
      const outer = 146 * s
      const inner = (major ? 130 : 137) * s
      ctx.lineWidth = (major ? 3 : 2) * s
      ctx.beginPath()
      ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner)
      ctx.lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer)
      ctx.stroke()
      if (major) {
        const r = 94 * s
        ctx.fillText(formatValue(v, step < 1 ? 1 : 0), cx + Math.cos(a) * r, cy + Math.sin(a) * r)
      }
    }

    ctx.fillStyle = MUTED
    ctx.font = font(18 * s, 600)
    ctx.fillText(style.label, cx, cy - 48 * s)
    ctx.font = font(17 * s, 500)
    ctx.fillText(data.unit('value'), cx, cy + 100 * s)
  },
  drawDynamic(ctx, size, style, data) {
    const s = Math.min(size.width, size.height) / DESIGN
    const cx = size.width / 2
    const cy = size.height / 2
    const value = data.value('value')
    const a = angleFor(value ?? style.min, style)

    ctx.lineCap = 'round'
    ctx.lineWidth = 14 * s
    ctx.strokeStyle = style.accent
    ctx.beginPath()
    ctx.arc(cx, cy, ARC_RADIUS * s, START, Math.max(a, START + 0.001))
    ctx.stroke()

    ctx.strokeStyle = TEXT
    ctx.lineWidth = 5 * s
    ctx.beginPath()
    ctx.moveTo(cx + Math.cos(a) * 20 * s, cy + Math.sin(a) * 20 * s)
    ctx.lineTo(cx + Math.cos(a) * 112 * s, cy + Math.sin(a) * 112 * s)
    ctx.stroke()
    ctx.fillStyle = TEXT
    ctx.beginPath()
    ctx.arc(cx, cy, 9 * s, 0, Math.PI * 2)
    ctx.fill()

    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = font(60 * s, 700)
    ctx.fillText(formatValue(value, style.decimals), cx, cy + 62 * s)
  },
}
