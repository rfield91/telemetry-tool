import { CANONICAL_CHANNELS, type CanonicalChannelId } from '../data/channels'
import { findChannel, type TelemetrySession } from '../data/import'
import type { Rect, WidgetInstance } from '../project/schema'
import { createWidgetData, resolveInputs } from './data'
import { WIDGETS } from './registry'

/**
 * Rect for a widget of the given type, sized by its height as a fraction of
 * the frame (width follows the widget's aspect and the frame's aspect).
 */
export function rectForHeight(type: string, frameAspect: number, h: number, x: number, y: number): Rect {
  const w = (h * WIDGETS[type]!.aspect) / frameAspect
  return { x, y, w, h }
}

export function createWidget(
  type: string,
  session: TelemetrySession | null,
  rect: Rect,
  bindings?: Record<string, string>,
  style: Record<string, unknown> = {},
): WidgetInstance {
  const definition = WIDGETS[type]
  if (!definition) throw new Error(`Unknown widget type "${type}"`)
  const resolvedBindings = bindings ?? Object.fromEntries(definition.inputs.map((input) => [input.name, input.channel]))
  const data = createWidgetData(resolveInputs(session, resolvedBindings), 0, 'defaults')
  return {
    id: crypto.randomUUID(),
    type,
    rect,
    bindings: resolvedBindings,
    style: { ...definition.defaultStyle(data), ...style },
  }
}

const READOUT_CHANNELS: CanonicalChannelId[] = ['rpm', 'coolantTemp', 'oilPressure', 'oilTemp']

/**
 * A starting layout using whichever channels the session has: speed gauge
 * and throttle bar bottom-left, up to three readouts, track map top-right,
 * g-meter bottom-right.
 */
export function createDefaultLayout(session: TelemetrySession, frameAspect: number): WidgetInstance[] {
  const has = (id: CanonicalChannelId) => findChannel(session, id) !== undefined
  const margin = 0.02
  const widgets: WidgetInstance[] = []
  let x = margin

  if (has('speed')) {
    const rect = rectForHeight('gauge', frameAspect, 0.36, x, 1 - margin - 0.36)
    widgets.push(createWidget('gauge', session, rect, { value: 'speed' }, { label: 'SPEED' }))
    x += rect.w + 0.008
  }
  if (has('throttle')) {
    const rect = rectForHeight('bar', frameAspect, 0.3, x, 1 - margin - 0.3)
    widgets.push(createWidget('bar', session, rect, { value: 'throttle' }, { label: 'THROTTLE' }))
    x += rect.w + 0.008
  }
  const readouts = READOUT_CHANNELS.filter(has).slice(0, 3)
  readouts.forEach((channel, i) => {
    const h = 0.09
    const y = 1 - margin - (readouts.length - i) * (h + 0.008) + 0.008
    const accents = ['#fbbf24', '#fb7185', '#38bdf8']
    widgets.push(
      createWidget('readout', session, rectForHeight('readout', frameAspect, h, x, y), { value: channel }, {
        label: CANONICAL_CHANNELS[channel].label.toUpperCase(),
        accent: accents[i],
      }),
    )
  })

  if (has('latitude') && has('longitude')) {
    const rect = rectForHeight('trackMap', frameAspect, 0.32, 0, margin)
    rect.x = 1 - margin - rect.w
    widgets.push(createWidget('trackMap', session, rect))
  }
  if (has('lateralAccel') && has('longitudinalAccel')) {
    const rect = rectForHeight('gMeter', frameAspect, 0.32, 0, 1 - margin - 0.32)
    rect.x = 1 - margin - rect.w
    widgets.push(createWidget('gMeter', session, rect))
  }
  return widgets
}
