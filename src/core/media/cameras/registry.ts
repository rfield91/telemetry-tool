import type { Mp4Info } from '../mp4'
import { djiActionAdapter } from './dji'
import type { CameraAdapter } from './types'

/** Registered cameras, most specific first. GoPro (GPMF) arrives in M5. */
export const CAMERA_ADAPTERS: readonly CameraAdapter[] = [djiActionAdapter]

export function detectCamera(info: Mp4Info, adapters: readonly CameraAdapter[] = CAMERA_ADAPTERS): CameraAdapter | null {
  return adapters.find((adapter) => adapter.detect(info)) ?? null
}
