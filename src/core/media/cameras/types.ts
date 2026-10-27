import type { RandomAccessFile } from '../file'
import type { Mp4Info } from '../mp4'

/** Camera turn rate on the video timeline, for sync. */
export interface CameraMotion {
  /** Video seconds. */
  times: Float64Array
  /** Rotation rate about the gravity axis (rad/s); sign follows the camera. */
  yawRate: Float64Array
  /** Human-readable source, e.g. "DJI djmd orientation". */
  source: string
}

export interface CameraIdentity {
  /** e.g. "DJI Osmo Action 4". */
  model: string | null
}

/**
 * One kind of camera. Adding a camera means adding an adapter and
 * registering it in `registry.ts`.
 */
export interface CameraAdapter {
  id: string
  label: string
  detect(info: Mp4Info): boolean
  /** Short description of the motion data this file carries, or null. */
  motionSource(info: Mp4Info): string | null
  identify?(file: RandomAccessFile, info: Mp4Info): Promise<CameraIdentity>
  readMotion?(file: RandomAccessFile, info: Mp4Info): Promise<CameraMotion | null>
}
