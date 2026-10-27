import type { ExportProgress, ExportStats } from '../../core/export/pipeline'
import { host } from '../host'
import type { ExportJobData, FromWorker, ToWorker } from './protocol'
import ExportWorker from './worker?worker&inline'

export class ExportCancelledError extends Error {
  constructor() {
    super('Export cancelled')
  }
}

/**
 * Run an export in a worker. Reads from the video and writes to the output
 * go through FileHost; the output is moved into place only on success.
 */
export async function runExportWorker(
  videoPath: string,
  outputPath: string,
  job: ExportJobData,
  onProgress: (progress: ExportProgress) => void,
  signal: AbortSignal,
): Promise<ExportStats> {
  const source = await host.openRandomAccess(videoPath)
  const output = await host.openOutput(outputPath)
  const worker = new ExportWorker()
  const send = (message: ToWorker, transfer: Transferable[] = []) => worker.postMessage(message, transfer)
  const cancel = () => send({ type: 'cancel' })
  signal.addEventListener('abort', cancel)

  let finished = false
  try {
    const stats = await new Promise<ExportStats>((resolve, reject) => {
      worker.onerror = (event) => reject(new Error(event.message || 'Export worker failed'))
      worker.onmessage = (event: MessageEvent<FromWorker>) => {
        const message = event.data
        if (message.type === 'progress') onProgress(message.progress)
        else if (message.type === 'done') resolve(message.stats)
        else if (message.type === 'error') reject(message.cancelled ? new ExportCancelledError() : new Error(message.message))
        else if (message.type === 'read') {
          source.readRanges(message.ranges).then(
            // Chunks may share one buffer; list each buffer once.
            (chunks) => send({ type: 'read-result', requestId: message.requestId, chunks }, [...new Set(chunks.map((c) => c.buffer as ArrayBuffer))]),
            (error: unknown) => send({ type: 'io-error', requestId: message.requestId, message: String(error) }),
          )
        } else if (message.type === 'write') {
          output.write(message.position, message.bytes).then(
            () => send({ type: 'write-done', requestId: message.requestId }),
            (error: unknown) => send({ type: 'io-error', requestId: message.requestId, message: String(error) }),
          )
        }
      }
      send({ type: 'run', job, fileSize: source.size })
    })
    await output.finish()
    finished = true
    return stats
  } finally {
    signal.removeEventListener('abort', cancel)
    worker.terminate()
    if (!finished) await output.abort().catch(() => undefined)
  }
}
