// @vitest-environment node

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { allowFile, fileSize, readRanges, serveFile } from './files.js'

let dir = ''
let file = ''
const bytes = Uint8Array.from({ length: 1000 }, (_, i) => i % 256)

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'files-test-'))
  file = path.join(dir, 'clip.mp4')
  await writeFile(file, bytes)
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('file access', () => {
  it('denies files the user has not opened', async () => {
    const other = path.join(dir, 'secret.txt')
    await writeFile(other, 'nope')
    await expect(fileSize(other)).rejects.toThrow(/denied/)
    expect((await serveFile(other, null)).status).toBe(403)
  })

  it('reads batched ranges, clamped to the file size', async () => {
    allowFile(file)
    expect(await fileSize(file)).toBe(1000)
    const [a, b, c] = await readRanges(file, [
      { offset: 0, length: 4 },
      { offset: 998, length: 10 },
      { offset: 2000, length: 4 },
    ])
    expect(Array.from(a!)).toEqual([0, 1, 2, 3])
    expect(Array.from(b!)).toEqual([998 % 256, 999 % 256])
    expect(c!.byteLength).toBe(0)
  })

  it('serves byte ranges for video seeking', async () => {
    allowFile(file)
    const partial = await serveFile(file, 'bytes=10-19')
    expect(partial.status).toBe(206)
    expect(partial.headers.get('Content-Range')).toBe('bytes 10-19/1000')
    expect(partial.headers.get('Content-Type')).toBe('video/mp4')
    expect(Array.from(new Uint8Array(await partial.arrayBuffer()))).toEqual(Array.from(bytes.subarray(10, 20)))

    const open = await serveFile(file, 'bytes=990-')
    expect(open.headers.get('Content-Range')).toBe('bytes 990-999/1000')
    const suffix = await serveFile(file, 'bytes=-5')
    expect(suffix.headers.get('Content-Range')).toBe('bytes 995-999/1000')
    expect((await serveFile(file, 'bytes=5000-')).status).toBe(416)

    const whole = await serveFile(file, null)
    expect(whole.status).toBe(200)
    expect((await whole.arrayBuffer()).byteLength).toBe(1000)
  })
})
