import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import {
  boundsOf,
  containsPoint,
  intersects,
  moveRect,
  resizeRect,
  snapTargets,
  type Corner,
  type Guide,
} from '../../core/layout/geometry'
import type { Rect } from '../../core/project/schema'
import { gestureKey, rectRatio, select, setRects, toggleSelected } from '../layout'
import { runtimeStore, useProject, useRuntime } from '../state'

type Point = { x: number; y: number }

type Gesture =
  | { kind: 'move'; start: Point; rects: Record<string, Rect>; key: string; moved: boolean }
  | { kind: 'resize'; id: string; corner: Corner; start: Rect; ratio: number; key: string }
  | { kind: 'marquee'; start: Point; base: string[] }

/** Pointer travel (CSS px) before a press becomes a drag. */
const DRAG_START = 3
/** Snap distance in CSS px. */
const SNAP = 6

const CORNERS: Array<{ corner: Corner; className: string }> = [
  { corner: 'nw', className: '-left-1 -top-1 cursor-nwse-resize' },
  { corner: 'ne', className: '-right-1 -top-1 cursor-nesw-resize' },
  { corner: 'sw', className: '-bottom-1 -left-1 cursor-nesw-resize' },
  { corner: 'se', className: '-bottom-1 -right-1 cursor-nwse-resize' },
]

const place = (rect: Rect) => ({
  left: `${rect.x * 100}%`,
  top: `${rect.y * 100}%`,
  width: `${rect.w * 100}%`,
  height: `${rect.h * 100}%`,
})

/**
 * Direct manipulation over the preview: click or drag a box to select,
 * drag to move (snapping to the frame, its centre and other widgets; hold
 * Alt to move freely), drag a corner to resize.
 */
export function LayoutEditor({ width, height }: { width: number; height: number }) {
  const widgets = useProject((s) => s.project.layout.widgets)
  const selection = useRuntime((s) => s.selection)
  const ref = useRef<HTMLDivElement>(null)
  const gesture = useRef<Gesture | null>(null)
  const [guides, setGuides] = useState<Guide[]>([])
  const [hover, setHover] = useState<string | null>(null)
  const [marquee, setMarquee] = useState<Rect | null>(null)

  const visible = widgets.filter((w) => !w.hidden)
  const selected = visible.filter((w) => selection.includes(w.id))
  const threshold = { x: SNAP / Math.max(1, width), y: SNAP / Math.max(1, height) }

  const toFrame = (event: ReactPointerEvent): Point => {
    const box = ref.current!.getBoundingClientRect()
    return { x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height }
  }
  const hitTest = (p: Point) => visible.findLast((w) => containsPoint(w.rect, p.x, p.y))
  const targetsExcept = (ids: Set<string>, free: boolean) =>
    free ? null : snapTargets(visible.filter((w) => !ids.has(w.id)).map((w) => w.rect))

  const onPointerDown = (event: ReactPointerEvent) => {
    if (event.button !== 0) return
    ref.current!.setPointerCapture(event.pointerId)
    const p = toFrame(event)
    const hit = hitTest(p)
    const additive = event.shiftKey || event.ctrlKey || event.metaKey
    if (!hit) {
      gesture.current = { kind: 'marquee', start: p, base: additive ? selection : [] }
      return
    }
    let ids = selection
    if (additive) {
      toggleSelected(hit.id)
      ids = runtimeStore.getState().selection
      if (!ids.includes(hit.id)) return
    } else if (!selection.includes(hit.id)) {
      select([hit.id])
      ids = [hit.id]
    }
    const movable = visible.filter((w) => ids.includes(w.id) && !w.locked)
    gesture.current = movable.length
      ? { kind: 'move', start: p, rects: Object.fromEntries(movable.map((w) => [w.id, w.rect])), key: gestureKey(), moved: false }
      : null
  }

  const startResize = (event: ReactPointerEvent, id: string, corner: Corner) => {
    if (event.button !== 0) return
    event.stopPropagation()
    const widget = widgets.find((w) => w.id === id)
    if (!widget) return
    ref.current!.setPointerCapture(event.pointerId)
    gesture.current = { kind: 'resize', id, corner, start: widget.rect, ratio: rectRatio(widget.type), key: gestureKey() }
  }

  const onPointerMove = (event: ReactPointerEvent) => {
    const p = toFrame(event)
    const g = gesture.current
    if (!g) {
      setHover(hitTest(p)?.id ?? null)
      return
    }
    if (g.kind === 'move') {
      if (!g.moved && Math.hypot((p.x - g.start.x) * width, (p.y - g.start.y) * height) < DRAG_START) return
      g.moved = true
      const bounds = boundsOf(Object.values(g.rects))
      const targets = targetsExcept(new Set(Object.keys(g.rects)), event.altKey)
      const moved = moveRect(bounds, p.x - g.start.x, p.y - g.start.y, targets, threshold)
      const dx = moved.rect.x - bounds.x
      const dy = moved.rect.y - bounds.y
      const rects = Object.fromEntries(Object.entries(g.rects).map(([id, r]) => [id, { ...r, x: r.x + dx, y: r.y + dy }]))
      setRects(Object.keys(rects).length > 1 ? 'Move widgets' : 'Move widget', rects, g.key)
      setGuides(moved.guides)
    } else if (g.kind === 'resize') {
      const resized = resizeRect(g.start, g.corner, p, g.ratio, targetsExcept(new Set([g.id]), event.altKey), threshold)
      setRects('Resize widget', { [g.id]: resized.rect }, g.key)
      setGuides(resized.guides)
    } else {
      const area = {
        x: Math.min(g.start.x, p.x),
        y: Math.min(g.start.y, p.y),
        w: Math.abs(p.x - g.start.x),
        h: Math.abs(p.y - g.start.y),
      }
      setMarquee(area)
      const inside = visible.filter((w) => intersects(w.rect, area)).map((w) => w.id)
      select([...new Set([...g.base, ...inside])])
    }
  }

  const onPointerUp = () => {
    const g = gesture.current
    // A click on empty space (no marquee drawn) clears the selection.
    if (g?.kind === 'marquee' && !marquee) select(g.base)
    gesture.current = null
    setGuides([])
    setMarquee(null)
  }

  const single = selected.length === 1 ? selected[0]! : null
  const hovered = hover && !selection.includes(hover) ? visible.find((w) => w.id === hover) : undefined
  const hoveredMovable = !!visible.find((w) => w.id === hover && !w.locked)

  return (
    <div
      ref={ref}
      className={`absolute inset-0 select-none ${hoveredMovable ? 'cursor-move' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => setHover(null)}
    >
      {hovered && <div className="pointer-events-none absolute border border-fg/50" style={place(hovered.rect)} />}
      {selected.map((widget) => (
        <div
          key={widget.id}
          className={`pointer-events-none absolute border border-accent ${widget.locked ? 'border-dashed' : ''}`}
          style={place(widget.rect)}
        />
      ))}
      {selected.length > 1 && (
        <div className="pointer-events-none absolute border border-dashed border-accent/60" style={place(boundsOf(selected.map((w) => w.rect)))} />
      )}
      {single && !single.locked && (
        <div className="pointer-events-none absolute" style={place(single.rect)}>
          {CORNERS.map(({ corner, className }) => (
            <div
              key={corner}
              className={`pointer-events-auto absolute size-2 rounded-[1px] border border-accent bg-canvas ${className}`}
              onPointerDown={(event) => startResize(event, single.id, corner)}
            />
          ))}
        </div>
      )}
      {guides.map((guide) =>
        guide.axis === 'x' ? (
          <div key={`x${guide.at}`} className="pointer-events-none absolute inset-y-0 w-px bg-info" style={{ left: `${guide.at * 100}%` }} />
        ) : (
          <div key={`y${guide.at}`} className="pointer-events-none absolute inset-x-0 h-px bg-info" style={{ top: `${guide.at * 100}%` }} />
        ),
      )}
      {marquee && <div className="pointer-events-none absolute border border-accent bg-accent-soft" style={place(marquee)} />}
    </div>
  )
}
