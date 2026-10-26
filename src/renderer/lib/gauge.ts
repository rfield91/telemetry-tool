import type { SeriesPoint } from './telemetry'

export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

export function gaugeFraction(value: number, min: number, max: number) {
  if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max)) {
    return 0
  }
  if (max <= min) return 0
  return clamp((value - min) / (max - min), 0, 1)
}

export function samplePoints(points: SeriesPoint[], time: number): number {
  if (points.length === 0) return 0
  const first = points[0]!
  const last = points[points.length - 1]!
  if (time <= first.time) return first.value
  if (time >= last.time) return last.value

  let low = 0
  let high = points.length - 1
  while (high - low > 1) {
    const middle = (low + high) >> 1
    if (points[middle]!.time <= time) low = middle
    else high = middle
  }

  const before = points[low]!
  const after = points[high]!
  const progress = (time - before.time) / (after.time - before.time)
  return before.value + (after.value - before.value) * progress
}

export function formatGaugeValue(value: number) {
  const absolute = Math.abs(value)
  if (absolute >= 100 || Number.isInteger(value)) {
    return Math.round(value).toLocaleString('en-US')
  }
  return value.toFixed(1)
}
