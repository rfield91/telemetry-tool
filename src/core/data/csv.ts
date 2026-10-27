import Papa from 'papaparse'

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

export function parseFiniteNumber(raw: string | undefined): number | null {
  const trimmed = (raw ?? '').trim()
  if (trimmed === '') return null
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : null
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

  return { fileName, headers, rows, errors, metadata, units }
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

/** Headers whose non-empty cells are mostly finite numbers. */
export function inferNumericColumns(csv: ParsedCsv): string[] {
  return csv.headers.filter((header) => columnLooksNumeric(csv.rows, header))
}

/**
 * Split a header like `SPEED (m/s)` or `Oil Temp [°F]` into its name and the
 * unit text in brackets. Headers without a bracketed suffix return no unit.
 */
export function splitHeaderUnit(header: string): { name: string; unit: string | null } {
  const match = header.match(/^(.*?)\s*[([]([^)\]]*)[)\]]\s*$/)
  if (!match) return { name: header.trim(), unit: null }
  return { name: match[1]!.trim(), unit: match[2]!.trim() || null }
}
