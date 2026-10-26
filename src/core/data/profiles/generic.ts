import { guessCanonicalChannel, type CanonicalChannelId } from '../channels'
import { inferNumericColumns, parseFiniteNumber, splitHeaderUnit, type ParsedCsv } from '../csv'
import { guessClock, inferTimestampUnit, timestampUnitFromLabel, UNIT_TO_SECONDS } from '../time'
import type { ChannelMapping, LoggerProfile, TimeMapping } from './types'

const TIME_HEADER = /(^|[_\s])(time|timestamp|elapsed|utc)([_\s([]|$)/i

/** Best guess at the time column: a time-like name, else the first numeric column. */
export function guessTimeColumn(parsed: ParsedCsv): string {
  const numeric = inferNumericColumns(parsed)
  return (
    numeric.find((header) => TIME_HEADER.test(header)) ??
    parsed.headers.find((header) => TIME_HEADER.test(header)) ??
    numeric[0] ??
    parsed.headers[0]!
  )
}

/** Unit text for a column from its header suffix or the units row. */
export function columnUnitText(parsed: ParsedCsv, column: string): string | undefined {
  return splitHeaderUnit(column).unit ?? parsed.units[column] ?? undefined
}

export function guessTimeMapping(parsed: ParsedCsv): TimeMapping {
  const column = guessTimeColumn(parsed)
  let unit = timestampUnitFromLabel(columnUnitText(parsed, column))
  const raw: number[] = []
  for (const row of parsed.rows) {
    const value = parseFiniteNumber(row[column])
    if (value !== null) raw.push(value)
    if (raw.length >= 200) break
  }
  if (unit === 'auto' && raw.length > 0) unit = inferTimestampUnit(raw)
  const firstSeconds = raw.length > 0 && unit !== 'auto' ? raw[0]! * UNIT_TO_SECONDS[unit] : 0
  return { column, unit, clock: guessClock(firstSeconds) }
}

/** Every numeric column except time, with a guessed canonical role each. */
export function guessChannelMappings(parsed: ParsedCsv, timeColumn: string): ChannelMapping[] {
  const taken = new Set<CanonicalChannelId>()
  return inferNumericColumns(parsed)
    .filter((column) => column !== timeColumn)
    .map((column) => {
      const { name } = splitHeaderUnit(column)
      const guess = guessCanonicalChannel(name)
      // One column per canonical role; later matches stay unmapped.
      const canonical = guess && !taken.has(guess) ? guess : undefined
      if (canonical) taken.add(canonical)
      return { column, canonical, unit: columnUnitText(parsed, column), label: name }
    })
}

/** Fallback for unrecognised CSVs; its guesses seed the mapping screen. */
export const genericProfile: LoggerProfile = {
  id: 'generic',
  label: 'Generic CSV',
  builtIn: true,
  detect() {
    return null
  },
  time: guessTimeMapping,
  channels(parsed) {
    return guessChannelMappings(parsed, guessTimeColumn(parsed))
  },
}
