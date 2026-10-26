import {
  AIM_GPS_LAT_ACC,
  AIM_GPS_LON_ACC,
  hasAimGMeterColumns,
} from './gMeter'
import type { ParsedCsv } from './telemetry'
import {
  AIM_GPS_LATITUDE,
  AIM_GPS_LONGITUDE,
  hasAimGpsColumns,
} from './trackMap'

export type CsvFormatId = 'aim' | 'generic'
export type FormatConfidence = 'high' | 'low'

export interface FormatDetection {
  id: CsvFormatId
  confidence: FormatConfidence
  reason: string
}

export interface GpsColumns {
  latitude: string
  longitude: string
}

export interface GMeterColumns {
  lateral: string
  longitudinal: string
}

export interface CsvFormatProfile {
  id: CsvFormatId
  label: string
  /**
   * When true, timestamp column/unit are assumed by the profile and the
   * Data mapping controls can be hidden after a confident detection.
   */
  assumesTimestampMapping: boolean
  /**
   * Return a match when this logger looks like a fit, or null to skip.
   * Generic is applied as a fallback by {@link detectCsvFormat}, not via detect.
   */
  detect(parsed: ParsedCsv): FormatDetection | null
  /** Columns that should not be chosen as the default gauge/bar/value channel. */
  excludeFromDefaultValue(headers: string[]): ReadonlySet<string>
  resolveGpsColumns(headers: string[]): GpsColumns | null
  resolveGMeterColumns(headers: string[]): GMeterColumns | null
}

const AIM_EXCLUDE = new Set([
  AIM_GPS_LATITUDE,
  AIM_GPS_LONGITUDE,
  AIM_GPS_LAT_ACC,
  AIM_GPS_LON_ACC,
])

const aimProfile: CsvFormatProfile = {
  id: 'aim',
  label: 'AiM',
  assumesTimestampMapping: true,
  detect(parsed) {
    const formatMeta = parsed.metadata.Format ?? ''
    if (/AiM/i.test(formatMeta)) {
      return {
        id: 'aim',
        confidence: 'high',
        reason: `Metadata Format is "${formatMeta}"`,
      }
    }
    if (hasAimGpsColumns(parsed.headers)) {
      return {
        id: 'aim',
        confidence: 'high',
        reason: 'Headers include GPS Latitude and GPS Longitude',
      }
    }
    const hasPreamble = Object.keys(parsed.metadata).length > 0
    const hasUnits = Object.keys(parsed.units).length > 0
    if (hasPreamble && hasUnits) {
      return {
        id: 'aim',
        confidence: 'low',
        reason: 'Metadata preamble and units row look AiM-like',
      }
    }
    return null
  },
  excludeFromDefaultValue() {
    return AIM_EXCLUDE
  },
  resolveGpsColumns(headers) {
    if (!hasAimGpsColumns(headers)) return null
    return { latitude: AIM_GPS_LATITUDE, longitude: AIM_GPS_LONGITUDE }
  },
  resolveGMeterColumns(headers) {
    if (!hasAimGMeterColumns(headers)) return null
    return { lateral: AIM_GPS_LAT_ACC, longitudinal: AIM_GPS_LON_ACC }
  },
}

const genericProfile: CsvFormatProfile = {
  id: 'generic',
  label: 'Generic CSV',
  assumesTimestampMapping: false,
  detect() {
    return null
  },
  excludeFromDefaultValue() {
    return new Set()
  },
  resolveGpsColumns() {
    return null
  },
  resolveGMeterColumns() {
    return null
  },
}

/** Registered logger profiles. Add new formats here (before Generic). */
export const CSV_FORMAT_PROFILES: readonly CsvFormatProfile[] = [
  aimProfile,
  genericProfile,
]

export function getCsvFormatProfile(id: CsvFormatId): CsvFormatProfile {
  return (
    CSV_FORMAT_PROFILES.find((profile) => profile.id === id) ?? genericProfile
  )
}

/**
 * Pick the best matching format. Prefer high-confidence logger matches;
 * fall back to a low-confidence match, then Generic.
 */
export function detectCsvFormat(parsed: ParsedCsv): FormatDetection {
  let lowConfidence: FormatDetection | null = null

  for (const profile of CSV_FORMAT_PROFILES) {
    if (profile.id === 'generic') continue
    const match = profile.detect(parsed)
    if (!match) continue
    if (match.confidence === 'high') return match
    if (!lowConfidence) lowConfidence = match
  }

  if (lowConfidence) return lowConfidence

  return {
    id: 'generic',
    confidence: 'high',
    reason: 'No logger-specific fingerprints found',
  }
}
