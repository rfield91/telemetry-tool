import type { TelemetrySession } from '../data/import'
import type { WidgetInstance } from '../project/schema'
import { createWidgetData, resolveInputs, type ResolvedInput } from './data'
import { WIDGETS } from './registry'
import type { AnyWidgetDefinition, Ctx2D } from './types'

export interface LayerCanvas {
  width: number
  height: number
  getContext(type: '2d'): Ctx2D | null
}

export type CreateCanvas = (width: number, height: number) => LayerCanvas

const defaultCreateCanvas: CreateCanvas = (width, height) => {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

interface Layer {
  key: string
  canvas: LayerCanvas
  prepared: unknown
}

/** Pixel box of a widget in a frame of the given size. */
export function widgetBox(widget: WidgetInstance, frameWidth: number, frameHeight: number) {
  return {
    x: Math.round(widget.rect.x * frameWidth),
    y: Math.round(widget.rect.y * frameHeight),
    width: Math.round(widget.rect.w * frameWidth),
    height: Math.round(widget.rect.h * frameHeight),
  }
}

/**
 * Draws a layout at a point in time. Each widget's static layer is cached
 * per size, style and bound data; only dynamic parts are drawn per frame.
 * The same renderer serves preview now and export later.
 */
export class OverlayRenderer {
  private readonly layers = new Map<string, Layer>()
  private readonly inputs = new Map<string, { key: string; inputs: Record<string, ResolvedInput | null> }>()
  private readonly sessionIds = new WeakMap<TelemetrySession, number>()
  private nextSessionId = 1
  private readonly createCanvas: CreateCanvas
  private readonly definitions: Record<string, AnyWidgetDefinition>
  /** Milliseconds spent in the last `render` call. */
  lastFrameMs = 0

  constructor(options: { createCanvas?: CreateCanvas; definitions?: Record<string, AnyWidgetDefinition> } = {}) {
    this.createCanvas = options.createCanvas ?? defaultCreateCanvas
    this.definitions = options.definitions ?? WIDGETS
  }

  private sessionId(session: TelemetrySession | null) {
    if (!session) return 0
    let id = this.sessionIds.get(session)
    if (!id) {
      id = this.nextSessionId++
      this.sessionIds.set(session, id)
    }
    return id
  }

  private resolve(widget: WidgetInstance, session: TelemetrySession | null) {
    const key = `${this.sessionId(session)}|${JSON.stringify(widget.bindings)}`
    let entry = this.inputs.get(widget.id)
    if (!entry || entry.key !== key) {
      entry = { key, inputs: resolveInputs(session, widget.bindings) }
      this.inputs.set(widget.id, entry)
    }
    return entry
  }

  render(
    ctx: Ctx2D,
    frame: { width: number; height: number },
    widgets: WidgetInstance[],
    session: TelemetrySession | null,
    time: number,
  ) {
    const started = performance.now()
    const live = new Set<string>()
    for (const widget of widgets) {
      if (widget.hidden) continue
      const definition = this.definitions[widget.type]
      if (!definition) continue
      const box = widgetBox(widget, frame.width, frame.height)
      if (box.width < 4 || box.height < 4) continue
      live.add(widget.id)

      const { key: dataKey, inputs } = this.resolve(widget, session)
      const data = createWidgetData(inputs, time, dataKey)
      const size = { width: box.width, height: box.height }
      const layerKey = `${box.width}x${box.height}|${JSON.stringify(widget.style)}|${dataKey}`
      let layer = this.layers.get(widget.id)
      if (!layer || layer.key !== layerKey) {
        const canvas = this.createCanvas(box.width, box.height)
        const layerCtx = canvas.getContext('2d')
        const prepared = layerCtx ? definition.drawStatic(layerCtx, size, widget.style, data) : undefined
        layer = { key: layerKey, canvas, prepared }
        this.layers.set(widget.id, layer)
      }

      ctx.drawImage(layer.canvas as CanvasImageSource, box.x, box.y)
      ctx.save()
      ctx.translate(box.x, box.y)
      definition.drawDynamic(ctx, size, widget.style, data, layer.prepared)
      ctx.restore()
    }
    for (const id of this.layers.keys()) if (!live.has(id)) this.layers.delete(id)
    this.lastFrameMs = performance.now() - started
  }
}
