import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { GMeter } from './GMeter'
import {
  formatGValue,
  gMeterFraction,
  hasAimGMeterColumns,
  niceMaxG,
} from '../lib/gMeter'
import { OverlayFrame } from '../export/OverlayFrame'

afterEach(cleanup)

describe('g-meter helpers', () => {
  it('maps signed g values into a ±maxG plot fraction', () => {
    expect(gMeterFraction(0, 2)).toBe(0.5)
    expect(gMeterFraction(-2, 2)).toBe(0)
    expect(gMeterFraction(2, 2)).toBe(1)
    expect(gMeterFraction(4, 2)).toBe(1)
    expect(gMeterFraction(-4, 2)).toBe(0)
  })

  it('formats g values to two decimal places', () => {
    expect(formatGValue(0.856)).toBe('0.86')
    expect(formatGValue(-1.2)).toBe('-1.20')
    expect(formatGValue(0)).toBe('0.00')
  })

  it('picks a tidy maxG from sample peaks', () => {
    expect(niceMaxG([])).toBe(2)
    expect(niceMaxG([0.4, -0.3])).toBe(1.5)
    expect(niceMaxG([1.1, -2.04])).toBe(2.5)
  })

  it('detects AiM LatAcc / LonAcc columns', () => {
    expect(hasAimGMeterColumns(['GPS LatAcc', 'GPS LonAcc'])).toBe(true)
    expect(hasAimGMeterColumns(['GPS Latitude', 'GPS Longitude'])).toBe(false)
  })
})

describe('GMeter', () => {
  it('exposes accessible lateral and longitudinal values', () => {
    render(
      <GMeter lateral={0.85} longitudinal={-0.42} maxG={2} label="G-Force" />,
    )

    expect(
      screen.getByRole('img', {
        name: 'G-Force: lateral 0.85 g, longitudinal -0.42 g',
      }),
    ).toBeInTheDocument()
  })
})

describe('OverlayFrame g-meter', () => {
  it('renders a g-meter from dual lateral/longitudinal series', () => {
    render(
      <OverlayFrame
        time={0.5}
        width={1920}
        height={1080}
        overlay={{
          components: [
            {
              id: 'g',
              type: 'g-meter',
              label: 'G',
              maxG: 2,
              x: 0.5,
              y: 0.5,
              size: 0.4,
              lateralPoints: [
                { time: 0, value: 0 },
                { time: 1, value: 1 },
              ],
              longitudinalPoints: [
                { time: 0, value: 0 },
                { time: 1, value: -1 },
              ],
            },
          ],
        }}
      />,
    )

    expect(
      screen.getByRole('img', {
        name: 'G: lateral 0.50 g, longitudinal -0.50 g',
      }),
    ).toBeInTheDocument()
  })
})
