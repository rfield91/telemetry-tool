import { autoBitrate, exportSegments, outputSize, totalDuration } from '../core/export/plan'
import type { ExportSettings } from '../core/project/schema'
import { baseName, host } from './host'
import { ExportCancelledError, runExportWorker } from './export/client'
import { projectStore, runtimeStore, timeMap } from './state'

/** Export: the plan shown in the dialog, and running it. */

const update = projectStore.getState().update

export interface ExportPlan {
  videoPath: string
  segments: ReturnType<typeof exportSegments>
  duration: number
  size: { width: number; height: number }
  source: { width: number; height: number; fps: number }
  bitrate: number
  autoBitrate: number
  settings: ExportSettings
  lapCount: number
}

/** What an export would produce with the current project, or null without a video. */
export function exportPlan(): ExportPlan | null {
  const { project } = projectStore.getState()
  const runtime = runtimeStore.getState()
  const videoEntry = project.videos[0]
  const video = videoEntry && runtime.videos[videoEntry.id]
  if (!videoEntry || !video) return null
  const telemetryId = project.telemetry[0]?.id
  const session = telemetryId ? runtime.sessions[telemetryId] : undefined
  const sync = project.syncs.find((s) => s.videoId === videoEntry.id && s.telemetryId === telemetryId)
  const map = timeMap(sync?.offsetSeconds ?? 0, sync?.drift ?? 0, true)
  const selection = project.selection?.telemetryId === telemetryId ? project.selection : null
  const segments = exportSegments(session?.laps ?? [], selection, map.toVideo, video.probe.duration)
  const source = { width: video.probe.video.width, height: video.probe.video.height, fps: video.probe.video.fps }
  const settings = project.export
  const size = outputSize(source, settings.resolution)
  const auto = autoBitrate(size.width, size.height, source.fps, settings.codec)
  return {
    videoPath: video.path,
    segments,
    duration: totalDuration(segments),
    size,
    source,
    bitrate: settings.bitrateMbps ? settings.bitrateMbps * 1e6 : auto,
    autoBitrate: auto,
    settings,
    lapCount: selection && session ? session.laps.filter((lap) => selection.laps.includes(lap.index)).length : 0,
  }
}

export function openExportDialog() {
  const { exportRun } = runtimeStore.getState()
  runtimeStore.setState({ exportOpen: true, ...(exportRun.status === 'running' ? {} : { exportRun: { status: 'idle' } }) })
}

export function closeExportDialog() {
  if (runtimeStore.getState().exportRun.status !== 'running') runtimeStore.setState({ exportOpen: false })
}

export function setExportSettings(patch: Partial<ExportSettings>) {
  update('Change export settings', (draft) => {
    Object.assign(draft.export, patch)
  })
}

export function setLeadSeconds(leadInSeconds: number, leadOutSeconds: number) {
  const telemetryId = projectStore.getState().project.telemetry[0]?.id
  if (!telemetryId) return
  update(
    'Change lead-in/out',
    (draft) => {
      if (!draft.selection || draft.selection.telemetryId !== telemetryId) {
        draft.selection = { telemetryId, laps: [], leadInSeconds: 2, leadOutSeconds: 2 }
      }
      draft.selection.leadInSeconds = Math.max(0, leadInSeconds)
      draft.selection.leadOutSeconds = Math.max(0, leadOutSeconds)
    },
    { coalesceKey: 'lead' },
  )
}

/** `<video folder>\<video name>-overlay.mp4` */
export function defaultOutputPath(videoPath: string): string {
  const name = baseName(videoPath).replace(/\.[^.]+$/, '')
  const folder = videoPath.slice(0, videoPath.length - baseName(videoPath).length)
  return `${folder}${name}-overlay.mp4`
}

let controller: AbortController | null = null

/** Ask where to save, then export. `outputPath` skips the dialog (dev harness tests). */
export async function startExport(outputPath?: string) {
  const plan = exportPlan()
  if (!plan || runtimeStore.getState().exportRun.status === 'running') return
  if (plan.segments.length === 0) {
    runtimeStore.setState({ exportRun: { status: 'error', message: 'There is nothing to export.' } })
    return
  }
  let path = outputPath ?? null
  if (!path) {
    try {
      path = await host.pickSavePath(defaultOutputPath(plan.videoPath))
    } catch (error) {
      runtimeStore.setState({ exportRun: { status: 'error', message: error instanceof Error ? error.message : String(error) } })
      return
    }
  }
  if (!path) return
  if (path.toLowerCase() === plan.videoPath.toLowerCase()) {
    runtimeStore.setState({ exportRun: { status: 'error', message: 'Choose a different file name; this would overwrite the source video.' } })
    return
  }

  const { project } = projectStore.getState()
  const runtime = runtimeStore.getState()
  const telemetryId = project.telemetry[0]?.id
  const sync = project.syncs.find((s) => s.videoId === project.videos[0]?.id && s.telemetryId === telemetryId)
  controller = new AbortController()
  const outputPathFinal = path
  runtimeStore.setState({ exportRun: { status: 'running', outputPath: outputPathFinal, progress: null } })
  try {
    const stats = await runExportWorker(
      plan.videoPath,
      outputPathFinal,
      {
        segments: plan.segments,
        size: plan.size,
        codec: plan.settings.codec,
        bitrate: plan.bitrate,
        includeAudio: plan.settings.includeAudio,
        widgets: project.layout.widgets,
        session: (telemetryId && runtime.sessions[telemetryId]) || null,
        sync: { offset: sync?.offsetSeconds ?? 0, drift: sync?.drift ?? 0 },
      },
      (progress) => runtimeStore.setState({ exportRun: { status: 'running', outputPath: outputPathFinal, progress } }),
      controller.signal,
    )
    runtimeStore.setState({ exportRun: { status: 'done', outputPath: outputPathFinal, stats } })
  } catch (error) {
    runtimeStore.setState({
      exportRun:
        error instanceof ExportCancelledError
          ? { status: 'cancelled' }
          : { status: 'error', message: error instanceof Error ? error.message : String(error) },
    })
  } finally {
    controller = null
  }
}

export function cancelExport() {
  controller?.abort()
}

export function revealExport(path: string) {
  void host.revealFile(path)
}
