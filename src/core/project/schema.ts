import type { CanonicalChannelId } from '../data/channels'
import type { UserProfileDefinition } from '../data/profiles/user'

export const PROJECT_VERSION = 1

/**
 * Projects reference media and telemetry files by path; the decoded data is
 * loaded at runtime and never stored in the project file.
 */
export interface ProjectVideo {
  id: string
  /** All chapter files of one recording, in order. */
  paths: string[]
  name: string
}

export interface ProjectTelemetry {
  id: string
  path: string
  name: string
  profileId: string
  /** Embedded copy of a user mapping so the project opens on other machines. */
  userProfile?: UserProfileDefinition
}

export type SyncMethod = 'camera-imu' | 'image-motion' | 'manual'

export interface ProjectSync {
  id: string
  videoId: string
  telemetryId: string
  /** video time = offsetSeconds + telemetry session time × (1 + drift) */
  offsetSeconds: number
  /** Logger clock rate error (e.g. 46e-6 = 46 ppm); absent means 0. */
  drift?: number
  method: SyncMethod
  /** 0–1, from the sync engine; null for manual. */
  confidence: number | null
}

export interface ProjectSelection {
  telemetryId: string
  /** Lap indices (1-based session positions) to export; empty = whole session. */
  laps: number[]
  leadInSeconds: number
  leadOutSeconds: number
}

/** Fractions of the output frame, so layouts survive resolution changes. */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface WidgetInstance {
  id: string
  type: string
  rect: Rect
  /** Widget input name → canonical channel (or a raw channel key). */
  bindings: Record<string, CanonicalChannelId | string>
  /** Widget input name → display unit id, overriding the channel's default. */
  units?: Record<string, string>
  style: Record<string, unknown>
  hidden?: boolean
  locked?: boolean
}

export interface ExportSettings {
  codec: 'hevc' | 'avc'
  /** Null = automatic from resolution and frame rate. */
  bitrateMbps: number | null
  resolution: 'source' | { width: number; height: number }
  includeAudio: boolean
}

export interface Project {
  version: typeof PROJECT_VERSION
  id: string
  name: string
  createdAt: string
  updatedAt: string
  videos: ProjectVideo[]
  telemetry: ProjectTelemetry[]
  syncs: ProjectSync[]
  selection: ProjectSelection | null
  layout: { widgets: WidgetInstance[] }
  export: ExportSettings
}

export function createProject(name = 'Untitled project', now = new Date()): Project {
  const timestamp = now.toISOString()
  return {
    version: PROJECT_VERSION,
    id: crypto.randomUUID(),
    name,
    createdAt: timestamp,
    updatedAt: timestamp,
    videos: [],
    telemetry: [],
    syncs: [],
    selection: null,
    layout: { widgets: [] },
    export: { codec: 'hevc', bitrateMbps: null, resolution: 'source', includeAudio: true },
  }
}
