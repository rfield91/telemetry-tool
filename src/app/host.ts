import { isUserProfileDefinition, type UserProfileDefinition } from '../core/data/profiles/user'
import { isLayoutTemplate, type LayoutTemplate } from '../core/layout/templates'
import type { ByteRange, RandomAccessFile } from '../core/media/file'

/**
 * Everything the UI needs from the machine: picking files, reading them and
 * persisting user logger profiles and layout templates. Electron implements it over IPC; the dev
 * build in a plain browser uses the Vite dev-server endpoints.
 */
export interface FileHost {
  kind: 'electron' | 'browser'
  pickFile(kind: 'video' | 'csv'): Promise<string | null>
  /** Absolute path of a dropped file, or null where paths aren't available. */
  pathForDroppedFile(file: File): Promise<string | null>
  readText(path: string): Promise<string>
  openRandomAccess(path: string): Promise<RandomAccessFile>
  /** URL a <video> element can stream (with range requests). */
  mediaUrl(path: string): string
  /** Where to save an export; null if the user cancels. */
  pickSavePath(defaultPath: string): Promise<string | null>
  /** Open an export output (written to `<path>.part` until finished). */
  openOutput(path: string): Promise<OutputFile>
  /** Show a saved export in Explorer. */
  revealFile(path: string): Promise<void>
  /** Append to the app's log file (desktop app; the console in the browser harness). */
  log(level: 'info' | 'warn' | 'error', message: string): void
  /** Open the folder holding the log file; false where there isn't one. */
  revealLogs(): Promise<boolean>
  loadProfiles(): Promise<UserProfileDefinition[]>
  saveProfiles(profiles: UserProfileDefinition[]): Promise<void>
  loadTemplates(): Promise<LayoutTemplate[]>
  saveTemplates(templates: LayoutTemplate[]): Promise<void>
}

export interface OutputFile {
  write(position: number, bytes: Uint8Array): Promise<void>
  /** Close and move the file into place. */
  finish(): Promise<void>
  /** Close and delete the partial file. */
  abort(): Promise<void>
}

const PROFILES_KEY = 'telemetry-overlay.logger-profiles'
const TEMPLATES_KEY = 'telemetry-overlay.layout-templates'

const validProfiles = (value: unknown) =>
  Array.isArray(value) ? value.filter(isUserProfileDefinition) : []
const validTemplates = (value: unknown) => (Array.isArray(value) ? value.filter(isLayoutTemplate) : [])

function loadLocal(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '[]')
  } catch {
    return []
  }
}

function saveLocal(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage unavailable (private window); the list lasts for the session.
  }
}

function electronHost(api: TelemetryOverlayApi): FileHost {
  return {
    kind: 'electron',
    pickFile: (kind) => api.pickFile(kind),
    pathForDroppedFile: (file) => api.pathForDroppedFile(file),
    readText: (path) => api.readText(path),
    async openRandomAccess(path) {
      const size = await api.fileSize(path)
      return { size, readRanges: (ranges: ByteRange[]) => api.readRanges(path, ranges) }
    },
    mediaUrl: (path) => `media://local/${encodeURIComponent(path)}`,
    pickSavePath: (defaultPath) => api.pickSavePath(defaultPath),
    async openOutput(path) {
      const id = await api.openOutput(path)
      return {
        write: (position, bytes) => api.writeOutput(id, position, bytes),
        finish: () => api.finishOutput(id),
        abort: () => api.abortOutput(id),
      }
    },
    revealFile: (path) => api.revealFile(path),
    log: (level, message) => void api.writeLog(level, message).catch(() => undefined),
    revealLogs: async () => (await api.revealLogs()) === '',
    loadProfiles: async () => validProfiles(await api.loadProfiles()),
    saveProfiles: (profiles) => api.saveProfiles(profiles),
    loadTemplates: async () => validTemplates(await api.loadTemplates()),
    saveTemplates: (templates) => api.saveTemplates(templates),
  }
}

function browserHost(): FileHost {
  const endpoint = (name: string, path: string) => `/__dev/${name}?path=${encodeURIComponent(path)}`
  return {
    kind: 'browser',
    // Dev harness only: there is no native file dialog in a plain browser.
    async pickFile(kind) {
      let path: string | null
      try {
        path = window.prompt(kind === 'video' ? 'Absolute path to a video file' : 'Absolute path to a CSV or XRK file')
      } catch {
        // Some embedded browsers block prompt().
        throw new Error('Open files with ?video=<path>&csv=<path> in the browser harness, or use the desktop app.')
      }
      return path?.trim().replace(/^"|"$/g, '') || null
    },
    // Browsers don't expose file paths for dropped files.
    pathForDroppedFile: async () => null,
    async readText(path) {
      const response = await fetch(endpoint('file', path))
      if (!response.ok) throw new Error(`Could not read ${path}`)
      return response.text()
    },
    async openRandomAccess(path) {
      const response = await fetch(endpoint('size', path))
      if (!response.ok) throw new Error(`Could not open ${path}`)
      const size = Number(await response.text())
      return {
        size,
        async readRanges(ranges) {
          const result = await fetch(endpoint('ranges', path), { method: 'POST', body: JSON.stringify(ranges) })
          const bytes = new Uint8Array(await result.arrayBuffer())
          let offset = 0
          return ranges.map((range) => {
            const length = Math.max(0, Math.min(range.length, size - range.offset))
            const part = bytes.subarray(offset, offset + length)
            offset += length
            return part
          })
        },
      }
    },
    mediaUrl: (path) => endpoint('file', path),
    // Dev harness only: no save dialog, so exports go to the suggested path.
    pickSavePath: async (defaultPath) => defaultPath,
    async openOutput(path) {
      const post = async (url: string, body?: BodyInit) => {
        const response = await fetch(url, { method: 'POST', body })
        if (!response.ok) throw new Error(await response.text())
        return response.text()
      }
      const id = await post(`/__dev/output/open?path=${encodeURIComponent(path)}`)
      return {
        write: async (position, bytes) => {
          await post(`/__dev/output/write?id=${id}&position=${position}`, bytes as Uint8Array<ArrayBuffer>)
        },
        finish: async () => {
          await post(`/__dev/output/finish?id=${id}`)
        },
        abort: async () => {
          await post(`/__dev/output/abort?id=${id}`)
        },
      }
    },
    revealFile: async () => {},
    log: (level, message) => console[level](`[log] ${message}`),
    revealLogs: async () => false,
    loadProfiles: async () => validProfiles(loadLocal(PROFILES_KEY)),
    saveProfiles: async (profiles) => saveLocal(PROFILES_KEY, profiles),
    loadTemplates: async () => validTemplates(loadLocal(TEMPLATES_KEY)),
    saveTemplates: async (templates) => saveLocal(TEMPLATES_KEY, templates),
  }
}

export const host: FileHost = window.telemetryOverlay ? electronHost(window.telemetryOverlay) : browserHost()

/** Last path segment, for display. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}
