import { describe, expect, it } from 'vitest'
import { detectCsvFormat } from './csvFormats'
import { parseCsv } from './telemetry'

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

describe('detectCsvFormat', () => {
  it('detects AiM from Format metadata with high confidence', () => {
    const csv = parseCsv(AIM_CSV, 'aim.csv')
    const detection = detectCsvFormat(csv)

    expect(detection).toEqual({
      id: 'aim',
      confidence: 'high',
      reason: 'Metadata Format is "AiM CSV File"',
    })
  })

  it('detects AiM from GPS Latitude/Longitude headers with high confidence', () => {
    const csv = parseCsv(
      `Time,GPS Latitude,GPS Longitude
0.000,41.9800,-71.8280
0.050,41.9805,-71.8275
`,
      'gps.csv',
    )
    const detection = detectCsvFormat(csv)

    expect(detection.id).toBe('aim')
    expect(detection.confidence).toBe('high')
    expect(detection.reason).toMatch(/GPS Latitude/)
  })

  it('falls back to Generic for plain header CSVs', () => {
    const csv = parseCsv(SAMPLE_CSV, 'session.csv')
    const detection = detectCsvFormat(csv)

    expect(detection).toEqual({
      id: 'generic',
      confidence: 'high',
      reason: 'No logger-specific fingerprints found',
    })
  })

  it('detects AiM with low confidence from preamble + units without Format/GPS', () => {
    const csv = parseCsv(
      `"Session","practice"

"Time","RPM","Speed"
"s","rpm","mph"

"0.000","1000","10"
"0.050","1100","12"
`,
      'ambiguous.csv',
    )
    const detection = detectCsvFormat(csv)

    expect(detection).toEqual({
      id: 'aim',
      confidence: 'low',
      reason: 'Metadata preamble and units row look AiM-like',
    })
  })
})
