// Renders the app icon (build/icon.png, 512×512) from the header's gauge
// glyph: an amber arc and needle on a graphite rounded square. electron-builder
// turns it into the Windows .ico. Run: node scripts/make-icon.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const SIZE = 512
const SAMPLES = 4 // supersampling per axis

// Glyph geometry in the header SVG's 24-unit viewBox.
const ARC = { cx: 12, cy: 16.5 - Math.sqrt(64 - 7.5 * 7.5), r: 8 }
const ARC_ENDS = [
  [4.5, 16.5],
  [19.5, 16.5],
]
const NEEDLE = [
  [12, 13.5],
  [15.6, 9.9],
]
const STROKE = 2.2
// Glyph centre and scale inside the square.
const CENTER = [12, 11.6]
const SCALE = (SIZE * 0.62) / 17

const BACKGROUND = [0x1c, 0x1c, 0x1f]
const ACCENT = [0xf5, 0x9e, 0x42]
const RADIUS = SIZE * 0.22

function segmentDistance(px, py, [ax, ay], [bx, by]) {
  const t = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)))
  return Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay)))
}

function arcDistance(px, py) {
  // The arc runs over the top; the gap is below the centre, between the ends.
  const dx = px - ARC.cx
  const dy = py - ARC.cy
  const inGap = dy > 0 && Math.abs(dx) / Math.hypot(dx, dy) < 7.5 / ARC.r
  if (!inGap) return Math.abs(Math.hypot(dx, dy) - ARC.r)
  return Math.min(...ARC_ENDS.map(([x, y]) => Math.hypot(px - x, py - y)))
}

function insideRoundedSquare(x, y) {
  const qx = Math.max(Math.abs(x - SIZE / 2) - (SIZE / 2 - RADIUS), 0)
  const qy = Math.max(Math.abs(y - SIZE / 2) - (SIZE / 2 - RADIUS), 0)
  return Math.hypot(qx, qy) <= RADIUS
}

const pixels = Buffer.alloc(SIZE * SIZE * 4)
for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    let cover = 0
    let glyph = 0
    for (let sy = 0; sy < SAMPLES; sy += 1) {
      for (let sx = 0; sx < SAMPLES; sx += 1) {
        const px = x + (sx + 0.5) / SAMPLES
        const py = y + (sy + 0.5) / SAMPLES
        if (!insideRoundedSquare(px, py)) continue
        cover += 1
        const gx = CENTER[0] + (px - SIZE / 2) / SCALE
        const gy = CENTER[1] + (py - SIZE / 2) / SCALE
        if (Math.min(arcDistance(gx, gy), segmentDistance(gx, gy, ...NEEDLE)) <= STROKE / 2) glyph += 1
      }
    }
    const total = SAMPLES * SAMPLES
    const g = cover ? glyph / cover : 0
    const i = (y * SIZE + x) * 4
    for (let c = 0; c < 3; c += 1) pixels[i + c] = Math.round(BACKGROUND[c] * (1 - g) + ACCENT[c] * g)
    pixels[i + 3] = Math.round((cover / total) * 255)
  }
}

// Minimal PNG encoder: RGBA, no filtering.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(bytes) {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}
const header = Buffer.alloc(13)
header.writeUInt32BE(SIZE, 0)
header.writeUInt32BE(SIZE, 4)
header.set([8, 6, 0, 0, 0], 8) // 8-bit RGBA
const rows = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let y = 0; y < SIZE; y += 1) pixels.copy(rows, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(rows, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])
mkdirSync('build', { recursive: true })
writeFileSync('build/icon.png', png)
console.log(`build/icon.png ${png.length} bytes`)
