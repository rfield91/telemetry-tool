// @vitest-environment node

import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { vp9AlphaOutputArgs } from './vp9AlphaArgs.js'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static') as string
const ffprobePath = require('ffprobe-static').path as string
const tempDirectories: string[] = []

async function run(
  executable: string,
  args: string[],
  input?: Buffer,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const process = spawn(executable, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    process.stdout.setEncoding('utf8')
    process.stderr.setEncoding('utf8')
    process.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    process.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    process.once('error', reject)
    process.once('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(stderr || `${path.basename(executable)} exited ${code}`))
    })
    process.stdin.end(input)
  })
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe('VP9 alpha encoder', () => {
  it('produces a playable WebM with alpha metadata', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'telemetry-overlay-'))
    tempDirectories.push(directory)
    const outputPath = path.join(directory, 'alpha.webm')

    // Two 2x2 BGRA frames: transparent red followed by opaque teal.
    const frames = Buffer.concat([
      Buffer.from([0, 0, 255, 0, 0, 0, 255, 64, 0, 0, 255, 128, 0, 0, 255, 192]),
      Buffer.from([
        191, 212, 45, 255, 191, 212, 45, 224, 191, 212, 45, 192, 191, 212, 45,
        160,
      ]),
    ])

    await run(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'bgra',
        '-s',
        '2x2',
        '-framerate',
        '2',
        '-i',
        'pipe:0',
        '-frames:v',
        '2',
        ...vp9AlphaOutputArgs(outputPath),
      ],
      frames,
    )

    const probe = JSON.parse(
      await run(ffprobePath, [
        '-v',
        'error',
        '-count_frames',
        '-show_entries',
        'stream=codec_name,nb_read_frames:stream_tags=alpha_mode:format=duration',
        '-of',
        'json',
        outputPath,
      ]),
    ) as {
      streams: Array<{
        codec_name: string
        nb_read_frames: string
        tags?: Record<string, string>
      }>
      format: { duration: string }
    }

    expect(probe.streams[0]?.codec_name).toBe('vp9')
    expect(probe.streams[0]?.nb_read_frames).toBe('2')
    expect(
      probe.streams[0]?.tags?.alpha_mode ??
        probe.streams[0]?.tags?.ALPHA_MODE,
    ).toBe('1')
    expect(Number(probe.format.duration)).toBeCloseTo(1, 1)
    expect((await readFile(outputPath)).byteLength).toBeGreaterThan(0)
  }, 20_000)

  it('encodes raw frames from a file on disk', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'telemetry-overlay-'))
    tempDirectories.push(directory)
    const rawPath = path.join(directory, 'frames.raw')
    const outputPath = path.join(directory, 'alpha.webm')
    const frames = Buffer.concat([
      Buffer.from([0, 0, 255, 0, 0, 0, 255, 64, 0, 0, 255, 128, 0, 0, 255, 192]),
      Buffer.from([
        191, 212, 45, 255, 191, 212, 45, 224, 191, 212, 45, 192, 191, 212, 45,
        160,
      ]),
    ])

    await import('node:fs/promises').then(({ writeFile }) =>
      writeFile(rawPath, frames),
    )

    await run(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'bgra',
        '-s',
        '2x2',
        '-framerate',
        '2',
        '-i',
        rawPath,
        '-frames:v',
        '2',
        ...vp9AlphaOutputArgs(outputPath),
      ],
    )

    expect((await readFile(outputPath)).byteLength).toBeGreaterThan(0)
  }, 20_000)
})
