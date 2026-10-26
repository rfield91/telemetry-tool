import type { RandomAccessFile } from '../file'
import { readTrackSamples, type Mp4Info } from '../mp4'
import { protoFloats, protoPath, protoString } from '../protobuf'
import type { CameraAdapter, CameraMotion } from './types'

/**
 * DJI Osmo Action cameras write a `djmd` metadata track: one protobuf
 * packet per video frame. Decoded without a schema (see spike/auto-sync):
 *   3.2.9  orientation quaternion (w, x, y, z)
 *   3.2.10 accelerometer in g (fields 2–4)
 *   3.4.1  device info; field 4 is the model code (e.g. "DJI AC003")
 */
const QUATERNION_PATH = [3, 2, 9]
const ACCEL_PATH = [3, 2, 10]
const DEVICE_PATH = [3, 4, 1]

const MODEL_NAMES: Record<string, string> = {
  'DJI AC003': 'DJI Osmo Action 4',
}

function djmdTrack(info: Mp4Info) {
  return info.tracks.find((track) => track.format === 'djmd')
}

type Quaternion = [number, number, number, number]

/**
 * Rotation rate between consecutive orientations, projected onto the
 * gravity direction (mean accelerometer vector) so mounting angle doesn't
 * matter.
 */
export function gravityYawRate(
  times: ArrayLike<number>,
  quaternions: Quaternion[],
  accels: Array<[number, number, number]>,
): { times: Float64Array; yawRate: Float64Array } {
  const up = [0, 1, 2].map((i) => accels.reduce((sum, a) => sum + a[i]!, 0) / Math.max(accels.length, 1))
  const norm = Math.hypot(up[0]!, up[1]!, up[2]!) || 1
  const n = Math.max(quaternions.length - 1, 0)
  const outTimes = new Float64Array(n)
  const yawRate = new Float64Array(n)
  for (let i = 1; i < quaternions.length; i += 1) {
    const [w1, x1, y1, z1] = quaternions[i - 1]!
    const [w2, x2, y2, z2] = quaternions[i]!
    // Body-frame relative rotation conj(q1) * q2.
    let d = [
      w1 * w2 + x1 * x2 + y1 * y2 + z1 * z2,
      w1 * x2 - x1 * w2 - y1 * z2 + z1 * y2,
      w1 * y2 + x1 * z2 - y1 * w2 - z1 * x2,
      w1 * z2 - x1 * y2 + y1 * x2 - z1 * w2,
    ]
    if (d[0]! < 0) d = d.map((v) => -v)
    const dt = times[i]! - times[i - 1]!
    const s = Math.hypot(d[1]!, d[2]!, d[3]!)
    const k = s > 0 && dt > 0 ? (2 * Math.atan2(s, d[0]!)) / s / dt : 0
    outTimes[i - 1] = (times[i]! + times[i - 1]!) / 2
    yawRate[i - 1] = ((d[1]! * up[0]! + d[2]! * up[1]! + d[3]! * up[2]!) / norm) * k
  }
  return { times: outTimes, yawRate }
}

/** Decode orientation + acceleration from djmd packets and derive yaw rate. */
export function decodeDjmdMotion(times: ArrayLike<number>, packets: Uint8Array[]): CameraMotion | null {
  const sampleTimes: number[] = []
  const quaternions: Quaternion[] = []
  const accels: Array<[number, number, number]> = []
  packets.forEach((packet, i) => {
    try {
      const q = protoPath(packet, QUATERNION_PATH)
      const a = protoPath(packet, ACCEL_PATH)
      if (!q || !a) return
      const quaternion = protoFloats(q, 4) as Quaternion
      // Guard against firmware changes: only trust unit quaternions.
      if (Math.abs(Math.hypot(...quaternion) - 1) > 0.01) return
      const accel = protoFloats(a, 4)
      sampleTimes.push(times[i]!)
      quaternions.push(quaternion)
      accels.push([accel[1]!, accel[2]!, accel[3]!])
    } catch {
      // Skip packets that don't decode.
    }
  })
  if (quaternions.length < 2) return null
  return { ...gravityYawRate(sampleTimes, quaternions, accels), source: 'DJI djmd orientation' }
}

export const djiActionAdapter: CameraAdapter = {
  id: 'dji-action',
  label: 'DJI Osmo Action',
  detect: (info) => djmdTrack(info) !== undefined,
  motionSource(info) {
    const track = djmdTrack(info)
    return track ? `DJI djmd orientation (${track.samples.sizes.length.toLocaleString('en-US')} samples)` : null
  },
  async identify(file: RandomAccessFile, info: Mp4Info) {
    const track = djmdTrack(info)
    if (!track || track.samples.sizes.length === 0) return { model: null }
    const [first] = await readTrackSamples(file, track, [0])
    try {
      const device = protoPath(first!, DEVICE_PATH)
      const code = device ? protoString(device, 4) : undefined
      return { model: code ? (MODEL_NAMES[code] ?? code) : null }
    } catch {
      return { model: null }
    }
  },
  async readMotion(file, info) {
    const track = djmdTrack(info)
    if (!track) return null
    const packets = await readTrackSamples(file, track)
    return decodeDjmdMotion(track.samples.times, packets)
  },
}
