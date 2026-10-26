import { describe, expect, it } from 'vitest'
import aimCsv from '../../../sample-data/3.csv?raw'
import nerCsv from '../../../sample-data/solostorm/ner-autocross-lap7.csv?raw'
import svtCsv from '../../../sample-data/solostorm/svt-canaan-lap37.csv?raw'
import { findChannel, importTelemetry, type TelemetrySession } from './import'
import { ProfileRegistry } from './profiles/registry'
import type { UserProfileDefinition } from './profiles/user'
import { sampleAt } from './series'
import { convert } from './units'

function canonicalIds(session: TelemetrySession) {
  return session.channels.flatMap((channel) => (channel.canonical ? [channel.canonical] : []))
}

describe('AiM import (sample-data/3.csv)', () => {
  const session = importTelemetry(aimCsv, '3.csv')

  it('detects the AiM profile and a relative clock', () => {
    expect(session.profileId).toBe('aim')
    expect(session.time).toMatchObject({ column: 'Time', unit: 'seconds', clock: 'relative', startUtcMs: null })
    expect(session.duration).toBeCloseTo(1125.95, 2)
    expect(session.warnings).toEqual([])
  })

  it('maps canonical channels and converts to base units', () => {
    expect(canonicalIds(session)).toEqual(
      expect.arrayContaining(['speed', 'yawRate', 'lateralAccel', 'longitudinalAccel', 'latitude', 'longitude', 'throttle', 'coolantTemp', 'oilTemp', 'oilPressure']),
    )
    const speed = findChannel(session, 'speed')!
    expect(speed).toMatchObject({ key: 'GPS Speed', sourceUnit: 'mph', unit: 'm/s', quantity: 'speed' })
    // First sample is 0.1118 mph.
    expect(sampleAt(speed.series, 0)).toBeCloseTo(convert(0.1118, 'mph', 'm/s'), 9)
    expect(findChannel(session, 'oilPressure')).toMatchObject({ sourceUnit: 'bar', unit: 'kPa' })
    expect(findChannel(session, 'yawRate')).toMatchObject({ key: 'GPS Gyro', sourceUnit: 'deg/s', unit: 'rad/s' })
  })

  it('builds laps from beacon markers matching the segment times', () => {
    expect(session.laps.map((lap) => [lap.kind, Number(lap.duration.toFixed(3))])).toEqual([
      ['out', 235.15],
      ['timed', 77.555],
      ['timed', 77.02],
      ['in', 736.275],
    ])
  })
})

describe('Solostorm import', () => {
  it('reads the NER autocross lap with GPS-scale timestamps', () => {
    const session = importTelemetry(nerCsv, 'ner.csv')
    expect(session.profileId).toBe('solostorm')
    expect(session.rowCount).toBe(1775)
    expect(session.duration).toBeCloseTo(70.961, 3)
    // GPS_TIME 17:57:03.544 on the GPS scale = 17:56:45.544 UTC.
    expect(new Date(session.time.startUtcMs!).toISOString()).toBe('2026-10-25T17:56:45.544Z')
    expect(session.laps).toMatchObject([{ loggerNumber: 7, kind: 'timed' }])
    expect(session.laps[0]!.duration).toBeCloseTo(70.961, 3)
    expect(session.warnings).toEqual([])
  })

  it('maps Solostorm channels with header units', () => {
    const session = importTelemetry(svtCsv, 'svt.csv')
    expect(session.laps).toMatchObject([{ loggerNumber: 37 }])
    expect(session.laps[0]!.duration).toBeCloseTo(61.831, 3)
    expect(findChannel(session, 'yawRate')).toMatchObject({ key: 'YAW_RATE (rad/s)', unit: 'rad/s' })
    expect(findChannel(session, 'lateralAccel')).toMatchObject({ key: 'ACCEL_X (m/s^2)', unit: 'm/s²' })
    expect(findChannel(session, 'coolantTemp')).toMatchObject({ sourceUnit: '°C', unit: '°C' })
    expect(findChannel(session, 'oilPressure')).toMatchObject({ sourceUnit: 'kPa', unit: 'kPa' })
    expect(findChannel(session, 'rpm')).toMatchObject({ key: 'RPM', unit: 'rpm' })
    const speed = findChannel(session, 'speed')!
    expect(speed.range!.max).toBeGreaterThan(40)
    expect(speed.range!.max).toBeLessThan(50)
  })
})

describe('generic import', () => {
  const csv = `Timestamp (ms),Speed [km/h],Engine RPM,Mystery
1700000000000,0,900,1
1700000000100,36,2000,2
1700000000200,72,3000,3
`

  it('guesses time, clock, units and channel roles', () => {
    const session = importTelemetry(csv, 'other-logger.csv')
    expect(session.profileId).toBe('generic')
    expect(session.detection.confidence).toBe('low')
    expect(session.time).toMatchObject({ column: 'Timestamp (ms)', unit: 'milliseconds', clock: 'unix-utc' })
    expect(session.time.startUtcMs).toBe(1_700_000_000_000)
    expect(session.duration).toBeCloseTo(0.2, 9)
    const speed = findChannel(session, 'speed')!
    expect(speed.unit).toBe('m/s')
    expect(sampleAt(speed.series, 0.2)).toBeCloseTo(20, 9)
    expect(findChannel(session, 'rpm')?.key).toBe('Engine RPM')
    expect(session.channels.find((channel) => channel.key === 'Mystery')?.canonical).toBeNull()
  })

  it('warns when a mapped unit does not fit the channel', () => {
    const session = importTelemetry('time,speed (psi)\n0,1\n1,2\n', 'odd.csv')
    expect(findChannel(session, 'speed')).toBeUndefined()
    expect(session.warnings[0]).toMatch(/not a speed unit/)
  })
})

describe('user profiles', () => {
  const definition: UserProfileDefinition = {
    version: 1,
    id: 'my-logger',
    label: 'My logger',
    match: { headers: ['t', 'v', 'lapno'] },
    time: { column: 't', unit: 'seconds', clock: 'relative' },
    channels: [{ column: 'v', canonical: 'speed', unit: 'mph' }],
    lapColumn: 'lapno',
  }
  const csv = 't,v,lapno\n0,10,1\n1,20,1\n2,30,2\n3,40,2\n4,50,3\n5,60,3\n'

  it('is detected before built-ins and applies the saved mapping', () => {
    const registry = new ProfileRegistry()
    registry.addUserProfile(definition)
    const session = importTelemetry(csv, 'mine.csv', registry)
    expect(session.profileId).toBe('my-logger')
    expect(findChannel(session, 'speed')).toMatchObject({ sourceUnit: 'mph', unit: 'm/s' })
    expect(session.laps.map((lap) => [lap.loggerNumber, lap.kind])).toEqual([
      [1, 'out'],
      [2, 'timed'],
      [3, 'in'],
    ])
  })

  it('reserves built-in ids', () => {
    expect(() => new ProfileRegistry().addUserProfile({ ...definition, id: 'aim' })).toThrow(/reserved/)
  })
})
