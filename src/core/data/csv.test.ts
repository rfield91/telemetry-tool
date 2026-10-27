import { describe, expect, it } from 'vitest'
import { inferNumericColumns, parseCsv, splitHeaderUnit } from './csv'

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
    expect(csv.rows[0]).toEqual({ time: '0', rpm: '1000', speed: '10', note: 'ok' })
    expect(csv.metadata).toEqual({})
    expect(csv.units).toEqual({})
  })

  it('skips metadata rows above the header (AiM-style export)', () => {
    const csv = parseCsv(AIM_CSV, 'aim.csv')
    expect(csv.headers).toEqual(['Time', 'GPS Speed', 'ECU OIL P'])
    expect(csv.rows).toHaveLength(3)
    expect(csv.rows[0]).toEqual({ Time: '0.000', 'GPS Speed': '0.1118', 'ECU OIL P': '2.0800' })
  })

  it('captures metadata and a units row', () => {
    const csv = parseCsv(AIM_CSV, 'aim.csv')
    expect(csv.metadata.Format).toBe('AiM CSV File')
    expect(csv.metadata['Beacon Markers']).toBe('235.15, 312.705, 389.725, 1126')
    expect(csv.units).toEqual({ Time: 's', 'GPS Speed': 'mph', 'ECU OIL P': 'bar' })
  })

  it('handles a header row without a units row', () => {
    const csv = parseCsv('"Session","test"\n\ntime,rpm\n0,1000\n1,2000\n', 'no-units.csv')
    expect(csv.headers).toEqual(['time', 'rpm'])
    expect(csv.rows).toHaveLength(2)
    expect(csv.units).toEqual({})
    expect(csv.metadata.Session).toBe('test')
  })

  it('makes duplicate header names unique', () => {
    const csv = parseCsv('t,a,a\n0,1,2\n1,3,4\n', 'dupes.csv')
    expect(csv.headers).toEqual(['t', 'a', 'a (2)'])
  })
})

describe('inferNumericColumns', () => {
  it('returns columns that are mostly numeric', () => {
    expect(inferNumericColumns(parseCsv(SAMPLE_CSV, 'session.csv'))).toEqual(['time', 'rpm', 'speed'])
  })
})

describe('splitHeaderUnit', () => {
  it('splits bracketed unit suffixes', () => {
    expect(splitHeaderUnit('SPEED (m/s)')).toEqual({ name: 'SPEED', unit: 'm/s' })
    expect(splitHeaderUnit('Oil Temp [°F]')).toEqual({ name: 'Oil Temp', unit: '°F' })
    expect(splitHeaderUnit('RPM')).toEqual({ name: 'RPM', unit: null })
  })
})
