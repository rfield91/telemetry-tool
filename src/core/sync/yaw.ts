import { findChannel, type TelemetrySession } from '../data/import'
import { projectToLocal } from '../data/gps'
import { sampleAt } from '../data/series'
import type { Signal } from './engine'

// GPS-course fallback tuning, chosen on the NER and SVT sessions: r ≈ 0.87–0.89
// and offsets ~0.08 s behind the gyro (GPS latency).
const COURSE_MIN_STEP_M = 2
const COURSE_SMOOTHING = 4

export interface LoggerYaw {
  signal: Signal
  /** e.g. "gyro yaw rate", "GPS heading". */
  source: string
  /** GPS-derived yaw lags the vehicle by tens of milliseconds. */
  gpsDerived: boolean
}

/** Rate of change of an angle (radians), unwrapped and smoothed over ±`halfWindow` samples. */
function angleRate(times: ArrayLike<number>, radians: ArrayLike<number>, halfWindow = 2): Signal {
  const outTimes: number[] = []
  const rates: number[] = []
  for (let i = 1; i < times.length; i += 1) {
    const dt = times[i]! - times[i - 1]!
    if (!(dt > 0)) continue
    let d = radians[i]! - radians[i - 1]!
    if (d > Math.PI) d -= 2 * Math.PI
    if (d < -Math.PI) d += 2 * Math.PI
    outTimes.push((times[i]! + times[i - 1]!) / 2)
    rates.push(d / dt)
  }
  // Moving average: GPS-derived angles are noisy sample to sample.
  const smoothed = rates.map((_, i) => {
    let sum = 0
    let count = 0
    for (let j = Math.max(0, i - halfWindow); j <= Math.min(rates.length - 1, i + halfWindow); j += 1) {
      sum += rates[j]!
      count += 1
    }
    return sum / count
  })
  return { times: outTimes, values: smoothed }
}

/**
 * The logger's yaw-rate signal for sync: the gyro channel when present,
 * else derived from GPS heading, else from the GPS course (lat/lon).
 */
export function loggerYaw(session: TelemetrySession): LoggerYaw | null {
  const gyro = findChannel(session, 'yawRate')
  if (gyro && gyro.series.times.length > 10) {
    return { signal: gyro.series, source: 'gyro yaw rate', gpsDerived: false }
  }

  const heading = findChannel(session, 'heading')
  if (heading && heading.series.times.length > 10) {
    const radians = Array.from(heading.series.values, (deg) => (deg * Math.PI) / 180)
    return { signal: angleRate(heading.series.times, radians), source: 'GPS heading', gpsDerived: true }
  }

  const lat = findChannel(session, 'latitude')
  const lon = findChannel(session, 'longitude')
  if (lat && lon && lat.series.times.length > 10) {
    const times = lat.series.times
    const lons = Array.from(times, (t) => sampleAt(lon.series, t) ?? NaN)
    const local = projectToLocal(lat.series.values, lons)
    // Course over ground between points at least MIN_STEP apart. Loggers
    // store coordinates to ~0.1 m, so short steps are mostly rounding noise.
    const courseTimes: number[] = []
    const courses: number[] = []
    let last = 0
    for (let i = 1; i < times.length; i += 1) {
      const dx = local.x[i]! - local.x[last]!
      const dy = local.y[i]! - local.y[last]!
      if (!Number.isFinite(dx) || Math.hypot(dx, dy) < COURSE_MIN_STEP_M) continue
      courseTimes.push((times[i]! + times[last]!) / 2)
      courses.push(Math.atan2(dx, dy))
      last = i
    }
    if (courses.length > 10) {
      return { signal: angleRate(courseTimes, courses, COURSE_SMOOTHING), source: 'GPS course', gpsDerived: true }
    }
  }
  return null
}
