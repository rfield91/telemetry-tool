import { describe, expect, it } from 'vitest'
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
