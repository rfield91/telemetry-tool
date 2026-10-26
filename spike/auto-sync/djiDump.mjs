// Schema-less protobuf dump of DJI per-frame metadata packets.
// Usage: node djiDump.mjs <stream.bin> <sizes.csv> <packetIndex> [maxDepth]
import fs from 'node:fs'

export function splitPackets(binPath, sizesPath) {
  const data = fs.readFileSync(binPath)
  const sizes = fs.readFileSync(sizesPath, 'utf8').trim().split(/\r?\n/).map((line) => {
    const [time, size] = line.split(',')
    return { time: Number(time), size: Number(size) }
  })
  let offset = 0
  return sizes.map(({ time, size }) => {
    const packet = data.subarray(offset, offset + size)
    offset += size
    return { time, packet }
  })
}

function readVarint(buf, pos) {
  let result = 0n
  let shift = 0n
  for (;;) {
    if (pos >= buf.length) throw new Error('varint overflow')
    const byte = buf[pos++]
    result |= BigInt(byte & 0x7f) << shift
    if (!(byte & 0x80)) return [result, pos]
    shift += 7n
    if (shift > 70n) throw new Error('varint too long')
  }
}

/** Parse a protobuf message; throws if bytes aren't a clean message. */
export function parseMessage(buf) {
  const fields = []
  let pos = 0
  while (pos < buf.length) {
    const [key, next] = readVarint(buf, pos)
    pos = next
    const field = Number(key >> 3n)
    const wire = Number(key & 7n)
    if (field === 0) throw new Error('field 0')
    if (wire === 0) {
      const [value, after] = readVarint(buf, pos)
      pos = after
      fields.push({ field, wire, value })
    } else if (wire === 1) {
      if (pos + 8 > buf.length) throw new Error('fixed64 overflow')
      fields.push({ field, wire, raw: buf.subarray(pos, pos + 8) })
      pos += 8
    } else if (wire === 2) {
      const [len, after] = readVarint(buf, pos)
      pos = after
      const n = Number(len)
      if (pos + n > buf.length) throw new Error('len overflow')
      fields.push({ field, wire, raw: buf.subarray(pos, pos + n) })
      pos += n
    } else if (wire === 5) {
      if (pos + 4 > buf.length) throw new Error('fixed32 overflow')
      fields.push({ field, wire, raw: buf.subarray(pos, pos + 4) })
      pos += 4
    } else {
      throw new Error(`wire type ${wire}`)
    }
  }
  return fields
}

function tryMessage(raw) {
  if (raw.length === 0) return null
  try {
    return parseMessage(raw)
  } catch {
    return null
  }
}

function describe(fields, depth, maxDepth, indent = '') {
  const lines = []
  for (const f of fields) {
    const label = `${indent}${f.field}`
    if (f.wire === 0) lines.push(`${label}: varint ${f.value}`)
    else if (f.wire === 5) lines.push(`${label}: f32 ${f.raw.readFloatLE(0).toPrecision(7)} (u32 ${f.raw.readUInt32LE(0)})`)
    else if (f.wire === 1) lines.push(`${label}: f64 ${f.raw.readDoubleLE(0).toPrecision(10)}`)
    else {
      const nested = depth < maxDepth ? tryMessage(f.raw) : null
      const printable = /^[\x20-\x7e]+$/.test(f.raw.toString('latin1'))
      if (printable && f.raw.length < 80) lines.push(`${label}: "${f.raw.toString('latin1')}"`)
      else if (nested && nested.length) {
        lines.push(`${label}: {  // ${f.raw.length} B`)
        lines.push(...describe(nested, depth + 1, maxDepth, indent + '  '))
        lines.push(`${indent}}`)
      } else lines.push(`${label}: bytes[${f.raw.length}] ${f.raw.subarray(0, 24).toString('hex')}${f.raw.length > 24 ? '…' : ''}`)
    }
  }
  return lines
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const [bin, sizes, index, maxDepth] = process.argv.slice(2)
  const packets = splitPackets(bin, sizes)
  const { time, packet } = packets[Number(index)]
  console.log(`packet ${index} @ ${time}s, ${packet.length} B`)
  console.log(describe(parseMessage(packet), 0, Number(maxDepth ?? 6)).join('\n'))
}
