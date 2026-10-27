import { host } from './host'
import { runtimeStore } from './state'

const describe = (error: unknown) => (error instanceof Error ? (error.stack ?? error.message) : String(error))

/**
 * Send renderer errors to the log file: uncaught errors, and every error
 * the UI shows (toasts, failed sync or export), so a user can send the log.
 */
export function installErrorLogging() {
  window.addEventListener('error', (event) => host.log('error', describe(event.error ?? event.message)))
  window.addEventListener('unhandledrejection', (event) => host.log('error', `unhandled promise: ${describe(event.reason)}`))
  runtimeStore.subscribe((state, previous) => {
    if (state.error && state.error !== previous.error) host.log('warn', `shown: ${state.error}`)
    if (state.syncRun !== previous.syncRun && state.syncRun.status === 'error') host.log('warn', `auto-sync: ${state.syncRun.message}`)
    const run = state.exportRun
    if (run !== previous.exportRun) {
      if (run.status === 'error') host.log('error', `export failed: ${run.message}`)
      if (run.status === 'done') {
        const { stats } = run
        host.log(
          'info',
          `export done: ${stats.frames} frames, ${stats.duration.toFixed(1)} s in ${stats.elapsedSeconds.toFixed(1)} s, ${stats.codec}, ${stats.compositor}${stats.warnings.length ? `; ${stats.warnings.join(' ')}` : ''}`,
        )
      }
    }
  })
}
