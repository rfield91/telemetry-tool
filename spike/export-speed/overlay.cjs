// Canvas 2D overlay layout drawn from real AiM telemetry (sample-data/3.csv).
// Roughly matches the aim-default preset: speed gauge, TPS bar, engine
// readouts, track map, g-meter. Static geometry is cached as Path2D.
const fs = require('node:fs')

function loadTelemetry(csvPath) {
  const lines = fs.readFileSync(csvPath, 'utf8').split(/\r?\n/)
  const headerIndex = lines.findIndex((line) => line.startsWith('"Time","GPS Speed"'))
  const headers = lines[headerIndex].split(',').map((cell) => cell.replace(/"/g, ''))
  const col = (name) => headers.indexOf(name)
  const wanted = {
    time: col('Time'),
    speed: col('GPS Speed'),
    latAcc: col('GPS LatAcc'),
    lonAcc: col('GPS LonAcc'),
    lat: col('GPS Latitude'),
    lon: col('GPS Longitude'),
    tps: col('ECU TPS'),
    oilT: col('ECU OIL T'),
    oilP: col('ECU OIL P'),
    ect: col('ECU ECT'),
  }
  const rows = []
  for (let i = headerIndex + 2; i < lines.length; i += 1) {
    const cells = lines[i].split(',')
    if (cells.length !== headers.length) continue
    const row = {}
    for (const [key, index] of Object.entries(wanted)) {
      row[key] = Number(cells[index].replace(/"/g, ''))
    }
    if (Number.isFinite(row.time)) rows.push(row)
  }
  return rows
}

function sampler(rows) {
  return (time, key) => {
    if (time <= rows[0].time) return rows[0][key]
    const last = rows[rows.length - 1]
    if (time >= last.time) return last[key]
    let lo = 0
    let hi = rows.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (rows[mid].time <= time) lo = mid
      else hi = mid
    }
    const a = rows[lo]
    const b = rows[hi]
    const t = (time - a.time) / (b.time - a.time)
    return a[key] + (b[key] - a[key]) * t
  }
}

function createOverlay(csvPath, width, height) {
  const rows = loadTelemetry(csvPath)
  const sample = sampler(rows)
  const u = height / 1080 // layout unit: 1px at 1080p
  const font = (px, weight = 600) => `${weight} ${Math.round(px * u)}px "Segoe UI", sans-serif`

  // Track map path, projected once into a 300u box.
  const mapBox = { x: width - 360 * u, y: 40 * u, size: 300 * u }
  const lat0 = rows[0].lat
  const cosLat = Math.cos((lat0 * Math.PI) / 180)
  const projected = rows.map((r) => [r.lon * cosLat, -r.lat])
  const xs = projected.map((p) => p[0])
  const ys = projected.map((p) => p[1])
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const span = Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY)
  const toMap = (lat, lon) => [
    mapBox.x + ((lon * cosLat - minX) / span) * mapBox.size,
    mapBox.y + ((-lat - minY) / span) * mapBox.size,
  ]
  // The outline is static: decimate it and rasterize it once into its own
  // layer, so each frame only blits it (re-stroking 22k segments per frame
  // was the 4K bottleneck).
  const step = Math.max(1, Math.floor(rows.length / 2000))
  const trackLayer = new OffscreenCanvas(Math.ceil(mapBox.size + 40 * u), Math.ceil(mapBox.size + 40 * u))
  const trackOrigin = { x: mapBox.x - 20 * u, y: mapBox.y - 20 * u }
  {
    const layerCtx = trackLayer.getContext('2d')
    layerCtx.translate(-trackOrigin.x, -trackOrigin.y)
    layerCtx.lineWidth = 4 * u
    layerCtx.lineJoin = 'round'
    layerCtx.strokeStyle = 'rgba(255,255,255,0.35)'
    layerCtx.beginPath()
    for (let i = 0; i < rows.length; i += step) {
      const [x, y] = toMap(rows[i].lat, rows[i].lon)
      if (i === 0) layerCtx.moveTo(x, y)
      else layerCtx.lineTo(x, y)
    }
    layerCtx.stroke()
  }

  // Speed gauge geometry.
  const gauge = { cx: 220 * u, cy: height - 220 * u, r: 170 * u, min: 0, max: 120 }
  const startAngle = (150 * Math.PI) / 180
  const sweep = (240 * Math.PI) / 180
  const ticks = new Path2D()
  for (let v = gauge.min; v <= gauge.max; v += 10) {
    const a = startAngle + ((v - gauge.min) / (gauge.max - gauge.min)) * sweep
    const inner = v % 20 === 0 ? gauge.r - 26 * u : gauge.r - 16 * u
    ticks.moveTo(gauge.cx + Math.cos(a) * inner, gauge.cy + Math.sin(a) * inner)
    ticks.lineTo(gauge.cx + Math.cos(a) * gauge.r, gauge.cy + Math.sin(a) * gauge.r)
  }

  const gMeter = { cx: width - 210 * u, cy: height - 220 * u, r: 150 * u, maxG: 1.5 }

  function panel(ctx, x, y, w, h) {
    ctx.fillStyle = 'rgba(8, 12, 20, 0.62)'
    ctx.beginPath()
    ctx.roundRect(x, y, w, h, 18 * u)
    ctx.fill()
  }

  function drawGauge(ctx, value) {
    const { cx, cy, r } = gauge
    ctx.fillStyle = 'rgba(8, 12, 20, 0.62)'
    ctx.beginPath()
    ctx.arc(cx, cy, r + 24 * u, 0, Math.PI * 2)
    ctx.fill()
    ctx.lineCap = 'round'
    ctx.lineWidth = 14 * u
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'
    ctx.beginPath()
    ctx.arc(cx, cy, r - 40 * u, startAngle, startAngle + sweep)
    ctx.stroke()
    const frac = Math.min(Math.max((value - gauge.min) / (gauge.max - gauge.min), 0), 1)
    ctx.strokeStyle = '#2dd4bf'
    ctx.beginPath()
    ctx.arc(cx, cy, r - 40 * u, startAngle, startAngle + sweep * frac)
    ctx.stroke()
    ctx.lineWidth = 3 * u
    ctx.strokeStyle = 'rgba(255,255,255,0.7)'
    ctx.stroke(ticks)
    const a = startAngle + sweep * frac
    ctx.lineWidth = 5 * u
    ctx.strokeStyle = '#f8fafc'
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(cx + Math.cos(a) * (r - 30 * u), cy + Math.sin(a) * (r - 30 * u))
    ctx.stroke()
    ctx.fillStyle = '#f8fafc'
    ctx.textAlign = 'center'
    ctx.font = font(64, 700)
    ctx.fillText(Math.round(value).toString(), cx, cy + 80 * u)
    ctx.font = font(20)
    ctx.fillStyle = '#94a3b8'
    ctx.fillText('MPH', cx, cy + 110 * u)
  }

  function drawBar(ctx, value) {
    const x = 440 * u
    const y = height - 380 * u
    const w = 60 * u
    const h = 300 * u
    panel(ctx, x - 16 * u, y - 16 * u, w + 32 * u, h + 70 * u)
    ctx.fillStyle = 'rgba(255,255,255,0.12)'
    ctx.fillRect(x, y, w, h)
    const frac = Math.min(Math.max(value / 100, 0), 1)
    ctx.fillStyle = '#22c55e'
    ctx.fillRect(x, y + h * (1 - frac), w, h * frac)
    ctx.fillStyle = '#f8fafc'
    ctx.font = font(22)
    ctx.textAlign = 'center'
    ctx.fillText(`TPS ${Math.round(value)}%`, x + w / 2, y + h + 38 * u)
  }

  function drawReadouts(ctx, time) {
    const x = 560 * u
    const y = height - 330 * u
    panel(ctx, x, y, 260 * u, 260 * u)
    const items = [
      ['OIL T', sample(time, 'oilT').toFixed(0), '°F', '#fbbf24'],
      ['OIL P', sample(time, 'oilP').toFixed(2), 'bar', '#38bdf8'],
      ['ECT', sample(time, 'ect').toFixed(0), '°F', '#fb7185'],
    ]
    ctx.textAlign = 'left'
    items.forEach(([label, value, unit, color], i) => {
      const rowY = y + 70 * u + i * 76 * u
      ctx.fillStyle = color
      ctx.font = font(18)
      ctx.fillText(label, x + 22 * u, rowY - 26 * u)
      ctx.fillStyle = '#f8fafc'
      ctx.font = font(40, 700)
      ctx.fillText(`${value} ${unit}`, x + 22 * u, rowY + 14 * u)
    })
  }

  function drawTrackMap(ctx, time) {
    panel(ctx, mapBox.x - 20 * u, mapBox.y - 20 * u, mapBox.size + 40 * u, mapBox.size + 40 * u)
    ctx.drawImage(trackLayer, trackOrigin.x, trackOrigin.y)
    const [x, y] = toMap(sample(time, 'lat'), sample(time, 'lon'))
    ctx.fillStyle = '#38bdf8'
    ctx.beginPath()
    ctx.arc(x, y, 9 * u, 0, Math.PI * 2)
    ctx.fill()
  }

  function drawGMeter(ctx, time) {
    const { cx, cy, r, maxG } = gMeter
    ctx.fillStyle = 'rgba(8, 12, 20, 0.62)'
    ctx.beginPath()
    ctx.arc(cx, cy, r + 20 * u, 0, Math.PI * 2)
    ctx.fill()
    ctx.lineWidth = 2 * u
    ctx.strokeStyle = 'rgba(255,255,255,0.2)'
    for (let g = 0.5; g <= maxG; g += 0.5) {
      ctx.beginPath()
      ctx.arc(cx, cy, (g / maxG) * r, 0, Math.PI * 2)
      ctx.stroke()
    }
    // Trail: last 1s at 20 Hz.
    ctx.fillStyle = 'rgba(167,139,250,0.35)'
    for (let k = 20; k >= 1; k -= 1) {
      const t = time - k * 0.05
      const gx = cx + (sample(t, 'latAcc') / maxG) * r
      const gy = cy - (sample(t, 'lonAcc') / maxG) * r
      ctx.beginPath()
      ctx.arc(gx, gy, 5 * u, 0, Math.PI * 2)
      ctx.fill()
    }
    const lat = sample(time, 'latAcc')
    const lon = sample(time, 'lonAcc')
    ctx.fillStyle = '#a78bfa'
    ctx.beginPath()
    ctx.arc(cx + (lat / maxG) * r, cy - (lon / maxG) * r, 11 * u, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#f8fafc'
    ctx.font = font(26, 700)
    ctx.textAlign = 'center'
    ctx.fillText(`${Math.hypot(lat, lon).toFixed(2)} g`, cx, cy + r + 55 * u)
  }

  // Frame-space bounding boxes (with a little padding) for atlas rendering.
  const box = (x, y, w, h) => {
    const pad = 4 * u
    const x0 = Math.max(0, Math.floor(x - pad))
    const y0 = Math.max(0, Math.floor(y - pad))
    return {
      x: x0,
      y: y0,
      w: Math.min(width, Math.ceil(x + w + pad)) - x0,
      h: Math.min(height, Math.ceil(y + h + pad)) - y0,
    }
  }
  const widgets = [
    { rect: box(26 * u, height - 414 * u, 388 * u, 388 * u), draw: (ctx, time) => drawGauge(ctx, sample(time, 'speed')) },
    { rect: box(424 * u, height - 396 * u, 92 * u, 370 * u), draw: (ctx, time) => drawBar(ctx, sample(time, 'tps')) },
    { rect: box(560 * u, height - 330 * u, 260 * u, 260 * u), draw: drawReadouts },
    { rect: box(mapBox.x - 20 * u, mapBox.y - 20 * u, mapBox.size + 40 * u, mapBox.size + 40 * u), draw: drawTrackMap },
    { rect: box(width - 380 * u, height - 390 * u, 340 * u, 385 * u), draw: drawGMeter },
  ]

  return {
    sampleCount: rows.length,
    widgets,
    draw(ctx, time) {
      drawGauge(ctx, sample(time, 'speed'))
      drawBar(ctx, sample(time, 'tps'))
      drawReadouts(ctx, time)
      drawTrackMap(ctx, time)
      drawGMeter(ctx, time)
    },
  }
}

module.exports = { createOverlay }
