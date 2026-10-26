import { font, formatValue, fraction, MUTED, roundedPanel, TEXT, TRACK_FILL } from './draw'
import type { WidgetDefinition } from './types'

export interface BarStyle {
  [key: string]: unknown
  label: string
  min: number
  max: number
  accent: string
  decimals: number
}

const DESIGN_H = 320
const TRACK = { top: 20, bottom: 236, width: 46 }

/** Vertical fill bar, e.g. throttle or brake. */
export const barWidget: WidgetDefinition<BarStyle> = {
  type: 'bar',
  label: 'Bar',
  inputs: [{ name: 'value', label: 'Value', channel: 'throttle' }],
  aspect: 0.38,
  defaultStyle() {
    return { label: 'THROTTLE', min: 0, max: 100, accent: '#22c55e', decimals: 0 }
  },
  drawStatic(ctx, size, style) {
    const s = size.height / DESIGN_H
    roundedPanel(ctx, 0, 0, size.width, size.height, 16 * s)
    ctx.fillStyle = TRACK_FILL
    ctx.beginPath()
    ctx.roundRect((size.width - TRACK.width * s) / 2, TRACK.top * s, TRACK.width * s, (TRACK.bottom - TRACK.top) * s, 10 * s)
    ctx.fill()
    ctx.fillStyle = MUTED
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = font(15 * s, 600)
    ctx.fillText(style.label, size.width / 2, 300 * s)
  },
  drawDynamic(ctx, size, style, data) {
    const s = size.height / DESIGN_H
    const value = data.value('value')
    const f = fraction(value ?? style.min, style.min, style.max)
    const trackH = (TRACK.bottom - TRACK.top) * s
    const fillH = trackH * f
    if (fillH > 0.5) {
      ctx.fillStyle = style.accent
      ctx.beginPath()
      ctx.roundRect((size.width - TRACK.width * s) / 2, TRACK.bottom * s - fillH, TRACK.width * s, fillH, 10 * s)
      ctx.fill()
    }
    ctx.fillStyle = TEXT
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = font(22 * s, 700)
    const unit = data.unit('value')
    ctx.fillText(`${formatValue(value, style.decimals)}${unit === '%' ? '%' : ''}`, size.width / 2, 268 * s)
  },
}
