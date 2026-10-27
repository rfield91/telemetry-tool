import { bestLap, lapAt, type Lap } from '../laps/laps'
import { font, MUTED, roundedPanel, TEXT } from './draw'
import type { WidgetDefinition } from './types'

export interface LapTimerStyle {
  [key: string]: unknown
  accent: string
  decimals: number
  showBest: boolean
}

const DESIGN_H = 120

/** `m:ss.d` with 0–3 decimals. */
export function formatRunningTime(seconds: number, decimals: number): string {
  const scale = 10 ** decimals
  const total = Math.floor(seconds * scale) / scale
  const minutes = Math.floor(total / 60)
  const rest = total - minutes * 60
  const width = decimals > 0 ? 3 + decimals : 2
  return `${minutes}:${rest.toFixed(decimals).padStart(width, '0')}`
}

function lapName(lap: Lap): string {
  if (lap.kind === 'out') return 'OUT LAP'
  if (lap.kind === 'in') return 'IN LAP'
  return `LAP ${lap.loggerNumber ?? lap.index}`
}

/** Current lap number and running lap time, with the session's best lap. */
export const lapTimerWidget: WidgetDefinition<LapTimerStyle, Lap | null> = {
  type: 'lapTimer',
  label: 'Lap timer',
  inputs: [],
  aspect: 2.6,
  styleFields: [
    { key: 'accent', label: 'Colour', kind: 'color' },
    { key: 'decimals', label: 'Decimals', kind: 'number', min: 0, max: 3, step: 1 },
    { key: 'showBest', label: 'Show best lap', kind: 'toggle' },
  ],
  defaultStyle() {
    return { accent: '#f59e42', decimals: 1, showBest: true }
  },
  drawStatic(ctx, size, style, data) {
    const s = size.height / DESIGN_H
    roundedPanel(ctx, 0, 0, size.width, size.height, 16 * s)
    const best = bestLap(data.laps)
    if (style.showBest && best) {
      ctx.textBaseline = 'alphabetic'
      ctx.textAlign = 'right'
      ctx.fillStyle = MUTED
      ctx.font = font(17 * s, 600)
      ctx.fillText(`BEST ${formatRunningTime(best.duration, 3)}`, size.width - 20 * s, 34 * s)
    }
    return best
  },
  drawDynamic(ctx, size, style, data) {
    const s = size.height / DESIGN_H
    const lap = lapAt(data.laps, data.time)
    ctx.textBaseline = 'alphabetic'
    ctx.textAlign = 'left'
    ctx.fillStyle = style.accent
    ctx.font = font(18 * s, 700)
    ctx.fillText(lap ? lapName(lap) : 'LAP', 20 * s, 34 * s)
    ctx.fillStyle = TEXT
    ctx.font = font(54 * s, 700)
    ctx.fillText(lap ? formatRunningTime(data.time - lap.start, style.decimals) : '—', 20 * s, 100 * s)
  },
}
