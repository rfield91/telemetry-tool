import type { Quantity } from './units'

/**
 * Logger-independent channel identities. Widgets, sync and layout templates
 * bind to these, so a layout built on AiM data works on Solostorm data.
 */
export type CanonicalChannelId =
  | 'speed'
  | 'yawRate'
  | 'lateralAccel'
  | 'longitudinalAccel'
  | 'verticalAccel'
  | 'latitude'
  | 'longitude'
  | 'altitude'
  | 'heading'
  | 'distance'
  | 'throttle'
  | 'brake'
  | 'steeringAngle'
  | 'rpm'
  | 'gear'
  | 'coolantTemp'
  | 'oilTemp'
  | 'oilPressure'
  | 'fuelPressure'
  | 'boostPressure'
  | 'batteryVoltage'

export interface CanonicalChannel {
  id: CanonicalChannelId
  label: string
  /** Null for unitless channels such as gear. */
  quantity: Quantity | null
  /** Default display unit (US conventions; user-configurable later). */
  displayUnit: string | null
}

export const CANONICAL_CHANNELS: Record<CanonicalChannelId, CanonicalChannel> = {
  speed: { id: 'speed', label: 'Speed', quantity: 'speed', displayUnit: 'mph' },
  yawRate: { id: 'yawRate', label: 'Yaw rate', quantity: 'angularRate', displayUnit: 'deg/s' },
  lateralAccel: { id: 'lateralAccel', label: 'Lateral g', quantity: 'acceleration', displayUnit: 'g' },
  longitudinalAccel: { id: 'longitudinalAccel', label: 'Longitudinal g', quantity: 'acceleration', displayUnit: 'g' },
  verticalAccel: { id: 'verticalAccel', label: 'Vertical g', quantity: 'acceleration', displayUnit: 'g' },
  latitude: { id: 'latitude', label: 'Latitude', quantity: 'angle', displayUnit: 'deg' },
  longitude: { id: 'longitude', label: 'Longitude', quantity: 'angle', displayUnit: 'deg' },
  altitude: { id: 'altitude', label: 'Altitude', quantity: 'distance', displayUnit: 'ft' },
  heading: { id: 'heading', label: 'Heading', quantity: 'angle', displayUnit: 'deg' },
  distance: { id: 'distance', label: 'Distance', quantity: 'distance', displayUnit: 'mi' },
  throttle: { id: 'throttle', label: 'Throttle', quantity: 'percent', displayUnit: '%' },
  brake: { id: 'brake', label: 'Brake', quantity: null, displayUnit: null },
  steeringAngle: { id: 'steeringAngle', label: 'Steering angle', quantity: 'angle', displayUnit: 'deg' },
  rpm: { id: 'rpm', label: 'RPM', quantity: 'rotation', displayUnit: 'rpm' },
  gear: { id: 'gear', label: 'Gear', quantity: null, displayUnit: null },
  coolantTemp: { id: 'coolantTemp', label: 'Coolant temp', quantity: 'temperature', displayUnit: '°F' },
  oilTemp: { id: 'oilTemp', label: 'Oil temp', quantity: 'temperature', displayUnit: '°F' },
  oilPressure: { id: 'oilPressure', label: 'Oil pressure', quantity: 'pressure', displayUnit: 'psi' },
  fuelPressure: { id: 'fuelPressure', label: 'Fuel pressure', quantity: 'pressure', displayUnit: 'psi' },
  boostPressure: { id: 'boostPressure', label: 'Boost', quantity: 'pressure', displayUnit: 'psi' },
  batteryVoltage: { id: 'batteryVoltage', label: 'Battery', quantity: 'voltage', displayUnit: 'V' },
}

export function isCanonicalChannelId(value: unknown): value is CanonicalChannelId {
  return typeof value === 'string' && value in CANONICAL_CHANNELS
}

/**
 * Name heuristics for unknown loggers, tried in order. Only used as the
 * starting guess on the mapping screen; users confirm or correct it.
 */
const NAME_GUESSES: Array<[RegExp, CanonicalChannelId]> = [
  [/\b(gps[\s_]*)?speed\b|\bvelocity\b|\bvss\b/i, 'speed'],
  [/\byaw[\s_]*rate\b|\bgyro[\s_]*z\b|\bgps[\s_]*gyro\b/i, 'yawRate'],
  [/\blat(eral)?[\s_]*(acc|accel|g)\b|\blatacc\b|\bg[\s_]*lat\b/i, 'lateralAccel'],
  [/\blon(gitudinal)?[\s_]*(acc|accel|g)\b|\blonacc\b|\bg[\s_]*long?\b/i, 'longitudinalAccel'],
  [/^(gps[\s_]*)?lat(itude)?$/i, 'latitude'],
  [/^(gps[\s_]*)?(lon|long|lng|longitude)$/i, 'longitude'],
  [/\b(altitude|elevation|elev|alt)\b/i, 'altitude'],
  [/\b(heading|course|bearing)\b/i, 'heading'],
  [/\bthrottle\b|\btps\b|\bpedal\b/i, 'throttle'],
  [/\bbrake\b/i, 'brake'],
  [/\bsteer/i, 'steeringAngle'],
  [/\brpm\b|\bengine[\s_]*speed\b/i, 'rpm'],
  [/\bgear\b/i, 'gear'],
  [/\b(coolant|water|ect)\b/i, 'coolantTemp'],
  [/\boil[\s_]*t(emp(erature)?)?\b/i, 'oilTemp'],
  [/\boil[\s_]*p(ress(ure)?)?\b/i, 'oilPressure'],
  [/\bfuel[\s_]*p(ress(ure)?)?\b/i, 'fuelPressure'],
  [/\bboost\b|\bmap\b/i, 'boostPressure'],
  [/\b(battery|batt|voltage)\b/i, 'batteryVoltage'],
  [/\bdistance\b|\bodometer\b/i, 'distance'],
]

export function guessCanonicalChannel(name: string): CanonicalChannelId | null {
  for (const [pattern, id] of NAME_GUESSES) if (pattern.test(name)) return id
  return null
}
