import type { Lap } from '../laps/laps'
import type { ExportSettings, ProjectSelection, Rect } from '../project/schema'

/**
 * Export planning: which parts of the video to render, at what size and
 * bitrate. Pure functions, no media APIs.
 */

/** A span of the source video, in video seconds. */
export interface Segment {
  start: number
  end: number
}

/** Merge overlapping or touching segments, sorted by start. */
export function mergeSegments(segments: Segment[]): Segment[] {
  const sorted = segments.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start)
  const merged: Segment[] = []
  for (const segment of sorted) {
    const last = merged[merged.length - 1]
    if (last && segment.start <= last.end) last.end = Math.max(last.end, segment.end)
    else merged.push({ ...segment })
  }
  return merged
}

/**
 * Parts of the video to export: the selected laps with lead-in and lead-out
 * (converted to video time and merged where they overlap), or the whole
 * video when no laps are selected. Clamped to the video.
 */
export function exportSegments(
  laps: readonly Lap[],
  selection: ProjectSelection | null,
  toVideo: (dataTime: number) => number,
  videoDuration: number,
): Segment[] {
  const chosen = laps.filter((lap) => selection?.laps.includes(lap.index))
  if (chosen.length === 0) return videoDuration > 0 ? [{ start: 0, end: videoDuration }] : []
  const leadIn = Math.max(0, selection?.leadInSeconds ?? 0)
  const leadOut = Math.max(0, selection?.leadOutSeconds ?? 0)
  return mergeSegments(
    chosen.map((lap) => ({
      start: Math.max(0, toVideo(lap.start) - leadIn),
      end: Math.min(videoDuration, toVideo(lap.end) + leadOut),
    })),
  )
}

export const totalDuration = (segments: Segment[]) => segments.reduce((sum, s) => sum + s.end - s.start, 0)

/** Output frame size: NV12 packing needs a width divisible by 4 and an even height. */
export function outputSize(source: { width: number; height: number }, resolution: ExportSettings['resolution']) {
  const target = resolution === 'source' ? source : resolution
  const scale = Math.min(1, target.height / source.height, target.width / source.width)
  const round = (value: number, step: number) => Math.max(step, Math.round(value / step) * step)
  return { width: round(source.width * scale, 4), height: round(source.height * scale, 2) }
}

/** Standard heights offered below the source size. */
export function resolutionChoices(source: { width: number; height: number }) {
  return [2160, 1440, 1080, 720]
    .filter((height) => height < source.height)
    .map((height) => outputSize(source, { width: Math.round((source.width * height) / source.height), height }))
}

/**
 * Bitrate (bits/s) that keeps the overlay text and footage clean: about
 * 0.12 bits per pixel per frame for HEVC and 0.18 for H.264.
 */
export function autoBitrate(width: number, height: number, fps: number, codec: ExportSettings['codec']): number {
  const bitsPerPixel = codec === 'hevc' ? 0.12 : 0.18
  const bitrate = width * height * Math.min(fps, 120) * bitsPerPixel
  return Math.round(Math.min(150e6, Math.max(4e6, bitrate)) / 1e5) * 1e5
}

export interface AtlasEntry {
  /** Where the widget sits in the output frame (pixels). */
  frame: Rect
  /** Where it's drawn in the overlay atlas (pixels). */
  atlas: { x: number; y: number }
}

/**
 * Pack widget boxes into a small overlay texture: shelves left to right,
 * with a gap so linear filtering doesn't bleed between widgets.
 */
export function packAtlas(boxes: Rect[], maxWidth = 4096, gap = 2) {
  const entries: AtlasEntry[] = []
  let x = 0
  let y = 0
  let shelf = 0
  let width = 1
  // Tallest first keeps shelves tight.
  const order = boxes.map((box, i) => ({ box, i })).sort((a, b) => b.box.h - a.box.h)
  for (const { box, i } of order) {
    if (x > 0 && x + box.w > maxWidth) {
      x = 0
      y += shelf + gap
      shelf = 0
    }
    entries[i] = { frame: box, atlas: { x, y } }
    x += box.w + gap
    shelf = Math.max(shelf, box.h)
    width = Math.max(width, x)
  }
  return { entries, width, height: Math.max(1, y + shelf) }
}

/** Seconds left at the average rate so far, or null before there's a rate. */
export function estimateRemaining(done: number, total: number, elapsedSeconds: number): number | null {
  if (done <= 0 || elapsedSeconds <= 0) return null
  return Math.max(0, ((total - done) * elapsedSeconds) / done)
}
