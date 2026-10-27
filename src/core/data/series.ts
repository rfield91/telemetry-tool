/** A time series in session seconds (time zero = first valid timestamp). */
export interface Series {
  times: Float64Array
  values: Float64Array
}

export interface SeriesStats {
  accepted: number
  /** Rows skipped for a missing/invalid time or value. */
  invalid: number
  /** Rows dropped because an earlier row had the same time (last wins). */
  duplicates: number
}

/**
 * Build a sorted series from per-row times and values. Rows with a
 * non-finite time or value are skipped; duplicate times keep the last value.
 */
export function buildSeries(
  rowTimes: ArrayLike<number>,
  rowValues: ArrayLike<number>,
): { series: Series; stats: SeriesStats } {
  const order: number[] = []
  let invalid = 0
  for (let i = 0; i < rowTimes.length; i += 1) {
    if (Number.isFinite(rowTimes[i]) && Number.isFinite(rowValues[i])) order.push(i)
    else invalid += 1
  }
  // Stable sort keeps file order among equal times, so "last wins" holds.
  order.sort((a, b) => rowTimes[a]! - rowTimes[b]!)

  const times: number[] = []
  const values: number[] = []
  let duplicates = 0
  for (const i of order) {
    const t = rowTimes[i]!
    if (times.length > 0 && times[times.length - 1] === t) {
      values[values.length - 1] = rowValues[i]!
      duplicates += 1
      continue
    }
    times.push(t)
    values.push(rowValues[i]!)
  }

  return {
    series: { times: Float64Array.from(times), values: Float64Array.from(values) },
    stats: { accepted: times.length, invalid, duplicates },
  }
}

/**
 * Linearly interpolate at `time`. Times outside the series clamp to the
 * first/last value. Returns null for an empty series.
 */
export function sampleAt(series: Series, time: number): number | null {
  const { times, values } = series
  const n = times.length
  if (n === 0) return null
  if (time <= times[0]!) return values[0]!
  if (time >= times[n - 1]!) return values[n - 1]!

  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (times[mid]! <= time) lo = mid
    else hi = mid
  }
  const t = (time - times[lo]!) / (times[hi]! - times[lo]!)
  return values[lo]! + t * (values[hi]! - values[lo]!)
}

export function seriesRange(series: Series): { min: number; max: number } | null {
  if (series.values.length === 0) return null
  let min = Infinity
  let max = -Infinity
  for (const value of series.values) {
    if (value < min) min = value
    if (value > max) max = value
  }
  return { min, max }
}

export function seriesDuration(series: Series): number {
  const n = series.times.length
  return n === 0 ? 0 : series.times[n - 1]! - series.times[0]!
}
