import { describe, expect, it } from 'vitest'
import { guessCanonicalChannel } from './channels'
import { inferTimestampUnit, timestampUnitFromLabel, toUtcMs } from './time'
import { convert, lookupUnit } from './units'

describe('units', () => {
  it('looks up logger spellings case-insensitively', () => {
    expect(lookupUnit('MPH')?.id).toBe('mph')
    expect(lookupUnit('m/s^2')?.id).toBe('m/s²')
    expect(lookupUnit(' °F ')?.id).toBe('°F')
    expect(lookupUnit('furlongs')).toBeNull()
    expect(lookupUnit('')).toBeNull()
  })

  it('converts within a quantity, including offset units', () => {
    expect(convert(60, 'mph', 'km/h')).toBeCloseTo(96.56064, 4)
    expect(convert(212, '°F', '°C')).toBeCloseTo(100, 10)
    expect(convert(100, '°C', '°F')).toBeCloseTo(212, 10)
    expect(convert(1, 'bar', 'psi')).toBeCloseTo(14.5038, 3)
    expect(convert(1, 'g', 'm/s²')).toBeCloseTo(9.80665, 10)
    expect(convert(180, 'deg/s', 'rad/s')).toBeCloseTo(Math.PI, 10)
  })

  it('refuses to convert across quantities', () => {
    expect(() => convert(1, 'mph', 'psi')).toThrow(/Cannot convert/)
  })
})

describe('time', () => {
  it('infers timestamp units from sample spacing', () => {
    expect(inferTimestampUnit([0, 0.1, 0.2, 0.3])).toBe('seconds')
    expect(inferTimestampUnit([0, 10, 20, 30])).toBe('milliseconds')
    expect(inferTimestampUnit([0, 10_000, 20_000])).toBe('microseconds')
  })

  it('reads unit labels', () => {
    expect(timestampUnitFromLabel('ms')).toBe('milliseconds')
    expect(timestampUnitFromLabel('s')).toBe('seconds')
    expect(timestampUnitFromLabel('mph')).toBe('auto')
  })

  it('converts GPS-scale epoch times to UTC (18 leap seconds)', () => {
    expect(toUtcMs(1000, 'unix-gps')).toBe(982_000)
    expect(toUtcMs(1000, 'unix-utc')).toBe(1_000_000)
    expect(toUtcMs(1000, 'relative')).toBeNull()
  })
})

describe('guessCanonicalChannel', () => {
  it('maps common column names', () => {
    expect(guessCanonicalChannel('GPS Speed')).toBe('speed')
    expect(guessCanonicalChannel('Engine RPM')).toBe('rpm')
    expect(guessCanonicalChannel('Lat')).toBe('latitude')
    expect(guessCanonicalChannel('LatAcc')).toBe('lateralAccel')
    expect(guessCanonicalChannel('Oil Temp')).toBe('oilTemp')
    expect(guessCanonicalChannel('Oil Press')).toBe('oilPressure')
    expect(guessCanonicalChannel('Satellites')).toBeNull()
  })
})
