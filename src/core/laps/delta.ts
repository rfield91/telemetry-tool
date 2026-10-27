import type { Series } from '../data/series'
import { bestLap, lapAt, type Lap } from './laps'

/**
 * Time gained or lost against the best lap at the same point of the lap.
 * Distance comes from integrating speed (m/s); each lap's distance is scaled
 * to the best lap's length, so slightly different lines still compare
 * point for point.
 */
export interface DeltaModel {
  best: Lap
  /** Seconds behind the best lap (negative = ahead), or null outside timed laps. */
  at(time: number): number | null
}

/** Cumulative distance (m) at each speed sample, by trapezoid integration. */
export function cumulativeDistance(speed: Series): Float64Array {
  const distance = new Float64Array(speed.times.length)
  for (let i = 1; i < speed.times.length; i += 1) {
    const dt = speed.times[i]! - speed.times[i - 1]!
    const v = (Math.max(0, speed.values[i]!) + Math.max(0, speed.values[i - 1]!)) / 2
    distance[i] = distance[i - 1]! + (Number.isFinite(v) ? v * dt : 0)
  }
  return distance
}

/** Linear interpolation of ys at x over ascending xs, clamped at the ends. */
function interpolate(xs: ArrayLike<number>, ys: ArrayLike<number>, x: number): number {
  const n = xs.length
  if (x <= xs[0]!) return ys[0]!
  if (x >= xs[n - 1]!) return ys[n - 1]!
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (xs[mid]! <= x) lo = mid
    else hi = mid
  }
  const span = xs[hi]! - xs[lo]!
  return span > 0 ? ys[lo]! + ((ys[hi]! - ys[lo]!) * (x - xs[lo]!)) / span : ys[lo]!
}

export function createDeltaModel(speed: Series, laps: readonly Lap[]): DeltaModel | null {
  const best = bestLap(laps)
  if (!best || speed.times.length < 2) return null
  const distance = cumulativeDistance(speed)
  const distanceAt = (time: number) => interpolate(speed.times, distance, time)
  const lapLength = (lap: Lap) => distanceAt(lap.end) - distanceAt(lap.start)
  const bestLength = lapLength(best)
  if (!(bestLength > 0)) return null

  // Best lap: elapsed time by distance into the lap (distance is non-decreasing).
  const refDistance: number[] = [0]
  const refTime: number[] = [0]
  const startDistance = distanceAt(best.start)
  for (let i = 0; i < speed.times.length; i += 1) {
    const t = speed.times[i]!
    if (t <= best.start || t >= best.end) continue
    const d = distance[i]! - startDistance
    if (d > refDistance[refDistance.length - 1]!) {
      refDistance.push(d)
      refTime.push(t - best.start)
    }
  }
  refDistance.push(bestLength)
  refTime.push(best.duration)

  const lengths = new Map<Lap, number>()
  return {
    best,
    at(time) {
      const lap = lapAt(laps, time)
      if (!lap || lap.kind !== 'timed') return null
      let length = lengths.get(lap)
      if (length === undefined) {
        length = lapLength(lap)
        lengths.set(lap, length)
      }
      if (!(length > 0)) return null
      const into = ((distanceAt(time) - distanceAt(lap.start)) / length) * bestLength
      return time - lap.start - interpolate(refDistance, refTime, into)
    },
  }
}
