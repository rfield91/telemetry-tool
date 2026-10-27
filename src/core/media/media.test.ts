import { describe, expect, it } from 'vitest'
import djmdBase64 from '../../../sample-data/media/dji-djmd-240.bin.b64?raw'
import djmdMeta from '../../../sample-data/media/dji-djmd-240.json'
import tinyBase64 from '../../../sample-data/media/tiny-h264-aac.mp4.b64?raw'
import { djiActionAdapter, decodeDjmdMotion, gravityYawRate } from './cameras/dji'
import { memoryFile } from './file'
import { readMp4, readTrackSamples, trackFrameRate } from './mp4'
import { probeVideo } from './probe'
import { parseProto, protoFloats, protoPath } from './protobuf'
import { buildMetadataMp4, fromBase64 } from './testing'

function djmdPackets(): Uint8Array[] {
  const bytes = fromBase64(djmdBase64)
  const packets: Uint8Array[] = []
  let offset = 0
  for (const size of djmdMeta.sizes) {
    packets.push(bytes.subarray(offset, offset + size))
    offset += size
  }
  return packets
}

describe('readMp4', () => {
  it('lists tracks and sample tables of a regular MP4', async () => {
    const info = await readMp4(memoryFile(fromBase64(tinyBase64)))
    expect(info.majorBrand).toBe('isom')
    expect(info.duration).toBeCloseTo(1, 1)
    const video = info.tracks.find((track) => track.handler === 'vide')!
    expect(video).toMatchObject({ format: 'avc1', width: 64, height: 36, rotation: 0 })
    expect(video.samples.sizes).toHaveLength(30)
    expect(trackFrameRate(video)).toBeCloseTo(30, 6)
    expect(info.tracks.find((track) => track.handler === 'soun')?.format).toBe('mp4a')
  })

  it('reads metadata samples back by byte range', async () => {
    const packets = djmdPackets().slice(0, 5)
    const file = memoryFile(buildMetadataMp4({ format: 'djmd', samples: packets, timescale: 60000, delta: 1001 }))
    const info = await readMp4(file)
    const track = info.tracks[0]!
    expect(track.format).toBe('djmd')
    expect(Array.from(track.samples.times)).toEqual([0, 1001, 2002, 3003, 4004].map((t) => t / 60000))
    const read = await readTrackSamples(file, track)
    expect(read.map((p) => Array.from(p))).toEqual(packets.map((p) => Array.from(p)))
  })
})

describe('protobuf', () => {
  it('decodes the DJI orientation quaternion as a unit quaternion', () => {
    const packet = djmdPackets()[1]!
    expect(parseProto(packet)[0]?.field).toBe(3)
    const q = protoFloats(protoPath(packet, [3, 2, 9])!, 4)
    expect(Math.hypot(...q)).toBeCloseTo(1, 4)
  })
})

describe('gravityYawRate', () => {
  type Q = [number, number, number, number]
  const yaw = (angle: number): Q => [Math.cos(angle / 2), 0, 0, Math.sin(angle / 2)]
  const mul = ([aw, ax, ay, az]: Q, [bw, bx, by, bz]: Q): Q => [
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
  ]
  const fps = 60
  const rate = 0.5 // rad/s about the vertical axis
  const times = Array.from({ length: 600 }, (_, i) => i / fps)
  const up = times.map((): [number, number, number] => [0, 0, 1])

  it('measures a steady turn', () => {
    const result = gravityYawRate(times, times.map((t) => yaw(rate * t)), up)
    expect(result.skipped).toBe(0)
    for (const value of result.yawRate) expect(value).toBeCloseTo(rate, 6)
  })

  it('drops a stray orientation stream interleaved with the main one', () => {
    // As in a 16-minute Osmo Action 4 file: bursts of a second stream ~2.6 rad away.
    const offset: Q = [Math.cos(1.3), 0.6 * Math.sin(1.3), 0, 0.8 * Math.sin(1.3)]
    const quaternions = times.map((t, i) => {
      const main = yaw(rate * t)
      const stray = (i >= 120 && i < 140) || (i >= 300 && i < 303) || (i >= 400 && i < 430)
      return stray ? mul(main, offset) : main
    })
    const result = gravityYawRate(times, quaternions, up)
    expect(result.skipped).toBe(53)
    expect(Math.max(...Array.from(result.yawRate, (v) => Math.abs(v - rate)))).toBeLessThan(1e-6)
  })

  it('keeps the main stream when it resumes after a long gap with a big real turn', () => {
    // 1 s of dropped frames during which the car turned 1.6 rad.
    const gapTimes = [...times.slice(0, 60), ...times.slice(60).map((t) => t + 1)]
    const quaternions = gapTimes.map((t, i) => yaw(rate * t + (i >= 60 ? 1.6 - rate : 0)))
    const result = gravityYawRate(gapTimes, quaternions, up)
    expect(result.yawRate.length).toBe(598)
    expect(Math.max(...Array.from(result.yawRate, (v) => Math.abs(v - rate)))).toBeLessThan(1e-6)
  })
})

describe('DJI Osmo Action adapter', () => {
  const packets = djmdPackets()
  const mp4 = buildMetadataMp4({
    format: 'djmd',
    samples: packets,
    timescale: djmdMeta.timescale,
    delta: djmdMeta.frameDuration,
    creationTime: new Date('2026-10-25T18:15:14Z'),
  })

  it('detects the camera and model from djmd', async () => {
    const file = memoryFile(mp4)
    const info = await readMp4(file)
    expect(djiActionAdapter.detect(info)).toBe(true)
    expect(await djiActionAdapter.identify!(file, info)).toEqual({ model: 'DJI Osmo Action 4' })
    expect(djiActionAdapter.motionSource(info)).toBe('DJI djmd orientation (240 samples)')
    expect(info.creationTime?.toISOString()).toBe('2026-10-25T18:15:14.000Z')
  })

  it('derives a yaw-rate signal on the video timeline', async () => {
    const file = memoryFile(mp4)
    const motion = (await djiActionAdapter.readMotion!(file, await readMp4(file)))!
    expect(motion.times).toHaveLength(239)
    expect(motion.times[0]).toBeCloseTo(0.5 * (1001 / 60000), 9)
    // Parked in the staging lane: small rotation rates only.
    const peak = Math.max(...Array.from(motion.yawRate, Math.abs))
    expect(Number.isFinite(peak)).toBe(true)
    expect(peak).toBeLessThan(0.5)
  })

  it('skips packets that are not valid djmd', () => {
    const motion = decodeDjmdMotion([0, 0.1, 0.2, 0.3], [packets[0]!, new Uint8Array([0xff, 0xff]), packets[1]!, packets[2]!])
    expect(motion?.times).toHaveLength(2)
  })
})

describe('probeVideo', () => {
  it('summarises a regular MP4 with no camera adapter', async () => {
    const { probe } = await probeVideo(memoryFile(fromBase64(tinyBase64)))
    expect(probe.video).toMatchObject({ codec: 'H.264', width: 64, height: 36, frameCount: 30 })
    expect(probe.video.fps).toBeCloseTo(30, 6)
    expect(probe.audio).toEqual({ codec: 'AAC' })
    expect(probe.camera).toBeNull()
  })
})
