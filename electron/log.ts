import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * A plain-text log in `userData/logs/` that users can send when something
 * goes wrong: errors from the main process, the renderer and the GPU, with
 * the app version. Rotates at 2 MB, keeping one older file.
 */
const MAX_BYTES = 2 * 1024 * 1024

let logFile: string | null = null

export function initLog(userDataDir: string, header: string) {
  const dir = path.join(userDataDir, 'logs')
  mkdirSync(dir, { recursive: true })
  logFile = path.join(dir, 'telemetry-overlay.log')
  writeLog('info', header)
}

export function logDirectory(): string | null {
  return logFile ? path.dirname(logFile) : null
}

export function writeLog(level: 'info' | 'warn' | 'error', message: string) {
  if (!logFile) return
  try {
    try {
      if (statSync(logFile).size > MAX_BYTES) renameSync(logFile, `${logFile}.old`)
    } catch {
      // No log yet.
    }
    // One entry per line; indent continuation lines (stack traces).
    const body = message.trim().replace(/\r?\n/g, '\n    ')
    appendFileSync(logFile, `${new Date().toISOString()} ${level.toUpperCase()} ${body}\n`)
  } catch {
    // Logging must never take the app down.
  }
}
