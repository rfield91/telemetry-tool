export type TimestampUnit = 'auto' | 'seconds' | 'milliseconds' | 'microseconds'
export type ResolvedTimestampUnit = Exclude<TimestampUnit, 'auto'>

/**
 * What a logger's timestamps count from.
 * - `relative`: seconds since some session-local zero (e.g. AiM `Time`).
 * - `unix-utc`: Unix epoch on the UTC time scale.
 * - `unix-gps`: Unix epoch on the GPS time scale, which runs ahead of UTC by
 *   the leap seconds (Solostorm `GPS_TIME`).
 */
export type TimeClock = 'relative' | 'unix-utc' | 'unix-gps'

/** GPS time has been ahead of UTC by 18 s since 2017-01-01. */
export const GPS_UTC_OFFSET_SECONDS = 18

export const UNIT_TO_SECONDS: Record<ResolvedTimestampUnit, number> = {
  seconds: 1,
  milliseconds: 1e-3,
  microseconds: 1e-6,
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

/**
 * Infer whether timestamps are seconds, milliseconds or microseconds from
 * the median positive spacing (typical logger rates are 1–1000 Hz), falling
 * back to the overall span.
 */
export function inferTimestampUnit(timestamps: number[]): ResolvedTimestampUnit {
  if (timestamps.length === 0) return 'seconds'

  const sorted = [...timestamps].sort((a, b) => a - b)
  const span = sorted[sorted.length - 1]! - sorted[0]!

  const diffs: number[] = []
  for (let i = 1; i < sorted.length; i += 1) {
    const delta = sorted[i]! - sorted[i - 1]!
    if (delta > 0) diffs.push(delta)
  }
  if (diffs.length > 0) {
    diffs.sort((a, b) => a - b)
    const medianDelta = median(diffs)
    if (medianDelta >= 1000) return 'microseconds'
    if (medianDelta >= 1) return 'milliseconds'
    return 'seconds'
  }

  if (span >= 1e9) return 'microseconds'
  if (span >= 1e5) return 'milliseconds'
  return 'seconds'
}

export function resolveTimestampUnit(
  unit: TimestampUnit,
  rawTimestamps: number[],
): ResolvedTimestampUnit {
  return unit === 'auto' ? inferTimestampUnit(rawTimestamps) : unit
}

/** Map a unit label from a header or units row to a timestamp unit. */
export function timestampUnitFromLabel(label: string | null | undefined): TimestampUnit {
  const text = (label ?? '').trim().toLowerCase()
  if (text === 's' || text === 'sec' || text === 'seconds') return 'seconds'
  if (text === 'ms' || text === 'msec' || text === 'milliseconds') return 'milliseconds'
  if (text === 'us' || text === 'µs' || text === 'microseconds') return 'microseconds'
  return 'auto'
}

/** UTC epoch milliseconds for a timestamp in seconds on the given clock. */
export function toUtcMs(seconds: number, clock: TimeClock): number | null {
  if (clock === 'relative') return null
  const utcSeconds = clock === 'unix-gps' ? seconds - GPS_UTC_OFFSET_SECONDS : seconds
  return utcSeconds * 1000
}

/**
 * Guess the clock from the first timestamp: values that look like a Unix
 * epoch after 2001 are treated as UTC, anything smaller as relative.
 */
export function guessClock(firstSeconds: number): TimeClock {
  return firstSeconds > 1e9 ? 'unix-utc' : 'relative'
}
