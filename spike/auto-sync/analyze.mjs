// Cross-checks for the sync result in out/signals.json:
//  1. Correlate the video yaw signal against several logger channels with
//     different latency paths (gyro yaw, GPS-heading yaw, lateral accel).
//  2. Time the visible launch (scene starts changing) vs the GPS speed ramp.
// Usage: node analyze.mjs <solostorm.csv>
import fs from 'node:fs'
import path from 'node:path'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'))
const signals = JSON.parse(fs.readFileSync(path.join(here, 'out/signals.json'), 'utf8'))
const GRID_HZ = signals.gridHz
const video = Float64Array.from(signals.video)

const lines = fs.readFileSync(process.argv[2], 'utf8').trim().split(/\r?\n/)
const headers = lines[0].split(',')
const rows = lines.slice(1).map((line) => line.split(',').map(Number))
const col = (name) => rows.map((r) => r[headers.indexOf(name)])
const gpsTime = col('GPS_TIME (ms)')
const times = gpsTime.map((t) => (t - gpsTime[0]) / 1000)
const real = col('RECORDED_SAMPLE_COUNT').map((n) => n > 0)

function resample(ts, vs, hz) {
  const out = new Float64Array(Math.floor(ts[ts.length - 1] * hz) + 1)
  let j = 0
  for (let i = 0; i < out.length; i += 1) {
    const t = i / hz
    while (j < ts.length - 2 && ts[j + 1] < t) j += 1
    const span = ts[j + 1] - ts[j]
    const f = span > 0 ? Math.min(Math.max((t - ts[j]) / span, 0), 1) : 0
    out[i] = vs[j] + (vs[j + 1] - vs[j]) * f
  }
  return out
}

function corr(a, b, lag) {
  const i0 = Math.max(0, -lag)
  const i1 = Math.min(a.length, b.length - lag)
  const n = i1 - i0
  let sa = 0
  let sb = 0
  for (let i = i0; i < i1; i += 1) {
    sa += a[i]
    sb += b[i + lag]
  }
  let cov = 0
  let va = 0
  let vb = 0
  for (let i = i0; i < i1; i += 1) {
    const da = a[i] - sa / n
    const db = b[i + lag] - sb / n
    cov += da * db
    va += da * da
    vb += db * db
  }
  return cov / Math.sqrt(va * vb)
}

/** Best offset searched ±3 s around a coarse estimate, with parabola refine. */
function bestOffset(loggerSignal, around) {
  const center = Math.round(around * GRID_HZ)
  let best = { lag: center, r: 0 }
  for (let lag = center - 3 * GRID_HZ; lag <= center + 3 * GRID_HZ; lag += 1) {
    const r = corr(loggerSignal, video, lag)
    if (Math.abs(r) > Math.abs(best.r)) best = { lag, r }
  }
  const [l, c, r] = [-1, 0, 1].map((d) => Math.abs(corr(loggerSignal, video, best.lag + d)))
  const denom = l - 2 * c + r
  const sub = denom < 0 ? (0.5 * (l - r)) / denom : 0
  return { offset: (best.lag + sub) / GRID_HZ, r: best.r }
}

// GPS-heading yaw rate: derivative of MATH_HEADING (deg) on real fixes only.
const heading = col('MATH_HEADING')
const headingTimes = []
const headingRate = []
let prev = null
rows.forEach((_, i) => {
  if (!real[i]) return
  if (prev !== null) {
    let d = heading[i] - heading[prev]
    if (d > 180) d -= 360
    if (d < -180) d += 360
    const dt = times[i] - times[prev]
    if (dt > 0) {
      headingTimes.push((times[i] + times[prev]) / 2)
      headingRate.push((d * Math.PI) / 180 / dt)
    }
  }
  prev = i
})

const coarse = signals.result.offsetSeconds
const channels = {
  'YAW_RATE (gyro)': resample(times, col('YAW_RATE (rad/s)'), GRID_HZ),
  'YAW_RATE (gyro, real samples only)': resample(
    times.filter((_, i) => real[i]),
    col('YAW_RATE (rad/s)').filter((_, i) => real[i]),
    GRID_HZ,
  ),
  'GPS heading rate': resample(headingTimes, headingRate, GRID_HZ),
  'ACCEL_Y (lateral)': resample(times, col('ACCEL_Y (m/s^2)'), GRID_HZ),
  'ACCEL_X': resample(times, col('ACCEL_X (m/s^2)'), GRID_HZ),
}
console.log('Offset by logger channel (video time = logger time + offset):')
for (const [name, signal] of Object.entries(channels)) {
  const { offset, r } = bestOffset(signal, coarse)
  console.log(`  ${name.padEnd(36)} ${offset.toFixed(3)} s   r=${r.toFixed(3)}`)
}

// Precision and clock drift: the offset from each 10 s window of the run
// (searched ±1 s around the full-run result).
{
  const yaw = channels['YAW_RATE (gyro)']
  const windowLength = 10 * GRID_HZ
  console.log('\nPer-window offsets (YAW_RATE, 10 s windows):')
  const offsets = []
  for (let start = 0; start + windowLength <= yaw.length; start += windowLength / 2) {
    const slice = yaw.slice(start, start + windowLength)
    const center = Math.round(coarse * GRID_HZ) + start
    let best = { lag: center, r: 0 }
    for (let lag = center - GRID_HZ; lag <= center + GRID_HZ; lag += 1) {
      const r = corr(slice, video, lag)
      if (Math.abs(r) > Math.abs(best.r)) best = { lag, r }
    }
    const [l, c, r] = [-1, 0, 1].map((d) => Math.abs(corr(slice, video, best.lag + d)))
    const denom = l - 2 * c + r
    const sub = denom < 0 ? (0.5 * (l - r)) / denom : 0
    const offset = (best.lag + sub - start) / GRID_HZ
    offsets.push({ t: start / GRID_HZ, offset })
    console.log(`  ${String(start / GRID_HZ).padStart(4)}–${String((start + windowLength) / GRID_HZ).padStart(2)} s  ${offset.toFixed(3)} s  r=${best.r.toFixed(3)}`)
  }
  const values = offsets.map((o) => o.offset)
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length)
  const n = offsets.length
  const mt = offsets.reduce((a, o) => a + o.t, 0) / n
  const drift = offsets.reduce((a, o) => a + (o.t - mt) * (o.offset - mean), 0) / offsets.reduce((a, o) => a + (o.t - mt) ** 2, 0)
  console.log(`  mean ${mean.toFixed(3)} s, sd ${(sd * 1000).toFixed(0)} ms, drift ${(drift * 1000).toFixed(2)} ms per s`)
}

// Launch: logger speed ramp extrapolated to zero, vs first sustained rise in
// scene change energy in the video.
const speed = col('SPEED (m/s)')
const slope = (speed[5] - speed[0]) / (times[5] - times[0])
const loggerZeroSpeed = times[0] - speed[0] / slope
const changes = signals.rawChanges
const fps = signals.fps
const quietEnd = Math.floor((coarse - 5) * fps)
const baseline = changes.slice(Math.max(1, quietEnd - 3 * fps), quietEnd)
const mean = baseline.reduce((a, b) => a + b, 0) / baseline.length
const sd = Math.sqrt(baseline.reduce((a, b) => a + (b - mean) ** 2, 0) / baseline.length)
let launchFrame = null
for (let i = quietEnd; i < changes.length - 10; i += 1) {
  if (changes.slice(i, i + 10).every((v) => v > mean + 4 * sd)) {
    launchFrame = i
    break
  }
}
console.log('\nLaunch check:')
console.log(`  logger speed reaches 0 (extrapolated) at logger t=${loggerZeroSpeed.toFixed(3)} s (accel ${slope.toFixed(2)} m/s²)`)
if (launchFrame !== null) {
  const launchVideo = launchFrame / fps
  console.log(`  video scene starts changing at frame ${launchFrame} = ${launchVideo.toFixed(3)} s (baseline ${mean.toFixed(2)}±${sd.toFixed(2)})`)
  console.log(`  implied offset ${(launchVideo - loggerZeroSpeed).toFixed(3)} s`)
}
