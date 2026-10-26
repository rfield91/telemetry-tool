import { useMemo } from 'react'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { TelemetrySession } from '../core/data/import'
import { ProfileRegistry } from '../core/data/profiles/registry'
import type { VideoProbe } from '../core/media/probe'
import { createProjectStore, type ProjectState } from '../core/project/store'
import type { Series } from '../core/data/series'
import type { LayoutTemplate } from '../core/layout/templates'
import type { SyncRunOutput } from './sync/protocol'

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
  /** Latest auto-sync run for the active video/data pair. */
  syncRun: SyncRun
  /** Selected widget ids, in selection order. */
  selection: string[]
  /** Saved layout templates. */
  templates: LayoutTemplate[]
  inspectorTab: 'sync' | 'layout'
}

export type SyncRun =
  | { status: 'idle' }
  | { status: 'running'; label: string }
  | { status: 'error'; message: string }
  | {
      status: 'done'
      output: SyncRunOutput
      /** Logger signal used (for the comparison plot) and where it came from. */
      logger: Series
      loggerSource: string
      gpsDerived: boolean
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
  syncRun: { status: 'idle' },
  selection: [],
  templates: [],
  inspectorTab: 'sync',
}))

export function useRuntime<T>(selector: (state: RuntimeState) => T): T {
  return useStore(runtimeStore, selector)
}

/**
 * Video ↔ data time for a sync: video = offset + data × (1 + drift).
 * Without a video, data time is the playback time.
 */
export interface TimeMap {
  offset: number
  drift: number
  toData(videoTime: number): number
  toVideo(dataTime: number): number
}

export function timeMap(offset: number, drift: number, hasVideo: boolean): TimeMap {
  if (!hasVideo) return { offset: 0, drift: 0, toData: (t) => t, toVideo: (t) => t }
  return {
    offset,
    drift,
    toData: (videoTime) => (videoTime - offset) / (1 + drift),
    toVideo: (dataTime) => offset + dataTime * (1 + drift),
  }
}

/** Selected widgets that still exist (undo can remove them). */
export function useSelectedWidgets() {
  const selection = useRuntime((s) => s.selection)
  const widgets = useProject((s) => s.project.layout.widgets)
  return useMemo(() => widgets.filter((w) => selection.includes(w.id)), [widgets, selection])
}

/** The single video/telemetry pair the preview works with. */
export function useActivePair() {
  const videoId = useProject((s) => s.project.videos[0]?.id ?? null)
  const telemetryId = useProject((s) => s.project.telemetry[0]?.id ?? null)
  const video = useRuntime((s) => (videoId ? s.videos[videoId] : undefined))
  const session = useRuntime((s) => (telemetryId ? s.sessions[telemetryId] : undefined))
  const sync = useProject((s) => s.project.syncs.find((entry) => entry.videoId === videoId && entry.telemetryId === telemetryId))
  const offset = sync?.offsetSeconds ?? 0
  const drift = sync?.drift ?? 0
  const time = useMemo(() => timeMap(offset, drift, !!video), [offset, drift, video])
  return { videoId, telemetryId, video, session, offset, drift, time }
}
