/** A protobuf field decoded without a schema. */
export interface ProtoField {
  field: number
  wire: 0 | 1 | 2 | 5
  /** Varint value (wire 0). */
  value?: bigint
  /** Raw bytes for fixed32/fixed64/length-delimited fields. */
  bytes?: Uint8Array
}

function readVarint(buf: Uint8Array, start: number): [bigint, number] {
  let result = 0n
  let shift = 0n
  let pos = start
  for (;;) {
    if (pos >= buf.length) throw new Error('Truncated varint')
    const byte = buf[pos++]!
    result |= BigInt(byte & 0x7f) << shift
    if (!(byte & 0x80)) return [result, pos]
    shift += 7n
    if (shift > 63n) throw new Error('Varint too long')
  }
}

/** Decode one message level. Throws if the bytes aren't a clean message. */
export function parseProto(buf: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = []
  let pos = 0
  while (pos < buf.length) {
    const [key, next] = readVarint(buf, pos)
    pos = next
    const field = Number(key >> 3n)
    const wire = Number(key & 7n)
    if (field === 0) throw new Error('Field number 0')
    if (wire === 0) {
      const [value, after] = readVarint(buf, pos)
      pos = after
      fields.push({ field, wire, value })
    } else if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4
      if (pos + size > buf.length) throw new Error('Truncated fixed field')
      fields.push({ field, wire, bytes: buf.subarray(pos, pos + size) })
      pos += size
    } else if (wire === 2) {
      const [length, after] = readVarint(buf, pos)
      pos = after
      const end = pos + Number(length)
      if (end > buf.length) throw new Error('Truncated length-delimited field')
      fields.push({ field, wire, bytes: buf.subarray(pos, end) })
      pos = end
    } else {
      throw new Error(`Unsupported wire type ${wire}`)
    }
  }
  return fields
}

/** Bytes of the first length-delimited field with this number. */
export function protoBytes(fields: ProtoField[], field: number): Uint8Array | undefined {
  return fields.find((f) => f.field === field && f.wire === 2)?.bytes
}

/** Follow a path of nested message fields, e.g. `[3, 2, 9]`. */
export function protoPath(message: Uint8Array, path: number[]): Uint8Array | undefined {
  let current: Uint8Array | undefined = message
  for (const field of path) {
    if (!current) return undefined
    current = protoBytes(parseProto(current), field)
  }
  return current
}

/**
 * Float32 fields 1..count of a message (proto3 omits zero-valued fields, so
 * missing entries are 0).
 */
export function protoFloats(message: Uint8Array, count: number): number[] {
  const values = new Array<number>(count).fill(0)
  for (const f of parseProto(message)) {
    if (f.wire === 5 && f.field <= count) {
      values[f.field - 1] = new DataView(f.bytes!.buffer, f.bytes!.byteOffset, 4).getFloat32(0, true)
    }
  }
  return values
}

export function protoString(message: Uint8Array, field: number): string | undefined {
  const bytes = protoBytes(parseProto(message), field)
  return bytes ? new TextDecoder().decode(bytes) : undefined
}
