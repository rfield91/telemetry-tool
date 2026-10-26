// Renders out/sync-plot.png from out/signals.json: logger yaw vs video image
// motion at the auto-sync offset and at the dash-timer offset, plus the
// correlation-vs-offset curve. Usage: electron plot.cjs [altOffsetSeconds]
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

// `--lap` plots out/lap-sync.json (camera IMU vs a single lap) instead.
const lapMode = process.argv.includes('--lap')
const signals = lapMode ? fromLapSync() : JSON.parse(fs.readFileSync(path.join(__dirname, 'out/signals.json'), 'utf8'))
function fromLapSync() {
  const lap = JSON.parse(fs.readFileSync(path.join(__dirname, 'out/lap-sync.json'), 'utf8'))
  return {
    gridHz: lap.gridHz,
    logger: lap.logger,
    video: lap.camera,
    scores: lap.scan,
    result: { offsetSeconds: lap.best.offset, correlation: lap.best.r },
  }
}
const hz = signals.gridHz
const auto = signals.result.offsetSeconds
const alt = Number(process.argv.find((a) => /^\d+(\.\d+)?$/.test(a)) ?? 29.4)
const sourceLabel = lapMode ? 'camera IMU yaw' : 'video image motion'
const altLabel = process.env.ALT_LABEL ?? (lapMode ? 'alternative' : 'dash timer')
const outFile = lapMode ? 'out/lap-sync-plot.png' : 'out/sync-plot.png'
const sign = Math.sign(signals.result.correlation)

// Scale video shift to logger units by least squares at the auto offset.
function aligned(offset) {
  const lag = Math.round(offset * hz)
  return signals.logger.map((_, i) => signals.video[i + lag] ?? 0)
}
const base = aligned(auto)
let num = 0
let den = 0
signals.logger.forEach((y, i) => {
  num += y * base[i] * sign
  den += base[i] * base[i]
})
const scale = (num / den) * sign

const W = 1400
const panel = (title, t0, t1, height, series) => {
  const i0 = Math.floor(t0 * hz)
  const i1 = Math.min(signals.logger.length, Math.floor(t1 * hz))
  const all = series.flatMap((s) => s.values.slice(i0, i1))
  const max = Math.max(...all.map(Math.abs)) * 1.05
  const x = (i) => 60 + ((i - i0) / (i1 - i0)) * (W - 80)
  const y = (v) => height / 2 - (v / max) * (height / 2 - 20)
  const lines = series
    .map(
      (s) =>
        `<polyline fill="none" stroke="${s.color}" stroke-width="${s.width ?? 2}" points="${s.values
          .slice(i0, i1)
          .map((v, k) => `${x(i0 + k).toFixed(1)},${y(v).toFixed(1)}`)
          .join(' ')}"/>`,
    )
    .join('')
  const ticks = []
  for (let t = Math.ceil(t0); t <= t1; t += t1 - t0 > 20 ? 10 : 1) {
    const i = t * hz
    ticks.push(`<line x1="${x(i)}" x2="${x(i)}" y1="0" y2="${height}" stroke="#334155"/><text x="${x(i) + 3}" y="${height - 4}" fill="#94a3b8" font-size="12">${t}s</text>`)
  }
  const legend = series.map((s, k) => `<text x="${70 + k * 330}" y="18" fill="${s.color}" font-size="14">${s.label}</text>`).join('')
  return `<div style="margin:12px 0"><div style="color:#e2e8f0;font:600 15px sans-serif;margin-bottom:4px">${title}</div>
  <svg width="${W}" height="${height}" style="background:#0f172a"><line x1="60" x2="${W - 20}" y1="${height / 2}" y2="${height / 2}" stroke="#475569"/>${ticks.join('')}${lines}${legend}</svg></div>`
}

const logger = signals.logger
const atAuto = aligned(auto).map((v) => v * scale)
const atAlt = aligned(alt).map((v) => v * scale)
// Window around the largest yaw swings for the zoomed view.
let peak = 0
logger.forEach((v, i) => {
  if (Math.abs(v) > Math.abs(logger[peak])) peak = i
})
const zoom0 = Math.max(0, peak / hz - 4)
const zoom1 = zoom0 + 8

const scores = signals.scores
const scorePanel = (() => {
  const H = 160
  const xs = scores.map((s) => s[0])
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const x = (t) => 60 + ((t - minX) / (maxX - minX)) * (W - 80)
  const y = (r) => H - 20 - Math.abs(r) * (H - 40)
  const pts = scores.map(([t, r]) => `${x(t).toFixed(1)},${y(r).toFixed(1)}`).join(' ')
  return `<div style="margin:12px 0"><div style="color:#e2e8f0;font:600 15px sans-serif;margin-bottom:4px">|correlation| vs candidate offset (whole video)</div>
  <svg width="${W}" height="${H}" style="background:#0f172a"><polyline fill="none" stroke="#a78bfa" stroke-width="1.5" points="${pts}"/>
  <line x1="${x(auto)}" x2="${x(auto)}" y1="0" y2="${H}" stroke="#2dd4bf" stroke-dasharray="4"/>
  <text x="${x(auto) + 6}" y="16" fill="#2dd4bf" font-size="13">auto ${auto.toFixed(3)} s, |r| ${Math.abs(signals.result.correlation).toFixed(3)}</text>
  <text x="62" y="${H - 4}" fill="#94a3b8" font-size="12">${minX.toFixed(0)} s</text><text x="${W - 70}" y="${H - 4}" fill="#94a3b8" font-size="12">${maxX.toFixed(0)} s</text></svg></div>`
})()

const html = `<body style="margin:0;padding:16px;background:#020617;width:${W + 32}px">
${panel(`Whole run: logger yaw vs ${sourceLabel} at auto offset ${auto.toFixed(3)} s`, 0, logger.length / hz, 220, [
  { label: 'logger YAW_RATE', color: '#f8fafc', values: logger },
  { label: `${sourceLabel} @ ${auto.toFixed(3)} s (auto)`, color: '#2dd4bf', values: atAuto },
])}
${panel(`${lapMode ? "Whole lap" : `Zoom ${zoom0.toFixed(0)}–${zoom1.toFixed(0)} s`}: auto offset vs ${altLabel} offset`, lapMode ? 0 : zoom0, lapMode ? logger.length / hz : zoom1, 300, [
  { label: 'logger YAW_RATE', color: '#f8fafc', values: logger, width: 3 },
  { label: `video @ ${auto.toFixed(3)} s (auto)`, color: '#2dd4bf', values: atAuto },
  { label: `video @ ${alt.toFixed(3)} s (${altLabel})`, color: '#f97316', values: atAlt },
])}
${scorePanel}
</body>`

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: W + 40, height: 1000, webPreferences: { offscreen: true } })
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  const height = await win.webContents.executeJavaScript('document.body.scrollHeight')
  win.setContentSize(W + 40, height)
  await new Promise((r) => setTimeout(r, 300))
  const image = await win.webContents.capturePage()
  fs.writeFileSync(path.join(__dirname, outFile), image.toPNG())
  console.log(`wrote ${outFile}`)
  app.quit()
})
