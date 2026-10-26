import { CANONICAL_CHANNELS, isCanonicalChannelId } from '../data/channels'
import type { TelemetrySession } from '../data/import'
import type { Rect, WidgetInstance } from '../project/schema'
import { findBoundChannel } from '../widgets/data'
import { WIDGETS } from '../widgets/registry'

export const TEMPLATE_KIND = 'telemetry-overlay/layout-template'
export const TEMPLATE_VERSION = 1

export type TemplateWidget = Omit<WidgetInstance, 'id'>

/**
 * A saved layout. Bindings are canonical channel ids wherever possible, so
 * a template made on AiM data applies to Solostorm data. Rects are frame
 * fractions, so it fits any resolution.
 */
export interface LayoutTemplate {
  kind: typeof TEMPLATE_KIND
  version: typeof TEMPLATE_VERSION
  id: string
  name: string
  createdAt: string
  widgets: TemplateWidget[]
}

/**
 * Make a template from a layout. Bindings to raw columns become canonical
 * ids when the session knows what the column is.
 */
export function createTemplate(
  name: string,
  widgets: readonly WidgetInstance[],
  session: TelemetrySession | null,
  now = new Date(),
): LayoutTemplate {
  return {
    kind: TEMPLATE_KIND,
    version: TEMPLATE_VERSION,
    id: crypto.randomUUID(),
    name,
    createdAt: now.toISOString(),
    widgets: widgets.map(({ id: _id, ...widget }) => ({
      ...structuredClone(widget),
      bindings: Object.fromEntries(
        Object.entries(widget.bindings).map(([input, binding]) => {
          const canonical = isCanonicalChannelId(binding) ? binding : findBoundChannel(session, binding)?.canonical
          return [input, canonical ?? binding]
        }),
      ),
    })),
  }
}

export interface AppliedTemplate {
  widgets: WidgetInstance[]
  /** Labels of channels the template uses that the session doesn't have. */
  missing: string[]
}

/** Widgets for a session from a template, with fresh ids. */
export function applyTemplate(template: LayoutTemplate, session: TelemetrySession | null): AppliedTemplate {
  const missing = new Set<string>()
  const widgets = template.widgets
    .filter((widget) => widget.type in WIDGETS)
    .map((widget) => {
      for (const binding of Object.values(widget.bindings)) {
        if (session && !findBoundChannel(session, binding)) {
          missing.add(isCanonicalChannelId(binding) ? CANONICAL_CHANNELS[binding].label : binding)
        }
      }
      return { ...structuredClone(widget), id: crypto.randomUUID() }
    })
  return { widgets, missing: [...missing] }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const isRect = (value: unknown): value is Rect =>
  isRecord(value) && ['x', 'y', 'w', 'h'].every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]))

const isStringRecord = (value: unknown) => isRecord(value) && Object.values(value).every((v) => typeof v === 'string')

export function isLayoutTemplate(value: unknown): value is LayoutTemplate {
  if (!isRecord(value) || value.kind !== TEMPLATE_KIND || value.version !== TEMPLATE_VERSION) return false
  if (typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.createdAt !== 'string') return false
  return (
    Array.isArray(value.widgets) &&
    value.widgets.every(
      (widget) =>
        isRecord(widget) &&
        typeof widget.type === 'string' &&
        isRect(widget.rect) &&
        isStringRecord(widget.bindings) &&
        (widget.units === undefined || isStringRecord(widget.units)) &&
        isRecord(widget.style),
    )
  )
}
