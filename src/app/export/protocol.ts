import type { ExportJob, ExportProgress, ExportStats } from '../../core/export/pipeline'
import type { ByteRange } from '../../core/media/file'

/** Messages between the UI thread and the export worker. */

/** The job minus file access, which the worker gets through messages. */
export type ExportJobData = Omit<ExportJob, 'source' | 'target'>

export type ToWorker =
  | { type: 'run'; job: ExportJobData; fileSize: number }
  | { type: 'cancel' }
  | { type: 'read-result'; requestId: number; chunks: Uint8Array[] }
  | { type: 'write-done'; requestId: number }
  | { type: 'io-error'; requestId: number; message: string }

export type FromWorker =
  | { type: 'read'; requestId: number; ranges: ByteRange[] }
  | { type: 'write'; requestId: number; position: number; bytes: Uint8Array }
  | { type: 'progress'; progress: ExportProgress }
  | { type: 'done'; stats: ExportStats }
  | { type: 'error'; message: string; cancelled: boolean }
