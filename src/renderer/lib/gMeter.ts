import { clamp } from './gauge'

/** AiM CSV column names for GPS-derived accelerations (g). */
export const AIM_GPS_LAT_ACC = 'GPS LatAcc'
export const AIM_GPS_LON_ACC = 'GPS LonAcc'

export function hasAimGMeterColumns(headers: string[]): boolean {
  return headers.includes(AIM_GPS_LAT_ACC) && headers.includes(AIM_GPS_LON_ACC)
}

/** Map a signed g value into a 0..1 plot fraction for a ±maxG range. */
export function gMeterFraction(value: number, maxG: number) {
  if (!Number.isFinite(value) || !Number.isFinite(maxG) || maxG <= 0) {
    return 0.5
  }
  return clamp((value + maxG) / (2 * maxG), 0, 1)
}

export function formatGValue(value: number) {
  if (!Number.isFinite(value)) return '0.00'
  const rounded = Math.round(value * 100) / 100
  const fixed = Math.abs(rounded).toFixed(2)
  return rounded < 0 ? `-${fixed}` : fixed
}

/** Round max |g| up to a tidy half-g step (minimum 1.5). */
export function niceMaxG(values: number[]) {
  if (values.length === 0) return 2
  const peak = Math.max(...values.map((value) => Math.abs(value)))
  if (!Number.isFinite(peak) || peak <= 0) return 1.5
  return Math.max(1.5, Math.ceil(peak * 2) / 2)
}
