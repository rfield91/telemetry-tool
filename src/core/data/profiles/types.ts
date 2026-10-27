import type { Lap } from '../../laps/laps'
import type { CanonicalChannelId } from '../channels'
import type { ParsedCsv } from '../csv'
import type { TimeClock, TimestampUnit } from '../time'

export type Confidence = 'high' | 'low'

export interface Detection {
  confidence: Confidence
  reason: string
}

export interface TimeMapping {
  column: string
  unit: TimestampUnit
  clock: TimeClock
}

export interface ChannelMapping {
  column: string
  canonical?: CanonicalChannelId
  /** Unit text as the logger writes it (looked up with `lookupUnit`). */
  unit?: string
  label?: string
}

export interface LapContext {
  parsed: ParsedCsv
  /** Session seconds per CSV row (NaN where the timestamp was invalid). */
  rowTimes: Float64Array
  /** Session duration in seconds. */
  duration: number
}

/**
 * How to read one kind of logger CSV. Built-in profiles cover known loggers;
 * user profiles come from confirmed mappings of unknown files.
 */
export interface LoggerProfile {
  id: string
  label: string
  builtIn: boolean
  /** Null when this profile doesn't recognise the file. */
  detect(parsed: ParsedCsv): Detection | null
  time(parsed: ParsedCsv): TimeMapping
  channels(parsed: ParsedCsv): ChannelMapping[]
  laps?(context: LapContext): Lap[]
}
