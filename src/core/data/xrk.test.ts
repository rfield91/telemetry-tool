import { describe, expect, it } from 'vitest'
import aimCsv from '../../../sample-data/3.csv?raw'
import xrkBase64 from '../../../sample-data/xrk/rx8-thompson-trimmed.xrk.b64?raw'
import { fromBase64 } from '../media/testing'
import { findChannel, importTelemetry, importXrk } from './import'
import { sampleAt } from './series'
import { ecefToLla, inflateXrz, isXrk, parseXrk, singleChunk } from './xrk'

// The XRK behind sample-data/3.csv (same session), trimmed to the
// configuration, the first ~35 s of data, the five lap markers and the
// closing session strings.
const bytes = fromBase64(xrkBase64)

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = singleChunk(data).pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

describe('parseXrk', () => {
  const file = parseXrk(bytes)
  const channel = (name: string) => file.channels.find((c) => c.name === name)!

  it('reads every message and the session strings', () => {
    expect(file.skippedBytes).toBe(0)
    expect(file.metadata).toMatchObject({
      Racer: 'Ryan Field',
      Vehicle: '2004 Mazda RX8 LFX',
      Venue: 'Thompson Bridge SF',
      Date: '07/18/2026',
      Time: '13:27:13',
    })
  })

  it('reads lap markers as contiguous laps', () => {
    expect(file.laps.map((lap) => [lap.number, lap.start, lap.end])).toEqual([
      [1, 0, 196008],
      [2, 196008, 273965],
      [3, 273965, 351196],
      [4, 351196, 428313],
      [5, 428313, 1125337],
    ])
  })

  it('decodes channels with their rates and units', () => {
    expect(channel('YawRate')).toMatchObject({ unit: 'deg/s' })
    expect(channel('LateralAcc').unit).toBe('g')
    expect(channel('ECU_OIL_P').unit).toBe('bar')
    expect(channel('ECU_OIL_T').unit).toBe('C')
    expect(channel('External Voltage').unit).toBe('V')
    const rate = (name: string) => {
      const { times } = channel(name)
      return ((times.length - 1) * 1000) / (times[times.length - 1]! - times[0]!)
    }
    expect(rate('YawRate')).toBeCloseTo(50, 0)
    expect(rate('ECU_RPM')).toBeCloseTo(10, 0)
    expect(rate('GPS Speed')).toBeCloseTo(10, 0)
    // mV scaled to volts.
    const volts = channel('External Voltage').values[0]!
    expect(volts).toBeGreaterThan(13)
    expect(volts).toBeLessThan(15)
  })

  it('converts GPS fixes to positions near Thompson', () => {
    const lat = channel('GPS Latitude').values
    const lon = channel('GPS Longitude').values
    expect(lat[0]).toBeCloseTo(41.98, 2)
    expect(lon[0]).toBeCloseTo(-71.83, 2)
  })

  it('rejects other files and inflates .xrz data', async () => {
    expect(isXrk(new TextEncoder().encode('Time,Speed\n0,1\n'))).toBe(false)
    expect(() => parseXrk(new Uint8Array(64))).toThrow(/not an AiM XRK/)
    const inflated = await inflateXrz(await deflate(bytes))
    expect(inflated).toEqual(bytes)
    expect(await inflateXrz(bytes)).toBe(bytes)
  })
})

describe('ecefToLla', () => {
  it('matches a known point', () => {
    // 0°N 0°E on the ellipsoid.
    const [lat, lon, alt] = ecefToLla(6378137, 0, 0)
    expect(lat).toBeCloseTo(0, 9)
    expect(lon).toBeCloseTo(0, 9)
    expect(alt).toBeCloseTo(0, 3)
  })
})

describe('importXrk', () => {
  const session = importXrk(bytes, 'session.xrk')
  const csv = importTelemetry(aimCsv, '3.csv')

  it('maps canonical channels in base units', () => {
    expect(session.profileId).toBe('aim-xrk')
    expect(session.warnings).toEqual([])
    expect(session.channels.flatMap((c) => (c.canonical ? [c.canonical] : []))).toEqual(
      expect.arrayContaining([
        'speed', 'yawRate', 'lateralAccel', 'longitudinalAccel', 'verticalAccel', 'latitude', 'longitude',
        'altitude', 'heading', 'throttle', 'rpm', 'gear', 'coolantTemp', 'oilTemp', 'oilPressure', 'batteryVoltage',
      ]),
    )
    expect(findChannel(session, 'yawRate')).toMatchObject({ key: 'YawRate', sourceUnit: 'deg/s', unit: 'rad/s' })
    expect(findChannel(session, 'oilPressure')).toMatchObject({ key: 'ECU_OIL_P', unit: 'kPa' })
    expect(findChannel(session, 'oilTemp')).toMatchObject({ key: 'ECU_OIL_T', unit: '°C' })
  })

  it('builds out, timed and in laps', () => {
    expect(session.laps.map((lap) => [lap.kind, lap.loggerNumber, Number(lap.duration.toFixed(3))])).toEqual([
      ['out', 1, 196.008],
      ['timed', 2, 77.957],
      ['timed', 3, 77.231],
      ['timed', 4, 77.117],
      ['in', 5, 697.024],
    ])
  })

  it('shares its clock and values with the CSV export of the same session', () => {
    const pairs: Array<[Parameters<typeof findChannel>[1], number]> = [
      ['speed', 0.01],
      ['latitude', 1e-6],
      ['longitude', 1e-6],
      ['oilTemp', 0.6],
      ['oilPressure', 1],
    ]
    for (const [id, tolerance] of pairs) {
      const a = findChannel(session, id)!.series
      const b = findChannel(csv, id)!.series
      for (const t of [5, 15, 25, 32]) {
        expect(Math.abs(sampleAt(a, t)! - sampleAt(b, t)!), `${id} at ${t} s`).toBeLessThan(tolerance)
      }
    }
  })
})
