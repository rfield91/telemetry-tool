import { lapsFromBoundaries } from '../../laps/laps'
import type { CanonicalChannelId } from '../channels'
import { inferNumericColumns, type ParsedCsv } from '../csv'
import { timestampUnitFromLabel } from '../time'
import type { LoggerProfile } from './types'

/** AiM Race Studio column names → canonical channels. */
const AIM_CHANNELS: Record<string, CanonicalChannelId> = {
  'GPS Speed': 'speed',
  // Units come from the units row (deg/s). Sign convention not yet checked
  // against video; see docs/REDESIGN-PLAN.md open questions.
  'GPS Gyro': 'yawRate',
  'GPS LatAcc': 'lateralAccel',
  'GPS LonAcc': 'longitudinalAccel',
  'GPS Latitude': 'latitude',
  'GPS Longitude': 'longitude',
  'GPS Altitude': 'altitude',
  'GPS Heading': 'heading',
  'Distance on GPS Speed': 'distance',
  'ECU TPS': 'throttle',
  TPS: 'throttle',
  Throttle: 'throttle',
  'Brake Press': 'brake',
  'Brake Pressure': 'brake',
  RPM: 'rpm',
  'ECU RPM': 'rpm',
  'Engine RPM': 'rpm',
  Gear: 'gear',
  'ECU ECT': 'coolantTemp',
  'Water Temp': 'coolantTemp',
  'ECU OIL T': 'oilTemp',
  'Oil Temp': 'oilTemp',
  'ECU OIL P': 'oilPressure',
  'Oil Press': 'oilPressure',
  'Fuel Press': 'fuelPressure',
  'Battery Voltage': 'batteryVoltage',
}

function timeColumn(parsed: ParsedCsv): string {
  return parsed.headers.find((header) => /^time$/i.test(header)) ?? parsed.headers[0]!
}

export const aimProfile: LoggerProfile = {
  id: 'aim',
  label: 'AiM Race Studio',
  builtIn: true,
  detect(parsed) {
    const format = parsed.metadata.Format ?? ''
    if (/AiM/i.test(format)) {
      return { confidence: 'high', reason: `Metadata Format is "${format}"` }
    }
    if (parsed.headers.includes('GPS Latitude') && parsed.headers.includes('GPS Longitude')) {
      return { confidence: 'high', reason: 'Headers include GPS Latitude and GPS Longitude' }
    }
    if (Object.keys(parsed.metadata).length > 0 && Object.keys(parsed.units).length > 0) {
      return { confidence: 'low', reason: 'Metadata preamble and units row look AiM-like' }
    }
    return null
  },
  time(parsed) {
    const column = timeColumn(parsed)
    return { column, unit: timestampUnitFromLabel(parsed.units[column]), clock: 'relative' }
  },
  channels(parsed) {
    const time = timeColumn(parsed)
    return inferNumericColumns(parsed)
      .filter((column) => column !== time)
      .map((column) => ({
        column,
        canonical: AIM_CHANNELS[column],
        unit: parsed.units[column],
      }))
  },
  laps({ parsed, duration }) {
    // "Beacon Markers" lists cumulative lap-line times in seconds; the last
    // one is usually the session end.
    const markers = (parsed.metadata['Beacon Markers'] ?? '')
      .split(',')
      .map((cell) => Number(cell.trim()))
      .filter((value) => Number.isFinite(value) && value > 0)
    if (markers.length === 0) return []
    const boundaries = [0, ...markers]
    if (boundaries[boundaries.length - 1]! < duration - 1e-6) boundaries.push(duration)
    return lapsFromBoundaries(boundaries)
  },
}
