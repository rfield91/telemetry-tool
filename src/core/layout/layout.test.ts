import { describe, expect, it } from 'vitest'
import aimCsv from '../../../sample-data/3.csv?raw'
import nerCsv from '../../../sample-data/solostorm/ner-autocross-lap7.csv?raw'
import { importTelemetry } from '../data/import'
import type { Rect } from '../project/schema'
import { findBoundChannel } from '../widgets/data'
import { createDefaultLayout, createWidget } from '../widgets/defaults'
import { boundsOf, containsPoint, moveRect, resizeAroundCentre, resizeRect, snapTargets } from './geometry'
import { applyTemplate, createTemplate, isLayoutTemplate } from './templates'

const threshold = { x: 0.01, y: 0.01 }

function expectRect(actual: Rect, expected: Rect) {
  for (const key of ['x', 'y', 'w', 'h'] as const) expect(actual[key]).toBeCloseTo(expected[key], 9)
}

describe('moveRect', () => {
  const start = { x: 0.2, y: 0.2, w: 0.1, h: 0.1 }

  it('snaps edges and centres to targets and reports guides', () => {
    const targets = snapTargets([{ x: 0.65, y: 0.6, w: 0.2, h: 0.2 }])
    // Right edge lands 0.004 short of the other widget's left edge.
    const { rect, guides } = moveRect(start, 0.346, 0.0, targets, threshold)
    expect(rect.x + rect.w).toBeCloseTo(0.65, 9)
    expect(guides).toEqual([{ axis: 'x', at: 0.65 }])
    // Centre to the frame centre.
    const centred = moveRect(start, 0.247, 0.253, targets, threshold)
    expect(centred.rect.x + centred.rect.w / 2).toBeCloseTo(0.5, 9)
    expect(centred.rect.y + centred.rect.h / 2).toBeCloseTo(0.5, 9)
  })

  it('moves freely without targets and stays inside the frame', () => {
    expect(moveRect(start, 0.296, 0, null, threshold).rect.x).toBeCloseTo(0.496, 9)
    expectRect(moveRect(start, 5, -5, null, threshold).rect, { x: 0.9, y: 0, w: 0.1, h: 0.1 })
  })
})

describe('resizeRect', () => {
  const start = { x: 0.2, y: 0.2, w: 0.1, h: 0.2 }

  it('keeps the aspect and the opposite corner', () => {
    const { rect } = resizeRect(start, 'se', { x: 0.35, y: 0.5 }, 0.5, null, threshold)
    expect(rect).toMatchObject({ x: 0.2, y: 0.2 })
    expect(rect.h).toBeCloseTo(0.3, 9)
    expect(rect.w / rect.h).toBeCloseTo(0.5, 9)
    const nw = resizeRect(start, 'nw', { x: 0.25, y: 0.3 }, 0.5, null, threshold).rect
    expect(nw.x + nw.w).toBeCloseTo(0.3, 9)
    expect(nw.y + nw.h).toBeCloseTo(0.4, 9)
    expect(nw.h).toBeCloseTo(0.1, 9)
  })

  it('snaps the dragged edge and limits size to the frame', () => {
    const snapped = resizeRect(start, 'se', { x: 0.3, y: 0.495 }, 0.5, snapTargets([]), threshold)
    expect(snapped.rect.y + snapped.rect.h).toBeCloseTo(0.5, 9)
    expect(snapped.guides).toEqual([{ axis: 'y', at: 0.5 }])
    const huge = resizeRect(start, 'se', { x: 5, y: 5 }, 0.5, null, threshold).rect
    expect(huge.y + huge.h).toBeCloseTo(1, 9)
    expect(resizeRect(start, 'se', { x: 0, y: 0 }, 0.5, null, threshold).rect.h).toBeCloseTo(0.03, 9)
  })

  it('resizes typed sizes around the centre', () => {
    expectRect(resizeAroundCentre(start, 0.4, 0.5), { x: 0.15, y: 0.1, w: 0.2, h: 0.4 })
  })
})

describe('helpers', () => {
  it('computes bounds and hit tests', () => {
    expectRect(boundsOf([{ x: 0.1, y: 0.2, w: 0.1, h: 0.1 }, { x: 0.5, y: 0.1, w: 0.2, h: 0.05 }]), { x: 0.1, y: 0.1, w: 0.6, h: 0.2 })
    expect(containsPoint({ x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, 0.15, 0.2)).toBe(true)
    expect(containsPoint({ x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, 0.25, 0.15)).toBe(false)
  })
})

describe('layout templates', () => {
  const aim = importTelemetry(aimCsv, '3.csv')
  const ner = importTelemetry(nerCsv, 'ner.csv')

  it('carries an AiM layout over to Solostorm data through canonical channels', () => {
    const layout = createDefaultLayout(aim, 16 / 9)
    // One widget bound to an AiM column by name.
    const rawSpeed = aim.channels.find((c) => c.canonical === 'speed')!
    layout.push(createWidget('readout', aim, { x: 0.4, y: 0.4, w: 0.1, h: 0.05 }, { value: rawSpeed.key }))

    const template = createTemplate('AiM default', layout, aim)
    expect(isLayoutTemplate(JSON.parse(JSON.stringify(template)))).toBe(true)
    expect(template.widgets.at(-1)!.bindings.value).toBe('speed')

    const applied = applyTemplate(template, ner)
    expect(applied.widgets.map((w) => w.type)).toEqual(layout.map((w) => w.type))
    expect(new Set(applied.widgets.map((w) => w.id)).size).toBe(layout.length)
    expect(applied.widgets.some((w, i) => w.id === layout[i]!.id)).toBe(false)
    const unresolved = applied.widgets.flatMap((w) => Object.values(w.bindings).filter((b) => !findBoundChannel(ner, b)))
    expect(applied.missing.length).toBe(new Set(unresolved).size)
    expect(applied.widgets.find((w) => w.type === 'gauge')!.rect).toEqual(layout.find((w) => w.type === 'gauge')!.rect)
  })

  it('rejects malformed templates', () => {
    expect(isLayoutTemplate({ kind: 'telemetry-overlay/layout-template', version: 1, id: 'a', name: 'b', createdAt: 'c', widgets: [{}] })).toBe(false)
    expect(isLayoutTemplate(null)).toBe(false)
  })
})
