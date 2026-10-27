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

/** Default bindings: each input's canonical channel. */
export function defaultBindings(type: string): Record<string, string> {
  return Object.fromEntries(WIDGETS[type]!.inputs.map((input) => [input.name, input.channel]))
}

/** Style defaults derived from the bound data (e.g. a gauge's range). */
export function defaultStyleFor(
  type: string,
  session: TelemetrySession | null,
  bindings: Record<string, string>,
  units?: Record<string, string>,
): Record<string, unknown> {
  const data = createWidgetData(resolveInputs(session, bindings, units), 0, 'defaults', session?.laps)
  return WIDGETS[type]!.defaultStyle(data)
}

export function createWidget(
  type: string,
  session: TelemetrySession | null,
  rect: Rect,
  bindings?: Record<string, string>,
  style: Record<string, unknown> = {},
): WidgetInstance {
  if (!WIDGETS[type]) throw new Error(`Unknown widget type "${type}"`)
  const resolvedBindings = bindings ?? defaultBindings(type)
  return {
    id: crypto.randomUUID(),
    type,
    rect,
    bindings: resolvedBindings,
    style: { ...defaultStyleFor(type, session, resolvedBindings), ...style },
  }
}

const READOUT_CHANNELS: CanonicalChannelId[] = ['rpm', 'coolantTemp', 'oilPressure', 'oilTemp']

/**
 * A starting layout using whichever channels the session has: lap timer and
 * delta top-left, speed gauge and throttle bar bottom-left, up to three
 * readouts, track map top-right, g-meter bottom-right.
 */
export function createDefaultLayout(session: TelemetrySession, frameAspect: number): WidgetInstance[] {
  const has = (id: CanonicalChannelId) => findChannel(session, id) !== undefined
  const margin = 0.02
  const widgets: WidgetInstance[] = []

  let top = margin
  if (session.laps.length > 0) {
    widgets.push(createWidget('lapTimer', session, rectForHeight('lapTimer', frameAspect, 0.09, margin, top)))
    top += 0.09 + 0.008
  }
  if (has('speed') && session.laps.filter((lap) => lap.kind === 'timed').length > 1) {
    widgets.push(createWidget('delta', session, rectForHeight('delta', frameAspect, 0.09, margin, top)))
  }

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
