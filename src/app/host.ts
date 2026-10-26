import { isUserProfileDefinition, type UserProfileDefinition } from '../core/data/profiles/user'
import type { ByteRange, RandomAccessFile } from '../core/media/file'

/**
 * Everything the UI needs from the machine: picking files, reading them and
 * persisting user logger profiles. Electron implements it over IPC; the dev
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
  loadProfiles(): Promise<UserProfileDefinition[]>
  saveProfiles(profiles: UserProfileDefinition[]): Promise<void>
}

const PROFILES_KEY = 'telemetry-overlay.logger-profiles'

const validProfiles = (value: unknown) =>
  Array.isArray(value) ? value.filter(isUserProfileDefinition) : []

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
    loadProfiles: async () => validProfiles(await api.loadProfiles()),
    saveProfiles: (profiles) => api.saveProfiles(profiles),
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
        path = window.prompt(kind === 'video' ? 'Absolute path to a video file' : 'Absolute path to a CSV file')
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
    async loadProfiles() {
      try {
        return validProfiles(JSON.parse(localStorage.getItem(PROFILES_KEY) ?? '[]'))
      } catch {
        return []
      }
    },
    async saveProfiles(profiles) {
      try {
        localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles))
      } catch {
        // Storage unavailable (private window); profiles last for the session.
      }
    },
  }
}

export const host: FileHost = window.telemetryOverlay ? electronHost(window.telemetryOverlay) : browserHost()

/** Last path segment, for display. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}
