import { CircleCheck, FolderOpen, LoaderCircle, TriangleAlert, X } from 'lucide-react'
import { estimateRemaining, resolutionChoices } from '../../core/export/plan'
import type { ExportSettings } from '../../core/project/schema'
import { cancelExport, closeExportDialog, exportPlan, revealExport, setExportSettings, setLeadSeconds, startExport, type ExportPlan } from '../exporting'
import { formatBytes, formatDuration, formatFps } from '../format'
import { baseName } from '../host'
import { useProject, useRuntime, type ExportRun } from '../state'
import { Button, inputClass, NumberInput, PropertyRow, Switch } from './ui'

/** Export settings, then progress and the result, in one dialog. */
export function ExportDialog() {
  const open = useRuntime((s) => s.exportOpen)
  const run = useRuntime((s) => s.exportRun)
  // Re-plan whenever the project or loaded media change.
  useProject((s) => s.project)
  useRuntime((s) => s.videos)
  if (!open) return null
  const plan = exportPlan()
  const running = run.status === 'running'

  return (
    <div className="fixed inset-0 z-20 grid place-items-center bg-black/70 p-6" role="dialog" aria-modal="true" aria-labelledby="export-title">
      <div className="flex max-h-full w-full max-w-lg flex-col rounded-xl border border-line bg-surface shadow-2xl">
        <header className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 id="export-title" className="text-base font-semibold text-fg">
            Export video
          </h2>
          {!running && (
            <button type="button" onClick={closeExportDialog} aria-label="Close" className="text-fg-subtle hover:text-fg">
              <X size={16} aria-hidden />
            </button>
          )}
        </header>
        <div className="overflow-y-auto px-5 py-4">
          {!plan ? (
            <p className="text-sm text-fg-muted">Add a video to export.</p>
          ) : run.status === 'running' || run.status === 'done' ? (
            <RunStatus run={run} plan={plan} />
          ) : (
            <Settings plan={plan} run={run} />
          )}
        </div>
        <footer className="flex justify-end gap-2 border-t border-line px-5 py-3">
          {run.status === 'running' ? (
            <Button onClick={cancelExport}>Cancel export</Button>
          ) : run.status === 'done' ? (
            <>
              <Button icon={FolderOpen} onClick={() => revealExport(run.outputPath)}>
                Show in folder
              </Button>
              <Button variant="primary" onClick={closeExportDialog}>
                Done
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={closeExportDialog}>
                Close
              </Button>
              <Button variant="primary" disabled={!plan || plan.duration <= 0} onClick={() => void startExport()}>
                Export…
              </Button>
            </>
          )}
        </footer>
      </div>
    </div>
  )
}

const CODECS: Array<[ExportSettings['codec'], string]> = [
  ['hevc', 'HEVC (smaller and faster)'],
  ['avc', 'H.264 (plays everywhere)'],
]

function Settings({ plan, run }: { plan: ExportPlan; run: ExportRun }) {
  const selection = useProject((s) => s.project.selection)
  const { settings, source } = plan
  const sizes = [{ ...source, label: `Source (${source.width}×${source.height})`, value: 'source' }].concat(
    resolutionChoices(source).map((size) => ({ ...size, fps: source.fps, label: `${size.width}×${size.height}`, value: `${size.width}x${size.height}` })),
  )
  const sizeValue = settings.resolution === 'source' ? 'source' : `${settings.resolution.width}x${settings.resolution.height}`
  const estimate = (plan.bitrate * plan.duration) / 8

  return (
    <div className="space-y-5">
      {run.status === 'error' && (
        <p className="flex gap-2 rounded-md border border-danger/40 bg-raised p-3 text-[13px] text-fg">
          <TriangleAlert size={15} className="mt-px shrink-0 text-danger" aria-hidden />
          {run.message}
        </p>
      )}
      {run.status === 'cancelled' && <p className="text-[13px] text-fg-muted">Export cancelled. The unfinished file was deleted.</p>}

      <section>
        <h3 className="mb-2 text-xs font-semibold text-fg-muted">Range</h3>
        <p className="text-[13px] text-fg">
          {plan.lapCount > 0
            ? `${plan.lapCount === 1 ? '1 lap' : `${plan.lapCount} laps`}${plan.segments.length > 1 ? `, as ${plan.segments.length} clips joined together` : ''}`
            : 'Whole video'}
          <span className="ml-2 text-fg-subtle">{formatDuration(plan.duration)}</span>
        </p>
        <p className="mt-1 text-xs text-fg-subtle">
          {plan.lapCount > 0 ? 'Change which laps in the Laps list.' : 'Tick laps in the Laps list to export just those.'}
        </p>
        {plan.lapCount > 0 && selection && (
          <div className="mt-3 grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-[11px] text-fg-subtle">Seconds before each lap</span>
              <NumberInput value={selection.leadInSeconds} min={0} max={60} step={0.5} onCommit={(v) => setLeadSeconds(v, selection.leadOutSeconds)} />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] text-fg-subtle">Seconds after each lap</span>
              <NumberInput value={selection.leadOutSeconds} min={0} max={60} step={0.5} onCommit={(v) => setLeadSeconds(selection.leadInSeconds, v)} />
            </label>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="mb-2 text-xs font-semibold text-fg-muted">Video</h3>
        <PropertyRow label="Format" htmlFor="export-codec">
          <select
            id="export-codec"
            className={inputClass}
            value={settings.codec}
            onChange={(event) => setExportSettings({ codec: event.target.value as ExportSettings['codec'] })}
          >
            {CODECS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </PropertyRow>
        <PropertyRow label="Size" htmlFor="export-size">
          <select
            id="export-size"
            className={inputClass}
            value={sizeValue}
            onChange={(event) => {
              const choice = sizes.find((size) => size.value === event.target.value)!
              setExportSettings({ resolution: choice.value === 'source' ? 'source' : { width: choice.width, height: choice.height } })
            }}
          >
            {sizes.map((size) => (
              <option key={size.value} value={size.value}>
                {size.label}
              </option>
            ))}
          </select>
        </PropertyRow>
        <PropertyRow label="Bitrate" htmlFor="export-bitrate">
          <div className="flex items-center gap-2">
            <select
              id="export-bitrate"
              className={inputClass}
              value={settings.bitrateMbps === null ? 'auto' : 'custom'}
              onChange={(event) =>
                setExportSettings({ bitrateMbps: event.target.value === 'auto' ? null : Math.round(plan.autoBitrate / 1e6) })
              }
            >
              <option value="auto">Automatic ({(plan.autoBitrate / 1e6).toFixed(1)} Mb/s)</option>
              <option value="custom">Custom</option>
            </select>
            {settings.bitrateMbps !== null && (
              <div className="flex w-28 shrink-0 items-center gap-1.5">
                <NumberInput value={settings.bitrateMbps} min={2} max={200} step={1} onCommit={(v) => setExportSettings({ bitrateMbps: v })} />
                <span className="text-xs text-fg-subtle">Mb/s</span>
              </div>
            )}
          </div>
        </PropertyRow>
        <PropertyRow label="Audio" htmlFor="export-audio">
          <div className="flex items-center gap-2">
            <Switch id="export-audio" checked={settings.includeAudio} onChange={(includeAudio) => setExportSettings({ includeAudio })} />
            <span className="text-xs text-fg-subtle">Copy the camera's sound</span>
          </div>
        </PropertyRow>
        <p className="pt-1 text-xs text-fg-subtle">
          {plan.size.width}×{plan.size.height} at {formatFps(source.fps)} fps · about {formatBytes(estimate)}
        </p>
      </section>
    </div>
  )
}

function RunStatus({ run, plan }: { run: Extract<ExportRun, { status: 'running' | 'done' }>; plan: ExportPlan }) {
  if (run.status === 'done') {
    const { stats } = run
    return (
      <div className="space-y-3">
        <p className="flex items-center gap-2 text-[13px] text-fg">
          <CircleCheck size={16} className="text-good" aria-hidden />
          Saved {baseName(run.outputPath)}
        </p>
        <p className="text-xs leading-relaxed text-fg-subtle">
          {formatDuration(stats.duration)} of video in {formatDuration(stats.elapsedSeconds)} ({(stats.duration / stats.elapsedSeconds).toFixed(1)}× real
          time) · {stats.codec === 'hevc' ? 'HEVC' : 'H.264'} · {formatBytes(stats.bytes)}
          {stats.audio ? ' · with audio' : ''}
          <br />
          {run.outputPath}
        </p>
        {stats.warnings.map((warning) => (
          <p key={warning} className="flex gap-2 text-xs leading-relaxed text-warn">
            <TriangleAlert size={13} className="mt-px shrink-0" aria-hidden />
            {warning}
          </p>
        ))}
      </div>
    )
  }
  const progress = run.progress
  const fraction = progress ? Math.min(1, progress.framesDone / progress.framesTotal) : 0
  const fps = progress && progress.elapsedSeconds > 0 ? progress.framesDone / progress.elapsedSeconds : 0
  const remaining = progress ? estimateRemaining(progress.framesDone, progress.framesTotal, progress.elapsedSeconds) : null
  return (
    <div className="space-y-3">
      <p className="flex items-center gap-2 text-[13px] text-fg">
        <LoaderCircle size={15} className="animate-spin text-fg-muted" aria-hidden />
        Exporting {baseName(run.outputPath)}
      </p>
      <div className="h-1.5 overflow-hidden rounded-full bg-raised" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
        <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${fraction * 100}%` }} />
      </div>
      <p className="flex justify-between font-mono text-xs tabular text-fg-subtle">
        <span>
          {Math.round(fraction * 100)}% · {fps ? `${Math.round(fps)} fps · ${(fps / plan.source.fps).toFixed(1)}× real time` : 'starting…'}
        </span>
        <span>{remaining !== null ? `${formatDuration(remaining)} left` : ''}</span>
      </p>
    </div>
  )
}
