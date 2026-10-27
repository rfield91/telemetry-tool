import { describe, expect, it } from 'vitest'
import { buildSeries, sampleAt, seriesRange } from './series'

describe('buildSeries', () => {
  it('skips invalid rows and sorts by time', () => {
    const { series, stats } = buildSeries([15, NaN, 5, 10, 20], [3000, 1, 1000, 2000, NaN])
    expect(Array.from(series.times)).toEqual([5, 10, 15])
    expect(Array.from(series.values)).toEqual([1000, 2000, 3000])
    expect(stats).toEqual({ accepted: 3, invalid: 2, duplicates: 0 })
  })

  it('keeps the last value when timestamps duplicate', () => {
    const { series, stats } = buildSeries([0, 1, 1, 2], [1000, 2000, 2500, 3000])
    expect(Array.from(series.values)).toEqual([1000, 2500, 3000])
    expect(stats.duplicates).toBe(1)
  })
})

describe('sampleAt', () => {
  const { series } = buildSeries([0, 1, 2], [1000, 2000, 3000])

  it('linearly interpolates between samples', () => {
    expect(sampleAt(series, 0.5)).toBe(1500)
    expect(sampleAt(series, 1.25)).toBe(2250)
  })

  it('clamps outside the series range', () => {
    expect(sampleAt(series, -1)).toBe(1000)
    expect(sampleAt(series, 99)).toBe(3000)
  })

  it('returns null for an empty series', () => {
    const empty = buildSeries([], []).series
    expect(sampleAt(empty, 0)).toBeNull()
    expect(seriesRange(empty)).toBeNull()
  })
})
