import { Film, RefreshCw, SlidersHorizontal, Table2, TriangleAlert, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { CANONICAL_CHANNELS } from '../../core/data/channels'
import { bestLap, formatLapTime, lapAt } from '../../core/laps/laps'
import { openTelemetry, openVideo } from '../actions'
import { formatBytes, formatClock, formatFps } from '../format'
import { player } from '../player'
import { runtimeStore, useActivePair, useProject, useRuntime } from '../state'
import { Disclosure, Field, IconButton, Section } from './ui'

/** Left column: the two source files and the lap list. */
export function MediaPanel() {
  return (
    <aside className="flex min-h-0 flex-col border-r border-line bg-surface">
      <Section title="Media">
        <div className="space-y-2">
          <VideoSource />
          <DataSource />
        </div>
      </Section>
      <Section title="Laps" grow>
        <LapList />
      </Section>
    </aside>
  )
}

function AddSource({ icon: Icon, title, hint, onClick }: { icon: LucideIcon; title: string; hint: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-lg border border-dashed border-line-strong p-3 text-left transition-colors hover:border-fg-subtle hover:bg-raised"
    >
      <span className="grid size-8 place-items-center rounded-md bg-raised text-fg-muted">
        <Icon size={16} aria-hidden />
      </span>
      <span>
        <span className="block font-medium text-fg">{title}</span>
        <span className="block text-xs text-fg-subtle">{hint}</span>
      </span>
    </button>
  )
}

function SourceCard({
  icon: Icon,
  name,
  summary,
  status,
  actions,
  children,
}: {
  icon: LucideIcon
  name: string
  summary: string
  status?: ReactNode
  actions: ReactNode
  children: ReactNode
}) {
  return (
    <div className="rounded-lg border border-line bg-raised p-3">
      <div className="flex items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-canvas text-fg-muted">
          <Icon size={16} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 font-medium break-all text-fg" title={name}>
            {name}
          </p>
          <p className="truncate text-xs text-fg-subtle">{summary}</p>
        </div>
        <div className="-mr-1 -mt-1 flex">{actions}</div>
      </div>
      {status && <div className="mt-2.5 text-xs">{status}</div>}
      <Disclosure label="Details">
        <dl>{children}</dl>
      </Disclosure>
    </div>
  )
}

function StatusLine({ tone, children }: { tone: 'good' | 'warn' | 'muted'; children: ReactNode }) {
  const dot = { good: 'bg-good', warn: 'bg-warn', muted: 'bg-fg-subtle' }[tone]
  return (
    <p className="flex items-center gap-2 text-fg-muted">
      <span className={`size-1.5 shrink-0 rounded-full ${dot}`} aria-hidden />
      {children}
    </p>
  )
}

function VideoSource() {
  const { video } = useActivePair()
  const name = useProject((s) => s.project.videos[0]?.name)
  if (!video || !name) {
    return <AddSource icon={Film} title="Add video" hint="MP4 or MOV from your camera" onClick={() => void openVideo()} />
  }
  const { probe } = video
  const camera = probe.camera?.model ?? probe.camera?.label
  return (
    <SourceCard
      icon={Film}
      name={name}
      summary={`${probe.video.width}×${probe.video.height} · ${formatFps(probe.video.fps)} fps · ${formatClock(probe.duration).replace(/\.\d+$/, '')}`}
      actions={<IconButton icon={RefreshCw} size="sm" label="Replace video" onClick={() => void openVideo()} />}
      status={
        probe.camera?.motionSource ? (
          <StatusLine tone="good">{camera} · motion data for auto-sync</StatusLine>
        ) : (
          <StatusLine tone="muted">{camera ?? 'Unknown camera'} · no motion data</StatusLine>
        )
      }
    >
      <Field label="Codec">{probe.video.codec}</Field>
      <Field label="Audio">{probe.audio?.codec ?? 'None'}</Field>
      <Field label="File size">{formatBytes(probe.fileSize)}</Field>
      <Field label="Frames">{probe.video.frameCount.toLocaleString('en-US')}</Field>
      {probe.camera?.motionSource && <Field label="Motion data">{probe.camera.motionSource}</Field>}
      {probe.creationTime && <Field label="Camera clock">{new Date(probe.creationTime).toLocaleString()}</Field>}
    </SourceCard>
  )
}

function DataSource() {
  const { session, telemetryId } = useActivePair()
  const name = useProject((s) => s.project.telemetry[0]?.name)
  if (!session || !telemetryId || !name) {
    return <AddSource icon={Table2} title="Add data" hint="Logger CSV: AiM, Solostorm, or any time-stamped CSV" onClick={() => void openTelemetry()} />
  }
  const openColumns = () => runtimeStore.setState({ mappingFor: telemetryId })
  const mapped = session.channels.filter((c) => c.canonical)
  return (
    <SourceCard
      icon={Table2}
      name={name}
      summary={`${session.profileLabel} · ${formatClock(session.duration).replace(/\.\d+$/, '')}`}
      actions={
        <>
          <IconButton icon={SlidersHorizontal} size="sm" label="Columns and units" onClick={openColumns} />
          <IconButton icon={RefreshCw} size="sm" label="Replace data" onClick={() => void openTelemetry()} />
        </>
      }
      status={
        session.warnings.length > 0 ? (
          <button type="button" onClick={openColumns} className="flex items-center gap-2 text-warn hover:underline">
            <TriangleAlert size={13} aria-hidden />
            {session.warnings.length} column {session.warnings.length === 1 ? 'needs' : 'need'} checking
          </button>
        ) : undefined
      }
    >
      <Field label="Recognised as">{session.profileLabel}</Field>
      <Field label="Started">
        {session.time.startUtcMs ? new Date(session.time.startUtcMs).toLocaleString() : 'Not in file'}
      </Field>
      <Field label="Channels">
        {mapped.length} recognised of {session.channels.length}
      </Field>
      <div className="mt-1.5 text-xs leading-relaxed text-fg-subtle">
        {mapped.map((c) => CANONICAL_CHANNELS[c.canonical!].label).join(', ')}
      </div>
    </SourceCard>
  )
}

function LapList() {
  const { session, video, offset } = useActivePair()
  const time = useRuntime((s) => s.time)
  if (!session) return <p className="text-xs text-fg-subtle">Laps appear here once data is added.</p>
  if (session.laps.length === 0) {
    return <p className="text-xs text-fg-subtle">This data file has no lap markers.</p>
  }
  const shift = video ? offset : 0
  const best = bestLap(session.laps)
  const current = lapAt(session.laps, time - shift)
  return (
    <ol className="-mx-2 space-y-px">
      {session.laps.map((lap) => {
        const isBest = lap === best
        const gap = best && lap.kind === 'timed' && !isBest ? `+${(lap.duration - best.duration).toFixed(3)}` : ''
        return (
          <li key={lap.index}>
            <button
              type="button"
              title="Jump to the start of this lap"
              onClick={() => player.seek(lap.start + shift)}
              className={`grid w-full grid-cols-[3.5rem_1fr_auto] items-baseline gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-hover ${
                lap === current ? 'bg-raised' : ''
              }`}
            >
              <span className="flex items-center gap-1.5 text-fg-muted">
                {lap === current && <span className="size-1.5 rounded-full bg-accent" aria-label="Current lap" />}
                {lap.kind === 'timed' ? `Lap ${lap.loggerNumber ?? lap.index}` : lap.kind === 'out' ? 'Out' : 'In'}
              </span>
              <span className={`text-right font-mono text-[13px] tabular ${isBest ? 'text-accent' : lap.kind === 'timed' ? 'text-fg' : 'text-fg-subtle'}`}>
                {formatLapTime(lap.duration)}
              </span>
              <span className="w-14 text-right font-mono text-xs tabular text-fg-subtle">{isBest ? 'best' : gap}</span>
            </button>
          </li>
        )
      })}
    </ol>
  )
}
