import type { CanonicalChannelId } from '../data/channels'
import type { Series } from '../data/series'

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

export interface WidgetSize {
  width: number
  height: number
}

export interface WidgetInputSpec {
  name: string
  label: string
  /** Canonical channel bound by default. */
  channel: CanonicalChannelId
}

/** Data a widget can read while drawing. Values are in display units. */
export interface WidgetData {
  /** Telemetry session time being drawn (seconds). */
  time: number
  value(input: string): number | null
  valueAt(input: string, time: number): number | null
  /** Display unit label for an input (e.g. "mph"), or "". */
  unit(input: string): string
  /** Raw series in base units, for whole-session drawings (track map). */
  series(input: string): Series | null
  /** Changes whenever the bound data changes; part of static-layer keys. */
  version: string
}

export type WidgetStyle = Record<string, unknown>

/**
 * A widget type. Static parts (faces, ticks, outlines) are drawn once into
 * a cached layer per size/style/data; only `drawDynamic` runs every frame.
 */
export interface WidgetDefinition<S extends WidgetStyle = WidgetStyle, P = void> {
  type: string
  label: string
  inputs: WidgetInputSpec[]
  /** Box width ÷ height; widgets keep this shape when resized. */
  aspect: number
  defaultStyle(data: WidgetData): S
  /** Draw the cached layer and return anything the dynamic pass needs. */
  drawStatic(ctx: Ctx2D, size: WidgetSize, style: S, data: WidgetData): P
  drawDynamic(ctx: Ctx2D, size: WidgetSize, style: S, data: WidgetData, prepared: P): void
}

// Widget definitions are stored in one registry regardless of their style
// and prepared types.
// oxlint-disable-next-line typescript/no-explicit-any
export type AnyWidgetDefinition = WidgetDefinition<any, any>
