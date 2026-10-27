import { ExportCancelled, runExport } from '../../core/export/pipeline'
import type { ByteRange } from '../../core/media/file'
import type { FromWorker, ToWorker } from './protocol'

/**
 * Export worker: runs the decode → composite → encode → mux pipeline off
 * the UI thread. File reads and writes go through the UI thread's FileHost.
 */
// The app's tsconfig uses the DOM lib; describe just the worker scope used here.
interface WorkerScope {
  postMessage(message: FromWorker, transfer?: Transferable[]): void
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null
}
const scope = self as unknown as WorkerScope
const post = (message: FromWorker, transfer: Transferable[] = []) => scope.postMessage(message, transfer)

const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
let nextRequest = 1
const controller = new AbortController()

function request<T>(message: (requestId: number) => FromWorker, transfer: Transferable[] = []): Promise<T> {
  const requestId = nextRequest++
  return new Promise<T>((resolve, reject) => {
    pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject })
    post(message(requestId), transfer)
  })
}

scope.onmessage = async (event: MessageEvent<ToWorker>) => {
  const message = event.data
  if (message.type === 'cancel') {
    controller.abort()
    return
  }
  if (message.type !== 'run') {
    const entry = pending.get(message.requestId)
    pending.delete(message.requestId)
    if (message.type === 'io-error') entry?.reject(new Error(message.message))
    else entry?.resolve(message.type === 'read-result' ? message.chunks : undefined)
    return
  }

  try {
    const stats = await runExport(
      {
        ...message.job,
        source: {
          size: message.fileSize,
          readRanges: (ranges: ByteRange[]) => request<Uint8Array[]>((requestId) => ({ type: 'read', requestId, ranges })),
        },
        target: {
          write: (position, bytes) => {
            // The muxer may reuse its buffer; send a copy we can transfer.
            const copy = bytes.slice()
            return request<void>((requestId) => ({ type: 'write', requestId, position, bytes: copy }), [copy.buffer])
          },
        },
      },
      { signal: controller.signal, onProgress: (progress) => post({ type: 'progress', progress }) },
    )
    post({ type: 'done', stats })
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error), cancelled: error instanceof ExportCancelled })
  }
}
