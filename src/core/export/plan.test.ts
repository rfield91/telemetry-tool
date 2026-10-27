import { describe, expect, it } from 'vitest'
import { lapsFromBoundaries } from '../laps/laps'
import { autoBitrate, estimateRemaining, exportSegments, mergeSegments, outputSize, packAtlas, resolutionChoices } from './plan'

describe('exportSegments', () => {
  const laps = lapsFromBoundaries([0, 100, 160, 219, 280, 400])
  const toVideo = (t: number) => 50 + t * 1.0001

  it('exports the whole video when no laps are selected', () => {
    expect(exportSegments(laps, null, toVideo, 900)).toEqual([{ start: 0, end: 900 }])
    expect(exportSegments(laps, { telemetryId: 't', laps: [], leadInSeconds: 2, leadOutSeconds: 2 }, toVideo, 900)).toEqual([
      { start: 0, end: 900 },
    ])
  })

  it('maps selected laps to video time with lead-in and lead-out, merging neighbours', () => {
    const segments = exportSegments(laps, { telemetryId: 't', laps: [2, 3, 5], leadInSeconds: 2, leadOutSeconds: 3 }, toVideo, 900)
    expect(segments).toHaveLength(2)
    expect(segments[0]!.start).toBeCloseTo(toVideo(100) - 2, 9)
    expect(segments[0]!.end).toBeCloseTo(toVideo(219) + 3, 9)
    expect(segments[1]!.start).toBeCloseTo(toVideo(280) - 2, 9)
  })

  it('clamps to the video', () => {
    const segments = exportSegments(laps, { telemetryId: 't', laps: [1, 5], leadInSeconds: 60, leadOutSeconds: 60 }, toVideo, 420)
    expect(segments[0]!.start).toBe(0)
    expect(segments.at(-1)!.end).toBe(420)
  })

  it('merges overlapping spans', () => {
    expect(mergeSegments([{ start: 5, end: 9 }, { start: 0, end: 3 }, { start: 2, end: 6 }, { start: 9, end: 9 }])).toEqual([{ start: 0, end: 9 }])
  })
})

describe('output size and bitrate', () => {
  it('keeps the source or scales down to an NV12-friendly size', () => {
    expect(outputSize({ width: 2688, height: 1512 }, 'source')).toEqual({ width: 2688, height: 1512 })
    expect(outputSize({ width: 2688, height: 1512 }, { width: 1920, height: 1080 })).toEqual({ width: 1920, height: 1080 })
    expect(outputSize({ width: 1920, height: 1080 }, { width: 3840, height: 2160 })).toEqual({ width: 1920, height: 1080 })
    const odd = outputSize({ width: 1918, height: 1081 }, 'source')
    expect(odd.width % 4).toBe(0)
    expect(odd.height % 2).toBe(0)
  })

  it('offers standard sizes below the source', () => {
    expect(resolutionChoices({ width: 2688, height: 1512 })).toEqual([
      { width: 2560, height: 1440 },
      { width: 1920, height: 1080 },
      { width: 1280, height: 720 },
    ])
  })

  it('picks a bitrate by pixels and codec', () => {
    expect(autoBitrate(2688, 1512, 59.94, 'hevc')).toBe(29_200_000)
    expect(autoBitrate(1920, 1080, 30, 'avc')).toBe(11_200_000)
    expect(autoBitrate(64, 36, 30, 'avc')).toBe(4_000_000)
  })
})

describe('packAtlas', () => {
  it('packs boxes without overlap inside the width limit', () => {
    const boxes = [
      { x: 0, y: 0, w: 540, h: 540 },
      { x: 0, y: 0, w: 380, h: 130 },
      { x: 0, y: 0, w: 380, h: 130 },
      { x: 0, y: 0, w: 205, h: 460 },
      { x: 0, y: 0, w: 900, h: 300 },
    ]
    const { entries, width, height } = packAtlas(boxes, 1200)
    expect(width).toBeLessThanOrEqual(1200 + 2)
    const placed = entries.map((e, i) => ({ x: e.atlas.x, y: e.atlas.y, w: boxes[i]!.w, h: boxes[i]!.h }))
    for (const a of placed) {
      expect(a.x + a.w).toBeLessThanOrEqual(width)
      expect(a.y + a.h).toBeLessThanOrEqual(height)
      for (const b of placed) {
        if (a === b) continue
        expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true)
      }
    }
    expect(entries[4]!.frame).toBe(boxes[4])
  })
})

describe('estimateRemaining', () => {
  it('extrapolates the average rate', () => {
    expect(estimateRemaining(0, 100, 5)).toBeNull()
    expect(estimateRemaining(25, 100, 5)).toBe(15)
  })
})
