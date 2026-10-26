// Runs each benchmark job in a fresh hidden window and prints a table.
// Usage: electron main.cjs [path/to/your-video.mp4 ...]
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

app.commandLine.appendSwitch('enable-features', 'PlatformHEVCEncoderSupport')

const media = path.join(__dirname, 'media')
const outDir = path.join(__dirname, 'out')
fs.mkdirSync(outDir, { recursive: true })

// Real camera files: a focused job set over a 60 s window starting at 5:00
// (override with START / DURATION env vars, in seconds).
const userVideos = process.argv.slice(2).filter((arg) => /\.(mp4|mov)$/i.test(arg))
const userJobs = []
{
  const jobs = userJobs
  for (const file of userVideos) {
    const base = {
      source: path.basename(file),
      input: path.resolve(file),
      fps: Number(process.env.FPS ?? 60000 / 1001),
      bitrate: 40e6,
      decodeHw: 'prefer-hardware',
      startSeconds: Number(process.env.START ?? 300),
      durationSeconds: Number(process.env.DURATION ?? 60),
    }
    jobs.push({ ...base, mode: 'decode' })
    jobs.push({ ...base, mode: 'full', encode: 'avc', hw: 'prefer-hardware' })
    jobs.push({ ...base, mode: 'full', encode: 'avc', hw: 'prefer-hardware', compositor: 'webgpu', atlas: true })
    jobs.push({ ...base, mode: 'full', encode: 'hevc', hw: 'prefer-hardware', compositor: 'webgpu', atlas: true })
  }
}
const sources = userVideos.length
  ? []
  : [
      { name: '1080p60 h264', file: path.join(media, 'src-1080p60-h264.mp4'), fps: 60, bitrate: 20e6 },
      { name: '4K60 hevc', file: path.join(media, 'src-4k60-hevc.mp4'), fps: 60, bitrate: 60e6 },
    ]

const jobs = []
for (const source of sources) {
  const base = { source: source.name, input: source.file, fps: source.fps, bitrate: source.bitrate, decodeHw: 'prefer-hardware' }
  jobs.push({ ...base, mode: 'decode' })
  jobs.push({ ...base, mode: 'draw' })
  jobs.push({ ...base, mode: 'full', encode: 'avc', hw: 'prefer-hardware' })
  jobs.push({ ...base, mode: 'full', encode: 'hevc', hw: 'prefer-hardware' })
  jobs.push({ ...base, mode: 'full', encode: 'avc', hw: 'prefer-software' })
  jobs.push({ ...base, mode: 'transcode', encode: 'avc', hw: 'prefer-hardware' })
  jobs.push({ ...base, mode: 'snapshot' })
  jobs.push({ ...base, mode: 'full', encode: 'avc', hw: 'prefer-hardware', compositor: 'gl' })
  jobs.push({ ...base, mode: 'full', encode: 'hevc', hw: 'prefer-hardware', compositor: 'gl' })
  jobs.push({ ...base, mode: 'full', encode: 'avc', hw: 'prefer-hardware', compositor: 'nv12' })
  jobs.push({ ...base, mode: 'full', encode: 'hevc', hw: 'prefer-hardware', compositor: 'nv12' })
  jobs.push({ ...base, mode: 'full', encode: 'avc', hw: 'prefer-hardware', compositor: 'nv12-async' })
  jobs.push({ ...base, mode: 'full', encode: 'hevc', hw: 'prefer-hardware', compositor: 'nv12-async' })
  jobs.push({ ...base, mode: 'full', encode: 'avc', hw: 'prefer-hardware', compositor: 'webgpu' })
  jobs.push({ ...base, mode: 'full', encode: 'hevc', hw: 'prefer-hardware', compositor: 'webgpu' })
  jobs.push({ ...base, mode: 'full', encode: 'avc', hw: 'prefer-hardware', compositor: 'webgpu', skipEncode: true })
  jobs.push({ ...base, mode: 'encode-cpu', encode: 'avc', hw: 'prefer-hardware' })
  jobs.push({ ...base, mode: 'full', encode: 'avc', hw: 'prefer-hardware', compositor: 'webgpu', skipEncode: true, skipOverlayUpload: true })
  jobs.push({ ...base, mode: 'full', encode: 'avc', hw: 'prefer-hardware', compositor: 'webgpu', skipEncode: true, bitmapUpload: true })
  jobs.push({ ...base, mode: 'full', encode: 'avc', hw: 'prefer-hardware', compositor: 'webgpu', atlas: true })
  jobs.push({ ...base, mode: 'full', encode: 'hevc', hw: 'prefer-hardware', compositor: 'webgpu', atlas: true })
  jobs.push({ ...base, mode: 'full', encode: 'avc', hw: 'prefer-hardware', compositor: 'webgpu', tinyOverlay: true })
  jobs.push({ ...base, mode: 'full', encode: 'avc', hw: 'prefer-hardware', compositor: 'webgpu', atlas: true, cpuOverlay: true })
  jobs.push({ ...base, mode: 'full', encode: 'hevc', hw: 'prefer-hardware', compositor: 'webgpu', atlas: true, cpuOverlay: true })
}
// WebGPU readback microbenchmarks (no video): full RGBA and NV12-sized.
for (const [width, height] of [[1920, 1080], [3840, 2160]]) {
  jobs.push({ source: `${height}p readback`, mode: 'gpuread', width, height, bytesPerPixel: 4 })
  jobs.push({ source: `${height}p readback`, mode: 'gpuread', width, height, bytesPerPixel: 1.5 })
}
if (userJobs.length) jobs.splice(0, jobs.length, ...userJobs)
jobs.forEach((job, i) => {
  job.index = i
  job.profile = Boolean(process.env.PROFILE)
  if (job.encode) job.output = path.join(outDir, `${i}-${job.encode}-${job.hw}${job.compositor ? `-${job.compositor}` : ''}.mp4`)
})
// ONLY=1,3 runs a subset of jobs by index.
const only = process.env.ONLY?.split(',').map(Number)
const selectedJobs = only ? jobs.filter((job) => only.includes(job.index)) : jobs

function runJob(job) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false },
    })
    ipcMain.once('result', (_event, result) => {
      win.destroy()
      resolve(result)
    })
    win.loadFile(path.join(__dirname, 'index.html'), { hash: encodeURIComponent(JSON.stringify(job)) })
  })
}

app.whenReady().then(async () => {
  const results = []
  for (const job of selectedJobs) {
    const result = await runJob(job)
    results.push(result)
    console.log(JSON.stringify(result))
  }
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2))
  app.quit()
})
