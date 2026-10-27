import { readBytes, type RandomAccessFile } from './file'

/**
 * Minimal ISO-BMFF (MP4/MOV) reader: track list and sample tables, enough
 * to find metadata tracks (DJI djmd, GoPro GPMF) and read their samples by
 * byte range without decoding any video.
 */

export interface SampleTable {
  /** Absolute file offset of each sample. */
  offsets: Float64Array
  sizes: Uint32Array
  /** Decode time of each sample in seconds. */
  times: Float64Array
}

export interface Mp4Track {
  id: number
  /** Handler type, e.g. `vide`, `soun`, `meta`, `tmcd`. */
  handler: string
  /** Sample entry four-cc, e.g. `hvc1`, `avc1`, `mp4a`, `djmd`, `gpmd`. */
  format: string
  timescale: number
  /** Seconds. */
  duration: number
  /** Visual tracks only. */
  width: number | null
  height: number | null
  /** Clockwise display rotation from the track matrix. */
  rotation: 0 | 90 | 180 | 270
  samples: SampleTable
}

export interface Mp4Info {
  majorBrand: string
  /** Seconds. */
  duration: number
  /** From mvhd; camera clocks are often wrong, so treat as a hint. */
  creationTime: Date | null
  tracks: Mp4Track[]
}

const MAC_EPOCH_OFFSET_SECONDS = 2_082_844_800 // 1904-01-01 → 1970-01-01

function fourcc(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  )
}

interface Box {
  type: string
  /** Offset of the box content (after the header) within the view. */
  start: number
  end: number
}

function* children(view: DataView, start: number, end: number): Generator<Box> {
  let pos = start
  while (pos + 8 <= end) {
    let size = view.getUint32(pos)
    const type = fourcc(view, pos + 4)
    let header = 8
    if (size === 1) {
      size = Number(view.getBigUint64(pos + 8))
      header = 16
    } else if (size === 0) {
      size = end - pos
    }
    if (size < header || pos + size > end) return
    yield { type, start: pos + header, end: pos + size }
    pos += size
  }
}

function child(view: DataView, box: Box, type: string): Box | undefined {
  for (const c of children(view, box.start, box.end)) if (c.type === type) return c
  return undefined
}

function childPath(view: DataView, box: Box, path: string[]): Box | undefined {
  let current: Box | undefined = box
  for (const type of path) {
    if (!current) return undefined
    current = child(view, current, type)
  }
  return current
}

/** Locate the top-level `moov` box by walking box headers from the start. */
async function findMoov(file: RandomAccessFile): Promise<{ offset: number; size: number; majorBrand: string }> {
  let offset = 0
  let majorBrand = ''
  while (offset + 8 <= file.size) {
    const header = await readBytes(file, offset, 16)
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
    let size = view.getUint32(0)
    const type = fourcc(view, 4)
    if (size === 1) size = Number(view.getBigUint64(8))
    else if (size === 0) size = file.size - offset
    if (size < 8) break
    if (type === 'ftyp') {
      const ftyp = await readBytes(file, offset + 8, 4)
      majorBrand = fourcc(new DataView(ftyp.buffer, ftyp.byteOffset, 4), 0)
    }
    if (type === 'moov') return { offset, size, majorBrand }
    offset += size
  }
  throw new Error('Not an MP4/MOV file (no moov box found)')
}

function readSampleTable(view: DataView, stbl: Box, timescale: number): SampleTable {
  const stsz = child(view, stbl, 'stsz')
  const stts = child(view, stbl, 'stts')
  const stsc = child(view, stbl, 'stsc')
  const stco = child(view, stbl, 'stco')
  const co64 = child(view, stbl, 'co64')
  if (!stsz || !stts || !stsc || (!stco && !co64)) {
    return { offsets: new Float64Array(), sizes: new Uint32Array(), times: new Float64Array() }
  }

  const fixedSize = view.getUint32(stsz.start + 4)
  const count = view.getUint32(stsz.start + 8)
  const sizes = new Uint32Array(count)
  for (let i = 0; i < count; i += 1) {
    sizes[i] = fixedSize !== 0 ? fixedSize : view.getUint32(stsz.start + 12 + i * 4)
  }

  const times = new Float64Array(count)
  let sample = 0
  let ticks = 0
  const sttsEntries = view.getUint32(stts.start + 4)
  for (let e = 0; e < sttsEntries && sample < count; e += 1) {
    const runCount = view.getUint32(stts.start + 8 + e * 8)
    const delta = view.getUint32(stts.start + 12 + e * 8)
    for (let k = 0; k < runCount && sample < count; k += 1) {
      times[sample++] = ticks / timescale
      ticks += delta
    }
  }

  const chunkBox = (co64 ?? stco)!
  const chunkCount = view.getUint32(chunkBox.start + 4)
  const chunkOffset = (i: number) =>
    co64 ? Number(view.getBigUint64(chunkBox.start + 8 + i * 8)) : view.getUint32(chunkBox.start + 8 + i * 4)

  const stscEntries = view.getUint32(stsc.start + 4)
  const offsets = new Float64Array(count)
  sample = 0
  for (let e = 0; e < stscEntries; e += 1) {
    const firstChunk = view.getUint32(stsc.start + 8 + e * 12) - 1
    const perChunk = view.getUint32(stsc.start + 12 + e * 12)
    const nextFirst = e + 1 < stscEntries ? view.getUint32(stsc.start + 8 + (e + 1) * 12) - 1 : chunkCount
    for (let chunk = firstChunk; chunk < nextFirst && sample < count; chunk += 1) {
      let offset = chunkOffset(chunk)
      for (let k = 0; k < perChunk && sample < count; k += 1) {
        offsets[sample] = offset
        offset += sizes[sample]!
        sample += 1
      }
    }
  }

  return { offsets, sizes, times }
}

function readTrack(view: DataView, trak: Box): Mp4Track | null {
  const tkhd = child(view, trak, 'tkhd')
  const mdhd = childPath(view, trak, ['mdia', 'mdhd'])
  const hdlr = childPath(view, trak, ['mdia', 'hdlr'])
  const stbl = childPath(view, trak, ['mdia', 'minf', 'stbl'])
  if (!tkhd || !mdhd || !hdlr || !stbl) return null

  const tkhdV1 = view.getUint8(tkhd.start) === 1
  const id = view.getUint32(tkhd.start + (tkhdV1 ? 20 : 12))
  const matrix = tkhd.start + (tkhdV1 ? 52 : 40)
  const a = view.getInt32(matrix) / 65536
  const b = view.getInt32(matrix + 4) / 65536
  const degrees = (Math.round((Math.atan2(b, a) * 180) / Math.PI / 90) * 90 + 360) % 360

  const mdhdV1 = view.getUint8(mdhd.start) === 1
  const timescale = view.getUint32(mdhd.start + (mdhdV1 ? 20 : 12))
  const durationTicks = mdhdV1 ? Number(view.getBigUint64(mdhd.start + 24)) : view.getUint32(mdhd.start + 16)
  const handler = fourcc(view, hdlr.start + 8)

  const stsd = child(view, stbl, 'stsd')
  let format = ''
  let width: number | null = null
  let height: number | null = null
  if (stsd && view.getUint32(stsd.start + 4) > 0) {
    const entry = stsd.start + 8
    format = fourcc(view, entry + 4)
    if (handler === 'vide') {
      width = view.getUint16(entry + 32)
      height = view.getUint16(entry + 34)
    }
  }

  return {
    id,
    handler,
    format,
    timescale,
    duration: timescale > 0 ? durationTicks / timescale : 0,
    width,
    height,
    rotation: degrees as Mp4Track['rotation'],
    samples: readSampleTable(view, stbl, timescale),
  }
}

export async function readMp4(file: RandomAccessFile): Promise<Mp4Info> {
  const location = await findMoov(file)
  const bytes = await readBytes(file, location.offset, location.size)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const moov: Box = { type: 'moov', start: 8, end: bytes.byteLength }
  if (view.getUint32(0) === 1) moov.start = 16

  let duration = 0
  let creationTime: Date | null = null
  const mvhd = child(view, moov, 'mvhd')
  if (mvhd) {
    const v1 = view.getUint8(mvhd.start) === 1
    const created = v1 ? Number(view.getBigUint64(mvhd.start + 4)) : view.getUint32(mvhd.start + 4)
    const timescale = view.getUint32(mvhd.start + (v1 ? 20 : 12))
    const ticks = v1 ? Number(view.getBigUint64(mvhd.start + 24)) : view.getUint32(mvhd.start + 16)
    duration = timescale > 0 ? ticks / timescale : 0
    if (created > 0) creationTime = new Date((created - MAC_EPOCH_OFFSET_SECONDS) * 1000)
  }

  const tracks: Mp4Track[] = []
  for (const box of children(view, moov.start, moov.end)) {
    if (box.type !== 'trak') continue
    const track = readTrack(view, box)
    if (track) tracks.push(track)
  }
  return { majorBrand: location.majorBrand, duration, creationTime, tracks }
}

/** Read the given samples (all by default) of a track in one batch. */
export async function readTrackSamples(
  file: RandomAccessFile,
  track: Mp4Track,
  indices?: number[],
): Promise<Uint8Array[]> {
  const which = indices ?? Array.from(track.samples.sizes, (_, i) => i)
  return file.readRanges(which.map((i) => ({ offset: track.samples.offsets[i]!, length: track.samples.sizes[i]! })))
}

/** Frames per second from the most common sample duration. */
export function trackFrameRate(track: Mp4Track): number | null {
  const { times } = track.samples
  if (times.length < 2) return null
  const counts = new Map<number, number>()
  for (let i = 1; i < Math.min(times.length, 600); i += 1) {
    const delta = Math.round((times[i]! - times[i - 1]!) * track.timescale)
    counts.set(delta, (counts.get(delta) ?? 0) + 1)
  }
  let best = 0
  let bestCount = 0
  for (const [delta, count] of counts) {
    if (count > bestCount) {
      best = delta
      bestCount = count
    }
  }
  return best > 0 ? track.timescale / best : null
}
