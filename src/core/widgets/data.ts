import { CANONICAL_CHANNELS, isCanonicalChannelId } from '../data/channels'
import type { TelemetryChannel, TelemetrySession } from '../data/import'
import { sampleAt } from '../data/series'
import { convert, getUnit } from '../data/units'
import type { WidgetData } from './types'

export interface ResolvedInput {
  channel: TelemetryChannel
  /** Display unit id, or null when the channel's unit is unknown. */
  unit: string | null
  toDisplay(value: number): number
}

function displayUnit(channel: TelemetryChannel): string | null {
  const preferred = channel.canonical ? CANONICAL_CHANNELS[channel.canonical].displayUnit : null
  if (!channel.unit) return null
  if (preferred && getUnit(preferred).quantity === getUnit(channel.unit).quantity) return preferred
  return channel.unit
}

/**
 * Resolve widget bindings (canonical ids or raw column keys) against a
 * session. Unbound or missing inputs resolve to null.
 */
export function resolveInputs(
  session: TelemetrySession | null,
  bindings: Record<string, string>,
): Record<string, ResolvedInput | null> {
  const resolved: Record<string, ResolvedInput | null> = {}
  for (const [input, binding] of Object.entries(bindings)) {
    const channel = session?.channels.find((c) =>
      isCanonicalChannelId(binding) ? c.canonical === binding : c.key === binding,
    )
    if (!channel) {
      resolved[input] = null
      continue
    }
    const unit = displayUnit(channel)
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
    value: (input) => valueAt(input, time),
    valueAt,
    unit: (input) => {
      const unit = inputs[input]?.unit
      return unit === 'rpm' ? 'RPM' : (unit ?? '')
    },
    series: (input) => inputs[input]?.channel.series ?? null,
  }
}
