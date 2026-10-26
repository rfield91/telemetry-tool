export type Quantity =
  | 'speed'
  | 'angularRate'
  | 'acceleration'
  | 'angle'
  | 'temperature'
  | 'pressure'
  | 'distance'
  | 'percent'
  | 'rotation'
  | 'time'
  | 'voltage'

export interface UnitDefinition {
  id: string
  quantity: Quantity
  /** Lower-case spellings found in logger headers and units rows. */
  aliases: string[]
  /** base = value * scale + offset */
  scale: number
  offset?: number
}

/**
 * Base unit per quantity; imported channel values are stored in these.
 * Temperatures use °C and pressures kPa so stored values stay readable.
 */
export const BASE_UNITS: Record<Quantity, string> = {
  speed: 'm/s',
  angularRate: 'rad/s',
  acceleration: 'm/s²',
  angle: 'deg',
  temperature: '°C',
  pressure: 'kPa',
  distance: 'm',
  percent: '%',
  rotation: 'rpm',
  time: 's',
  voltage: 'V',
}

const STANDARD_GRAVITY = 9.80665

export const UNITS: readonly UnitDefinition[] = [
  { id: 'm/s', quantity: 'speed', aliases: ['m/s', 'mps'], scale: 1 },
  { id: 'km/h', quantity: 'speed', aliases: ['km/h', 'kph', 'kmh'], scale: 1 / 3.6 },
  { id: 'mph', quantity: 'speed', aliases: ['mph', 'mi/h'], scale: 0.44704 },
  { id: 'ft/s', quantity: 'speed', aliases: ['ft/s', 'fps'], scale: 0.3048 },
  { id: 'kn', quantity: 'speed', aliases: ['kn', 'kt', 'knots'], scale: 1852 / 3600 },

  { id: 'rad/s', quantity: 'angularRate', aliases: ['rad/s'], scale: 1 },
  { id: 'deg/s', quantity: 'angularRate', aliases: ['deg/s', '°/s', 'dps'], scale: Math.PI / 180 },

  { id: 'm/s²', quantity: 'acceleration', aliases: ['m/s²', 'm/s^2', 'm/s2', 'mps2'], scale: 1 },
  { id: 'g', quantity: 'acceleration', aliases: ['g', 'g-force'], scale: STANDARD_GRAVITY },

  { id: 'deg', quantity: 'angle', aliases: ['deg', '°', 'degrees', 'degree'], scale: 1 },
  { id: 'rad', quantity: 'angle', aliases: ['rad', 'radians'], scale: 180 / Math.PI },

  { id: '°C', quantity: 'temperature', aliases: ['°c', 'c', 'degc', 'celsius'], scale: 1 },
  { id: '°F', quantity: 'temperature', aliases: ['°f', 'f', 'degf', 'fahrenheit'], scale: 5 / 9, offset: (-32 * 5) / 9 },
  { id: 'K', quantity: 'temperature', aliases: ['k', 'kelvin'], scale: 1, offset: -273.15 },

  { id: 'kPa', quantity: 'pressure', aliases: ['kpa'], scale: 1 },
  { id: 'Pa', quantity: 'pressure', aliases: ['pa'], scale: 1e-3 },
  { id: 'hPa', quantity: 'pressure', aliases: ['hpa'], scale: 0.1 },
  { id: 'mbar', quantity: 'pressure', aliases: ['mbar'], scale: 0.1 },
  { id: 'bar', quantity: 'pressure', aliases: ['bar'], scale: 100 },
  { id: 'psi', quantity: 'pressure', aliases: ['psi'], scale: 6.894757293168 },

  { id: 'm', quantity: 'distance', aliases: ['m', 'meters', 'metres'], scale: 1 },
  { id: 'km', quantity: 'distance', aliases: ['km'], scale: 1000 },
  { id: 'mm', quantity: 'distance', aliases: ['mm'], scale: 1e-3 },
  { id: 'cm', quantity: 'distance', aliases: ['cm'], scale: 1e-2 },
  { id: 'ft', quantity: 'distance', aliases: ['ft', 'feet'], scale: 0.3048 },
  { id: 'mi', quantity: 'distance', aliases: ['mi', 'miles'], scale: 1609.344 },

  { id: '%', quantity: 'percent', aliases: ['%', 'pct', 'percent'], scale: 1 },
  { id: 'rpm', quantity: 'rotation', aliases: ['rpm', 'r/min'], scale: 1 },

  { id: 's', quantity: 'time', aliases: ['s', 'sec', 'seconds'], scale: 1 },
  { id: 'ms', quantity: 'time', aliases: ['ms', 'msec'], scale: 1e-3 },

  { id: 'V', quantity: 'voltage', aliases: ['v', 'volts'], scale: 1 },
  { id: 'mV', quantity: 'voltage', aliases: ['mv'], scale: 1e-3 },
]

const BY_ALIAS = new Map<string, UnitDefinition>()
for (const unit of UNITS) {
  for (const alias of unit.aliases) BY_ALIAS.set(alias, unit)
  BY_ALIAS.set(unit.id.toLowerCase(), unit)
}

/** Look up a unit from free text (`"MPH"`, `"m/s^2"`, `"°F"`); null if unknown. */
export function lookupUnit(text: string | null | undefined): UnitDefinition | null {
  const key = (text ?? '').trim().toLowerCase().replace(/\s+/g, '')
  return key === '' ? null : (BY_ALIAS.get(key) ?? null)
}

export function getUnit(id: string): UnitDefinition {
  const unit = UNITS.find((candidate) => candidate.id === id)
  if (!unit) throw new Error(`Unknown unit "${id}"`)
  return unit
}

export function unitsFor(quantity: Quantity): UnitDefinition[] {
  return UNITS.filter((unit) => unit.quantity === quantity)
}

export function toBase(value: number, unit: UnitDefinition): number {
  return value * unit.scale + (unit.offset ?? 0)
}

export function fromBase(value: number, unit: UnitDefinition): number {
  return (value - (unit.offset ?? 0)) / unit.scale
}

/** Convert between two units of the same quantity. */
export function convert(value: number, from: string, to: string): number {
  if (from === to) return value
  const source = getUnit(from)
  const target = getUnit(to)
  if (source.quantity !== target.quantity) {
    throw new Error(`Cannot convert ${source.quantity} (${from}) to ${target.quantity} (${to})`)
  }
  return fromBase(toBase(value, source), target)
}
