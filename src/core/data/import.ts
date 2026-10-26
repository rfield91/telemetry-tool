import type { Lap } from '../laps/laps'
import { CANONICAL_CHANNELS, type CanonicalChannelId } from './channels'
import { parseCsv, parseFiniteNumber, type ParsedCsv } from './csv'
import { ProfileRegistry } from './profiles/registry'
import type { Detection, LoggerProfile } from './profiles/types'
import { buildSeries, seriesRange, type Series, type SeriesStats } from './series'
import { resolveTimestampUnit, toUtcMs, UNIT_TO_SECONDS, type ResolvedTimestampUnit, type TimeClock } from './time'
import { BASE_UNITS, lookupUnit, toBase, type Quantity } from './units'

export interface TelemetryChannel {
  /** Source column name; unique within a session. */
  key: string
  label: string
  canonical: CanonicalChannelId | null
  quantity: Quantity | null
  /** Unit the stored values are in (the quantity's base unit), or null if unknown. */
  unit: string | null
  /** Unit text as written by the logger. */
  sourceUnit: string | null
  series: Series
  range: { min: number; max: number } | null
  stats: SeriesStats
}

export interface TelemetrySession {
  fileName: string
  profileId: string
  profileLabel: string
  detection: Detection
  time: {
    column: string
    unit: ResolvedTimestampUnit
    clock: TimeClock
    /** UTC epoch ms of session time zero, when the logger's clock is absolute. */
    startUtcMs: number | null
  }
  /** Seconds from the first to the last valid timestamp. */
  duration: number
  rowCount: number
  channels: TelemetryChannel[]
  laps: Lap[]
  metadata: Record<string, string>
  /** Non-fatal problems worth showing on the mapping screen. */
  warnings: string[]
}

export interface ImportOptions {
  /** Force a profile instead of auto-detecting. */
  profileId?: string
}

export function importTelemetry(
  text: string,
  fileName: string,
  registry: ProfileRegistry = new ProfileRegistry(),
  options: ImportOptions = {},
): TelemetrySession {
  const parsed = parseCsv(text, fileName)
  if (parsed.headers.length < 2 || parsed.rows.length === 0) {
    throw new Error('The CSV needs a header row and at least one data row.')
  }
  if (options.profileId) {
    const profile = registry.get(options.profileId)
    if (!profile) throw new Error(`Unknown logger profile "${options.profileId}"`)
    return importParsed(parsed, profile, { confidence: 'high', reason: 'Selected manually' })
  }
  const { profile, detection } = registry.detect(parsed)
  return importParsed(parsed, profile, detection)
}

export function importParsed(
  parsed: ParsedCsv,
  profile: LoggerProfile,
  detection: Detection,
): TelemetrySession {
  const warnings: string[] = []
  const timeMapping = profile.time(parsed)
  if (!parsed.headers.includes(timeMapping.column)) {
    throw new Error(`Time column "${timeMapping.column}" is not in this file.`)
  }

  const rawTimes = Float64Array.from(parsed.rows, (row) => parseFiniteNumber(row[timeMapping.column]) ?? NaN)
  const validRaw: number[] = []
  let zeroRaw = Infinity
  for (const value of rawTimes) {
    if (!Number.isFinite(value)) continue
    if (validRaw.length < 2000) validRaw.push(value)
    if (value < zeroRaw) zeroRaw = value
  }
  if (!Number.isFinite(zeroRaw)) {
    throw new Error(`No valid timestamps in column "${timeMapping.column}".`)
  }
  const timeUnit = resolveTimestampUnit(timeMapping.unit, validRaw)
  const scale = UNIT_TO_SECONDS[timeUnit]
  const rowTimes = rawTimes.map((raw) => (raw - zeroRaw) * scale)
  let duration = 0
  for (const t of rowTimes) if (t > duration) duration = t

  const channels: TelemetryChannel[] = []
  const claimed = new Set<CanonicalChannelId>()
  for (const mapping of profile.channels(parsed)) {
    const sourceUnit = mapping.unit?.trim() || null
    const unitDef = lookupUnit(sourceUnit)
    let canonical = mapping.canonical ?? null
    const expected = canonical ? CANONICAL_CHANNELS[canonical].quantity : null

    if (canonical && claimed.has(canonical)) {
      warnings.push(`${mapping.column}: ${canonical} is already mapped to another column`)
      canonical = null
    }
    if (canonical && expected && unitDef && unitDef.quantity !== expected) {
      warnings.push(`${mapping.column}: unit "${sourceUnit}" is not a ${expected} unit, so it isn't used as ${canonical}`)
      canonical = null
    }
    if (canonical && expected && !unitDef) {
      warnings.push(`${mapping.column}: unknown unit${sourceUnit ? ` "${sourceUnit}"` : ''}; values kept as-is`)
    }

    const rawValues = Float64Array.from(parsed.rows, (row) => parseFiniteNumber(row[mapping.column]) ?? NaN)
    const values = unitDef ? rawValues.map((value) => toBase(value, unitDef)) : rawValues
    const { series, stats } = buildSeries(rowTimes, values)
    if (stats.accepted === 0) continue
    if (canonical) claimed.add(canonical)

    channels.push({
      key: mapping.column,
      label: mapping.label ?? mapping.column,
      canonical,
      quantity: unitDef?.quantity ?? expected,
      unit: unitDef ? BASE_UNITS[unitDef.quantity] : null,
      sourceUnit,
      series,
      range: seriesRange(series),
      stats,
    })
  }

  const laps = profile.laps?.({ parsed, rowTimes, duration }) ?? []

  return {
    fileName: parsed.fileName,
    profileId: profile.id,
    profileLabel: profile.label,
    detection,
    time: {
      column: timeMapping.column,
      unit: timeUnit,
      clock: timeMapping.clock,
      startUtcMs: toUtcMs(zeroRaw * scale, timeMapping.clock),
    },
    duration,
    rowCount: parsed.rows.length,
    channels,
    laps,
    metadata: parsed.metadata,
    warnings,
  }
}

export function findChannel(session: TelemetrySession, id: CanonicalChannelId): TelemetryChannel | undefined {
  return session.channels.find((channel) => channel.canonical === id)
}
