import { maskedLagSums } from './fft'

/**
 * Finds how a logger signal lines up with a camera signal (both yaw rate,
 * any units, any sign convention):
 *   video time = offset + logger time × (1 + drift)
 *
 * 1. Normalised (Pearson) correlation at every lag in one FFT pass, ignoring
 *    missing samples (gaps in either signal), so full sessions are as cheap
 *    as single laps.
 * 2. Each local peak is a candidate. A lap of a multi-lap video matches
 *    every lap of the track, so when peaks are close the candidates are
 *    re-ranked by how well the logger's first and second halves agree: on
 *    the right lap both halves give the same offset, on a wrong lap the
 *    second half drifts by the lap-time difference.
 * 3. Robust pass: 5 s windows that don't agree at the chosen offset (bad
 *    camera metadata, glitches) are excluded and the offset is refined on
 *    the rest.
 * 4. Offsets from 10 s windows give clock drift (a line fit, for long
 *    recordings) and precision (the scatter around that line).
 */

export const SYNC_HZ = 50
/** Gaps longer than this in either signal count as missing data (s). */
const MAX_GAP = 0.5
/** Shortest logger recording worth fitting clock drift on (s). */
const MIN_DRIFT_SPAN = 120
/** Overlap needed when one recording contains the other (a lap in a video, a video in a session). */
const CONTAINED_OVERLAP = 0.8
/**
 * Recordings needn't contain one another: a camera started minutes before
 * the logger and stopped minutes before it overlaps it for only part of
 * each. That search accepts a smaller overlap, with an absolute floor so a
 * few seconds of overlap can't win by chance.
 */
const PARTIAL_OVERLAP = 0.3
const MIN_OVERLAP_SECONDS = 30

export interface Signal {
  /** Seconds, ascending. */
  times: ArrayLike<number>
  values: ArrayLike<number>
}

export interface SyncCandidate {
  offset: number
  /** Pearson r at this offset (sign depends on axis conventions). */
  correlation: number
  /** Second-half offset minus first-half offset (s); null when not checked. */
  halfDrift: number | null
}

export type SyncConfidence = 'high' | 'medium' | 'low'

export interface SyncResult {
  /** Video time of logger time zero. */
  offset: number
  /** Logger clock rate error: video = offset + logger × (1 + drift). */
  drift: number
  /** Pearson r over the data that agreed (sign follows axis conventions). */
  correlation: number
  confidence: SyncConfidence
  /** How the winner was separated from the runner-up. */
  separation: { by: 'peak' | 'half-drift'; ratio: number }
  /** Scatter of window offsets around the fit (s); null if too short. */
  precision: number | null
  /** Share of informative logger windows that agreed at this offset (0–1). */
  coverage: number
  /** Candidates, best first (at most 8). */
  candidates: SyncCandidate[]
}

export interface SyncOptions {
  /**
   * Minimum overlap as a fraction of the shorter signal's valid samples,
   * never less than 30 s unless a signal is shorter. By default both 0.8
   * (one recording contains the other) and 0.3 (they partly overlap) are
   * tried, and the more confident result wins.
   */
  minOverlapFraction?: number
  /** Peaks closer than this (s) are merged; default 5 s. */
  minPeakSpacing?: number
}

/**
 * Linear resample onto a uniform grid starting at t = 0. Grid points inside
 * a gap longer than `maxGap` between source samples are NaN (missing).
 */
export function resample(signal: Signal, hz = SYNC_HZ, maxGap = MAX_GAP): Float64Array {
  const { times, values } = signal
  const n = times.length
  if (n === 0) return new Float64Array()
  const out = new Float64Array(Math.floor(times[n - 1]! * hz) + 1)
  let j = 0
  for (let i = 0; i < out.length; i += 1) {
    const t = i / hz
    while (j < n - 2 && times[j + 1]! < t) j += 1
    if (n === 1 || t <= times[0]!) {
      out[i] = t < times[0]! - maxGap ? NaN : values[0]!
      continue
    }
    const span = times[j + 1]! - times[j]!
    if (span > maxGap) {
      // Missing inside the gap; grid points on either end keep the sample.
      out[i] = t <= times[j]! + 1e-9 ? values[j]! : t >= times[j + 1]! - 1e-9 ? values[j + 1]! : NaN
      continue
    }
    const f = span > 0 ? Math.min(Math.max((t - times[j]!) / span, 0), 1) : 0
    out[i] = values[j]! + (values[j + 1]! - values[j]!) * f
  }
  return out
}

/**
 * Clip isolated spikes (sensor glitches, decode errors) to a few times the
 * signal's 99th percentile so one bad stretch can't dominate the
 * correlation. Ordinary driving stays well inside the limit.
 */
export function clipSpikes(values: Float64Array): Float64Array {
  const magnitudes = Array.from(values, Math.abs).filter((v) => !Number.isNaN(v))
  if (magnitudes.length === 0) return values
  magnitudes.sort((a, b) => a - b)
  const limit = 4 * magnitudes[Math.floor(0.99 * (magnitudes.length - 1))]!
  if (!(limit > 0)) return values
  return values.map((v) => (Number.isNaN(v) ? v : Math.min(Math.max(v, -limit), limit)))
}

const validCount = (values: Float64Array) => values.reduce((n, v) => (Number.isNaN(v) ? n : n + 1), 0)

/** Pearson r for every lag L (logger[i] ↔ camera[i + L]), ignoring missing samples; NaN where overlap is too short. */
export function correlationByLag(logger: Float64Array, camera: Float64Array, minOverlap: number): Float64Array {
  const n = logger.length
  const sums = maskedLagSums(logger, camera)
  const r = new Float64Array(n + camera.length - 1).fill(NaN)
  for (let index = 0; index < r.length; index += 1) {
    const k = Math.round(sums.count[index]!)
    if (k < minOverlap) continue
    const sa = sums.sumA[index]!
    const sb = sums.sumB[index]!
    const va = sums.sumA2[index]! - (sa * sa) / k
    const vb = sums.sumB2[index]! - (sb * sb) / k
    if (va <= 1e-9 || vb <= 1e-9) continue
    r[index] = (sums.sumAB[index]! - (sa * sb) / k) / Math.sqrt(va * vb)
  }
  return r
}

/**
 * Direct Pearson r of logger[start..end) against camera shifted by `lag`,
 * skipping missing samples and logger samples where `use` is 0.
 */
function correlationAt(
  logger: Float64Array,
  camera: Float64Array,
  lag: number,
  start = 0,
  end = logger.length,
  use?: Uint8Array,
): number {
  const i0 = Math.max(start, -lag)
  const i1 = Math.min(end, camera.length - lag)
  let k = 0
  let sa = 0
  let sb = 0
  let saa = 0
  let sbb = 0
  let sab = 0
  for (let i = i0; i < i1; i += 1) {
    const a = logger[i]!
    const b = camera[i + lag]!
    if (Number.isNaN(a) || Number.isNaN(b) || (use && !use[i])) continue
    k += 1
    sa += a
    sb += b
    saa += a * a
    sbb += b * b
    sab += a * b
  }
  if (k < 10) return 0
  const va = saa - (sa * sa) / k
  const vb = sbb - (sb * sb) / k
  return va > 0 && vb > 0 ? (sab - (sa * sb) / k) / Math.sqrt(va * vb) : 0
}

/** Best lag near `center` (±range samples), refined to sub-sample by a parabola. */
function refineLag(
  logger: Float64Array,
  camera: Float64Array,
  center: number,
  range: number,
  sign: number,
  start = 0,
  end = logger.length,
  use?: Uint8Array,
): { lag: number; r: number } {
  let best = center
  let bestR = -Infinity
  for (let lag = center - range; lag <= center + range; lag += 1) {
    const r = sign * correlationAt(logger, camera, lag, start, end, use)
    if (r > bestR) {
      bestR = r
      best = lag
    }
  }
  const l = sign * correlationAt(logger, camera, best - 1, start, end, use)
  const rr = sign * correlationAt(logger, camera, best + 1, start, end, use)
  const denom = l - 2 * bestR + rr
  const sub = denom < 0 ? Math.min(Math.max((0.5 * (l - rr)) / denom, -0.5), 0.5) : 0
  return { lag: best + sub, r: sign * bestR }
}

function standardDeviation(values: Float64Array, start: number, end: number): number {
  let n = 0
  let sum = 0
  let sumSq = 0
  for (let i = start; i < end; i += 1) {
    const v = values[i]!
    if (Number.isNaN(v)) continue
    n += 1
    sum += v
    sumSq += v * v
  }
  return n > 1 ? Math.sqrt(Math.max(0, sumSq / n - (sum / n) ** 2)) : 0
}

const CONFIDENCE_RANK: Record<SyncConfidence, number> = { low: 0, medium: 1, high: 2 }

export function synchronize(loggerSignal: Signal, cameraSignal: Signal, options: SyncOptions = {}): SyncResult | null {
  if (options.minOverlapFraction !== undefined) return synchronizeOnce(loggerSignal, cameraSignal, options)
  // Search both ways. When one recording contains the other, the contained
  // search is the stronger evidence (short partial overlaps make runner-up
  // peaks look better than they are). When they only partly overlap, the
  // contained search can't reach the true offset and settles on a wrong
  // lap, which the partial search beats on confidence.
  const contained = synchronizeOnce(loggerSignal, cameraSignal, { ...options, minOverlapFraction: CONTAINED_OVERLAP })
  const partial = synchronizeOnce(loggerSignal, cameraSignal, { ...options, minOverlapFraction: PARTIAL_OVERLAP })
  if (!partial || !contained) return contained ?? partial
  const rank = CONFIDENCE_RANK[partial.confidence] - CONFIDENCE_RANK[contained.confidence]
  if (rank !== 0) return rank > 0 ? partial : contained
  return Math.abs(partial.correlation) > Math.abs(contained.correlation) + 0.05 ? partial : contained
}

function synchronizeOnce(loggerSignal: Signal, cameraSignal: Signal, options: SyncOptions): SyncResult | null {
  const logger = clipSpikes(resample(loggerSignal))
  const camera = clipSpikes(resample(cameraSignal))
  const loggerValid = validCount(logger)
  if (loggerValid < SYNC_HZ * 5 || validCount(camera) < SYNC_HZ * 5) return null
  const n = logger.length
  const shorter = Math.min(loggerValid, validCount(camera))
  const minOverlap = Math.floor(
    Math.min(shorter, Math.max(MIN_OVERLAP_SECONDS * SYNC_HZ, shorter * (options.minOverlapFraction ?? CONTAINED_OVERLAP))),
  )
  const r = correlationByLag(logger, camera, minOverlap)

  // Axis conventions differ between loggers and cameras: take the sign of
  // the strongest match and look for peaks of that sign.
  let strongest = 0
  for (const value of r) if (Math.abs(value) > Math.abs(strongest)) strongest = value
  if (strongest === 0 || Number.isNaN(strongest)) return null
  const sign = Math.sign(strongest)

  const spacing = Math.round((options.minPeakSpacing ?? 5) * SYNC_HZ)
  const peaks: number[] = []
  for (let i = 0; i < r.length; i += 1) {
    const value = sign * r[i]!
    if (!(value > 0.3)) continue
    let isPeak = true
    for (let j = Math.max(0, i - spacing); j <= Math.min(r.length - 1, i + spacing); j += 1) {
      if (j !== i && sign * r[j]! > value) {
        isPeak = false
        break
      }
    }
    if (isPeak) peaks.push(i)
  }
  peaks.sort((x, y) => sign * r[y]! - sign * r[x]!)

  const candidates: SyncCandidate[] = peaks.slice(0, 8).map((index) => {
    const refined = refineLag(logger, camera, index - (n - 1), 1, sign)
    return { offset: refined.lag / SYNC_HZ, correlation: refined.r, halfDrift: null }
  })
  if (candidates.length === 0) return null

  // Close peaks (e.g. adjacent laps): rank by first/second-half agreement.
  const top = Math.abs(candidates[0]!.correlation)
  const contenders = candidates.filter((c) => Math.abs(c.correlation) >= 0.6 * top)
  const half = Math.floor(n / 2)
  const halfRange = 2 * SYNC_HZ
  const measureDrift = (c: SyncCandidate) => {
    const lag = Math.round(c.offset * SYNC_HZ)
    const first = refineLag(logger, camera, lag, halfRange, sign, 0, half)
    const second = refineLag(logger, camera, lag, halfRange, sign, half, n)
    c.halfDrift = (second.lag - first.lag) / SYNC_HZ
  }

  let separation: SyncResult['separation']
  const peakRatio = candidates[1] ? top / Math.abs(candidates[1].correlation) : Infinity
  if (contenders.length > 1 && peakRatio < 1.5 && n >= SYNC_HZ * 20) {
    contenders.forEach(measureDrift)
    contenders.sort((x, y) => Math.abs(x.halfDrift!) - Math.abs(y.halfDrift!))
    const rest = candidates.filter((c) => !contenders.includes(c))
    candidates.splice(0, candidates.length, ...contenders, ...rest)
    const d1 = Math.abs(contenders[0]!.halfDrift!)
    const d2 = Math.abs(contenders[1]!.halfDrift!)
    separation = { by: 'half-drift', ratio: d2 / Math.max(d1, 0.02) }
  } else {
    if (n >= SYNC_HZ * 20) measureDrift(candidates[0]!)
    separation = { by: 'peak', ratio: peakRatio }
  }

  // Robust pass: drop 5 s windows that don't agree at the chosen offset.
  // Windows with almost no turning carry no timing information either way.
  const best = candidates[0]!
  const bestLag = Math.round(best.offset * SYNC_HZ)
  const window = 5 * SYNC_HZ
  const overallSpread = standardDeviation(logger, 0, n)
  const use = new Uint8Array(n)
  let informative = 0
  let agreeing = 0
  for (let start = 0; start < n; start += window) {
    const end = Math.min(n, start + window)
    if (standardDeviation(logger, start, end) < 0.15 * overallSpread) continue
    if (correlationAt(logger, camera, bestLag, start, end) === 0) continue
    informative += 1
    if (sign * correlationAt(logger, camera, bestLag, start, end) >= 0.5) {
      agreeing += 1
      use.fill(1, start, end)
    }
  }
  const coverage = informative > 0 ? agreeing / informative : 0
  const refined = refineLag(logger, camera, bestLag, SYNC_HZ, sign, 0, n, use)

  // Window offsets → drift (line fit) and precision (scatter around it).
  const fitWindow = 10 * SYNC_HZ
  const points: Array<{ t: number; offset: number }> = []
  for (let start = 0; start + fitWindow <= n; start += fitWindow / 2) {
    let usable = 0
    for (let i = start; i < start + fitWindow; i += 1) usable += use[i]!
    if (usable < fitWindow * 0.8) continue
    const w = refineLag(logger, camera, Math.round(refined.lag), SYNC_HZ / 2, sign, start, start + fitWindow, use)
    if (w.r * sign <= 0 && sign !== 0) continue
    points.push({ t: (start + fitWindow / 2) / SYNC_HZ, offset: w.lag / SYNC_HZ })
  }

  let offset = refined.lag / SYNC_HZ
  let drift = 0
  let precision: number | null = null
  if (points.length >= 3) {
    const meanT = points.reduce((s, p) => s + p.t, 0) / points.length
    const meanO = points.reduce((s, p) => s + p.offset, 0) / points.length
    const sxx = points.reduce((s, p) => s + (p.t - meanT) ** 2, 0)
    const slope = sxx > 0 ? points.reduce((s, p) => s + (p.t - meanT) * (p.offset - meanO), 0) / sxx : 0
    const span = points[points.length - 1]!.t - points[0]!.t
    // Only correct drift over long recordings, and only within what real
    // clocks do (1000 ppm); short laps can't measure it reliably.
    const fitDrift = span >= MIN_DRIFT_SPAN && Math.abs(slope) < 1e-3
    drift = fitDrift ? slope : 0
    const intercept = fitDrift ? meanO - slope * meanT : meanO
    if (fitDrift) offset = intercept
    const residuals = points.map((p) => p.offset - (intercept + drift * p.t))
    precision = Math.sqrt(residuals.reduce((s, v) => s + v * v, 0) / residuals.length)
  }
  best.offset = offset
  best.correlation = refined.r

  const strength = Math.abs(refined.r)
  let confidence: SyncConfidence =
    strength >= 0.8 && separation.ratio >= 3 ? 'high' : strength >= 0.6 && separation.ratio >= 1.5 ? 'medium' : 'low'
  // Mostly disagreeing data can't be trusted, however good the rest looks.
  if (coverage < 0.5) confidence = 'low'
  else if (coverage < 0.75 && confidence === 'high') confidence = 'medium'

  return {
    offset,
    drift,
    correlation: refined.r,
    confidence,
    separation,
    precision,
    coverage,
    candidates,
  }
}
