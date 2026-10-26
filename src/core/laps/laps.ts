/**
 * - `out`: from the session start to the first lap line crossing.
 * - `in`: from the last crossing to the end of the session.
 * - `timed`: a full lap between two crossings.
 */
export type LapKind = 'out' | 'in' | 'timed'

export interface Lap {
  /** 1-based position in the session (not the logger's own lap counter). */
  index: number
  /** The logger's lap number when it provides one (e.g. Solostorm lap 37). */
  loggerNumber: number | null
  /** Session seconds. */
  start: number
  end: number
  duration: number
  kind: LapKind
}

/**
 * Laps from sorted boundary times (session seconds), e.g. AiM beacon
 * markers. With more than one lap, the first is the out lap and the last the
 * in lap; a single segment is treated as one timed lap.
 */
export function lapsFromBoundaries(
  boundaries: number[],
  loggerNumbers: Array<number | null> = [],
): Lap[] {
  const laps: Lap[] = []
  for (let i = 1; i < boundaries.length; i += 1) {
    const start = boundaries[i - 1]!
    const end = boundaries[i]!
    if (!(end > start)) continue
    laps.push({
      index: laps.length + 1,
      loggerNumber: loggerNumbers[i - 1] ?? null,
      start,
      end,
      duration: end - start,
      kind: 'timed',
    })
  }
  if (laps.length > 1) {
    laps[0]!.kind = 'out'
    laps[laps.length - 1]!.kind = 'in'
  }
  return laps
}

/**
 * Laps from a per-row lap-number column (e.g. Solostorm `MATH_LAP_NUMBER`).
 * A lap runs from its first row to the next lap's first row; the last lap
 * ends at its own last row.
 */
export function lapsFromLapNumbers(
  rowTimes: ArrayLike<number>,
  rowLapNumbers: ArrayLike<number>,
): Lap[] {
  const boundaries: number[] = []
  const numbers: number[] = []
  let current: number | null = null
  let lastTime = NaN
  for (let i = 0; i < rowTimes.length; i += 1) {
    const time = rowTimes[i]!
    const lap = rowLapNumbers[i]!
    if (!Number.isFinite(time) || !Number.isFinite(lap)) continue
    if (lap !== current) {
      boundaries.push(time)
      numbers.push(lap)
      current = lap
    }
    lastTime = time
  }
  if (boundaries.length === 0) return []
  boundaries.push(lastTime)
  return lapsFromBoundaries(boundaries, numbers)
}

/** Fastest timed lap; out/in laps are never "best". */
export function bestLap(laps: Lap[]): Lap | null {
  let best: Lap | null = null
  for (const lap of laps) {
    if (lap.kind !== 'timed') continue
    if (!best || lap.duration < best.duration) best = lap
  }
  return best
}

export function lapAt(laps: Lap[], time: number): Lap | null {
  return laps.find((lap) => time >= lap.start && time < lap.end) ?? null
}

/** `m:ss.SSS` lap-time formatting. */
export function formatLapTime(seconds: number): string {
  const totalMs = Math.round(seconds * 1000)
  const minutes = Math.floor(totalMs / 60_000)
  const rest = (totalMs - minutes * 60_000) / 1000
  return `${minutes}:${rest.toFixed(3).padStart(6, '0')}`
}
