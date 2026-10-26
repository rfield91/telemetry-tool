import Papa from 'papaparse'

export type TimestampUnit = 'auto' | 'seconds' | 'milliseconds' | 'microseconds'
export type ResolvedTimestampUnit = Exclude<TimestampUnit, 'auto'>

export type CsvRow = Record<string, string>

export interface CsvParseIssue {
  type: string
  code: string
  message: string
  row?: number
}

export interface ParsedCsv {
  fileName: string
  headers: string[]
  rows: CsvRow[]
  errors: CsvParseIssue[]
  /** Key/value rows found above the header row (e.g. AiM session info). */
  metadata: Record<string, string>
  /** Per-column units from a units row directly below the header, if present. */
  units: Record<string, string>
}

export interface SeriesPoint {
  /** Normalized time in seconds; first accepted sample is 0. */
  time: number
  value: number
}

export interface GpsPoint {
  /** Normalized time in seconds; first accepted sample is 0. */
  time: number
  lat: number
  lon: number
}

export interface GpsTrack {
  fileName: string
  timestampColumn: string
  latitudeColumn: string
  longitudeColumn: string
  timestampUnit: ResolvedTimestampUnit
  points: GpsPoint[]
  stats: SeriesStats
  errors: SeriesRowIssue[]
}

export interface BuildGpsTrackOptions {
  timestampColumn: string
  latitudeColumn: string
  longitudeColumn: string
  /** Defaults to `'auto'`. */
  timestampUnit?: TimestampUnit
}

export type SeriesRowIssueReason =
  | 'missing_timestamp'
  | 'missing_value'
  | 'invalid_timestamp'
  | 'invalid_value'

export interface SeriesRowIssue {
  /** 0-based index into ParsedCsv.rows */
  rowIndex: number
  reason: SeriesRowIssueReason
  timestampRaw: string
  valueRaw: string
}

export interface SeriesStats {
  totalRows: number
  acceptedRows: number
  invalidRows: number
  duplicateTimestamps: number
  durationSeconds: number
  rawTimeStartSeconds: number | null
  rawTimeEndSeconds: number | null
}

export interface TelemetrySeries {
  fileName: string
  timestampColumn: string
  valueColumn: string
  timestampUnit: ResolvedTimestampUnit
  points: SeriesPoint[]
  stats: SeriesStats
  errors: SeriesRowIssue[]
}

export interface BuildSeriesOptions {
  timestampColumn: string
  valueColumn: string
  /** Defaults to `'auto'`. */
  timestampUnit?: TimestampUnit
}

const UNIT_TO_SECONDS: Record<ResolvedTimestampUnit, number> = {
  seconds: 1,
  milliseconds: 1_000,
  microseconds: 1_000_000,
}

function rowNumericFraction(row: string[]): number {
  let numeric = 0
  let nonEmpty = 0
  for (const cell of row) {
    const trimmed = cell.trim()
    if (trimmed === '') continue
    nonEmpty += 1
    if (parseFiniteNumber(trimmed) !== null) numeric += 1
  }
  return nonEmpty === 0 ? 0 : numeric / nonEmpty
}

/**
 * Locate the main data run: the longest run of consecutive rows that are
 * mostly numeric and share a column count. Short numeric metadata rows (e.g.
 * AiM "Beacon Markers") lose to the real samples on run length.
 */
function findDataRun(
  rows: string[][],
): { start: number; columnCount: number } | null {
  let best: { start: number; length: number; columnCount: number } | null = null
  let run: { start: number; length: number; columnCount: number } | null = null

  // Sentinel pass beyond the last row commits any trailing run.
  for (let i = 0; i <= rows.length; i += 1) {
    const row = rows[i]
    const isNumericRow =
      row !== undefined && row.length >= 2 && rowNumericFraction(row) >= 0.6

    if (isNumericRow && run && row.length === run.columnCount) {
      run.length += 1
      continue
    }

    if (run && (!best || run.length > best.length)) {
      best = run
    }
    run =
      isNumericRow && row
        ? { start: i, length: 1, columnCount: row.length }
        : null
  }

  return best ? { start: best.start, columnCount: best.columnCount } : null
}

const UNIT_TOKEN_PATTERN =
  /^(s|ms|us|µs|min|h|mph|km\/h|kph|m\/s|ft\/s|deg|rad|deg\/s|rad\/s|g|m\/s2|m\/s²|%|bar|psi|kpa|mpa|hpa|mbar|°f|°c|f|c|k|m|mm|cm|km|mi|ft|in|rpm|v|mv|a|ma|w|kw|hp|nm|l|gal|l\/h|gph|afr|lambda|hz|db|#|-)$/i

/**
 * True when the row's non-empty cells are mostly recognizable unit tokens
 * (e.g. an AiM units row: "s","mph","g","deg","°F",...).
 */
function looksLikeUnitsRow(row: string[]): boolean {
  let nonEmpty = 0
  let unitLike = 0
  for (const cell of row) {
    const trimmed = cell.trim()
    if (trimmed === '') continue
    nonEmpty += 1
    if (UNIT_TOKEN_PATTERN.test(trimmed)) unitLike += 1
  }
  return nonEmpty > 0 && unitLike / nonEmpty >= 0.6
}

function resolveHeaderNames(cells: string[]): string[] {
  const seen = new Map<string, number>()
  return cells.map((cell, index) => {
    const base = cell.trim() || `Column ${index + 1}`
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return count === 0 ? base : `${base} (${count + 1})`
  })
}

/**
 * Parse CSV text into headers and raw string rows.
 *
 * Handles logger exports (e.g. AiM) that put key/value metadata rows above the
 * real header and an optional units row directly below it. The header row is
 * found by locating the main numeric data block and walking back over the
 * non-numeric rows with a matching column count.
 */
export function parseCsv(text: string, fileName: string): ParsedCsv {
  const result = Papa.parse<string[]>(text, {
    skipEmptyLines: 'greedy',
    dynamicTyping: false,
  })
  const allRows = result.data.filter((row) =>
    row.some((cell) => cell.trim() !== ''),
  )

  const run = findDataRun(allRows)
  let headerIndex = allRows.length > 0 ? 0 : -1
  let unitsIndex: number | null = null

  if (run) {
    const candidates: number[] = []
    for (let i = run.start - 1; i >= 0; i -= 1) {
      const row = allRows[i]!
      if (row.length === run.columnCount && rowNumericFraction(row) < 0.5) {
        candidates.push(i)
      } else {
        break
      }
    }

    if (candidates.length >= 2 && looksLikeUnitsRow(allRows[candidates[0]!]!)) {
      unitsIndex = candidates[0]!
      headerIndex = candidates[1]!
    } else if (candidates.length >= 1) {
      headerIndex = candidates[0]!
    } else {
      headerIndex = -1
    }
  }

  const headerCells =
    headerIndex >= 0
      ? allRows[headerIndex]!
      : Array.from({ length: run?.columnCount ?? 0 }, () => '')
  const headers = resolveHeaderNames(headerCells)

  const units: Record<string, string> = {}
  if (unitsIndex !== null) {
    allRows[unitsIndex]!.forEach((cell, index) => {
      const unit = cell.trim()
      const header = headers[index]
      if (unit !== '' && header) units[header] = unit
    })
  }

  const metadata: Record<string, string> = {}
  const metadataEnd = headerIndex >= 0 ? headerIndex : (run?.start ?? 0)
  for (let i = 0; i < metadataEnd; i += 1) {
    const row = allRows[i]!
    const key = (row[0] ?? '').trim()
    if (key === '') continue
    metadata[key] = row
      .slice(1)
      .map((cell) => cell.trim())
      .filter((cell) => cell !== '')
      .join(', ')
  }

  const dataStart = (unitsIndex ?? headerIndex) + 1
  const rows: CsvRow[] = []
  for (let i = Math.max(dataStart, run?.start ?? dataStart, 0); i < allRows.length; i += 1) {
    const cells = allRows[i]!
    if (!cells.some((cell) => cell.trim() !== '')) continue
    const row: CsvRow = {}
    headers.forEach((header, index) => {
      row[header] = cells[index] ?? ''
    })
    rows.push(row)
  }

  const errors: CsvParseIssue[] = result.errors.map((error) => ({
    type: error.type,
    code: error.code,
    message: error.message,
    row: error.row,
  }))

  return {
    fileName,
    headers,
    rows,
    errors,
    metadata,
    units,
  }
}

function parseFiniteNumber(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : null
}

function columnLooksNumeric(rows: CsvRow[], column: string): boolean {
  let numeric = 0
  let considered = 0

  for (const row of rows) {
    const raw = (row[column] ?? '').trim()
    if (raw === '') continue
    considered += 1
    if (parseFiniteNumber(raw) !== null) numeric += 1
  }

  if (considered === 0) return false
  return numeric / considered >= 0.8
}

/**
 * Return headers whose non-empty cells are mostly finite numbers.
 */
export function inferNumericColumns(csv: ParsedCsv): string[] {
  return csv.headers.filter((header) => columnLooksNumeric(csv.rows, header))
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2
  }
  return sorted[mid]!
}

/**
 * Infer whether absolute timestamp values are seconds, milliseconds, or microseconds
 * using positive successive deltas when available, otherwise the overall span.
 */
export function inferTimestampUnit(timestamps: number[]): ResolvedTimestampUnit {
  if (timestamps.length === 0) return 'seconds'

  const sorted = [...timestamps].sort((a, b) => a - b)
  const span = sorted[sorted.length - 1]! - sorted[0]!

  if (sorted.length >= 2) {
    const diffs: number[] = []
    for (let i = 1; i < sorted.length; i += 1) {
      const delta = sorted[i]! - sorted[i - 1]!
      if (delta > 0) diffs.push(delta)
    }

    if (diffs.length > 0) {
      diffs.sort((a, b) => a - b)
      const medianDelta = median(diffs)
      // Typical logger rates: 1–1000 Hz
      // seconds ≈ 0.001–1, milliseconds ≈ 1–1000, microseconds ≈ 1000+
      if (medianDelta >= 1000) return 'microseconds'
      if (medianDelta >= 1) return 'milliseconds'
      return 'seconds'
    }
  }

  if (span >= 1e9) return 'microseconds'
  if (span >= 1e5) return 'milliseconds'
  return 'seconds'
}

function resolveTimestampUnit(
  unit: TimestampUnit,
  rawTimestamps: number[],
): ResolvedTimestampUnit {
  if (unit !== 'auto') return unit
  return inferTimestampUnit(rawTimestamps)
}

function toSeconds(rawTimestamp: number, unit: ResolvedTimestampUnit): number {
  return rawTimestamp / UNIT_TO_SECONDS[unit]
}

/**
 * Build a normalized, sorted telemetry series from selected CSV columns.
 *
 * - Invalid rows are skipped and recorded in `errors` / `stats`.
 * - Points are sorted by time ascending.
 * - Duplicate timestamps keep the last accepted value.
 * - Times are normalized so the first accepted sample is `0` seconds.
 */
export function buildSeries(
  csv: ParsedCsv,
  options: BuildSeriesOptions,
): TelemetrySeries {
  const timestampColumn = options.timestampColumn
  const valueColumn = options.valueColumn
  const requestedUnit = options.timestampUnit ?? 'auto'

  const provisional: Array<{
    rowIndex: number
    rawTime: number
    value: number
  }> = []
  const errors: SeriesRowIssue[] = []

  for (let rowIndex = 0; rowIndex < csv.rows.length; rowIndex += 1) {
    const row = csv.rows[rowIndex]!
    const timestampRaw = row[timestampColumn] ?? ''
    const valueRaw = row[valueColumn] ?? ''

    const rawTime = parseFiniteNumber(timestampRaw)
    const value = parseFiniteNumber(valueRaw)

    if (rawTime === null || value === null) {
      let reason: SeriesRowIssueReason
      if (timestampRaw.trim() === '') reason = 'missing_timestamp'
      else if (valueRaw.trim() === '') reason = 'missing_value'
      else if (rawTime === null) reason = 'invalid_timestamp'
      else reason = 'invalid_value'

      errors.push({
        rowIndex,
        reason,
        timestampRaw,
        valueRaw,
      })
      continue
    }

    provisional.push({ rowIndex, rawTime, value })
  }

  const timestampUnit = resolveTimestampUnit(
    requestedUnit,
    provisional.map((point) => point.rawTime),
  )

  const timed = provisional
    .map((point) => ({
      time: toSeconds(point.rawTime, timestampUnit),
      value: point.value,
    }))
    .sort((a, b) => a.time - b.time)

  let duplicateTimestamps = 0
  const deduped: SeriesPoint[] = []
  for (const point of timed) {
    const last = deduped[deduped.length - 1]
    if (last && last.time === point.time) {
      duplicateTimestamps += 1
      last.value = point.value
      continue
    }
    deduped.push({ time: point.time, value: point.value })
  }

  const rawTimeStartSeconds = deduped[0]?.time ?? null
  const rawTimeEndSeconds = deduped[deduped.length - 1]?.time ?? null
  const origin = rawTimeStartSeconds ?? 0

  const points = deduped.map((point) => ({
    time: point.time - origin,
    value: point.value,
  }))

  const durationSeconds = points.length > 0 ? points[points.length - 1]!.time : 0

  return {
    fileName: csv.fileName,
    timestampColumn,
    valueColumn,
    timestampUnit,
    points,
    stats: {
      totalRows: csv.rows.length,
      acceptedRows: points.length,
      invalidRows: errors.length,
      duplicateTimestamps,
      durationSeconds,
      rawTimeStartSeconds,
      rawTimeEndSeconds,
    },
    errors,
  }
}

/**
 * Build a normalized GPS track from paired latitude/longitude columns.
 *
 * Rows missing a valid timestamp, latitude, or longitude are skipped.
 * Times are normalized so the first accepted sample is `0` seconds.
 */
export function buildGpsTrack(
  csv: ParsedCsv,
  options: BuildGpsTrackOptions,
): GpsTrack {
  const timestampColumn = options.timestampColumn
  const latitudeColumn = options.latitudeColumn
  const longitudeColumn = options.longitudeColumn
  const requestedUnit = options.timestampUnit ?? 'auto'

  const provisional: Array<{
    rowIndex: number
    rawTime: number
    lat: number
    lon: number
  }> = []
  const errors: SeriesRowIssue[] = []

  for (let rowIndex = 0; rowIndex < csv.rows.length; rowIndex += 1) {
    const row = csv.rows[rowIndex]!
    const timestampRaw = row[timestampColumn] ?? ''
    const latRaw = row[latitudeColumn] ?? ''
    const lonRaw = row[longitudeColumn] ?? ''

    const rawTime = parseFiniteNumber(timestampRaw)
    const lat = parseFiniteNumber(latRaw)
    const lon = parseFiniteNumber(lonRaw)

    if (rawTime === null || lat === null || lon === null) {
      let reason: SeriesRowIssueReason
      if (timestampRaw.trim() === '') reason = 'missing_timestamp'
      else if (latRaw.trim() === '' || lonRaw.trim() === '') reason = 'missing_value'
      else if (rawTime === null) reason = 'invalid_timestamp'
      else reason = 'invalid_value'

      errors.push({
        rowIndex,
        reason,
        timestampRaw,
        valueRaw: `${latRaw},${lonRaw}`,
      })
      continue
    }

    provisional.push({ rowIndex, rawTime, lat, lon })
  }

  const timestampUnit = resolveTimestampUnit(
    requestedUnit,
    provisional.map((point) => point.rawTime),
  )

  const timed = provisional
    .map((point) => ({
      time: toSeconds(point.rawTime, timestampUnit),
      lat: point.lat,
      lon: point.lon,
    }))
    .sort((a, b) => a.time - b.time)

  let duplicateTimestamps = 0
  const deduped: GpsPoint[] = []
  for (const point of timed) {
    const last = deduped[deduped.length - 1]
    if (last && last.time === point.time) {
      duplicateTimestamps += 1
      last.lat = point.lat
      last.lon = point.lon
      continue
    }
    deduped.push({ time: point.time, lat: point.lat, lon: point.lon })
  }

  const rawTimeStartSeconds = deduped[0]?.time ?? null
  const rawTimeEndSeconds = deduped[deduped.length - 1]?.time ?? null
  const origin = rawTimeStartSeconds ?? 0

  const points = deduped.map((point) => ({
    time: point.time - origin,
    lat: point.lat,
    lon: point.lon,
  }))

  const durationSeconds = points.length > 0 ? points[points.length - 1]!.time : 0

  return {
    fileName: csv.fileName,
    timestampColumn,
    latitudeColumn,
    longitudeColumn,
    timestampUnit,
    points,
    stats: {
      totalRows: csv.rows.length,
      acceptedRows: points.length,
      invalidRows: errors.length,
      duplicateTimestamps,
      durationSeconds,
      rawTimeStartSeconds,
      rawTimeEndSeconds,
    },
    errors,
  }
}

/**
 * Linearly interpolate `series` at `timeSeconds` (normalized).
 * Values before the first / after the last sample clamp to the boundary value.
 * Returns `null` when the series has no points.
 */
export function sampleAt(
  series: TelemetrySeries,
  timeSeconds: number,
): number | null {
  const { points } = series
  if (points.length === 0) return null

  const first = points[0]!
  const last = points[points.length - 1]!

  if (timeSeconds <= first.time) return first.value
  if (timeSeconds >= last.time) return last.value

  let lo = 0
  let hi = points.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (points[mid]!.time <= timeSeconds) lo = mid
    else hi = mid
  }

  const left = points[lo]!
  const right = points[hi]!
  if (right.time === left.time) return left.value

  const t = (timeSeconds - left.time) / (right.time - left.time)
  return left.value + t * (right.value - left.value)
}

/** Convenience alias used by preview/export call sites. */
export function interpolate(series: TelemetrySeries, timeSeconds: number): number | null {
  return sampleAt(series, timeSeconds)
}
