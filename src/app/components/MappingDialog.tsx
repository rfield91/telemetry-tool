import { useMemo, useState } from 'react'
import { CANONICAL_CHANNELS, type CanonicalChannelId } from '../../core/data/channels'
import { inferNumericColumns, parseCsv } from '../../core/data/csv'
import type { UserProfileDefinition } from '../../core/data/profiles/user'
import type { TimeClock, TimestampUnit } from '../../core/data/time'
import { lookupUnit, UNITS } from '../../core/data/units'
import { applyMapping } from '../actions'
import { runtimeStore, useProject, useRuntime } from '../state'
import { Button, inputClass } from './ui'

interface Row {
  column: string
  role: CanonicalChannelId | ''
  unit: string
}

const TIME_UNITS: Array<[TimestampUnit, string]> = [
  ['auto', 'Auto-detect'],
  ['seconds', 'Seconds'],
  ['milliseconds', 'Milliseconds'],
  ['microseconds', 'Microseconds'],
]

const CLOCKS: Array<[TimeClock, string]> = [
  ['relative', 'Relative (session time)'],
  ['unix-utc', 'Unix epoch, UTC'],
  ['unix-gps', 'Unix epoch, GPS time (UTC + 18 s)'],
]

const ROLE_OPTIONS = Object.values(CANONICAL_CHANNELS)

const selectClass = inputClass

/** Mapping screen: confirm or correct how a CSV's columns are read. */
export function MappingDialog() {
  const telemetryId = useRuntime((s) => s.mappingFor)
  if (!telemetryId) return null
  return <MappingForm key={telemetryId} telemetryId={telemetryId} />
}

function MappingForm({ telemetryId }: { telemetryId: string }) {
  const session = useRuntime((s) => s.sessions[telemetryId])!
  const text = useRuntime((s) => s.csvText[telemetryId])!
  const registry = useRuntime((s) => s.registry)
  const fileName = useProject((s) => s.project.telemetry.find((t) => t.id === telemetryId)?.name ?? '')
  const parsed = useMemo(() => parseCsv(text, fileName), [text, fileName])
  const numeric = useMemo(() => inferNumericColumns(parsed), [parsed])
  const existing = registry.userProfileDefinitions().find((d) => d.id === session.profileId)

  const [label, setLabel] = useState(existing?.label ?? (session.profileId === 'generic' ? fileName.replace(/\.csv$/i, '') : `${session.profileLabel} (custom)`))
  const [timeColumn, setTimeColumn] = useState(session.time.column)
  const [timeUnit, setTimeUnit] = useState<TimestampUnit>(session.time.unit)
  const [clock, setClock] = useState<TimeClock>(session.time.clock)
  const [lapColumn, setLapColumn] = useState(existing?.lapColumn ?? (parsed.headers.includes('MATH_LAP_NUMBER') ? 'MATH_LAP_NUMBER' : ''))
  // Recognised columns first. The order is fixed when the dialog opens so
  // rows don't jump while roles are edited.
  const [rows, setRows] = useState<Row[]>(() => {
    const all = numeric
      .filter((column) => column !== session.time.column)
      .map((column): Row => {
        const channel = session.channels.find((c) => c.key === column)
        return { column, role: channel?.canonical ?? '', unit: lookupUnit(channel?.sourceUnit)?.id ?? '' }
      })
    return [...all.filter((row) => row.role), ...all.filter((row) => !row.role)]
  })
  const [initiallyMapped] = useState(() => new Set(rows.filter((row) => row.role).map((row) => row.column)))
  const hiddenCount = rows.length - initiallyMapped.size
  // Short files (typical unknown loggers) show everything; wide exports
  // like Solostorm's 80+ columns start with only the recognised ones.
  const [showAll, setShowAll] = useState(hiddenCount <= 12)

  const roleCounts = new Map<string, number>()
  for (const row of rows) if (row.role) roleCounts.set(row.role, (roleCounts.get(row.role) ?? 0) + 1)
  const duplicates = [...roleCounts].filter(([, count]) => count > 1).map(([role]) => CANONICAL_CHANNELS[role as CanonicalChannelId].label)
  const unitProblems = rows.filter((row) => {
    const quantity = row.role ? CANONICAL_CHANNELS[row.role].quantity : null
    return quantity && row.unit && lookupUnit(row.unit)?.quantity !== quantity
  })
  const canSave = label.trim() !== '' && duplicates.length === 0 && unitProblems.length === 0

  const setRow = (column: string, patch: Partial<Row>) =>
    setRows((current) => current.map((row) => (row.column === column ? { ...row, ...patch } : row)))

  const save = () => {
    const mapped = rows.filter((row) => row.role)
    const definition: UserProfileDefinition = {
      version: 1,
      id: existing?.id ?? `user-${crypto.randomUUID()}`,
      label: label.trim(),
      match: { headers: [timeColumn, ...mapped.map((row) => row.column)] },
      time: { column: timeColumn, unit: timeUnit, clock },
      channels: rows.map((row) => ({
        column: row.column,
        canonical: row.role || undefined,
        unit: row.unit || undefined,
      })),
      lapColumn: lapColumn || undefined,
    }
    void applyMapping(telemetryId, definition)
  }

  const firstRow = parsed.rows[0] ?? {}

  return (
    <div className="fixed inset-0 z-20 grid place-items-center bg-black/70 p-6" role="dialog" aria-modal="true" aria-labelledby="mapping-title">
      <div className="flex max-h-full w-full max-w-4xl flex-col rounded-xl border shadow-2xl border-line bg-surface shadow-2xl">
        <header className="border-b border-line px-5 py-4">
          <h2 id="mapping-title" className="text-base font-semibold text-fg">
            Columns in {fileName}
          </h2>
          <p className="mt-1 text-sm text-fg-muted">
            {session.profileId === 'generic'
              ? "This logger wasn't recognised, so these are guesses. Check the time column and the roles of the channels you want on screen."
              : `Read as ${session.profileLabel}. Changes are saved as your own profile for files like this.`}
          </p>
        </header>

        <div className="grid grid-cols-2 gap-3 border-b border-line px-5 py-4 md:grid-cols-4">
          <label className="text-xs text-fg-muted">
            Profile name
            <input className={`${selectClass} mt-1`} value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <label className="text-xs text-fg-muted">
            Time column
            <select className={`${selectClass} mt-1`} value={timeColumn} onChange={(e) => setTimeColumn(e.target.value)}>
              {parsed.headers.map((header) => (
                <option key={header} value={header}>
                  {header}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-fg-muted">
            Time unit
            <select className={`${selectClass} mt-1`} value={timeUnit} onChange={(e) => setTimeUnit(e.target.value as TimestampUnit)}>
              {TIME_UNITS.map(([value, text]) => (
                <option key={value} value={value}>
                  {text}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-fg-muted">
            Clock
            <select className={`${selectClass} mt-1`} value={clock} onChange={(e) => setClock(e.target.value as TimeClock)}>
              {CLOCKS.map(([value, text]) => (
                <option key={value} value={value}>
                  {text}
                </option>
              ))}
            </select>
          </label>
          <label className="col-span-2 text-xs text-fg-muted">
            Lap number column (optional)
            <select className={`${selectClass} mt-1`} value={lapColumn} onChange={(e) => setLapColumn(e.target.value)}>
              <option value="">None</option>
              {numeric.map((header) => (
                <option key={header} value={header}>
                  {header}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-2">
          <table className="w-full text-[13px]">
            <thead className="sticky top-0 bg-surface text-left text-xs text-fg-subtle">
              <tr>
                <th className="py-2 font-normal">Column</th>
                <th className="font-normal">First value</th>
                <th className="w-56 font-normal">Shown as</th>
                <th className="w-36 font-normal">Unit</th>
              </tr>
            </thead>
            <tbody>
              {rows
                .filter((row) => row.column !== timeColumn && (showAll || initiallyMapped.has(row.column)))
                .map((row) => {
                  const quantity = row.role ? CANONICAL_CHANNELS[row.role].quantity : null
                  const units = quantity ? UNITS.filter((unit) => unit.quantity === quantity) : UNITS
                  const badUnit = quantity && row.unit && lookupUnit(row.unit)?.quantity !== quantity
                  return (
                    <tr key={row.column} className="border-t border-line/60">
                      <td className="py-1 pr-3 text-fg">{row.column}</td>
                      <td className="pr-2 font-mono text-xs text-fg-subtle">{firstRow[row.column]}</td>
                      <td className="pr-2">
                        <select
                          className={selectClass}
                          value={row.role}
                          onChange={(e) => setRow(row.column, { role: e.target.value as CanonicalChannelId | '' })}
                        >
                          <option value="">Not used as a standard channel</option>
                          {ROLE_OPTIONS.map((role) => (
                            <option key={role.id} value={role.id}>
                              {role.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <select
                          className={`${selectClass} ${badUnit ? 'border-danger' : ''}`}
                          value={row.unit}
                          onChange={(e) => setRow(row.column, { unit: e.target.value })}
                        >
                          <option value="">Unknown</option>
                          {units.map((unit) => (
                            <option key={unit.id} value={unit.id}>
                              {unit.id}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  )
                })}
            </tbody>
          </table>
          {hiddenCount > 0 && (
            <button type="button" onClick={() => setShowAll(!showAll)} className="mt-2 mb-1 text-xs text-fg-muted hover:text-fg">
              {showAll ? 'Show only recognised columns' : `Show ${hiddenCount} more columns`}
            </button>
          )}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-line px-5 py-3">
          <p className="text-xs text-danger">
            {duplicates.length > 0 && `Each role can be used once: ${duplicates.join(', ')}. `}
            {unitProblems.length > 0 && `Pick a matching unit for: ${unitProblems.map((row) => row.column).join(', ')}.`}
          </p>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => runtimeStore.setState({ mappingFor: null })}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!canSave} onClick={save}>
              Save profile and apply
            </Button>
          </div>
        </footer>
      </div>
    </div>
  )
}
