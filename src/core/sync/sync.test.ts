import { describe, expect, it } from 'vitest'
import nerCsv from '../../../sample-data/solostorm/ner-autocross-lap7.csv?raw'
import svtCsv from '../../../sample-data/solostorm/svt-canaan-lap37.csv?raw'
import svtSessionCsv from '../../../sample-data/solostorm/svt-canaan-session.csv?raw'
import nerYawBase64 from '../../../sample-data/sync/ner-camera-yaw.b64?raw'
import nerYawMeta from '../../../sample-data/sync/ner-camera-yaw.json'
import svtYawBase64 from '../../../sample-data/sync/svt-camera-yaw.b64?raw'
import svtYawMeta from '../../../sample-data/sync/svt-camera-yaw.json'
import { findChannel, importTelemetry, type TelemetrySession } from '../data/import'
import { fromBase64 } from '../media/testing'
import { correlationByLag, resample, synchronize, type Signal } from './engine'
import { crossCorrelate } from './fft'
import { loggerYaw } from './yaw'

/** Camera yaw fixtures: int16 (rad/s × scale) at a fixed rate from t = 0; gaps are left out. */
function cameraYaw(base64: string, meta: { hz: number; scale: number; missing: number }): Signal {
  const bytes = fromBase64(base64)
  const ints = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2)
  const times: number[] = []
  const values: number[] = []
  ints.forEach((v, i) => {
    if (v === meta.missing) return
    times.push(i / meta.hz)
    values.push(v / meta.scale)
  })
  return { times, values }
}

describe('crossCorrelate', () => {
  it('matches a direct computation', () => {
    const a = Float64Array.from([1, -2, 3])
    const b = Float64Array.from([0.5, 4, -1, 2])
    const fast = crossCorrelate(a, b)
    for (let lag = -2; lag < 4; lag += 1) {
      let direct = 0
      for (let i = 0; i < 3; i += 1) if (i + lag >= 0 && i + lag < 4) direct += a[i]! * b[i + lag]!
      expect(fast[lag + 2]).toBeCloseTo(direct, 9)
    }
  })
})

describe('correlationByLag', () => {
  it('finds a known shift in a synthetic signal', () => {
    const base = Float64Array.from({ length: 2000 }, (_, i) => Math.sin(i / 17) + 0.5 * Math.sin(i / 5.3))
    const logger = base.slice(300, 1300)
    const r = correlationByLag(logger, base, 800)
    let best = -1
    for (let i = 0; i < r.length; i += 1) if (!Number.isNaN(r[i]) && (best < 0 || r[i]! > r[best]!)) best = i
    expect(best - (logger.length - 1)).toBe(300)
    expect(r[best]).toBeCloseTo(1, 9)
  })

  it('resamples onto a uniform grid', () => {
    expect(Array.from(resample({ times: [0, 0.04, 0.1], values: [0, 4, 10] }, 50))).toEqual([0, 2, 4, 6, 8, 10])
  })

  it('marks long gaps as missing instead of interpolating across them', () => {
    const grid = Array.from(resample({ times: [0, 0.02, 1.02, 1.04], values: [1, 1, 5, 5] }, 50))
    expect(grid.slice(0, 2)).toEqual([1, 1])
    expect(grid.slice(2, 51).every(Number.isNaN)).toBe(true)
    expect(grid.slice(51)).toEqual([5, 5])
  })

  it('ignores missing samples when correlating', () => {
    const base = Float64Array.from({ length: 1500 }, (_, i) => Math.sin(i / 13) + 0.4 * Math.sin(i / 4.1))
    const camera = base.map((v, i) => (i > 600 && i < 800 ? NaN : v))
    const logger = base.slice(200, 1200)
    const r = correlationByLag(logger, camera, 600)
    expect(r[200 + logger.length - 1]).toBeCloseTo(1, 9)
  })
})

describe('synchronize (real sessions)', () => {
  it('NER autocross: one run in one video', () => {
    const session = importTelemetry(nerCsv, 'ner.csv')
    const result = synchronize(loggerYaw(session)!.signal, cameraYaw(nerYawBase64, nerYawMeta))!
    // Camera-IMU result from spike/auto-sync: 29.146 s.
    expect(result.offset).toBeCloseTo(29.146, 1)
    expect(Math.abs(result.offset - 29.146)).toBeLessThan(0.02)
    expect(Math.abs(result.correlation)).toBeGreaterThan(0.95)
    expect(result.confidence).toBe('high')
    expect(result.separation.by).toBe('peak')
    expect(result.precision!).toBeLessThan(0.02)
  })

  it('SVT Canaan: finds the exported lap among the session’s laps', () => {
    const session = importTelemetry(svtCsv, 'svt.csv')
    const result = synchronize(loggerYaw(session)!.signal, cameraYaw(svtYawBase64, svtYawMeta))!
    // spike/auto-sync lapSync: lap starts at 4:14.69 (254.693 s).
    expect(Math.abs(result.offset - 254.693)).toBeLessThan(0.02)
    expect(result.separation.by).toBe('half-drift')
    expect(Math.abs(result.candidates[0]!.halfDrift!)).toBeLessThan(0.05)
    // The neighbouring lap correlates almost as well but drifts.
    const neighbour = result.candidates.find((c) => Math.abs(c.offset - 192.46) < 1)!
    expect(Math.abs(neighbour.correlation)).toBeGreaterThan(0.9)
    expect(Math.abs(neighbour.halfDrift!)).toBeGreaterThan(0.3)
    expect(result.confidence).toBe('high')
  })

  it('SVT Canaan full session: syncs once and places every lap', () => {
    const session = importTelemetry(svtSessionCsv, 'svt-session.csv')
    expect(session.laps.map((lap) => lap.loggerNumber)).toEqual([35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46])
    const result = synchronize(loggerYaw(session)!.signal, cameraYaw(svtYawBase64, svtYawMeta))!
    // Lap 37 must land where the single-lap export puts it (254.693 s).
    const lap37 = session.laps.find((lap) => lap.loggerNumber === 37)!
    const lap37InVideo = result.offset + lap37.start * (1 + result.drift)
    expect(Math.abs(lap37InVideo - 254.693)).toBeLessThan(0.01)
    expect(Math.abs(result.correlation)).toBeGreaterThan(0.95)
    expect(result.coverage).toBeGreaterThan(0.9)
    // The logger clock runs ~46 ppm fast relative to the camera.
    expect(result.drift * 1e6).toBeGreaterThan(20)
    expect(result.drift * 1e6).toBeLessThan(80)
    expect(result.confidence).toBe('high')
  })

  it('ignores a stretch of bad camera data', () => {
    const session = importTelemetry(nerCsv, 'ner.csv')
    const camera = cameraYaw(nerYawBase64, nerYawMeta)
    // Flip the sign of 15 s of camera motion in the middle of the run, as
    // the stray DJI orientation stream does.
    const values = Array.from(camera.values, (v, i) => {
      const t = camera.times[i]!
      return t > 60 && t < 75 ? -v : v
    })
    const result = synchronize(loggerYaw(session)!.signal, { times: camera.times, values })!
    expect(Math.abs(result.offset - 29.146)).toBeLessThan(0.02)
    expect(result.coverage).toBeLessThan(0.9)
    expect(result.coverage).toBeGreaterThan(0.6)
    expect(Math.abs(result.correlation)).toBeGreaterThan(0.95)
  })

  it('returns null when there is too little data', () => {
    expect(synchronize({ times: [0, 1], values: [0, 1] }, { times: [0, 1], values: [1, 0] })).toBeNull()
  })
})

describe('loggerYaw', () => {
  const session = importTelemetry(nerCsv, 'ner.csv')

  it('prefers the gyro channel', () => {
    expect(loggerYaw(session)?.source).toBe('gyro yaw rate')
  })

  function without(...ids: string[]): TelemetrySession {
    return { ...session, channels: session.channels.filter((c) => !c.canonical || !ids.includes(c.canonical)) }
  }

  it('falls back to GPS heading, then GPS course, and still syncs', () => {
    const camera = cameraYaw(nerYawBase64, nerYawMeta)
    const heading = loggerYaw(without('yawRate'))!
    expect(heading.source).toBe('GPS heading')
    expect(Math.abs(synchronize(heading.signal, camera)!.offset - 29.146)).toBeLessThan(0.1)

    const course = loggerYaw(without('yawRate', 'heading'))!
    expect(course.source).toBe('GPS course')
    expect(Math.abs(synchronize(course.signal, camera)!.offset - 29.146)).toBeLessThan(0.15)
  })

  it('returns null without yaw, heading or GPS', () => {
    expect(loggerYaw(without('yawRate', 'heading', 'latitude', 'longitude'))).toBeNull()
    expect(findChannel(session, 'yawRate')).toBeDefined()
  })
})
