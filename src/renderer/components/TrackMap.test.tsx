import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildTrailPath,
  pointsToPath,
  projectGpsTrack,
  sampleGpsPoints,
  trackIndexAt,
} from '../lib/trackMap'
import { TrackMap } from './TrackMap'
import { OverlayFrame } from '../export/OverlayFrame'

afterEach(cleanup)

describe('track map helpers', () => {
  it('projects GPS points into a north-up viewBox fit', () => {
    const { projected } = projectGpsTrack(
      [
        { lat: 41.98, lon: -71.83 },
        { lat: 41.99, lon: -71.82 },
      ],
      320,
      320,
      24,
    )

    expect(projected).toHaveLength(2)
    // Higher latitude should be above (smaller y) in SVG space.
    expect(projected[1]!.y).toBeLessThan(projected[0]!.y)
    // Higher longitude (east) should be to the right (larger x).
    expect(projected[1]!.x).toBeGreaterThan(projected[0]!.x)
  })

  it('interpolates GPS samples between timestamps', () => {
    const points = [
      { time: 0, lat: 41.0, lon: -71.0 },
      { time: 2, lat: 42.0, lon: -70.0 },
    ]
    expect(sampleGpsPoints(points, 1)).toEqual({ lat: 41.5, lon: -70.5 })
    expect(trackIndexAt(points, 1)).toBe(0)
    expect(pointsToPath([{ x: 1, y: 2 }, { x: 3, y: 4 }])).toBe(
      'M 1.00 2.00 L 3.00 4.00',
    )
  })

  it('subsamples long trails for SVG paths', () => {
    const projected = Array.from({ length: 10_000 }, (_, index) => ({
      x: index,
      y: index,
    }))
    const path = buildTrailPath(projected, projected.length - 1, null, 800)
    const vertices = path.split(' L ').length
    expect(vertices).toBeLessThanOrEqual(800)
    expect(path.startsWith('M 0.00 0.00')).toBe(true)
    expect(path).toContain('9999.00 9999.00')
  })
})

describe('TrackMap', () => {
  it('exposes the current GPS position in its accessible label', () => {
    render(
      <TrackMap
        label="Track"
        time={1}
        points={[
          { time: 0, lat: 41.0, lon: -71.0 },
          { time: 2, lat: 42.0, lon: -70.0 },
        ]}
      />,
    )

    expect(
      screen.getByRole('img', { name: 'Track: 41.50000, -70.50000' }),
    ).toBeTruthy()
  })
})

describe('OverlayFrame track map', () => {
  it('renders a track-map component alongside gauges', () => {
    render(
      <OverlayFrame
        time={0.5}
        width={1000}
        height={500}
        overlay={{
          components: [
            {
              id: 'map',
              type: 'track-map',
              label: 'Track',
              x: 0.2,
              y: 0.3,
              size: 0.4,
              points: [
                { time: 0, lat: 41.0, lon: -71.0 },
                { time: 1, lat: 42.0, lon: -70.0 },
              ],
            },
          ],
        }}
      />,
    )

    const map = screen.getByRole('img', { name: /Track:/ })
    expect(map.parentElement).toHaveStyle({
      left: '200px',
      top: '150px',
      width: '200px',
      height: '200px',
    })
  })
})
