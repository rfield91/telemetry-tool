import { describe, expect, it } from 'vitest'
import { fitToBox, projectToLocal, toBox } from './gps'

describe('projectToLocal', () => {
  it('projects to metres around the mid-point', () => {
    // ~111.2 m per 0.001° of latitude; longitude shrinks by cos(lat).
    const p = projectToLocal([42.0, 42.001], [-71.0, -71.001])
    expect(p.y[1]! - p.y[0]!).toBeCloseTo(111.32, 1)
    expect(p.x[0]! - p.x[1]!).toBeCloseTo(111.32 * Math.cos((42.0005 * Math.PI) / 180), 1)
    expect(p.x[0]! + p.x[1]!).toBeCloseTo(0, 9)
  })
})

describe('fitToBox', () => {
  it('fits north-up with preserved aspect and padding', () => {
    // A 200 m (east) × 100 m (north) rectangle into a 220×220 box.
    const p = { x: Float64Array.from([-100, 100, 100, -100]), y: Float64Array.from([-50, -50, 50, 50]), refLat: 0, refLon: 0 }
    const fit = fitToBox(p, 220, 220, 10)
    expect(fit.scale).toBeCloseTo(1, 9)
    expect(toBox(fit, -100, 50)).toEqual({ x: 10, y: 60 })
    expect(toBox(fit, 100, -50)).toEqual({ x: 210, y: 160 })
  })

  it('handles a stationary track', () => {
    const p = projectToLocal([42, 42], [-71, -71])
    const fit = fitToBox(p, 100, 100)
    const point = toBox(fit, p.x[0]!, p.y[0]!)
    expect(point.x).toBeCloseTo(50, 9)
    expect(point.y).toBeCloseTo(50, 9)
  })
})
