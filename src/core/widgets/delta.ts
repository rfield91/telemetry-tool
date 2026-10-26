import { createDeltaModel, type DeltaModel } from '../laps/delta'
import { font, MUTED, roundedPanel, TRACK_FILL } from './draw'
import type { WidgetDefinition } from './types'

export interface DeltaStyle {
  [key: string]: unknown
  label: string
  fasterColor: string
  slowerColor: string
  /** Seconds at which the bar is full. */
  range: number
  decimals: number
}

const DESIGN_H = 120
const BAR = { y: 92, height: 12, inset: 20 }

/** Time gained or lost against the best lap, as a number and a centred bar. */
export const deltaWidget: WidgetDefinition<DeltaStyle, DeltaModel | null> = {
  type: 'delta',
  label: 'Delta to best',
  inputs: [{ name: 'speed', label: 'Speed', channel: 'speed' }],
  aspect: 2.6,
  styleFields: [
    { key: 'label', label: 'Label', kind: 'text' },
    { key: 'fasterColor', label: 'Ahead colour', kind: 'color' },
    { key: 'slowerColor', label: 'Behind colour', kind: 'color' },
    { key: 'range', label: 'Bar range (s)', kind: 'number', min: 0.1, max: 10, step: 0.1 },
    { key: 'decimals', label: 'Decimals', kind: 'number', min: 1, max: 3, step: 1 },
  ],
  defaultStyle() {
    return { label: 'DELTA', fasterColor: '#4ade80', slowerColor: '#f87171', range: 1, decimals: 2 }
  },
  drawStatic(ctx, size, style, data) {
    const s = size.height / DESIGN_H
    roundedPanel(ctx, 0, 0, size.width, size.height, 16 * s)
    ctx.textBaseline = 'alphabetic'
    ctx.textAlign = 'left'
    ctx.fillStyle = MUTED
    ctx.font = font(18 * s, 700)
    ctx.fillText(style.label, 20 * s, 34 * s)

    const x = BAR.inset * s
    const w = size.width - 2 * BAR.inset * s
    ctx.fillStyle = TRACK_FILL
    ctx.beginPath()
    ctx.roundRect(x, BAR.y * s, w, BAR.height * s, (BAR.height / 2) * s)
    ctx.fill()
    ctx.fillStyle = 'rgba(255,255,255,0.7)'
    ctx.fillRect(size.width / 2 - 1.5 * s, (BAR.y - 4) * s, 3 * s, (BAR.height + 8) * s)

    const speed = data.series('speed')
    return speed ? createDeltaModel(speed, data.laps) : null
  },
  drawDynamic(ctx, size, style, data, model) {
    const s = size.height / DESIGN_H
    const delta = model?.at(data.time) ?? null
    ctx.textBaseline = 'alphabetic'
    ctx.textAlign = 'right'
    ctx.font = font(48 * s, 700)
    if (delta === null) {
      ctx.fillStyle = MUTED
      ctx.fillText('—', size.width - 20 * s, 74 * s)
      return
    }
    const color = delta <= 0 ? style.fasterColor : style.slowerColor
    const text = `${delta < 0 ? '−' : '+'}${Math.abs(delta).toFixed(style.decimals)}`
    ctx.fillStyle = color
    ctx.fillText(text, size.width - 20 * s, 74 * s)

    const half = size.width / 2 - BAR.inset * s
    const length = Math.min(1, Math.abs(delta) / (style.range > 0 ? style.range : 1)) * half
    if (length < 0.5) return
    // Ahead fills to the left of centre, behind to the right.
    const x = delta <= 0 ? size.width / 2 - length : size.width / 2
    ctx.beginPath()
    ctx.roundRect(x, BAR.y * s, length, BAR.height * s, (BAR.height / 2) * s)
    ctx.fill()
  },
}
