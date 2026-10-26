import type { ByteRange } from '../../core/media/file'
import type { SyncResult } from '../../core/sync/engine'

/** Messages between the UI thread and the sync worker. */

export interface SyncRunRequest {
  type: 'run'
  fileSize: number
  logger: { times: Float64Array; values: Float64Array }
}

export interface CameraMotionData {
  times: Float64Array
  yawRate: Float64Array
  source: string
}

export interface SyncRunOutput {
  sync: SyncResult | null
  camera: CameraMotionData
}

export type ToWorker =
  | SyncRunRequest
  | { type: 'read-result'; requestId: number; chunks: Uint8Array[] }
  | { type: 'read-error'; requestId: number; message: string }

export type FromWorker =
  | { type: 'progress'; label: string }
  | { type: 'read'; requestId: number; ranges: ByteRange[] }
  | { type: 'done'; output: SyncRunOutput }
  | { type: 'error'; message: string }
