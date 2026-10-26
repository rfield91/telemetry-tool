import { importTelemetry } from '../core/data/import'
import type { UserProfileDefinition } from '../core/data/profiles/user'
import { probeVideo } from '../core/media/probe'
import { createDefaultLayout } from '../core/widgets/defaults'
import { baseName, host } from './host'
import type { ProjectState } from '../core/project/store'
import { projectStore, runtimeStore } from './state'

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

function frameAspect(): number {
  const { project } = projectStore.getState()
  const video = project.videos[0] && runtimeStore.getState().videos[project.videos[0].id]
  return video ? video.probe.video.width / video.probe.video.height : 16 / 9
}

function ensureSync(videoId: string | undefined, telemetryId: string | undefined) {
  if (!videoId || !telemetryId) return
  update('Link video and telemetry', (draft) => {
    if (draft.syncs.some((s) => s.videoId === videoId && s.telemetryId === telemetryId)) return
    draft.syncs = [{ id: crypto.randomUUID(), videoId, telemetryId, offsetSeconds: 0, method: 'manual', confidence: null }]
  })
}

export async function openVideo(path?: string) {
  const picked = path ?? (await host.pickFile('video'))
  if (!picked) return
  await withBusy('Reading video…', async () => {
    const file = await host.openRandomAccess(picked)
    const { probe } = await probeVideo(file)
    const id = crypto.randomUUID()
    runtimeStore.setState((s) => ({
      videos: { ...s.videos, [id]: { path: picked, url: host.mediaUrl(picked), probe } },
      time: 0,
      playing: false,
    }))
    update('Open video', (draft) => {
      draft.videos = [{ id, name: baseName(picked), paths: [picked] }]
    })
    ensureSync(id, projectStore.getState().project.telemetry[0]?.id)
  })
}

export async function openTelemetry(path?: string) {
  const picked = path ?? (await host.pickFile('csv'))
  if (!picked) return
  await withBusy('Importing telemetry…', async () => {
    const text = await host.readText(picked)
    const session = importTelemetry(text, baseName(picked), runtimeStore.getState().registry)
    const id = crypto.randomUUID()
    runtimeStore.setState((s) => ({
      sessions: { ...s.sessions, [id]: session },
      csvText: { ...s.csvText, [id]: text },
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

/** Route dropped files: videos to the video slot, CSVs to telemetry. */
export async function openDroppedFiles(files: File[]) {
  for (const file of files) {
    const isVideo = VIDEO_EXTENSIONS.test(file.name)
    const isCsv = /\.csv$/i.test(file.name)
    if (!isVideo && !isCsv) {
      runtimeStore.setState({ error: `${file.name} isn't a video (MP4/MOV) or CSV file.` })
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

export function resetLayout() {
  const { project } = projectStore.getState()
  const session = project.telemetry[0] && runtimeStore.getState().sessions[project.telemetry[0].id]
  if (!session) return
  const layout = createDefaultLayout(session, frameAspect())
  update('Reset layout', (draft) => {
    draft.layout.widgets = layout
  })
}

export function toggleWidget(id: string) {
  update('Toggle widget', (draft) => {
    const widget = draft.layout.widgets.find((w) => w.id === id)
    if (widget) widget.hidden = !widget.hidden
  })
}
