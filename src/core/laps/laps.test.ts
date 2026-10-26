import { describe, expect, it } from 'vitest'
import svtSession from '../../../sample-data/solostorm/svt-canaan-session.csv?raw'
import { findChannel, importTelemetry } from '../data/import'
import { createDeltaModel, cumulativeDistance } from './delta'
import { bestLap, formatLapTime, lapAt, lapsFromBoundaries, lapsFromLapNumbers } from './laps'

describe('lapsFromBoundaries', () => {
  it('marks the first lap out and the last in when there are several', () => {
    const laps = lapsFromBoundaries([0, 100, 160, 219, 400])
    expect(laps.map((lap) => [lap.kind, lap.duration])).toEqual([
      ['out', 100],
      ['timed', 60],
      ['timed', 59],
      ['in', 181],
    ])
    expect(bestLap(laps)?.index).toBe(3)
  })

  it('treats a single segment as one timed lap', () => {
    expect(lapsFromBoundaries([0, 61.8])).toMatchObject([{ index: 1, kind: 'timed', duration: 61.8 }])
  })
})

describe('lapsFromLapNumbers', () => {
  it('splits rows where the lap counter changes', () => {
    const times = [0, 1, 2, 3, 4, 5, 6]
    const numbers = [3, 3, 4, 4, 4, 5, 5]
    const laps = lapsFromLapNumbers(times, numbers)
    expect(laps.map((lap) => [lap.loggerNumber, lap.start, lap.end, lap.kind])).toEqual([
      [3, 0, 2, 'out'],
      [4, 2, 5, 'timed'],
      [5, 5, 6, 'in'],
    ])
    expect(lapAt(laps, 2.5)?.loggerNumber).toBe(4)
  })
})

describe('formatLapTime', () => {
  it('formats m:ss.SSS', () => {
    expect(formatLapTime(61.831)).toBe('1:01.831')
    expect(formatLapTime(77.02)).toBe('1:17.020')
    expect(formatLapTime(9.5)).toBe('0:09.500')
  })
})

describe('createDeltaModel', () => {
  const session = importTelemetry(svtSession, 'svt-canaan-session.csv')
  const speed = findChannel(session, 'speed')!.series
  const model = createDeltaModel(speed, session.laps)!

  it('is zero on the best lap and the lap-time difference at the line', () => {
    expect(model.best.loggerNumber).toBe(37)
    for (let t = model.best.start + 1; t < model.best.end; t += 7) expect(model.at(t)).toBeCloseTo(0, 6)
    for (const lap of session.laps.filter((l) => l.kind === 'timed' && l !== model.best)) {
      expect(model.at(lap.end - 1e-6)!).toBeCloseTo(lap.duration - model.best.duration, 2)
      // Nearly level at the start of the lap.
      expect(Math.abs(model.at(lap.start + 0.05)!)).toBeLessThan(0.1)
    }
  })

  it('is null outside timed laps', () => {
    const out = session.laps.find((lap) => lap.kind === 'out')!
    expect(model.at(out.start + 1)).toBeNull()
    expect(model.at(-5)).toBeNull()
  })

  it('integrates speed into distance', () => {
    const series = { times: new Float64Array([0, 1, 2, 3]), values: new Float64Array([10, 10, 20, 20]) }
    expect(Array.from(cumulativeDistance(series))).toEqual([0, 10, 25, 45])
  })
})
