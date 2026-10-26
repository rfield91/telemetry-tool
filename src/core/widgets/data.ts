import { CANONICAL_CHANNELS, isCanonicalChannelId } from '../data/channels'
import type { TelemetryChannel, TelemetrySession } from '../data/import'
import { sampleAt } from '../data/series'
import { convert, getUnit, UNITS } from '../data/units'
import type { Lap } from '../laps/laps'
import type { WidgetData } from './types'

export interface ResolvedInput {
  channel: TelemetryChannel
  /** Display unit id, or null when the channel's unit is unknown. */
  unit: string | null
  toDisplay(value: number): number
}

const knownUnit = (id: string | undefined) => !!id && UNITS.some((unit) => unit.id === id)

/** The chosen unit if it measures the same quantity, else the channel's default display unit. */
function displayUnit(channel: TelemetryChannel, chosen?: string): string | null {
  if (!channel.unit) return null
  const quantity = getUnit(channel.unit).quantity
  if (chosen && knownUnit(chosen) && getUnit(chosen).quantity === quantity) return chosen
  const preferred = channel.canonical ? CANONICAL_CHANNELS[channel.canonical].displayUnit : null
  if (preferred && getUnit(preferred).quantity === quantity) return preferred
  return channel.unit
}

/** The session channel a binding (canonical id or raw column key) refers to. */
export function findBoundChannel(session: TelemetrySession | null | undefined, binding: string): TelemetryChannel | undefined {
  return session?.channels.find((c) => (isCanonicalChannelId(binding) ? c.canonical === binding : c.key === binding))
}

/**
 * Resolve widget bindings (canonical ids or raw column keys) against a
 * session, with optional per-input display units. Unbound or missing inputs
 * resolve to null.
 */
export function resolveInputs(
  session: TelemetrySession | null,
  bindings: Record<string, string>,
  units: Record<string, string> = {},
): Record<string, ResolvedInput | null> {
  const resolved: Record<string, ResolvedInput | null> = {}
  for (const [input, binding] of Object.entries(bindings)) {
    const channel = findBoundChannel(session, binding)
    if (!channel) {
      resolved[input] = null
      continue
    }
    const unit = displayUnit(channel, units[input])
    const from = channel.unit
    resolved[input] = {
      channel,
      unit,
      toDisplay: from && unit && from !== unit ? (value) => convert(value, from, unit) : (value) => value,
    }
  }
  return resolved
}

export function createWidgetData(
  inputs: Record<string, ResolvedInput | null>,
  time: number,
  version: string,
  laps: readonly Lap[] = [],
): WidgetData {
  const valueAt = (input: string, at: number) => {
    const resolved = inputs[input]
    if (!resolved) return null
    const value = sampleAt(resolved.channel.series, at)
    return value === null ? null : resolved.toDisplay(value)
  }
  return {
    time,
    version,
    laps,
    value: (input) => valueAt(input, time),
    valueAt,
    unit: (input) => {
      const unit = inputs[input]?.unit
      return unit === 'rpm' ? 'RPM' : (unit ?? '')
    },
    series: (input) => inputs[input]?.channel.series ?? null,
  }
}
