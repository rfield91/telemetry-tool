// Multi-lap sync: find which lap of a session video a single-lap logger
// export belongs to, using the DJI camera IMU (djmd) yaw rate.
//
// 1. Correlate the lap's yaw against the whole video: every lap gives a peak.
// 2. For each candidate, align the lap's first and second halves separately.
//    On the right lap both halves agree; on a wrong lap the second half drifts
//    by roughly the lap-time difference.
//
// Usage: node lapSync.mjs <video.mp4> <solostorm-lap.csv> [cameraClockAheadSeconds]
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

const [videoPath, csvPath, clockAheadArg] = process.argv.slice(2)

// ---------- camera IMU yaw ----------
function cameraYaw(file) {
  const probe = spawnSync(ffprobePath, ['-v', 'error', '-show_entries', 'stream=index,codec_tag_string:stream_tags=creation_time', '-of', 'csv=p=0', file], { encoding: 'utf8' })
  const lines = probe.stdout.trim().split(/\r?\n/)
  const djmd = lines.find((l) => l.split(',')[1] === 'djmd')
  if (!djmd) throw new Error('No djmd metadata track')
  const stream = Number(djmd.split(',')[0])
  const creationTime = djmd.split(',')[2]
  const sizes = spawnSync(ffprobePath, ['-v', 'error', '-select_streams', String(stream), '-show_entries', 'packet=pts_time,size', '-of', 'csv=p=0', file], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .stdout.trim()
    .split(/\r?\n/)
    .map((l) => l.split(',').map(Number))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'djmd-'))
  const tmp = path.join(dir, 'djmd.bin')
  spawnSync(ffmpegPath, ['-v', 'error', '-y', '-i', file, '-map', `0:${stream}`, '-c', 'copy', '-f', 'data', tmp])
  const blob = fs.readFileSync(tmp)
  fs.rmSync(dir, { recursive: true })

  const sub = (fields, n) => fields.find((f) => f.field === n)?.raw
  const floats = (raw, count) => {
    const values = new Array(count).fill(0)
    for (const f of parseMessage(raw)) if (f.wire === 5 && f.field <= count) values[f.field - 1] = f.raw.readFloatLE(0)
    return values
  }
  const samples = []
  let offset = 0
  for (const [time, size] of sizes) {
    const packet = blob.subarray(offset, offset + size)
    offset += size
    const state = parseMessage(sub(parseMessage(sub(parseMessage(packet), 3)), 2))
    const q = sub(state, 9)
    const a = sub(state, 10)
    if (q && a) samples.push({ time, q: floats(q, 4), a: floats(a, 4).slice(1) })
  }

  const up = [0, 1, 2].map((i) => samples.reduce((acc, s) => acc + s.a[i], 0) / samples.length)
  const norm = Math.hypot(...up)
  const times = []
  const yaw = []
  for (let i = 1; i < samples.length; i += 1) {
    const [w1, x1, y1, z1] = samples[i - 1].q
    const [w2, x2, y2, z2] = samples[i].q
    // Body-frame relative rotation conj(q1) * q2.
    let d = [
      w1 * w2 + x1 * x2 + y1 * y2 + z1 * z2,
      w1 * x2 - x1 * w2 - y1 * z2 + z1 * y2,
      w1 * y2 + x1 * z2 - y1 * w2 - z1 * x2,
      w1 * z2 - x1 * y2 + y1 * x2 - z1 * w2,
    ]
    if (d[0] < 0) d = d.map((v) => -v)
    const dt = samples[i].time - samples[i - 1].time
    const s = Math.hypot(d[1], d[2], d[3])
    const k = s > 0 && dt > 0 ? (2 * Math.atan2(s, d[0])) / s / dt : 0
    times.push((samples[i].time + samples[i - 1].time) / 2)
    yaw.push(((d[1] * up[0] + d[2] * up[1] + d[3] * up[2]) / norm) * k)
  }
  return { times, yaw, creationTime }
}

// ---------- logger ----------
function loggerLap(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/)
  const headers = lines[0].split(',')
  const rows = lines.slice(1).map((l) => l.split(',').map(Number))
  const col = (n) => headers.indexOf(n)
  const t0 = rows[0][col('GPS_TIME (ms)')]
  return {
    times: rows.map((r) => (r[col('GPS_TIME (ms)')] - t0) / 1000),
    yaw: rows.map((r) => r[col('YAW_RATE (rad/s)')]),
    // GPS time runs 18 s ahead of UTC.
    startUtcMs: t0 - 18_000,
    lap: rows[0][col('MATH_LAP_NUMBER')],
  }
}

// ---------- signal helpers ----------
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
  if (n < a.length * 0.95) return null
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
/** Best lag within ±range samples of `center`, with parabola refinement. */
function refine(a, b, center, range) {
  let best = { lag: center, r: 0 }
  for (let lag = center - range; lag <= center + range; lag += 1) {
    const r = corr(a, b, lag) ?? 0
    if (Math.abs(r) > Math.abs(best.r)) best = { lag, r }
  }
  const [l, c, r] = [-1, 0, 1].map((d) => Math.abs(corr(a, b, best.lag + d) ?? 0))
  const denom = l - 2 * c + r
  return { offset: (best.lag + (denom < 0 ? (0.5 * (l - r)) / denom : 0)) / GRID_HZ, r: best.r }
}

// ---------- main ----------
const started = performance.now()
const cam = cameraYaw(videoPath)
const lap = loggerLap(csvPath)
const camera = resample(cam.times, cam.yaw, GRID_HZ)
const logger = resample(lap.times, lap.yaw, GRID_HZ)
const lapSeconds = lap.times[lap.times.length - 1]

// 1. Full scan; keep local |r| maxima at least half a lap apart.
const scan = []
for (let lag = 0; lag <= camera.length - logger.length; lag += 1) scan.push({ lag, r: corr(logger, camera, lag) ?? 0 })
const sign = Math.sign(scan.reduce((best, s) => (Math.abs(s.r) > Math.abs(best.r) ? s : best)).r)
const minGap = Math.floor((lapSeconds / 2) * GRID_HZ)
const peaks = scan
  .filter((s, i) => s.r * sign > 0.3 && scan.slice(Math.max(0, i - minGap), i + minGap).every((o) => o.r * sign <= s.r * sign))
  .sort((a, b) => a.lag - b.lag)

// 2. Half-split check per candidate.
const half = Math.floor(logger.length / 2)
const first = logger.slice(0, half)
const second = logger.slice(half)
const candidates = peaks.map((p, index) => {
  const full = refine(logger, camera, p.lag, GRID_HZ)
  const a = refine(first, camera, Math.round(full.offset * GRID_HZ), 2 * GRID_HZ)
  const b = refine(second, camera, Math.round(full.offset * GRID_HZ) + half, 2 * GRID_HZ)
  const secondOffset = b.offset - half / GRID_HZ
  return {
    index: index + 1,
    offset: full.offset,
    r: full.r,
    firstHalf: a.offset,
    secondHalf: secondOffset,
    halfDrift: secondOffset - a.offset,
  }
})
// Video lap length ≈ spacing to the next candidate.
candidates.forEach((c, i) => {
  c.videoLapSeconds = candidates[i + 1] ? candidates[i + 1].offset - c.offset : null
})
const ranked = [...candidates].sort((x, y) => Math.abs(x.halfDrift) - Math.abs(y.halfDrift))
const best = ranked[0]
const elapsed = (performance.now() - started) / 1000

console.log(`Logged lap: #${lap.lap}, ${lapSeconds.toFixed(3)} s, started ${new Date(lap.startUtcMs).toISOString()} (UTC)`)
console.log(`Video: ${(camera.length / GRID_HZ).toFixed(1)} s, camera clock says ${cam.creationTime}`)
console.log(`Analysis took ${elapsed.toFixed(1)} s\n`)
console.log(' cand   offset(s)    r     1st half   2nd half   drift(ms)  video lap(s)')
for (const c of candidates) {
  console.log(
    `${c === best ? '→' : ' '}${String(c.index).padStart(4)}  ${c.offset.toFixed(3).padStart(9)}  ${c.r.toFixed(3).padStart(6)}  ${c.firstHalf.toFixed(3).padStart(9)}  ${c.secondHalf
      .toFixed(3)
      .padStart(9)}  ${(c.halfDrift * 1000).toFixed(0).padStart(8)}  ${c.videoLapSeconds?.toFixed(3) ?? '   —'}`,
  )
}
const runnerUp = ranked[1]
console.log(
  `\nBest: candidate ${best.index}, video time = logger time + ${best.offset.toFixed(3)} s (lap starts at ${Math.floor(best.offset / 60)}:${(best.offset % 60).toFixed(2).padStart(5, '0')} in the video)`,
)
console.log(`Half drift ${(best.halfDrift * 1000).toFixed(0)} ms vs next-best ${(runnerUp.halfDrift * 1000).toFixed(0)} ms (candidate ${runnerUp.index})`)

if (clockAheadArg) {
  const cameraStartUtc = Date.parse(cam.creationTime) - Number(clockAheadArg) * 1000
  const predicted = (lap.startUtcMs - cameraStartUtc) / 1000
  console.log(`Clock prior (camera ${clockAheadArg} s fast): lap predicted at ${predicted.toFixed(1)} s in the video (${(predicted - best.offset).toFixed(1)} s from best)`)
}

fs.mkdirSync(new URL('./out/', import.meta.url), { recursive: true })
fs.writeFileSync(
  new URL('./out/lap-sync.json', import.meta.url),
  JSON.stringify({ gridHz: GRID_HZ, candidates, best, logger: Array.from(logger), camera: Array.from(camera), scan: scan.filter((_, i) => i % 5 === 0).map((s) => [s.lag / GRID_HZ, Number(s.r.toFixed(4))]) }),
)
