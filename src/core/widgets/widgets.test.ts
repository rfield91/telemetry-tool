import { describe, expect, it } from 'vitest'
import nerCsv from '../../../sample-data/solostorm/ner-autocross-lap7.csv?raw'
import { findChannel, importTelemetry } from '../data/import'
import { sampleAt } from '../data/series'
import { convert } from '../data/units'
import { createWidgetData, resolveInputs } from './data'
import { createDefaultLayout } from './defaults'
import { niceMax, niceStep } from './draw'
import { OverlayRenderer, type LayerCanvas } from './renderer'
import type { Ctx2D } from './types'

const session = importTelemetry(nerCsv, 'ner.csv')

/** A canvas context that accepts any call and counts them. */
function recordingContext() {
  const calls: string[] = []
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(target, prop) {
      if (prop === 'calls') return calls
      if (prop in target) return target[prop as string]
      return (...args: unknown[]) => {
        calls.push(String(prop))
        return prop === 'measureText' ? { width: 10 * String(args[0]).length } : undefined
      }
    },
    set(target, prop, value) {
      target[prop as string] = value
      return true
    },
  })
  return ctx as unknown as Ctx2D & { calls: string[] }
}

describe('widget data', () => {
  it('converts bound channels to display units', () => {
    const inputs = resolveInputs(session, { speed: 'speed', coolant: 'coolantTemp', missing: 'boostPressure' })
    const data = createWidgetData(inputs, 10, 'v')
    const speedMs = sampleAt(findChannel(session, 'speed')!.series, 10)!
    expect(data.value('speed')).toBeCloseTo(convert(speedMs, 'm/s', 'mph'), 9)
    expect(data.unit('speed')).toBe('mph')
    expect(data.unit('coolant')).toBe('°F')
    expect(data.value('missing')).toBeNull()
  })

  it('binds raw column keys as well as canonical ids', () => {
    const inputs = resolveInputs(session, { sats: 'SATELLITE_COUNT' })
    expect(createWidgetData(inputs, 0, 'v').value('sats')).toBe(8)
  })
})

describe('createDefaultLayout', () => {
  const layout = createDefaultLayout(session, 16 / 9)

  it('places the five widget types for a full Solostorm session', () => {
    expect(layout.map((w) => w.type)).toEqual(['gauge', 'bar', 'readout', 'readout', 'readout', 'trackMap', 'gMeter'])
    for (const widget of layout) {
      expect(widget.rect.x).toBeGreaterThanOrEqual(0)
      expect(widget.rect.y).toBeGreaterThanOrEqual(0)
      expect(widget.rect.x + widget.rect.w).toBeLessThanOrEqual(1)
      expect(widget.rect.y + widget.rect.h).toBeLessThanOrEqual(1)
    }
  })

  it('derives ranges from the data', () => {
    // Peak speed is about 68 mph.
    expect(layout[0]!.style).toMatchObject({ label: 'SPEED', min: 0, max: 80 })
    expect(layout.find((w) => w.type === 'gMeter')!.style.maxG).toBe(1.5)
  })
})

describe('OverlayRenderer', () => {
  it('draws static layers once and dynamic parts every frame', () => {
    const layers: Array<LayerCanvas & { ctx: Ctx2D & { calls: string[] } }> = []
    const renderer = new OverlayRenderer({
      createCanvas: (width, height) => {
        const ctx = recordingContext()
        const canvas = { width, height, ctx, getContext: () => ctx }
        layers.push(canvas)
        return canvas
      },
    })
    const layout = createDefaultLayout(session, 16 / 9)
    const target = recordingContext()

    renderer.render(target, { width: 1920, height: 1080 }, layout, session, 10)
    expect(layers).toHaveLength(layout.length)
    const staticCalls = layers.map((layer) => layer.ctx.calls.length)
    expect(Math.min(...staticCalls)).toBeGreaterThan(0)

    for (let t = 10; t < 11; t += 1 / 60) renderer.render(target, { width: 1920, height: 1080 }, layout, session, t)
    expect(layers).toHaveLength(layout.length)
    expect(layers.map((layer) => layer.ctx.calls.length)).toEqual(staticCalls)
    expect(target.calls.filter((call) => call === 'drawImage')).toHaveLength(layout.length * 61)

    // A new size or style rebuilds only that widget's layer.
    const restyled = layout.map((w, i) => (i === 0 ? { ...w, style: { ...w.style, accent: '#ff0000' } } : w))
    renderer.render(target, { width: 1920, height: 1080 }, restyled, session, 11)
    expect(layers).toHaveLength(layout.length + 1)
    renderer.render(target, { width: 1280, height: 720 }, restyled, session, 11)
    expect(layers).toHaveLength(layout.length * 2 + 1)
  })
})

describe('nice ranges', () => {
  it('rounds dial limits and tick steps', () => {
    expect(niceMax(71.6)).toBe(80)
    expect(niceMax(130)).toBe(140)
    expect(niceMax(7600)).toBe(8000)
    expect(niceStep(80)).toBe(10)
    expect(niceStep(8000)).toBe(1000)
  })
})
