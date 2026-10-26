import type { Signal } from '../../core/sync/engine'
import { host } from '../host'
import type { FromWorker, SyncRunOutput, ToWorker } from './protocol'
import SyncWorker from './worker?worker&inline'

/**
 * Run auto-sync for a video file against a logger yaw signal in a worker.
 * The worker asks for file byte ranges; they're answered here via FileHost.
 */
export async function runSyncWorker(
  videoPath: string,
  logger: Signal,
  onProgress: (label: string) => void,
): Promise<SyncRunOutput> {
  const file = await host.openRandomAccess(videoPath)
  const worker = new SyncWorker()
  const send = (message: ToWorker, transfer: Transferable[] = []) => worker.postMessage(message, transfer)

  try {
    return await new Promise<SyncRunOutput>((resolve, reject) => {
      worker.onerror = (event) => reject(new Error(event.message || 'Sync worker failed'))
      worker.onmessage = (event: MessageEvent<FromWorker>) => {
        const message = event.data
        if (message.type === 'progress') onProgress(message.label)
        else if (message.type === 'done') resolve(message.output)
        else if (message.type === 'error') reject(new Error(message.message))
        else if (message.type === 'read') {
          file.readRanges(message.ranges).then(
            (chunks) => send({ type: 'read-result', requestId: message.requestId, chunks }),
            (error: unknown) => send({ type: 'read-error', requestId: message.requestId, message: String(error) }),
          )
        }
      }
      const times = Float64Array.from(logger.times)
      const values = Float64Array.from(logger.values)
      send({ type: 'run', fileSize: file.size, logger: { times, values } }, [times.buffer, values.buffer])
    })
  } finally {
    worker.terminate()
  }
}
