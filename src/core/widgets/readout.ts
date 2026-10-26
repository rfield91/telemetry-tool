import { font, formatValue, MUTED, roundedPanel, TEXT } from './draw'
import type { WidgetDefinition } from './types'

export interface ReadoutStyle {
  [key: string]: unknown
  label: string
  accent: string
  decimals: number
}

const DESIGN_H = 120

/** A single labelled number, e.g. coolant temperature. */
export const readoutWidget: WidgetDefinition<ReadoutStyle> = {
  type: 'readout',
  label: 'Readout',
  inputs: [{ name: 'value', label: 'Value', channel: 'coolantTemp' }],
  aspect: 2.4,
  defaultStyle() {
    return { label: 'VALUE', accent: '#fbbf24', decimals: 0 }
  },
  drawStatic(ctx, size, style, data) {
    const s = size.height / DESIGN_H
    roundedPanel(ctx, 0, 0, size.width, size.height, 16 * s)
    ctx.textBaseline = 'alphabetic'
    ctx.textAlign = 'left'
    ctx.fillStyle = style.accent
    ctx.font = font(18 * s, 700)
    ctx.fillText(style.label, 20 * s, 34 * s)
    ctx.textAlign = 'right'
    ctx.fillStyle = MUTED
    ctx.font = font(22 * s, 600)
    ctx.fillText(data.unit('value'), size.width - 20 * s, 98 * s)
  },
  drawDynamic(ctx, size, style, data) {
    const s = size.height / DESIGN_H
    ctx.textBaseline = 'alphabetic'
    ctx.textAlign = 'left'
    ctx.fillStyle = TEXT
    ctx.font = font(54 * s, 700)
    ctx.fillText(formatValue(data.value('value'), style.decimals), 20 * s, 100 * s)
  },
}
