import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

afterEach(cleanup)
import { Gauge } from './Gauge'
import { gaugeFraction, samplePoints } from '../lib/gauge'
import { OverlayFrame } from '../export/OverlayFrame'

describe('gauge helpers', () => {
  it('scales and clamps values to the gauge range', () => {
    expect(gaugeFraction(50, 0, 100)).toBe(0.5)
    expect(gaugeFraction(-10, 0, 100)).toBe(0)
    expect(gaugeFraction(110, 0, 100)).toBe(1)
    expect(gaugeFraction(10, 10, 10)).toBe(0)
  })

  it('interpolates point arrays deterministically', () => {
    const points = [
      { time: 0, value: 1_000 },
      { time: 2, value: 3_000 },
    ]
    expect(samplePoints(points, -1)).toBe(1_000)
    expect(samplePoints(points, 1)).toBe(2_000)
    expect(samplePoints(points, 3)).toBe(3_000)
  })
})

describe('Gauge', () => {
  it('exposes an accessible meter value', () => {
    render(
      <Gauge value={4250} min={0} max={8000} label="Engine speed" unit="RPM" />,
    )

    const meter = screen.getByRole('meter', { name: 'Engine speed' })
    expect(meter).toHaveAttribute('aria-valuenow', '4250')
    expect(meter).toHaveAttribute('aria-valuetext', '4,250 RPM')
  })
})

describe('OverlayFrame', () => {
  it('uses explicit frame time and dimensions', () => {
    render(
      <OverlayFrame
        time={0.5}
        width={1920}
        height={1080}
        overlay={{
          components: [
            {
              id: 'speed',
              type: 'gauge',
              label: 'Speed',
              unit: 'mph',
              min: 0,
              max: 160,
              x: 0.5,
              y: 0.5,
              size: 0.6,
              points: [
                { time: 0, value: 0 },
                { time: 1, value: 100 },
              ],
            },
          ],
        }}
      />,
    )

    expect(screen.getByTestId('overlay-frame')).toHaveStyle({
      width: '1920px',
      height: '1080px',
    })
    expect(screen.getByRole('meter', { name: 'Speed' })).toHaveAttribute(
      'aria-valuenow',
      '50',
    )
  })

  it('positions and sizes each gauge from its layout', () => {
    render(
      <OverlayFrame
        time={0}
        width={1000}
        height={500}
        overlay={{
          components: [
            {
              id: 'rpm',
              type: 'gauge',
              label: 'RPM',
              unit: 'rpm',
              min: 0,
              max: 9000,
              x: 0.25,
              y: 0.8,
              size: 0.4,
              points: [{ time: 0, value: 4500 }],
            },
            {
              id: 'speed',
              type: 'gauge',
              label: 'Speed',
              unit: 'mph',
              min: 0,
              max: 160,
              x: 0.75,
              y: 0.8,
              size: 0.4,
              points: [{ time: 0, value: 80 }],
            },
          ],
        }}
      />,
    )

    const rpm = screen.getByRole('meter', { name: 'RPM' })
    const speed = screen.getByRole('meter', { name: 'Speed' })
    expect(rpm).toHaveAttribute('aria-valuenow', '4500')
    expect(speed).toHaveAttribute('aria-valuenow', '80')

    // size 0.4 of a 500px-tall frame = 200px square, centered at x/y fractions
    expect(rpm.parentElement).toHaveStyle({
      left: '250px',
      top: '400px',
      width: '200px',
      height: '200px',
    })
    expect(speed.parentElement).toHaveStyle({ left: '750px' })
  })
})
