import { lapsFromLapNumbers } from '../../laps/laps'
import type { CanonicalChannelId } from '../channels'
import { inferNumericColumns, parseFiniteNumber, splitHeaderUnit } from '../csv'
import type { LoggerProfile } from './types'

const TIME_COLUMN = 'GPS_TIME (ms)'
const LAP_COLUMN = 'MATH_LAP_NUMBER'

/** Solostorm base names (header text before the unit) → canonical channels. */
const SOLOSTORM_CHANNELS: Record<string, CanonicalChannelId> = {
  SPEED: 'speed',
  YAW_RATE: 'yawRate',
  // ACCEL_X is the lateral axis on this logger: it correlates with vehicle
  // yaw seen in video (spike/auto-sync). ACCEL_Z carries gravity.
  ACCEL_X: 'lateralAccel',
  ACCEL_Y: 'longitudinalAccel',
  ACCEL_Z: 'verticalAccel',
  LAT: 'latitude',
  LONG: 'longitude',
  ELEV: 'altitude',
  MATH_HEADING: 'heading',
  MATH_ELAPSED_DISTANCE: 'distance',
  THROTTLE: 'throttle',
  RPM: 'rpm',
  MATH_GEAR_NUMBER: 'gear',
  COOLANT_TEMPERATURE: 'coolantTemp',
  OIL_PRESSURE: 'oilPressure',
}

/** Units for columns whose headers don't state one. */
const IMPLIED_UNITS: Record<string, string> = {
  RPM: 'rpm',
  MATH_HEADING: 'deg',
  MATH_ELAPSED_DISTANCE: 'm',
}

export const solostormProfile: LoggerProfile = {
  id: 'solostorm',
  label: 'Solostorm',
  builtIn: true,
  detect(parsed) {
    const headers = new Set(parsed.headers)
    if (headers.has(TIME_COLUMN) && headers.has('SYSTEM_TIME (ms)')) {
      return { confidence: 'high', reason: 'Headers include GPS_TIME (ms) and SYSTEM_TIME (ms)' }
    }
    return null
  },
  time() {
    // Unix-epoch milliseconds on the GPS time scale (18 s ahead of UTC).
    return { column: TIME_COLUMN, unit: 'milliseconds', clock: 'unix-gps' }
  },
  channels(parsed) {
    return inferNumericColumns(parsed)
      .filter((column) => column !== TIME_COLUMN && column !== 'SYSTEM_TIME (ms)')
      .map((column) => {
        const { name, unit } = splitHeaderUnit(column)
        return {
          column,
          canonical: SOLOSTORM_CHANNELS[name],
          unit: unit ?? IMPLIED_UNITS[name],
          label: name,
        }
      })
  },
  laps({ parsed, rowTimes }) {
    if (!parsed.headers.includes(LAP_COLUMN)) return []
    const lapNumbers = Float64Array.from(parsed.rows, (row) => parseFiniteNumber(row[LAP_COLUMN]) ?? NaN)
    return lapsFromLapNumbers(rowTimes, lapNumbers)
  },
}
