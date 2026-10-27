/**
 * Reader for AiM `.xrk` logger files (and `.xrz`, the same data zlib
 * compressed). Framework-free; works on the whole file in memory.
 *
 * The format is undocumented. This follows the reverse-engineered parser in
 * libxrk (MIT, https://github.com/m3rlin45/libxrk, itself derived from
 * Scott Smith's TrackDataAnalysis): a stream of `<h…>` header messages
 * (channel and group definitions, GPS fixes, lap markers, session strings)
 * interleaved with `(G…)`, `(S…)` and `(M…)` data messages. Expansion-device
 * `(c…)` messages aren't decoded yet; their bytes are counted in
 * `skippedBytes`.
 */

export interface XrkChannel {
  name: string
  shortName: string
  /** Unit text as AiM labels it (`km/h`, `g`, `C`, `bar`…), or '' when unknown. */
  unit: string
  /** Milliseconds from the session's first timecode. */
  times: Float64Array
  values: Float64Array
}

export interface XrkLap {
  /** The logger's lap number. */
  number: number
  /** Milliseconds from the session's first timecode. */
  start: number
  end: number
}

export interface XrkFile {
  channels: XrkChannel[]
  laps: XrkLap[]
  /** Session strings (driver, vehicle, venue, date…), keyed like an AiM CSV preamble. */
  metadata: Record<string, string>
  /** Milliseconds from the first to the last timecode. */
  duration: number
  /** Bytes that didn't parse as any known message. */
  skippedBytes: number
}

const tok = (s: string) => {
  let value = 0
  for (let i = 0; i < s.length; i += 1) value |= s.charCodeAt(i) << (i * 8)
  return value >>> 0
}

const T = {
  CHS: tok('CHS'),
  GRP: tok('GRP'),
  GPS: tok('GPS'),
  GPS1: tok('GPS1'),
  LAP: tok('LAP'),
  CNF: tok('CNF'),
  TRK: tok('TRK'),
}

/** Session strings worth keeping, with the names an AiM CSV export uses. */
const STRING_TOKENS: Record<number, string> = {
  [tok('RCR')]: 'Racer',
  [tok('VEH')]: 'Vehicle',
  [tok('CMP')]: 'Championship',
  [tok('VTY')]: 'Session',
  [tok('TMD')]: 'Date',
  [tok('TMT')]: 'Time',
  [tok('NTE')]: 'Comment',
}

/** AiM unit codes (CHS byte 12, low 7 bits). */
const UNITS: Record<number, string> = {
  1: '%', 3: 'g', 4: 'deg', 5: 'deg/s', 9: 'Hz', 12: 'mm', 14: 'bar', 15: 'rpm',
  16: 'km/h', 17: 'C', 18: 'ms', 19: 'Nm', 20: 'km/h', 21: 'mV', 22: 'l', 24: 'l/s',
  27: 'A', 30: 'lambda', 31: 'gear', 33: '%', 43: 'kg',
}

type Decoder = 'i32' | 'u16' | 'i16' | 'f32' | 'u8' | 'gear' | 'f16'

/** Sample decoders by CHS byte 20. */
const DECODERS: Record<number, Decoder> = {
  0: 'i32', 1: 'u16', 3: 'i32', 4: 'i16', 6: 'f32', 8: 'i32', 11: 'i16', 12: 'i32', 13: 'u8',
  15: 'gear', 20: 'f16', 22: 'i32', 24: 'i32', 26: 'i32', 27: 'i32', 31: 'i32', 32: 'i32',
  33: 'i32', 37: 'i32', 38: 'i32', 39: 'i32',
}

const DECODER_SIZE: Record<Decoder, number> = { i32: 4, u16: 2, i16: 2, f32: 4, u8: 1, gear: 2, f16: 2 }

/** Internal channels that aren't telemetry. */
const SKIPPED_CHANNELS = new Set(['StrtRec', 'Master Clk'])

interface ChannelDef {
  index: number
  name: string
  shortName: string
  unit: string
  decoder: Decoder | null
  /** Bytes per sample in data messages. */
  size: number
  /** Sample period for M messages, ms. */
  periodMs: number
  group: number | null
  /** Byte offset of this channel inside its group's row. */
  groupOffset: number
}

interface Accumulator {
  lastTime: number
  times: number[]
  /** Offsets into the file of each accepted sample. */
  offsets: number[]
}

const newAccumulator = (): Accumulator => ({ lastTime: -1, times: [], offsets: [] })

function cString(bytes: Uint8Array, start: number, length: number): string {
  let end = start
  while (end < start + length && bytes[end] !== 0) end += 1
  let text = ''
  for (let i = start; i < end; i += 1) text += String.fromCharCode(bytes[i]!)
  return text
}

function halfToFloat(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1
  const exponent = (bits >> 10) & 0x1f
  const mantissa = bits & 0x3ff
  if (exponent === 0) return sign * mantissa * 2 ** -24
  if (exponent === 31) return mantissa ? NaN : sign * Infinity
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15)
}

const GEAR_CODES: Record<number, number> = { 0x4e: 0, 0x31: 1, 0x32: 2, 0x33: 3, 0x34: 4, 0x35: 5, 0x36: 6 }

function decodeSample(view: DataView, offset: number, decoder: Decoder): number {
  switch (decoder) {
    case 'i32':
      return view.getInt32(offset, true)
    case 'u16':
      return view.getUint16(offset, true)
    case 'i16':
      return view.getInt16(offset, true)
    case 'f32':
      return view.getFloat32(offset, true)
    case 'u8':
      return view.getUint8(offset)
    case 'gear': {
      const code = view.getUint16(offset, true)
      return GEAR_CODES[code] ?? code
    }
    case 'f16':
      return halfToFloat(view.getUint16(offset, true))
  }
}

/** Whether the bytes look like zlib (an `.xrz` file) rather than raw XRK. */
export function isZlib(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 0x78 && ((bytes[0]! << 8) | bytes[1]!) % 31 === 0
}

/** Whether the bytes start like an XRK file. */
export function isXrk(bytes: Uint8Array): boolean {
  return bytes.length > 12 && bytes[0] === 0x3c && bytes[1] === 0x68 && cString(bytes, 2, 3) === 'CNF'
}

/** A stream of one chunk. */
export function singleChunk(bytes: Uint8Array): ReadableStream<BufferSource> {
  return new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(bytes as Uint8Array<ArrayBuffer>)
      controller.close()
    },
  })
}

/** Inflate `.xrz` data; XRK data passes through unchanged. */
export async function inflateXrz(bytes: Uint8Array): Promise<Uint8Array> {
  if (!isZlib(bytes)) return bytes
  const stream = singleChunk(bytes).pipeThrough(new DecompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

class Parser {
  readonly channels = new Map<number, ChannelDef>()
  /** Member channel indices per group index. */
  readonly groups = new Map<number, number[]>()
  readonly groupData = new Map<number, Accumulator>()
  readonly sampleData = new Map<number, Accumulator>()
  readonly burstData = new Map<number, Accumulator>()
  /** File offsets of 56-byte GPS records. */
  readonly gps: number[] = []
  readonly laps: Array<{ segment: number; number: number; duration: number; end: number }> = []
  readonly strings: Record<string, string> = {}
  skipped = 0
  readonly bytes: Uint8Array
  readonly view: DataView

  constructor(bytes: Uint8Array, view: DataView) {
    this.bytes = bytes
    this.view = view
  }

  /** Scan messages in [start, end). */
  scan(start: number, end: number) {
    const { bytes } = this
    let pos = start
    while (pos < end) {
      let used = 0
      if (pos + 2 < end) {
        const a = bytes[pos]
        const b = bytes[pos + 1]
        if (a === 0x3c && b === 0x68) used = this.header(pos, end)
        else if (a === 0x28 && b === 0x47) used = this.row(pos, end, this.groupData, this.groupRowSize)
        else if (a === 0x28 && b === 0x53) used = this.row(pos, end, this.sampleData, this.sampleRowSize)
        else if (a === 0x28 && b === 0x4d) used = this.burst(pos, end)
      }
      if (used > 0) {
        pos += used
      } else {
        this.skipped += 1
        pos += 1
      }
    }
  }

  private readonly groupRowSize = (index: number) => {
    const members = this.groups.get(index)
    if (!members) return 0
    let size = 0
    for (const member of members) size += this.channels.get(member)?.size ?? 0
    return size
  }

  private readonly sampleRowSize = (index: number) => this.channels.get(index)?.size ?? 0

  /** `<h` token len version `>` payload `<` token checksum `>`. Returns bytes used, 0 if invalid. */
  private header(pos: number, end: number): number {
    const { bytes, view } = this
    if (pos + 20 > end) return 0
    const token = view.getUint32(pos + 2, true)
    const length = view.getInt32(pos + 6, true)
    if (bytes[pos + 11] !== 0x3e || length < 0) return 0
    const payload = pos + 12
    const footer = payload + length
    if (footer + 8 > end) return 0
    if (bytes[footer] !== 0x3c || bytes[footer + 7] !== 0x3e) return 0
    if (view.getUint32(footer + 1, true) !== token) return 0
    let sum = 0
    for (let i = payload; i < footer; i += 1) sum += bytes[i]!
    if ((sum & 0xffff) !== view.getUint16(footer + 5, true)) return 0

    // Three-letter tokens are space padded on the wire.
    const id = token >>> 24 === 0x20 ? (token & 0xffffff) >>> 0 : token
    this.message(id, payload, length)
    return footer + 8 - pos
  }

  private message(id: number, at: number, length: number) {
    const { bytes, view } = this
    if (id === T.CNF) {
      // Configuration block: nested channel and group definitions.
      this.scan(at, at + length)
      for (const acc of [this.groupData, this.sampleData, this.burstData]) for (const a of acc.values()) a.lastTime = -1
    } else if (id === T.CHS && length >= 112) {
      const index = view.getUint16(at, true)
      if (this.channels.has(index)) return
      const decoderType = bytes[at + 20]!
      const name = cString(bytes, at + 32, 24)
      const decoder = name === 'Calculated_Gear' || name === 'PreCalcGear' ? null : (DECODERS[decoderType] ?? null)
      const unitCode = bytes[at + 12]!
      let unit = UNITS[unitCode & 0x7f] ?? ''
      if (unit === 'mV' && unitCode & 0x80) unit = 'V'
      this.channels.set(index, {
        index,
        name,
        shortName: cString(bytes, at + 24, 8),
        unit,
        decoder,
        size: bytes[at + 72]!,
        periodMs: Math.floor(view.getUint32(at + 64, true) / 1000),
        group: null,
        groupOffset: 0,
      })
    } else if (id === T.GRP && length >= 4) {
      const index = view.getUint16(at, true)
      const count = view.getUint16(at + 2, true)
      if (length < 4 + count * 2) return
      const members: number[] = []
      let offset = 0
      for (let i = 0; i < count; i += 1) {
        const member = view.getUint16(at + 4 + i * 2, true)
        members.push(member)
        const channel = this.channels.get(member)
        if (channel) {
          channel.group = index
          channel.groupOffset = offset
          offset += channel.size
        }
      }
      this.groups.set(index, members)
    } else if ((id === T.GPS || id === T.GPS1) && length % 56 === 0) {
      for (let i = 0; i < length; i += 56) this.gps.push(at + i)
    } else if (id === T.LAP && length >= 20) {
      this.laps.push({
        segment: bytes[at + 1]!,
        number: view.getUint16(at + 2, true),
        duration: view.getUint32(at + 4, true),
        end: view.getUint32(at + 16, true),
      })
    } else if (id === T.TRK && length >= 44) {
      const name = cString(bytes, at, 32).trim()
      if (name) this.strings.Venue = name
    } else if (STRING_TOKENS[id]) {
      const text = cString(bytes, at, length).trim()
      if (text) this.strings[STRING_TOKENS[id]] = text
    }
  }

  /** `(G` / `(S`: time(4) index(2) data `)`. Keeps strictly increasing times. */
  private row(pos: number, end: number, store: Map<number, Accumulator>, rowSize: (index: number) => number): number {
    if (pos + 9 > end) return 0
    const index = this.view.getUint16(pos + 6, true)
    const size = rowSize(index)
    if (size === 0) return 0
    const total = 9 + size
    if (pos + total > end || this.bytes[pos + total - 1] !== 0x29) return 0
    const time = this.view.getInt32(pos + 2, true)
    let acc = store.get(index)
    if (!acc) store.set(index, (acc = newAccumulator()))
    if (time > acc.lastTime) {
      acc.lastTime = time
      acc.times.push(time)
      acc.offsets.push(pos + 8)
    }
    return total
  }

  /** `(M`: time(4) index(2) count(2) samples `)`, samples `periodMs` apart. */
  private burst(pos: number, end: number): number {
    if (pos + 11 > end) return 0
    const index = this.view.getUint16(pos + 6, true)
    const channel = this.channels.get(index)
    if (!channel || channel.periodMs === 0 || channel.size === 0) return 0
    const count = this.view.getUint16(pos + 8, true)
    const total = 11 + channel.size * count
    if (pos + total > end || this.bytes[pos + total - 1] !== 0x29) return 0
    const time = this.view.getInt32(pos + 2, true)
    let acc = this.burstData.get(index)
    if (!acc) this.burstData.set(index, (acc = newAccumulator()))
    // Bursts can overlap the previous one; skip samples already covered.
    const skip = time <= acc.lastTime ? Math.floor((acc.lastTime - time) / channel.periodMs) + 1 : 0
    if (skip < count) {
      acc.lastTime = time + (count - 1) * channel.periodMs
      for (let i = skip; i < count; i += 1) {
        acc.times.push(time + i * channel.periodMs)
        acc.offsets.push(pos + 10 + i * channel.size)
      }
    }
    return total
  }
}

const WGS84_A = 6378137
const WGS84_E2 = 8.181919084261345e-2 ** 2

/** ECEF (m) to latitude/longitude (deg) and altitude (m), Vermeille (2003). */
export function ecefToLla(x: number, y: number, z: number): [number, number, number] {
  const a2 = WGS84_A * WGS84_A
  const e4 = WGS84_E2 * WGS84_E2
  const p = (x * x + y * y) / a2
  const q = ((1 - WGS84_E2) / a2) * z * z
  const r = (p + q - e4) / 6
  const s = (e4 / 4) * p * q / (r * r * r)
  const t = Math.cbrt(1 + s + Math.sqrt(s * (2 + s)))
  const u0 = r * (1 + t + 1 / t)
  const v = Math.sqrt(u0 * u0 + e4 * q)
  const u = u0 + v
  const w = (WGS84_E2 / 2) * (u - q) / v
  const k = Math.sqrt(u + w * w) - w
  const d = (k * Math.hypot(x, y)) / (k + WGS84_E2)
  const rootDz = Math.hypot(d, z)
  const lat = (180 / Math.PI) * 2 * Math.atan2(z, d + rootDz)
  const lon = (180 / Math.PI) * Math.atan2(y, x)
  const alt = ((k + WGS84_E2 - 1) / k) * rootDz
  return [lat, lon, alt]
}

/**
 * GPS timecodes from old MXP firmware can have their upper 16 bits
 * corrupted. When times run backwards, rebuild them from the low 16 bits,
 * placing each at the 65536 ms multiple closest to its predecessor.
 */
function fixGpsTimes(times: number[]) {
  if (!times.some((t, i) => i > 0 && t < times[i - 1]!)) return
  for (let i = 1; i < times.length; i += 1) {
    let delta = ((times[i]! - times[i - 1]!) & 0xffff) >>> 0
    if (delta >= 0x8000) delta -= 0x10000
    times[i] = times[i - 1]! + delta
  }
}

/** GPS channels from u-blox NAV-SOL records (ECEF position and velocity). */
function gpsChannels(parser: Parser, zero: number): XrkChannel[] {
  const { view } = parser
  const n = parser.gps.length
  if (n === 0) return []
  const rawTimes = parser.gps.map((at) => view.getInt32(at, true))
  fixGpsTimes(rawTimes)

  const times: number[] = []
  const lat: number[] = []
  const lon: number[] = []
  const alt: number[] = []
  const speed: number[] = []
  const heading: number[] = []
  for (let i = 0; i < n; i += 1) {
    const at = parser.gps[i]!
    // Records without a fix (byte 14 < 2) have no usable position.
    if (view.getUint8(at + 14) < 2) continue
    if (times.length > 0 && rawTimes[i]! <= times[times.length - 1]! + zero) continue
    const [la, lo, al] = ecefToLla(
      view.getInt32(at + 16, true) / 100,
      view.getInt32(at + 20, true) / 100,
      view.getInt32(at + 24, true) / 100,
    )
    const vx = view.getInt32(at + 32, true) / 100
    const vy = view.getInt32(at + 36, true) / 100
    const vz = view.getInt32(at + 40, true) / 100
    const phi = (la * Math.PI) / 180
    const lambda = (lo * Math.PI) / 180
    const east = -Math.sin(lambda) * vx + Math.cos(lambda) * vy
    const north = -Math.sin(phi) * Math.cos(lambda) * vx - Math.sin(phi) * Math.sin(lambda) * vy + Math.cos(phi) * vz
    times.push(rawTimes[i]! - zero)
    lat.push(la)
    lon.push(lo)
    alt.push(al)
    speed.push(Math.sqrt(vx * vx + vy * vy + vz * vz))
    // ±180°, as Race Studio exports it.
    heading.push((Math.atan2(east, north) * 180) / Math.PI)
  }
  const t = Float64Array.from(times)
  const channel = (name: string, unit: string, values: number[]): XrkChannel => ({
    name,
    shortName: name,
    unit,
    times: t,
    values: Float64Array.from(values),
  })
  return [
    channel('GPS Speed', 'm/s', speed),
    channel('GPS Latitude', 'deg', lat),
    channel('GPS Longitude', 'deg', lon),
    channel('GPS Altitude', 'm', alt),
    channel('GPS Heading', 'deg', heading),
  ]
}

/** Lap markers: segment 0 only, one per lap number, with a single missed lap filled in. */
function lapList(parser: Parser, zero: number): XrkLap[] {
  const laps: XrkLap[] = []
  for (const marker of parser.laps) {
    if (marker.segment !== 0) continue
    const end = marker.end - zero
    const start = end - marker.duration
    const last = laps[laps.length - 1]
    if (last) {
      if (marker.number === last.number) continue
      if (marker.number === last.number + 2) {
        laps.push({ number: last.number + 1, start: last.end, end: start })
      } else if (marker.number !== last.number + 1) {
        return []
      }
    }
    laps.push({ number: marker.number, start, end })
  }
  return laps.some((lap) => lap.start < -1 || lap.end <= lap.start) ? [] : laps
}

/** Parse an XRK file (inflate `.xrz` data first with `inflateXrz`). */
export function parseXrk(bytes: Uint8Array): XrkFile {
  if (!isXrk(bytes)) throw new Error('This is not an AiM XRK file.')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const parser = new Parser(bytes, view)
  parser.scan(0, bytes.length)

  interface Source {
    channel: ChannelDef
    acc: Accumulator
    /** Byte offset of the sample from each recorded offset. */
    shift: number
  }
  const sources: Source[] = []
  for (const channel of parser.channels.values()) {
    if (!channel.decoder || SKIPPED_CHANNELS.has(channel.name)) continue
    if (DECODER_SIZE[channel.decoder] > channel.size) continue
    if (channel.group !== null) {
      const acc = parser.groupData.get(channel.group)
      if (acc) sources.push({ channel, acc, shift: channel.groupOffset })
      continue
    }
    const sample = parser.sampleData.get(channel.index)
    const burst = parser.burstData.get(channel.index)
    if (sample) sources.push({ channel, acc: sample, shift: 0 })
    else if (burst) sources.push({ channel, acc: burst, shift: 0 })
  }

  // Time zero is the earliest timecode of any data, GPS fix or lap start.
  let zero = Infinity
  let last = -Infinity
  for (const { acc } of sources) {
    if (acc.times.length === 0) continue
    zero = Math.min(zero, acc.times[0]!)
    last = Math.max(last, acc.times[acc.times.length - 1]!)
  }
  for (const at of parser.gps) {
    const time = view.getInt32(at, true)
    if (view.getUint8(at + 14) >= 2) {
      zero = Math.min(zero, time)
      last = Math.max(last, time)
    }
  }
  for (const lap of parser.laps) {
    if (lap.segment !== 0) continue
    zero = Math.min(zero, lap.end - lap.duration)
    last = Math.max(last, lap.end)
  }
  if (!Number.isFinite(zero)) throw new Error('The XRK file has no recorded data.')

  const channels: XrkChannel[] = []
  for (const { channel, acc, shift } of sources) {
    const n = acc.times.length
    const times = new Float64Array(n)
    const values = new Float64Array(n)
    const scale = channel.unit === 'V' ? 1e-3 : 1
    for (let i = 0; i < n; i += 1) {
      times[i] = acc.times[i]! - zero
      values[i] = decodeSample(view, acc.offsets[i]! + shift, channel.decoder!) * scale
    }
    channels.push({ name: channel.name, shortName: channel.shortName, unit: channel.unit, times, values })
  }
  channels.sort((a, b) => a.name.localeCompare(b.name))
  const gps = gpsChannels(parser, zero)
  const taken = new Set(channels.map((c) => c.name))
  channels.push(...gps.filter((c) => !taken.has(c.name)))

  return {
    channels,
    laps: lapList(parser, zero),
    metadata: { ...parser.strings },
    duration: last - zero,
    skippedBytes: parser.skipped,
  }
}
