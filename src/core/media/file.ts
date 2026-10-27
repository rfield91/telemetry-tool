export interface ByteRange {
  offset: number
  length: number
}

/**
 * Random-access reads on a (possibly multi-GB) file. Reads are batched so
 * thousands of small metadata samples cost one round trip to the host.
 */
export interface RandomAccessFile {
  size: number
  readRanges(ranges: ByteRange[]): Promise<Uint8Array[]>
}

export async function readBytes(file: RandomAccessFile, offset: number, length: number): Promise<Uint8Array> {
  const [bytes] = await file.readRanges([{ offset, length }])
  return bytes!
}

export function memoryFile(bytes: Uint8Array): RandomAccessFile {
  return {
    size: bytes.byteLength,
    async readRanges(ranges) {
      return ranges.map(({ offset, length }) => bytes.subarray(offset, Math.min(offset + length, bytes.byteLength)))
    },
  }
}
