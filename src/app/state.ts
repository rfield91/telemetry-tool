import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { TelemetrySession } from '../core/data/import'
import { ProfileRegistry } from '../core/data/profiles/registry'
import type { VideoProbe } from '../core/media/probe'
import { createProjectStore, type ProjectState } from '../core/project/store'

/** The undoable project document (files, sync offset, layout). */
export const projectStore = createProjectStore()

export function useProject<T>(selector: (state: ProjectState) => T): T {
  return useStore(projectStore, selector)
}

export interface LoadedVideo {
  path: string
  url: string
  probe: VideoProbe
}

export interface RuntimeState {
  /** Decoded data for project entries, keyed by project id. Never saved. */
  videos: Record<string, LoadedVideo>
  sessions: Record<string, TelemetrySession>
  registry: ProfileRegistry
  /** Raw CSV text kept so a mapping change can re-import without re-reading. */
  csvText: Record<string, string>
  busy: string | null
  error: string | null
  /** Telemetry id whose mapping dialog is open. */
  mappingFor: string | null
  /** Current video time in seconds (throttled copy for the UI). */
  time: number
  playing: boolean
  /** Performance readout on the viewer. */
  showStats: boolean
}

export const runtimeStore = createStore<RuntimeState>()(() => ({
  videos: {},
  sessions: {},
  registry: new ProfileRegistry(),
  csvText: {},
  busy: null,
  error: null,
  mappingFor: null,
  time: 0,
  playing: false,
  showStats: false,
}))

export function useRuntime<T>(selector: (state: RuntimeState) => T): T {
  return useStore(runtimeStore, selector)
}

/** The single video/telemetry pair the M1 preview works with. */
export function useActivePair() {
  const videoId = useProject((s) => s.project.videos[0]?.id ?? null)
  const telemetryId = useProject((s) => s.project.telemetry[0]?.id ?? null)
  const video = useRuntime((s) => (videoId ? s.videos[videoId] : undefined))
  const session = useRuntime((s) => (telemetryId ? s.sessions[telemetryId] : undefined))
  const offset = useProject(
    (s) => s.project.syncs.find((sync) => sync.videoId === videoId && sync.telemetryId === telemetryId)?.offsetSeconds ?? 0,
  )
  return { videoId, telemetryId, video, session, offset }
}
