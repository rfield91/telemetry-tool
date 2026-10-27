import { importTelemetry, importXrk, type TelemetrySession } from '../core/data/import'
import { inflateXrz } from '../core/data/xrk'
import type { UserProfileDefinition } from '../core/data/profiles/user'
import { probeVideo } from '../core/media/probe'
import type { ProjectState } from '../core/project/store'
import type { SyncConfidence } from '../core/sync/engine'
import { loggerYaw } from '../core/sync/yaw'
import { createDefaultLayout } from '../core/widgets/defaults'
import { baseName, host } from './host'
import { projectStore, runtimeStore } from './state'
import { runSyncWorker } from './sync/client'

const update: ProjectState['update'] = (...args) => projectStore.getState().update(...args)

async function withBusy<T>(label: string, task: () => Promise<T>): Promise<T | undefined> {
  runtimeStore.setState({ busy: label, error: null })
  try {
    return await task()
  } catch (error) {
    runtimeStore.setState({ error: error instanceof Error ? error.message : String(error) })
    return undefined
  } finally {
    runtimeStore.setState({ busy: null })
  }
}

/** File dialog; failures (e.g. no dialog in this host) become a visible error. */
async function pickFile(kind: 'video' | 'csv'): Promise<string | null> {
  try {
    return await host.pickFile(kind)
  } catch (error) {
    runtimeStore.setState({ error: error instanceof Error ? error.message : String(error) })
    return null
  }
}

export async function loadUserProfiles() {
  const registry = runtimeStore.getState().registry
  for (const definition of await host.loadProfiles()) {
    try {
      registry.addUserProfile(definition)
    } catch {
      // Skip profiles that clash with built-in ids.
    }
  }
}

/** Output frame size: the video's, or 1920×1080 before one is loaded. */
export function frameSize(): { width: number; height: number } {
  const { project } = projectStore.getState()
  const video = project.videos[0] && runtimeStore.getState().videos[project.videos[0].id]
  return video ? { width: video.probe.video.width, height: video.probe.video.height } : { width: 1920, height: 1080 }
}

export function frameAspect(): number {
  const { width, height } = frameSize()
  return width / height
}

function ensureSync(videoId: string | undefined, telemetryId: string | undefined) {
  if (!videoId || !telemetryId) return
  update('Link video and telemetry', (draft) => {
    if (draft.syncs.some((s) => s.videoId === videoId && s.telemetryId === telemetryId)) return
    draft.syncs = [{ id: crypto.randomUUID(), videoId, telemetryId, offsetSeconds: 0, drift: 0, method: 'manual', confidence: null }]
  })
}

export async function openVideo(path?: string) {
  const picked = path ?? (await pickFile('video'))
  if (!picked) return
  await withBusy('Reading video…', async () => {
    const file = await host.openRandomAccess(picked)
    const { probe } = await probeVideo(file)
    const id = crypto.randomUUID()
    runtimeStore.setState((s) => ({
      videos: { ...s.videos, [id]: { path: picked, url: host.mediaUrl(picked), probe } },
      time: 0,
      playing: false,
      syncRun: { status: 'idle' },
    }))
    update('Open video', (draft) => {
      draft.videos = [{ id, name: baseName(picked), paths: [picked] }]
    })
    ensureSync(id, projectStore.getState().project.telemetry[0]?.id)
  })
  void maybeAutoSync()
}

export async function openTelemetry(path?: string) {
  const picked = path ?? (await pickFile('csv'))
  if (!picked) return
  await withBusy('Importing telemetry…', async () => {
    let session: TelemetrySession
    let text: string | null = null
    if (XRK_EXTENSIONS.test(picked)) {
      const file = await host.openRandomAccess(picked)
      const [bytes] = await file.readRanges([{ offset: 0, length: file.size }])
      session = importXrk(await inflateXrz(bytes!), baseName(picked))
    } else {
      text = await host.readText(picked)
      session = importTelemetry(text, baseName(picked), runtimeStore.getState().registry)
    }
    const id = crypto.randomUUID()
    runtimeStore.setState((s) => ({
      sessions: { ...s.sessions, [id]: session },
      // Only CSVs have a column mapping to revisit.
      csvText: text === null ? s.csvText : { ...s.csvText, [id]: text },
      syncRun: { status: 'idle' },
      // Unknown loggers go straight to the mapping screen.
      mappingFor: session.profileId === 'generic' ? id : s.mappingFor,
    }))
    const layout = createDefaultLayout(session, frameAspect())
    update('Open telemetry', (draft) => {
      draft.telemetry = [{ id, name: baseName(picked), path: picked, profileId: session.profileId }]
      if (draft.layout.widgets.length === 0) draft.layout.widgets = layout
    })
    ensureSync(projectStore.getState().project.videos[0]?.id, id)
  })
  void maybeAutoSync()
}

/** The sync entry linking the active video and data, if both are loaded. */
function activeSync() {
  const { project } = projectStore.getState()
  const videoId = project.videos[0]?.id
  const telemetryId = project.telemetry[0]?.id
  const sync = project.syncs.find((s) => s.videoId === videoId && s.telemetryId === telemetryId)
  const runtime = runtimeStore.getState()
  const video = videoId ? runtime.videos[videoId] : undefined
  const session = telemetryId ? runtime.sessions[telemetryId] : undefined
  return sync && video && session ? { sync, video, session } : null
}

const CONFIDENCE_SCORE: Record<SyncConfidence, number> = { high: 0.95, medium: 0.7, low: 0.4 }

/** Run auto-sync once for a fresh pair (never over an offset the user set). */
async function maybeAutoSync() {
  const active = activeSync()
  if (active?.video.probe.camera?.motionSource && active.sync.method === 'manual' && active.sync.offsetSeconds === 0) {
    await autoSync()
  }
}

export async function autoSync() {
  const active = activeSync()
  if (!active) return
  const yaw = loggerYaw(active.session)
  if (!yaw) {
    runtimeStore.setState({
      syncRun: { status: 'error', message: 'This data has no yaw rate, heading or GPS position to sync with.' },
    })
    return
  }
  const startedFrom = { id: active.sync.id, offset: active.sync.offsetSeconds, method: active.sync.method }
  runtimeStore.setState({ syncRun: { status: 'running', label: 'Starting…' } })
  try {
    const output = await runSyncWorker(active.video.path, yaw.signal, (label) =>
      runtimeStore.setState({ syncRun: { status: 'running', label } }),
    )
    if (!output.sync) throw new Error("Couldn't find where this data matches the video.")
    const result = output.sync
    runtimeStore.setState({
      syncRun: {
        status: 'done',
        output,
        logger: { times: Float64Array.from(yaw.signal.times), values: Float64Array.from(yaw.signal.values) },
        loggerSource: yaw.source,
        gpsDerived: yaw.gpsDerived,
      },
    })
    // Apply unless the user changed the offset while this was running.
    const current = projectStore.getState().project.syncs.find((s) => s.id === startedFrom.id)
    if (current && current.offsetSeconds === startedFrom.offset && current.method === startedFrom.method) {
      update('Auto-sync', (draft) => {
        const sync = draft.syncs.find((s) => s.id === startedFrom.id)
        if (!sync) return
        sync.offsetSeconds = Math.round(result.offset * 1000) / 1000
        sync.drift = result.drift
        sync.method = 'camera-imu'
        sync.confidence = CONFIDENCE_SCORE[result.confidence]
      })
    }
  } catch (error) {
    runtimeStore.setState({ syncRun: { status: 'error', message: error instanceof Error ? error.message : String(error) } })
  }
}

/** Use one of auto-sync's other matches (e.g. a different lap). */
export function chooseSyncMatch(offset: number, drift = 0) {
  const active = activeSync()
  if (!active) return
  update('Choose sync match', (draft) => {
    const sync = draft.syncs.find((s) => s.id === active.sync.id)
    if (!sync) return
    sync.offsetSeconds = Math.round(offset * 1000) / 1000
    sync.drift = drift
    sync.method = 'camera-imu'
    // The user picked it, so the engine's confidence no longer applies.
    sync.confidence = null
  })
}

/** Save a confirmed mapping as a user profile and re-import with it. */
export async function applyMapping(telemetryId: string, definition: UserProfileDefinition) {
  const { registry, csvText } = runtimeStore.getState()
  const text = csvText[telemetryId]
  const entry = projectStore.getState().project.telemetry.find((t) => t.id === telemetryId)
  if (!text || !entry) return
  registry.removeUserProfile(definition.id)
  registry.addUserProfile(definition)
  await host.saveProfiles(registry.userProfileDefinitions())
  const session = importTelemetry(text, entry.name, registry, { profileId: definition.id })
  runtimeStore.setState((s) => ({ sessions: { ...s.sessions, [telemetryId]: session }, mappingFor: null }))
  update('Apply column mapping', (draft) => {
    const telemetry = draft.telemetry.find((t) => t.id === telemetryId)
    if (telemetry) {
      telemetry.profileId = definition.id
      telemetry.userProfile = definition
    }
  })
}

const VIDEO_EXTENSIONS = /\.(mp4|mov|m4v)$/i
const XRK_EXTENSIONS = /\.(xrk|xrz)$/i

/** Route dropped files: videos to the video slot, CSV/XRK logger files to telemetry. */
export async function openDroppedFiles(files: File[]) {
  for (const file of files) {
    const isVideo = VIDEO_EXTENSIONS.test(file.name)
    const isData = /\.csv$/i.test(file.name) || XRK_EXTENSIONS.test(file.name)
    if (!isVideo && !isData) {
      runtimeStore.setState({ error: `${file.name} isn't a video (MP4/MOV) or logger file (CSV/XRK).` })
      continue
    }
    const path = await host.pathForDroppedFile(file)
    if (!path) {
      runtimeStore.setState({ error: 'Drag and drop needs the desktop app. Use the Add buttons instead.' })
      return
    }
    if (isVideo) await openVideo(path)
    else await openTelemetry(path)
  }
}

export function dismissError() {
  runtimeStore.setState({ error: null })
}

export function setOffset(seconds: number) {
  const { project } = projectStore.getState()
  const videoId = project.videos[0]?.id
  const telemetryId = project.telemetry[0]?.id
  if (!videoId || !telemetryId || !Number.isFinite(seconds)) return
  update(
    'Change sync offset',
    (draft) => {
      const sync = draft.syncs.find((s) => s.videoId === videoId && s.telemetryId === telemetryId)
      if (sync) {
        sync.offsetSeconds = Math.round(seconds * 1000) / 1000
        sync.method = 'manual'
        sync.confidence = null
      }
    },
    { coalesceKey: 'offset' },
  )
}

/** Add or remove a lap from the export selection (none selected = whole session). */
export function toggleLapSelection(lapIndex: number) {
  const telemetryId = projectStore.getState().project.telemetry[0]?.id
  if (!telemetryId) return
  update('Select laps', (draft) => {
    if (!draft.selection || draft.selection.telemetryId !== telemetryId) {
      draft.selection = { telemetryId, laps: [], leadInSeconds: 2, leadOutSeconds: 2 }
    }
    const laps = draft.selection.laps
    const at = laps.indexOf(lapIndex)
    if (at >= 0) laps.splice(at, 1)
    else laps.push(lapIndex)
    laps.sort((a, b) => a - b)
  })
}
