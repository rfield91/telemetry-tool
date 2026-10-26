import { lapsFromLapNumbers } from '../../laps/laps'
import { isCanonicalChannelId } from '../channels'
import { parseFiniteNumber } from '../csv'
import type { ChannelMapping, LoggerProfile, TimeMapping } from './types'

/**
 * A mapping the user confirmed for an unknown logger, saved as JSON so it
 * auto-detects matching files next time (and can be shared).
 */
export interface UserProfileDefinition {
  version: 1
  id: string
  label: string
  /** The profile matches files containing all of these headers. */
  match: { headers: string[] }
  time: TimeMapping
  channels: ChannelMapping[]
  /** Optional per-row lap-number column. */
  lapColumn?: string
}

export function createUserProfile(definition: UserProfileDefinition): LoggerProfile {
  return {
    id: definition.id,
    label: definition.label,
    builtIn: false,
    detect(parsed) {
      const headers = new Set(parsed.headers)
      return definition.match.headers.every((header) => headers.has(header))
        ? { confidence: 'high', reason: `Matches saved mapping "${definition.label}"` }
        : null
    },
    time() {
      return definition.time
    },
    channels(parsed) {
      const headers = new Set(parsed.headers)
      return definition.channels.filter((mapping) => headers.has(mapping.column))
    },
    laps: definition.lapColumn
      ? ({ parsed, rowTimes }) => {
          const column = definition.lapColumn!
          if (!parsed.headers.includes(column)) return []
          const numbers = Float64Array.from(parsed.rows, (row) => parseFiniteNumber(row[column]) ?? NaN)
          return lapsFromLapNumbers(rowTimes, numbers)
        }
      : undefined,
  }
}

const TIME_UNITS = new Set(['auto', 'seconds', 'milliseconds', 'microseconds'])
const CLOCKS = new Set(['relative', 'unix-utc', 'unix-gps'])

/** Validate untrusted JSON (e.g. an imported profile file). */
export function isUserProfileDefinition(value: unknown): value is UserProfileDefinition {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  const time = v.time as Record<string, unknown> | undefined
  const match = v.match as Record<string, unknown> | undefined
  return (
    v.version === 1 &&
    typeof v.id === 'string' &&
    typeof v.label === 'string' &&
    !!match &&
    Array.isArray(match.headers) &&
    match.headers.every((header) => typeof header === 'string') &&
    !!time &&
    typeof time.column === 'string' &&
    TIME_UNITS.has(time.unit as string) &&
    CLOCKS.has(time.clock as string) &&
    Array.isArray(v.channels) &&
    v.channels.every((channel: unknown) => {
      const c = channel as Record<string, unknown>
      return (
        !!c &&
        typeof c.column === 'string' &&
        (c.canonical === undefined || isCanonicalChannelId(c.canonical)) &&
        (c.unit === undefined || typeof c.unit === 'string')
      )
    }) &&
    (v.lapColumn === undefined || typeof v.lapColumn === 'string')
  )
}
