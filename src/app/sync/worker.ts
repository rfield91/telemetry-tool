import { detectCamera } from '../../core/media/cameras/registry'
import type { ByteRange, RandomAccessFile } from '../../core/media/file'
import { readMp4 } from '../../core/media/mp4'
import { synchronize } from '../../core/sync/engine'
import type { FromWorker, ToWorker } from './protocol'

/**
 * Sync worker: reads the camera's motion track (byte ranges are fetched by
 * the UI thread through FileHost) and runs the correlation off the UI thread.
 */
// The app's tsconfig uses the DOM lib; describe just the worker scope used here.
interface WorkerScope {
  postMessage(message: FromWorker, transfer: Transferable[]): void
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null
}
const scope = self as unknown as WorkerScope
const pending = new Map<number, { resolve: (chunks: Uint8Array[]) => void; reject: (error: Error) => void }>()
let nextRequest = 1

const post = (message: FromWorker, transfer: Transferable[] = []) => scope.postMessage(message, transfer)

function remoteFile(size: number): RandomAccessFile {
  return {
    size,
    readRanges(ranges: ByteRange[]) {
      const requestId = nextRequest++
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject })
        post({ type: 'read', requestId, ranges })
      })
    },
  }
}

scope.onmessage = async (event: MessageEvent<ToWorker>) => {
  const message = event.data
  if (message.type === 'read-result' || message.type === 'read-error') {
    const request = pending.get(message.requestId)
    pending.delete(message.requestId)
    if (message.type === 'read-result') request?.resolve(message.chunks)
    else request?.reject(new Error(message.message))
    return
  }

  try {
    const file = remoteFile(message.fileSize)
    post({ type: 'progress', label: 'Reading camera motion…' })
    const info = await readMp4(file)
    const adapter = detectCamera(info)
    const motion = adapter?.readMotion ? await adapter.readMotion(file, info) : null
    if (!motion) throw new Error("This video has no camera motion data, so it can't be synced automatically yet.")

    post({ type: 'progress', label: 'Matching data to video…' })
    const sync = synchronize(message.logger, { times: motion.times, values: motion.yawRate })
    post(
      { type: 'done', output: { sync, camera: { times: motion.times, yawRate: motion.yawRate, source: motion.source } } },
      [motion.times.buffer, motion.yawRate.buffer],
    )
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}
