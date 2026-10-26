import { createReadStream } from 'node:fs'
import { open, stat, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'

export interface ByteRange {
  offset: number
  length: number
}

const MIME_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/mp4',
  '.csv': 'text/csv',
}

/**
 * Files the renderer may read: only ones the user picked in a dialog (or
 * that a later milestone's project open adds).
 */
const allowed = new Set<string>()
const handles = new Map<string, Promise<FileHandle>>()

const key = (filePath: string) => path.resolve(filePath).toLowerCase()

export function allowFile(filePath: string) {
  allowed.add(key(filePath))
}

function assertAllowed(filePath: string) {
  if (!allowed.has(key(filePath))) throw new Error('File access denied: open it through the app first.')
}

function handleFor(filePath: string) {
  let handle = handles.get(key(filePath))
  if (!handle) {
    handle = open(filePath, 'r')
    handles.set(key(filePath), handle)
  }
  return handle
}

export async function fileSize(filePath: string): Promise<number> {
  assertAllowed(filePath)
  return (await stat(filePath)).size
}

export async function readRanges(filePath: string, ranges: ByteRange[]): Promise<Uint8Array[]> {
  assertAllowed(filePath)
  const handle = await handleFor(filePath)
  const size = (await handle.stat()).size
  return Promise.all(
    ranges.map(async ({ offset, length }) => {
      const clamped = Math.max(0, Math.min(length, size - offset))
      const buffer = new Uint8Array(clamped)
      if (clamped > 0) await handle.read(buffer, 0, clamped, offset)
      return buffer
    }),
  )
}

/** Serve a file with HTTP range support (for `<video>` seeking). */
export async function serveFile(filePath: string, rangeHeader: string | null): Promise<Response> {
  try {
    assertAllowed(filePath)
  } catch {
    return new Response('Forbidden', { status: 403 })
  }
  const size = (await stat(filePath)).size
  const type = MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
  const match = rangeHeader?.match(/bytes=(\d*)-(\d*)/)
  if (!match) {
    const body = Readable.toWeb(createReadStream(filePath)) as ReadableStream
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' },
    })
  }
  let start = match[1] ? Number(match[1]) : NaN
  let end = match[2] ? Number(match[2]) : size - 1
  if (Number.isNaN(start)) {
    // Suffix range: last N bytes.
    start = Math.max(0, size - end)
    end = size - 1
  }
  end = Math.min(end, size - 1)
  if (start > end || start >= size) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
  }
  const body = Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream
  return new Response(body, {
    status: 206,
    headers: {
      'Content-Type': type,
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
    },
  })
}
