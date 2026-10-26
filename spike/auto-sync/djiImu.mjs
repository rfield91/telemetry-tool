// Sync a logger CSV to DJI Osmo Action 4 video using the camera's own IMU:
// the per-frame `djmd` protobuf carries an orientation quaternion (3.2.9) and
// an accelerometer vector in g (3.2.10), timestamped on the video timeline.
//
// Usage: node djiImu.mjs <video.mp4> <solostorm.csv>
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseMessage } from './djiDump.mjs'

const require = createRequire(import.meta.url)
const ffmpegPath = require('../../node_modules/ffmpeg-static')
const ffprobePath = require('../../node_modules/ffprobe-static').path
const GRID_HZ = 50

const [videoPath, csvPath] = process.argv.slice(2)
const started = performance.now()

// ---------- extract djmd packets ----------
function findDjmdStream() {
  const probe = spawnSync(ffprobePath, ['-v', 'error', '-show_entries', 'stream=index,codec_tag_string', '-of', 'csv=p=0', videoPath], { encoding: 'utf8' })
  const line = probe.stdout.split(/\r?\n/).find((l) => l.endsWith(',djmd'))
  if (!line) throw new Error('No djmd metadata track in this file')
  return Number(line.split(',')[0])
}
const stream = findDjmdStream()
const sizes = spawnSync(ffprobePath, ['-v', 'error', '-select_streams', String(stream), '-show_entries', 'packet=pts_time,size', '-of', 'csv=p=0', videoPath], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
  .stdout.trim()
  .split(/\r?\n/)
  .map((l) => l.split(',').map(Number))
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'djmd-')), 'djmd.bin')
spawnSync(ffmpegPath, ['-v', 'error', '-y', '-i', videoPath, '-map', `0:${stream}`, '-c', 'copy', '-f', 'data', tmp])
const blob = fs.readFileSync(tmp)
fs.rmSync(path.dirname(tmp), { recursive: true })

// proto3 omits zero-valued fields, so absent components default to 0.
const floatsByField = (raw, count) => {
  const values = new Array(count).fill(0)
  for (const f of parseMessage(raw)) if (f.wire === 5 && f.field <= count) values[f.field - 1] = f.raw.readFloatLE(0)
  return values
}
const sub = (fields, n) => fields.find((f) => f.field === n)?.raw

const samples = []
let offset = 0
for (const [time, size] of sizes) {
  const packet = blob.subarray(offset, offset + size)
  offset += size
  const frame = parseMessage(sub(parseMessage(packet), 3))
  const state = parseMessage(sub(frame, 2))
  const q = sub(state, 9)
  const a = sub(state, 10)
  if (!q || !a) continue
  samples.push({ time, q: floatsByField(q, 4), a: floatsByField(a, 4).slice(1) })
}
const extractSeconds = (performance.now() - started) / 1000

// ---------- angular velocity ----------
const conj = ([w, x, y, z]) => [w, -x, -y, -z]
const mul = ([aw, ax, ay, az], [bw, bx, by, bz]) => [
  aw * bw - ax * bx - ay * by - az * bz,
  aw * bx + ax * bw + ay * bz - az * by,
  aw * by - ax * bz + ay * bw + az * bx,
  aw * bz + ax * by - ay * bx + az * bw,
]
/** Rotation from q1 to q2 as a rate vector (rad/s), body or world frame. */
function rate(q1, q2, dt, frame) {
  let d = frame === 'body' ? mul(conj(q1), q2) : mul(q2, conj(q1))
  if (d[0] < 0) d = d.map((v) => -v)
  const s = Math.hypot(d[1], d[2], d[3])
  const angle = 2 * Math.atan2(s, d[0])
  const k = s > 0 ? angle / s / dt : 0
  return [d[1] * k, d[2] * k, d[3] * k]
}

// Gravity direction in the camera's body frame = mean accelerometer vector.
const mean = [0, 1, 2].map((i) => samples.reduce((acc, s) => acc + s.a[i], 0) / samples.length)
const gNorm = Math.hypot(...mean)
const up = mean.map((v) => v / gNorm)

const times = []
const candidates = { 'body·gravity': [], 'world z': [], 'body x': [], 'body y': [], 'body z': [] }
for (let i = 1; i < samples.length; i += 1) {
  const dt = samples[i].time - samples[i - 1].time
  if (dt <= 0) continue
  const body = rate(samples[i - 1].q, samples[i].q, dt, 'body')
  const world = rate(samples[i - 1].q, samples[i].q, dt, 'world')
  times.push((samples[i].time + samples[i - 1].time) / 2)
  candidates['body·gravity'].push(body[0] * up[0] + body[1] * up[1] + body[2] * up[2])
  candidates['world z'].push(world[2])
  candidates['body x'].push(body[0])
  candidates['body y'].push(body[1])
  candidates['body z'].push(body[2])
}

// ---------- logger ----------
const lines = fs.readFileSync(csvPath, 'utf8').trim().split(/\r?\n/)
const headers = lines[0].split(',')
const rows = lines.slice(1).map((l) => l.split(',').map(Number))
const tCol = headers.indexOf('GPS_TIME (ms)')
const yawCol = headers.indexOf('YAW_RATE (rad/s)')
const loggerTimes = rows.map((r) => (r[tCol] - rows[0][tCol]) / 1000)
const loggerYaw = rows.map((r) => r[yawCol])

// ---------- correlation ----------
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
  if (n < a.length * 0.8) return null
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
function search(logger, camera) {
  const scores = []
  for (let lag = -logger.length; lag <= camera.length; lag += 1) {
    const r = corr(logger, camera, lag)
    if (r !== null) scores.push({ lag, r })
  }
  scores.sort((x, y) => Math.abs(y.r) - Math.abs(x.r))
  const best = scores[0]
  const runnerUp = scores.find((s) => Math.abs(s.lag - best.lag) > GRID_HZ)
  const [l, c, r] = [-1, 0, 1].map((d) => Math.abs(corr(logger, camera, best.lag + d) ?? 0))
  const denom = l - 2 * c + r
  const subLag = denom < 0 ? (0.5 * (l - r)) / denom : 0
  return { offset: (best.lag + subLag) / GRID_HZ, r: best.r, peakRatio: Math.abs(best.r) / Math.abs(runnerUp.r) }
}

const logger = resample(loggerTimes, loggerYaw, GRID_HZ)
console.log(`djmd: ${samples.length} samples over ${samples[samples.length - 1].time.toFixed(1)} s, extracted in ${extractSeconds.toFixed(1)} s`)
console.log(`mean accel (g): [${mean.map((v) => v.toFixed(3)).join(', ')}], |g| = ${gNorm.toFixed(3)}`)
console.log('Offset by camera-IMU axis (video time = logger time + offset):')
const results = {}
for (const [name, values] of Object.entries(candidates)) {
  const result = search(logger, resample(times, values, GRID_HZ))
  results[name] = result
  console.log(`  ${name.padEnd(14)} ${result.offset.toFixed(3)} s   r=${result.r.toFixed(3)}   peak ratio ${result.peakRatio.toFixed(2)}`)
}

// Per-window precision on the gravity-projected yaw.
const camera = resample(times, candidates['body·gravity'], GRID_HZ)
const best = results['body·gravity']
const windowLength = 10 * GRID_HZ
const offsets = []
for (let start = 0; start + windowLength <= logger.length; start += windowLength / 2) {
  const slice = logger.slice(start, start + windowLength)
  const center = Math.round(best.offset * GRID_HZ) + start
  let top = { lag: center, r: 0 }
  for (let lag = center - GRID_HZ; lag <= center + GRID_HZ; lag += 1) {
    const r = corr(slice, camera, lag) ?? 0
    if (Math.abs(r) > Math.abs(top.r)) top = { lag, r }
  }
  const [l, c, r] = [-1, 0, 1].map((d) => Math.abs(corr(slice, camera, top.lag + d) ?? 0))
  const denom = l - 2 * c + r
  offsets.push((top.lag + (denom < 0 ? (0.5 * (l - r)) / denom : 0) - start) / GRID_HZ)
}
const m = offsets.reduce((a, b) => a + b, 0) / offsets.length
const sd = Math.sqrt(offsets.reduce((a, b) => a + (b - m) ** 2, 0) / offsets.length)
console.log(`Per-window (10 s): mean ${m.toFixed(3)} s, sd ${(sd * 1000).toFixed(0)} ms over ${offsets.length} windows`)

// Scale check: camera yaw rate vs logger yaw rate at the best offset.
const lag = Math.round(best.offset * GRID_HZ)
let num = 0
let den = 0
logger.forEach((y, i) => {
  const c = camera[i + lag] ?? 0
  num += y * c
  den += y * y
})
console.log(`Camera yaw rate / logger yaw rate (least squares): ${(num / den).toFixed(3)}`)

fs.mkdirSync(new URL('./out/', import.meta.url), { recursive: true })
fs.writeFileSync(
  new URL('./out/dji-imu.json', import.meta.url),
  JSON.stringify({ gridHz: GRID_HZ, offset: best.offset, logger: Array.from(logger), camera: Array.from(camera) }),
)
