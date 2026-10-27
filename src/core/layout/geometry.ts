import type { Rect } from '../project/schema'

/**
 * Layout geometry for the editor. Everything is in frame fractions (0–1 on
 * each axis), like `WidgetInstance.rect`.
 */

/** A snap line: `axis: 'x'` is a vertical line at x = `at`. */
export interface Guide {
  axis: 'x' | 'y'
  at: number
}

export interface SnapTargets {
  x: number[]
  y: number[]
}

export interface SnapResult {
  rect: Rect
  guides: Guide[]
}

/** Snap distance per axis, in frame fractions. */
export interface Threshold {
  x: number
  y: number
}

/** Margin the default layout uses; also a snap line on every side. */
export const SAFE_MARGIN = 0.02
/** Smallest widget height, as a fraction of the frame. */
export const MIN_HEIGHT = 0.03

const xLines = (r: Rect) => [r.x, r.x + r.w / 2, r.x + r.w]
const yLines = (r: Rect) => [r.y, r.y + r.h / 2, r.y + r.h]

/** Frame edges, centre and safe margins, plus edges and centres of other widgets. */
export function snapTargets(others: Rect[]): SnapTargets {
  const frame = [0, SAFE_MARGIN, 0.5, 1 - SAFE_MARGIN, 1]
  return {
    x: [...frame, ...others.flatMap(xLines)],
    y: [...frame, ...others.flatMap(yLines)],
  }
}

/** Closest target to any of the lines, within the threshold. */
function nearest(lines: number[], targets: number[], threshold: number): { delta: number; at: number } | null {
  let best: { delta: number; at: number } | null = null
  for (const line of lines) {
    for (const target of targets) {
      const delta = target - line
      if (Math.abs(delta) <= threshold && (!best || Math.abs(delta) < Math.abs(best.delta))) best = { delta, at: target }
    }
  }
  return best
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max))

/** Bounding box of several rects. */
export function boundsOf(rects: Rect[]): Rect {
  const x = Math.min(...rects.map((r) => r.x))
  const y = Math.min(...rects.map((r) => r.y))
  const right = Math.max(...rects.map((r) => r.x + r.w))
  const bottom = Math.max(...rects.map((r) => r.y + r.h))
  return { x, y, w: right - x, h: bottom - y }
}

/**
 * Move a rect by (dx, dy), kept inside the frame, snapping its edges and
 * centre to the targets. Pass `targets: null` to move freely.
 */
export function moveRect(start: Rect, dx: number, dy: number, targets: SnapTargets | null, threshold: Threshold): SnapResult {
  const rect = { ...start, x: clamp(start.x + dx, 0, 1 - start.w), y: clamp(start.y + dy, 0, 1 - start.h) }
  const guides: Guide[] = []
  if (targets) {
    const sx = nearest(xLines(rect), targets.x, threshold.x)
    if (sx && rect.x + sx.delta >= -1e-9 && rect.x + rect.w + sx.delta <= 1 + 1e-9) {
      rect.x += sx.delta
      guides.push({ axis: 'x', at: sx.at })
    }
    const sy = nearest(yLines(rect), targets.y, threshold.y)
    if (sy && rect.y + sy.delta >= -1e-9 && rect.y + rect.h + sy.delta <= 1 + 1e-9) {
      rect.y += sy.delta
      guides.push({ axis: 'y', at: sy.at })
    }
  }
  return { rect, guides }
}

export type Corner = 'nw' | 'ne' | 'sw' | 'se'

/**
 * Resize from a corner while the opposite corner stays put. `ratio` is the
 * rect's width ÷ height in frame fractions, which is kept. The dragged
 * corner snaps on whichever axis is closer to a target.
 */
export function resizeRect(
  start: Rect,
  corner: Corner,
  pointer: { x: number; y: number },
  ratio: number,
  targets: SnapTargets | null,
  threshold: Threshold,
): SnapResult {
  const west = corner.includes('w')
  const north = corner.includes('n')
  const anchorX = west ? start.x + start.w : start.x
  const anchorY = north ? start.y + start.h : start.y
  const dirX = west ? -1 : 1
  const dirY = north ? -1 : 1
  // Largest height that keeps the rect inside the frame.
  const room = Math.min(north ? anchorY : 1 - anchorY, (west ? anchorX : 1 - anchorX) / ratio)

  // Follow whichever axis the pointer has moved further along; past the
  // anchor the size goes negative and clamps to the minimum.
  let h = Math.max(dirY * (pointer.y - anchorY), (dirX * (pointer.x - anchorX)) / ratio)
  const guides: Guide[] = []
  if (targets) {
    const edgeX = anchorX + dirX * h * ratio
    const edgeY = anchorY + dirY * h
    const sx = nearest([edgeX], targets.x, threshold.x)
    const sy = nearest([edgeY], targets.y, threshold.y)
    const useX = sx && (!sy || Math.abs(sx.delta) / threshold.x <= Math.abs(sy.delta) / threshold.y)
    if (useX) {
      h = Math.abs(sx.at - anchorX) / ratio
      guides.push({ axis: 'x', at: sx.at })
    } else if (sy) {
      h = Math.abs(sy.at - anchorY)
      guides.push({ axis: 'y', at: sy.at })
    }
  }
  h = clamp(h, MIN_HEIGHT, room)
  const w = h * ratio
  const rect = { x: west ? anchorX - w : anchorX, y: north ? anchorY - h : anchorY, w, h }
  // A snap that the size limits overrode no longer applies.
  const kept = guides.filter((g) =>
    g.axis === 'x' ? Math.abs(g.at - (west ? rect.x : rect.x + w)) < 1e-9 : Math.abs(g.at - (north ? rect.y : rect.y + h)) < 1e-9,
  )
  return { rect, guides: kept }
}

/** Resize keeping the centre, for typed-in sizes; stays inside the frame. */
export function resizeAroundCentre(start: Rect, h: number, ratio: number): Rect {
  const height = clamp(h, MIN_HEIGHT, Math.min(1, 1 / ratio))
  const w = height * ratio
  const cx = start.x + start.w / 2
  const cy = start.y + start.h / 2
  return { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - height / 2, 0, 1 - height), w, h: height }
}

export function containsPoint(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}
