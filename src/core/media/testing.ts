// Test helpers: decode base64 fixtures and assemble minimal MP4 files.

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text.replace(/\s+/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

function u32(...values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4)
  const view = new DataView(out.buffer)
  values.forEach((value, i) => view.setUint32(i * 4, value >>> 0))
  return out
}

const ascii = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0))

function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(payload)
  return concat([u32(body.byteLength + 8), ascii(type), body])
}

const zeros = (n: number) => new Uint8Array(n)

/**
 * A minimal MP4 with one metadata track whose samples are `samples`
 * (one sample per chunk, fixed `delta` ticks apart).
 */
export function buildMetadataMp4(options: {
  format: string
  samples: Uint8Array[]
  timescale: number
  delta: number
  creationTime?: Date
}): Uint8Array {
  const { format, samples, timescale, delta } = options
  const n = samples.length
  const durationTicks = n * delta
  const created = options.creationTime ? Math.round(options.creationTime.getTime() / 1000) + 2_082_844_800 : 0

  const ftyp = box('ftyp', ascii('isom'), u32(512), ascii('isomiso2mp41'))
  const mdat = box('mdat', ...samples)
  const firstOffset = ftyp.byteLength + 8
  const offsets: number[] = []
  let offset = firstOffset
  for (const sample of samples) {
    offsets.push(offset)
    offset += sample.byteLength
  }

  const identity = u32(0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000)
  const mvhd = box('mvhd', u32(0, created, created, timescale, durationTicks), zeros(80))
  const tkhd = box('tkhd', u32(3, created, created, 1, 0, durationTicks), zeros(16), identity, u32(0, 0))
  const mdhd = box('mdhd', u32(0, created, created, timescale, durationTicks), zeros(4))
  const hdlr = box('hdlr', u32(0, 0), ascii('meta'), zeros(13))
  const stsd = box('stsd', u32(0, 1), box(format, zeros(6), new Uint8Array([0, 1])))
  const stts = box('stts', u32(0, 1, n, delta))
  const stsc = box('stsc', u32(0, 1, 1, 1, 1))
  const stsz = box('stsz', u32(0, 0, n, ...samples.map((s) => s.byteLength)))
  const stco = box('stco', u32(0, n, ...offsets))
  const stbl = box('stbl', stsd, stts, stsc, stsz, stco)
  const trak = box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', stbl)))
  const moov = box('moov', mvhd, trak)
  return concat([ftyp, mdat, moov])
}
