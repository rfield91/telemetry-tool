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

/** Fastest rotation a car-mounted camera plausibly makes (≈ 340°/s). */
const MAX_RATE = 6
/** Allowance for sensor noise on top of MAX_RATE · dt (rad). */
const ANGLE_SLACK = 0.05
/**
 * Largest plausible change across any gap (rad). Cameras drop frames (gaps
 * of up to ~1 s), and without a cap MAX_RATE · dt would accept anything
 * after a gap. The second stream sits 2.3–3 rad away from the first.
 */
const MAX_JUMP = 1.5

/** Body-frame relative rotation conj(q1) · q2, in the short-way hemisphere. */
function relativeRotation([w1, x1, y1, z1]: Quaternion, [w2, x2, y2, z2]: Quaternion): Quaternion {
  const d: Quaternion = [
    w1 * w2 + x1 * x2 + y1 * y2 + z1 * z2,
    w1 * x2 - x1 * w2 - y1 * z2 + z1 * y2,
    w1 * y2 + x1 * z2 - y1 * w2 - z1 * x2,
    w1 * z2 - x1 * y2 + y1 * x2 - z1 * w2,
  ]
  return d[0] < 0 ? [-d[0], -d[1], -d[2], -d[3]] : d
}

/**
 * Rotation rate between successive orientations, projected onto the
 * gravity direction (mean accelerometer vector) so mounting angle doesn't
 * matter.
 *
 * Some recordings interleave other orientation streams, 2.3–3 rad away from
 * the main one (seen in a 16-minute Osmo Action 4 file around stretches of
 * dropped frames). Their turn rates are inconsistent with the vehicle (often
 * the wrong sign), and comparing neighbours across a switch reads as a
 * ~150 rad/s spin. So samples are split into tracks by continuity (each
 * sample joins the track it can be reached from with a plausible rotation),
 * rates are measured within each track, and stray tracks are dropped.
 */
export function gravityYawRate(
  times: ArrayLike<number>,
  quaternions: Quaternion[],
  accels: Array<[number, number, number]>,
): { times: Float64Array; yawRate: Float64Array; skipped: number } {
  const up = [0, 1, 2].map((i) => accels.reduce((sum, a) => sum + a[i]!, 0) / Math.max(accels.length, 1))
  const norm = Math.hypot(up[0]!, up[1]!, up[2]!) || 1

  interface Track {
    first: number
    last: number
    samples: number
    times: number[]
    rates: number[]
  }
  const tracks: Track[] = []
  for (let i = 0; i < quaternions.length; i += 1) {
    let best: { track: Track; angle: number; d: Quaternion } | null = null
    for (const track of tracks) {
      const dt = times[i]! - times[track.last]!
      if (!(dt > 0)) continue
      const d = relativeRotation(quaternions[track.last]!, quaternions[i]!)
      const angle = 2 * Math.atan2(Math.hypot(d[1], d[2], d[3]), d[0])
      if (angle <= Math.min(MAX_RATE * dt + ANGLE_SLACK, MAX_JUMP) && (!best || angle < best.angle)) {
        best = { track, angle, d }
      }
    }
    if (!best) {
      tracks.push({ first: i, last: i, samples: 1, times: [], rates: [] })
      continue
    }
    const { track, angle, d } = best
    const dt = times[i]! - times[track.last]!
    const s = Math.hypot(d[1], d[2], d[3])
    const k = s > 0 ? angle / s / dt : 0
    track.times.push((times[i]! + times[track.last]!) / 2)
    track.rates.push(((d[1] * up[0]! + d[2] * up[1]! + d[3] * up[2]!) / norm) * k)
    track.last = i
    track.samples += 1
  }

  // Keep tracks that don't overlap in time with a larger one: the main
  // stream and its continuations after gaps. Overlapping stray tracks are
  // dropped, which can leave holes; the sync engine treats holes as missing
  // data rather than interpolating across them.
  const overlaps = (a: Track, b: Track) => times[a.first]! < times[b.last]! && times[b.first]! < times[a.last]!
  const kept = tracks.filter((track) => !tracks.some((other) => other.samples > track.samples && overlaps(track, other)))
  const merged = kept
    .flatMap((track) => track.times.map((t, k) => [t, track.rates[k]!] as const))
    .sort((a, b) => a[0] - b[0])
  return {
    times: Float64Array.from(merged, ([t]) => t),
    yawRate: Float64Array.from(merged, ([, rate]) => rate),
    skipped: quaternions.length - kept.reduce((sum, track) => sum + track.samples, 0),
  }
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
  const { times: rateTimes, yawRate } = gravityYawRate(sampleTimes, quaternions, accels)
  return { times: rateTimes, yawRate, source: 'DJI djmd orientation' }
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
