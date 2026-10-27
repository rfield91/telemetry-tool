import { CANONICAL_CHANNELS, isCanonicalChannelId } from '../core/data/channels'
import type { TelemetrySession } from '../core/data/import'
import { moveRect, resizeAroundCentre } from '../core/layout/geometry'
import { applyTemplate, createTemplate, type LayoutTemplate } from '../core/layout/templates'
import type { Rect, WidgetInstance } from '../core/project/schema'
import { findBoundChannel } from '../core/widgets/data'
import { createDefaultLayout, createWidget, defaultBindings, defaultStyleFor, rectForHeight } from '../core/widgets/defaults'
import { WIDGETS } from '../core/widgets/registry'
import { frameAspect, frameSize } from './actions'
import { host } from './host'
import { projectStore, runtimeStore } from './state'

/** Layout editing: selection, geometry, styles, bindings, layers and templates. */

const update = projectStore.getState().update
const widgets = () => projectStore.getState().project.layout.widgets

function activeSession(): TelemetrySession | null {
  const telemetryId = projectStore.getState().project.telemetry[0]?.id
  return (telemetryId && runtimeStore.getState().sessions[telemetryId]) || null
}

function findWidget(id: string): WidgetInstance | undefined {
  return widgets().find((w) => w.id === id)
}

/** Width ÷ height of a widget's rect in frame fractions. */
export function rectRatio(type: string): number {
  return (WIDGETS[type]?.aspect ?? 1) / frameAspect()
}

// Selection

export function select(ids: string[]) {
  runtimeStore.setState(ids.length ? { selection: ids, inspectorTab: 'layout' } : { selection: [] })
}

export function toggleSelected(id: string) {
  const { selection } = runtimeStore.getState()
  select(selection.includes(id) ? selection.filter((s) => s !== id) : [...selection, id])
}

export function selectAll() {
  select(widgets().filter((w) => !w.hidden).map((w) => w.id))
}

const editable = () => {
  const ids = runtimeStore.getState().selection
  return widgets().filter((w) => ids.includes(w.id) && !w.locked)
}

// Geometry

let gestures = 0
/** A fresh coalescing key, so one drag is one undo step but two drags are two. */
export const gestureKey = () => `gesture:${++gestures}`

export function setRects(label: string, rects: Record<string, Rect>, coalesceKey?: string) {
  update(
    label,
    (draft) => {
      for (const widget of draft.layout.widgets) {
        const rect = rects[widget.id]
        if (rect) widget.rect = rect
      }
    },
    { coalesceKey },
  )
}

/** Move the selection by whole output pixels. */
export function nudgeSelection(dxPixels: number, dyPixels: number) {
  const { width, height } = frameSize()
  const rects: Record<string, Rect> = {}
  for (const widget of editable()) {
    rects[widget.id] = moveRect(widget.rect, dxPixels / width, dyPixels / height, null, { x: 0, y: 0 }).rect
  }
  if (Object.keys(rects).length) setRects('Nudge', rects, 'nudge')
}

/** Typed position and height in output pixels; width follows the aspect. */
export function setWidgetBox(id: string, box: { x?: number; y?: number; height?: number }) {
  const widget = findWidget(id)
  if (!widget) return
  const { width, height } = frameSize()
  let rect = widget.rect
  if (box.height !== undefined) rect = resizeAroundCentre(rect, box.height / height, rectRatio(widget.type))
  const x = box.x !== undefined ? box.x / width : rect.x
  const y = box.y !== undefined ? box.y / height : rect.y
  rect = moveRect(rect, x - rect.x, y - rect.y, null, { x: 0, y: 0 }).rect
  setRects('Resize', { [id]: rect }, `box:${id}`)
}

// Style and data

export function setStyle(id: string, key: string, value: unknown) {
  update(
    'Change style',
    (draft) => {
      const widget = draft.layout.widgets.find((w) => w.id === id)
      if (widget) widget.style[key] = value
    },
    { coalesceKey: `style:${id}:${key}` },
  )
}

/** Overlay label for a binding, e.g. "OIL TEMP". */
function bindingLabel(session: TelemetrySession | null, binding: string): string {
  if (isCanonicalChannelId(binding)) return CANONICAL_CHANNELS[binding].label.toUpperCase()
  return (findBoundChannel(session, binding)?.label ?? binding).toUpperCase()
}

/**
 * Change bindings or units. Style values still at their data-derived
 * default (a gauge's range) follow the new data, and a label naming the old
 * channel is renamed; values the user changed are kept.
 */
function rebind(label: string, id: string, change: (widget: WidgetInstance) => void) {
  const widget = findWidget(id)
  if (!widget) return
  const session = activeSession()
  const next = structuredClone(widget)
  change(next)
  const before = defaultStyleFor(widget.type, session, widget.bindings, widget.units)
  const after = defaultStyleFor(next.type, session, next.bindings, next.units)
  for (const [key, value] of Object.entries(after)) {
    if (key !== 'label' && Object.is(widget.style[key], before[key])) next.style[key] = value
  }
  const [oldBinding] = Object.values(widget.bindings)
  const [newBinding] = Object.values(next.bindings)
  if (oldBinding && newBinding && widget.style.label === bindingLabel(session, oldBinding)) {
    next.style.label = bindingLabel(session, newBinding)
  }
  update(label, (draft) => {
    const index = draft.layout.widgets.findIndex((w) => w.id === id)
    if (index >= 0) draft.layout.widgets[index] = next
  })
}

export function setBinding(id: string, input: string, binding: string) {
  rebind('Change data', id, (widget) => {
    widget.bindings[input] = binding
    if (widget.units) delete widget.units[input]
  })
}

export function setUnit(id: string, input: string, unit: string | null) {
  rebind('Change unit', id, (widget) => {
    const units = { ...widget.units }
    if (unit) units[input] = unit
    else delete units[input]
    if (Object.keys(units).length) widget.units = units
    else delete widget.units
  })
}

// Layers

/** Move a widget to a position in the draw order (0 = back). */
export function reorderWidget(id: string, toIndex: number) {
  update('Reorder layers', (draft) => {
    const list = draft.layout.widgets
    const from = list.findIndex((w) => w.id === id)
    if (from < 0) return
    const [widget] = list.splice(from, 1)
    list.splice(Math.max(0, Math.min(list.length, toIndex)), 0, widget!)
  })
}

export function toggleHidden(id: string) {
  update('Show or hide widget', (draft) => {
    const widget = draft.layout.widgets.find((w) => w.id === id)
    if (widget) widget.hidden = !widget.hidden || undefined
  })
}

export function toggleLocked(id: string) {
  update('Lock or unlock widget', (draft) => {
    const widget = draft.layout.widgets.find((w) => w.id === id)
    if (widget) widget.locked = !widget.locked || undefined
  })
}

export function deleteSelection() {
  const ids = new Set(editable().map((w) => w.id))
  if (!ids.size) return
  update(ids.size > 1 ? 'Delete widgets' : 'Delete widget', (draft) => {
    draft.layout.widgets = draft.layout.widgets.filter((w) => !ids.has(w.id))
  })
  select([])
}

export function duplicateSelection() {
  const ids = runtimeStore.getState().selection
  const copies = widgets()
    .filter((w) => ids.includes(w.id))
    .map((w) => ({
      ...structuredClone(w),
      id: crypto.randomUUID(),
      locked: undefined,
      rect: moveRect(w.rect, 0.02, 0.02, null, { x: 0, y: 0 }).rect,
    }))
  if (!copies.length) return
  update('Duplicate', (draft) => {
    draft.layout.widgets.push(...copies)
  })
  select(copies.map((w) => w.id))
}

const NEW_WIDGET_HEIGHT: Record<string, number> = { readout: 0.09, lapTimer: 0.09, delta: 0.09, bar: 0.3 }

/** Add a widget in the middle of the frame, bound to its default channels. */
export function addWidget(type: string) {
  const session = activeSession()
  const h = NEW_WIDGET_HEIGHT[type] ?? 0.3
  const rect = rectForHeight(type, frameAspect(), h, 0, 0.5 - h / 2)
  rect.x = 0.5 - rect.w / 2
  const bindings = defaultBindings(type)
  const style: Record<string, unknown> = {}
  // Single-value widgets (gauge, bar, readout) are labelled with their channel.
  const inputs = WIDGETS[type]!.inputs
  if (inputs.length === 1 && inputs[0]!.name === 'value' && 'label' in defaultStyleFor(type, session, bindings)) {
    style.label = bindingLabel(session, bindings.value!)
  }
  const widget = createWidget(type, session, rect, bindings, style)
  update(`Add ${WIDGETS[type]!.label.toLowerCase()}`, (draft) => {
    draft.layout.widgets.push(widget)
  })
  select([widget.id])
}

// Whole layouts

export function resetLayout() {
  const session = activeSession()
  if (!session) return
  const layout = createDefaultLayout(session, frameAspect())
  update('Use default layout', (draft) => {
    draft.layout.widgets = layout
  })
  select([])
}

export function clearLayout() {
  update('Clear layout', (draft) => {
    draft.layout.widgets = []
  })
  select([])
}

export async function loadTemplates() {
  runtimeStore.setState({ templates: await host.loadTemplates() })
}

async function storeTemplates(templates: LayoutTemplate[]) {
  runtimeStore.setState({ templates })
  try {
    await host.saveTemplates(templates)
  } catch (error) {
    runtimeStore.setState({ error: `Couldn't save templates: ${error instanceof Error ? error.message : String(error)}` })
  }
}

/** Save the current layout; a template with the same name is replaced. */
export async function saveTemplate(name: string) {
  const trimmed = name.trim()
  if (!trimmed) return
  const template = createTemplate(trimmed, widgets(), activeSession())
  const others = runtimeStore.getState().templates.filter((t) => t.name.toLowerCase() !== trimmed.toLowerCase())
  await storeTemplates([...others, template].sort((a, b) => a.name.localeCompare(b.name)))
}

export async function deleteTemplate(id: string) {
  await storeTemplates(runtimeStore.getState().templates.filter((t) => t.id !== id))
}

export function applyLayoutTemplate(template: LayoutTemplate) {
  const { widgets: applied } = applyTemplate(template, activeSession())
  update(`Apply “${template.name}”`, (draft) => {
    draft.layout.widgets = applied
  })
  select([])
}

/** Labels of a widget's bound channels the data doesn't have. */
export function missingChannels(widget: WidgetInstance, session: TelemetrySession | null | undefined): string[] {
  if (!session) return []
  return Object.values(widget.bindings)
    .filter((binding) => !findBoundChannel(session, binding))
    .map((binding) => (isCanonicalChannelId(binding) ? CANONICAL_CHANNELS[binding].label : binding))
}
