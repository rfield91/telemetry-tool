import { describe, expect, it } from 'vitest'
import {
  buildGpsTrack,
  buildSeries,
  inferNumericColumns,
  inferTimestampUnit,
  interpolate,
  parseCsv,
  sampleAt,
} from './telemetry'

const SAMPLE_CSV = `time,rpm,speed,note
0,1000,10,ok
1,2000,20,ok
2,3000,30,ok
`

const AIM_CSV = `"Format","AiM CSV File"
"Session","TSMP 1.7 CT"
"Vehicle","2004 Mazda RX8 LFX"
"Sample Rate","20"
"Beacon Markers","235.15","312.705","389.725","1126"
"Segment Times","3:55.150","1:17.555","1:17.020","12:16.273"

"Time","GPS Speed","ECU OIL P"
"s","mph","bar"

"0.000","0.1118","2.0800"
"0.050","0.1118","2.0800"
"0.100","55.5000","2.0779"
`

describe('parseCsv', () => {
  it('exposes headers and raw string rows', () => {
    const csv = parseCsv(SAMPLE_CSV, 'session.csv')

    expect(csv.fileName).toBe('session.csv')
    expect(csv.headers).toEqual(['time', 'rpm', 'speed', 'note'])
    expect(csv.rows).toHaveLength(3)
    expect(csv.rows[0]).toEqual({
      time: '0',
      rpm: '1000',
      speed: '10',
      note: 'ok',
    })
    expect(csv.metadata).toEqual({})
    expect(csv.units).toEqual({})
  })

  it('skips metadata rows above the header (AiM-style export)', () => {
    const csv = parseCsv(AIM_CSV, 'aim.csv')

    expect(csv.headers).toEqual(['Time', 'GPS Speed', 'ECU OIL P'])
    expect(csv.rows).toHaveLength(3)
    expect(csv.rows[0]).toEqual({
      Time: '0.000',
      'GPS Speed': '0.1118',
      'ECU OIL P': '2.0800',
    })
  })

  it('captures metadata and a units row from AiM-style exports', () => {
    const csv = parseCsv(AIM_CSV, 'aim.csv')

    expect(csv.metadata['Format']).toBe('AiM CSV File')
    expect(csv.metadata['Vehicle']).toBe('2004 Mazda RX8 LFX')
    expect(csv.metadata['Beacon Markers']).toBe('235.15, 312.705, 389.725, 1126')
    expect(csv.units).toEqual({
      Time: 's',
      'GPS Speed': 'mph',
      'ECU OIL P': 'bar',
    })
  })

  it('builds a usable series from AiM-style data', () => {
    const csv = parseCsv(AIM_CSV, 'aim.csv')
    const series = buildSeries(csv, {
      timestampColumn: 'Time',
      valueColumn: 'GPS Speed',
      timestampUnit: 'seconds',
    })

    expect(series.points).toEqual([
      { time: 0, value: 0.1118 },
      { time: 0.05, value: 0.1118 },
      { time: 0.1, value: 55.5 },
    ])
    expect(series.stats.invalidRows).toBe(0)
  })

  it('handles a header row without a units row', () => {
    const csv = parseCsv(
      `"Session","test"

time,rpm
0,1000
1,2000
`,
      'no-units.csv',
    )

    expect(csv.headers).toEqual(['time', 'rpm'])
    expect(csv.rows).toHaveLength(2)
    expect(csv.units).toEqual({})
    expect(csv.metadata['Session']).toBe('test')
  })
})

describe('inferNumericColumns', () => {
  it('returns columns that are mostly numeric', () => {
    const csv = parseCsv(SAMPLE_CSV, 'session.csv')
    expect(inferNumericColumns(csv)).toEqual(['time', 'rpm', 'speed'])
  })
})

describe('buildGpsTrack', () => {
  it('builds paired latitude/longitude points', () => {
    const csv = parseCsv(
      `Time,GPS Latitude,GPS Longitude
0.000,41.9800,-71.8280
0.050,41.9805,-71.8275
0.100,41.9810,-71.8270
`,
      'gps.csv',
    )
    const track = buildGpsTrack(csv, {
      timestampColumn: 'Time',
      latitudeColumn: 'GPS Latitude',
      longitudeColumn: 'GPS Longitude',
      timestampUnit: 'seconds',
    })

    expect(track.points).toEqual([
      { time: 0, lat: 41.98, lon: -71.828 },
      { time: 0.05, lat: 41.9805, lon: -71.8275 },
      { time: 0.1, lat: 41.981, lon: -71.827 },
    ])
    expect(track.stats.acceptedRows).toBe(3)
  })
})

describe('buildSeries', () => {
  it('skips invalid rows and reports stats/errors', () => {
    const csv = parseCsv(
      `time,rpm
0,1000
bad,2000
1,
2,not-a-number
3,3000
`,
      'bad.csv',
    )

    const series = buildSeries(csv, {
      timestampColumn: 'time',
      valueColumn: 'rpm',
      timestampUnit: 'seconds',
    })

    expect(series.points).toEqual([
      { time: 0, value: 1000 },
      { time: 3, value: 3000 },
    ])
    expect(series.stats.totalRows).toBe(5)
    expect(series.stats.acceptedRows).toBe(2)
    expect(series.stats.invalidRows).toBe(3)
    expect(series.errors.map((error) => error.reason)).toEqual([
      'invalid_timestamp',
      'missing_value',
      'invalid_value',
    ])
  })

  it('sorts out-of-order rows and normalizes the first accepted time to 0', () => {
    const csv = parseCsv(
      `time,rpm
15,3000
5,1000
10,2000
`,
      'unordered.csv',
    )

    const series = buildSeries(csv, {
      timestampColumn: 'time',
      valueColumn: 'rpm',
      timestampUnit: 'seconds',
    })

    expect(series.points).toEqual([
      { time: 0, value: 1000 },
      { time: 5, value: 2000 },
      { time: 10, value: 3000 },
    ])
    expect(series.stats.rawTimeStartSeconds).toBe(5)
    expect(series.stats.rawTimeEndSeconds).toBe(15)
    expect(series.stats.durationSeconds).toBe(10)
  })

  it('keeps the last value when timestamps duplicate', () => {
    const csv = parseCsv(
      `time,rpm
0,1000
1,2000
1,2500
2,3000
`,
      'dupes.csv',
    )

    const series = buildSeries(csv, {
      timestampColumn: 'time',
      valueColumn: 'rpm',
      timestampUnit: 'seconds',
    })

    expect(series.points).toEqual([
      { time: 0, value: 1000 },
      { time: 1, value: 2500 },
      { time: 2, value: 3000 },
    ])
    expect(series.stats.duplicateTimestamps).toBe(1)
    expect(series.stats.acceptedRows).toBe(3)
  })
})

describe('timestamp units', () => {
  it('converts milliseconds to normalized seconds', () => {
    const csv = parseCsv(
      `time,rpm
1000,1000
2000,2000
3500,3000
`,
      'ms.csv',
    )

    const series = buildSeries(csv, {
      timestampColumn: 'time',
      valueColumn: 'rpm',
      timestampUnit: 'milliseconds',
    })

    expect(series.timestampUnit).toBe('milliseconds')
    expect(series.points).toEqual([
      { time: 0, value: 1000 },
      { time: 1, value: 2000 },
      { time: 2.5, value: 3000 },
    ])
  })

  it('converts microseconds to normalized seconds', () => {
    const csv = parseCsv(
      `time,rpm
0,1000
500000,2000
1000000,3000
`,
      'us.csv',
    )

    const series = buildSeries(csv, {
      timestampColumn: 'time',
      valueColumn: 'rpm',
      timestampUnit: 'microseconds',
    })

    expect(series.timestampUnit).toBe('microseconds')
    expect(series.points).toEqual([
      { time: 0, value: 1000 },
      { time: 0.5, value: 2000 },
      { time: 1, value: 3000 },
    ])
  })

  it('auto-detects millisecond spacing', () => {
    expect(inferTimestampUnit([0, 10, 20, 30])).toBe('milliseconds')

    const csv = parseCsv(
      `time,rpm
0,1000
10,2000
20,3000
`,
      'auto-ms.csv',
    )
    const series = buildSeries(csv, {
      timestampColumn: 'time',
      valueColumn: 'rpm',
      timestampUnit: 'auto',
    })

    expect(series.timestampUnit).toBe('milliseconds')
    expect(series.points.map((point) => point.time)).toEqual([0, 0.01, 0.02])
  })

  it('auto-detects second and microsecond spacing', () => {
    expect(inferTimestampUnit([0, 0.1, 0.2, 0.3])).toBe('seconds')
    expect(inferTimestampUnit([0, 10_000, 20_000, 30_000])).toBe('microseconds')
  })
})

describe('sampleAt / interpolate', () => {
  const series = buildSeries(parseCsv(SAMPLE_CSV, 'session.csv'), {
    timestampColumn: 'time',
    valueColumn: 'rpm',
    timestampUnit: 'seconds',
  })

  it('linearly interpolates between samples', () => {
    expect(sampleAt(series, 0.5)).toBe(1500)
    expect(interpolate(series, 1.25)).toBe(2250)
  })

  it('clamps to boundary values outside the series range', () => {
    expect(sampleAt(series, -1)).toBe(1000)
    expect(sampleAt(series, 0)).toBe(1000)
    expect(sampleAt(series, 2)).toBe(3000)
    expect(sampleAt(series, 99)).toBe(3000)
  })

  it('returns null for an empty series', () => {
    const empty = buildSeries(parseCsv('time,rpm\nbad,x\n', 'empty.csv'), {
      timestampColumn: 'time',
      valueColumn: 'rpm',
    })
    expect(empty.points).toHaveLength(0)
    expect(sampleAt(empty, 0)).toBeNull()
  })
})
