// Auto-sync spike: find the offset between a logger CSV and an in-car video by
// cross-correlating the logger's yaw rate with horizontal image motion seen
// through the windshield (the camera is fixed to the car, so the scene slides
// sideways as the car yaws).
//
// Usage: node sync.mjs <video> <solostorm.csv> [--region x,y,w,h] (fractions)
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const ffmpegPath = require('../../node_modules/ffmpeg-static')

const [videoPath, csvPath] = process.argv.slice(2)
const regionArg = process.argv.indexOf('--region')
const region = regionArg > 0 ? process.argv[regionArg + 1].split(',').map(Number) : [0.27, 0.35, 0.4, 0.14]
const outDir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), 'out')
fs.mkdirSync(outDir, { recursive: true })

const STRIP_WIDTH = 320
const MAX_SHIFT = 16 // px per frame at STRIP_WIDTH
const GRID_HZ = 50

// ---------- logger ----------
function loadSolostorm(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/)
  const headers = lines[0].split(',')
  const col = (name) => {
    const index = headers.indexOf(name)
    if (index < 0) throw new Error(`Missing column ${name}`)
    return index
  }
  const t = col('GPS_TIME (ms)')
  const yaw = col('YAW_RATE (rad/s)')
  const speed = col('SPEED (m/s)')
  const rows = lines.slice(1).map((line) => line.split(','))
  const t0 = Number(rows[0][t])
  return rows.map((cells) => ({
    time: (Number(cells[t]) - t0) / 1000,
    yaw: Number(cells[yaw]),
    speed: Number(cells[speed]),
  }))
}

// ---------- video motion ----------
async function probeFps(file) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, ['-hide_banner', '-i', file], { windowsHide: true })
    let err = ''
    ff.stderr.on('data', (d) => (err += d))
    ff.on('close', () => {
      const m = err.match(/Video: .*?(\d+(?:\.\d+)?) fps/)
      if (m) resolve(Number(m[1]))
      else reject(new Error('Could not read fps'))
    })
  })
}

/** Decode a grayscale strip per frame and return per-frame horizontal shift (px). */
async function videoShifts(file) {
  const [rx, ry, rw, rh] = region
  // Height follows the crop aspect; keep it even.
  const filter = `crop=iw*${rw}:ih*${rh}:iw*${rx}:ih*${ry},scale=${STRIP_WIDTH}:-2,format=gray`
  const probe = spawn(
    ffmpegPath,
    ['-v', 'error', '-i', file, '-map', '0:v:0', '-frames:v', '1', '-vf', filter, '-f', 'rawvideo', '-'],
    { windowsHide: true },
  )
  const first = await new Promise((resolve) => {
    const chunks = []
    probe.stdout.on('data', (d) => chunks.push(d))
    probe.on('close', () => resolve(Buffer.concat(chunks)))
  })
  const height = first.length / STRIP_WIDTH
  const frameSize = STRIP_WIDTH * height

  const ff = spawn(
    ffmpegPath,
    ['-v', 'error', '-hwaccel', 'auto', '-i', file, '-map', '0:v:0', '-vf', filter, '-f', 'rawvideo', '-'],
    { windowsHide: true },
  )
  const shifts = []
  const changes = []
  let prev = null
  let pending = Buffer.alloc(0)
  for await (const chunk of ff.stdout) {
    pending = Buffer.concat([pending, chunk])
    while (pending.length >= frameSize) {
      const frame = pending.subarray(0, frameSize)
      pending = pending.subarray(frameSize)
      const current = Float32Array.from(frame)
      shifts.push(prev ? bestShift(prev, current, STRIP_WIDTH, height) : 0)
      changes.push(prev ? meanAbsDiff(prev, current) : 0)
      prev = current
    }
  }
  return { shifts, changes, height }
}

/** Mean absolute pixel change between frames (scene motion energy). */
function meanAbsDiff(a, b) {
  let sum = 0
  for (let i = 0; i < a.length; i += 1) sum += Math.abs(a[i] - b[i])
  return sum / a.length
}

/**
 * Horizontal shift s minimizing mean |a(x) - b(x + s)| over the overlap,
 * refined to subpixel with a parabola through the three best costs.
 */
function bestShift(a, b, width, height) {
  const costs = []
  for (let s = -MAX_SHIFT; s <= MAX_SHIFT; s += 1) {
    let sum = 0
    let n = 0
    const x0 = Math.max(0, -s)
    const x1 = Math.min(width, width - s)
    for (let y = 0; y < height; y += 1) {
      const row = y * width
      for (let x = x0; x < x1; x += 2) {
        sum += Math.abs(a[row + x] - b[row + x + s])
        n += 1
      }
    }
    costs.push(sum / n)
  }
  let best = 0
  for (let i = 1; i < costs.length; i += 1) if (costs[i] < costs[best]) best = i
  let sub = 0
  if (best > 0 && best < costs.length - 1) {
    const [l, c, r] = [costs[best - 1], costs[best], costs[best + 1]]
    const denom = l - 2 * c + r
    if (denom > 0) sub = (0.5 * (l - r)) / denom
  }
  return best - MAX_SHIFT + sub
}

// ---------- signal helpers ----------
function resample(times, values, hz) {
  const end = times[times.length - 1]
  const out = new Float64Array(Math.floor(end * hz) + 1)
  let j = 0
  for (let i = 0; i < out.length; i += 1) {
    const t = i / hz
    while (j < times.length - 2 && times[j + 1] < t) j += 1
    const span = times[j + 1] - times[j]
    const f = span > 0 ? Math.min(Math.max((t - times[j]) / span, 0), 1) : 0
    out[i] = values[j] + (values[j + 1] - values[j]) * f
  }
  return out
}

function median3(values) {
  return values.map((v, i) => {
    if (i === 0 || i === values.length - 1) return v
    const a = values[i - 1]
    const c = values[i + 1]
    return Math.max(Math.min(a, v), Math.min(Math.max(a, v), c))
  })
}

/** Pearson r of logger[i] vs video[i + lag] over the overlap. */
function correlationAt(logger, video, lag, minOverlap) {
  const i0 = Math.max(0, -lag)
  const i1 = Math.min(logger.length, video.length - lag)
  const n = i1 - i0
  if (n < minOverlap) return null
  let sa = 0
  let sb = 0
  for (let i = i0; i < i1; i += 1) {
    sa += logger[i]
    sb += video[i + lag]
  }
  const ma = sa / n
  const mb = sb / n
  let cov = 0
  let va = 0
  let vb = 0
  for (let i = i0; i < i1; i += 1) {
    const da = logger[i] - ma
    const db = video[i + lag] - mb
    cov += da * db
    va += da * da
    vb += db * db
  }
  return cov / Math.sqrt(va * vb)
}

// ---------- main ----------
const started = performance.now()
const logger = loadSolostorm(csvPath)
const fps = await probeFps(videoPath)
const { shifts, changes, height } = await videoShifts(videoPath)
const decodeSeconds = (performance.now() - started) / 1000

const videoTimes = shifts.map((_, i) => i / fps)
const videoSignal = resample(videoTimes, median3(shifts), GRID_HZ)
const loggerSignal = resample(
  logger.map((r) => r.time),
  logger.map((r) => r.yaw),
  GRID_HZ,
)

// lag (grid samples): video time = logger time + lag / GRID_HZ
const minOverlap = Math.floor(loggerSignal.length * 0.8)
const scores = []
for (let lag = -loggerSignal.length; lag <= videoSignal.length; lag += 1) {
  const r = correlationAt(loggerSignal, videoSignal, lag, minOverlap)
  if (r !== null) scores.push({ lag, r })
}
// Image shift sign vs yaw sign depends on mounting, so rank by |r|.
scores.sort((a, b) => Math.abs(b.r) - Math.abs(a.r))
const best = scores[0]
// Next-best peak at least 1 s away, as a confidence margin.
const runnerUp = scores.find((s) => Math.abs(s.lag - best.lag) > GRID_HZ)
const at = (lag) => correlationAt(loggerSignal, videoSignal, lag, minOverlap) ?? 0
const [l, c, r] = [Math.abs(at(best.lag - 1)), Math.abs(best.r), Math.abs(at(best.lag + 1))]
const denom = l - 2 * c + r
const subLag = denom < 0 ? (0.5 * (l - r)) / denom : 0
const offsetSeconds = (best.lag + subLag) / GRID_HZ

const result = {
  video: path.basename(videoPath),
  csv: path.basename(csvPath),
  fps,
  frames: shifts.length,
  strip: `${STRIP_WIDTH}x${height}`,
  region,
  decodeAndMotionSeconds: Number(decodeSeconds.toFixed(1)),
  offsetSeconds: Number(offsetSeconds.toFixed(3)),
  meaning: 'video time = logger time (from first CSV row) + offsetSeconds',
  correlation: Number(best.r.toFixed(3)),
  runnerUp: runnerUp && { offsetSeconds: runnerUp.lag / GRID_HZ, correlation: Number(runnerUp.r.toFixed(3)) },
  peakRatio: runnerUp ? Number((Math.abs(best.r) / Math.abs(runnerUp.r)).toFixed(2)) : null,
}
console.log(JSON.stringify(result, null, 2))

fs.writeFileSync(
  path.join(outDir, 'signals.json'),
  JSON.stringify({
    result,
    gridHz: GRID_HZ,
    logger: Array.from(loggerSignal),
    loggerSpeed: Array.from(resample(logger.map((r) => r.time), logger.map((r) => r.speed), GRID_HZ)),
    video: Array.from(videoSignal),
    fps,
    rawShifts: shifts.map((v) => Number(v.toFixed(3))),
    rawChanges: changes.map((v) => Number(v.toFixed(3))),
    scores: scores
      .slice()
      .sort((a, b) => a.lag - b.lag)
      .map((s) => [s.lag / GRID_HZ, Number(s.r.toFixed(4))]),
  }),
)
