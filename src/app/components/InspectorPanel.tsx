import {
  ChartColumn,
  CircleCheck,
  CircleDashed,
  Crosshair,
  Eye,
  EyeOff,
  Gauge,
  Hash,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Route,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { CANONICAL_CHANNELS, isCanonicalChannelId } from '../../core/data/channels'
import type { WidgetInstance } from '../../core/project/schema'
import { WIDGETS } from '../../core/widgets/registry'
import { autoSync, chooseSyncMatch, resetLayout, setOffset, toggleWidget } from '../actions'
import { formatClock } from '../format'
import { useActivePair, useProject, useRuntime } from '../state'
import { SyncPlot } from './SyncPlot'
import { Button, Disclosure, inputClass, Section } from './ui'

const WIDGET_ICONS: Record<string, LucideIcon> = {
  gauge: Gauge,
  bar: ChartColumn,
  readout: Hash,
  trackMap: Route,
  gMeter: Crosshair,
}

/** Right column: sync offset and the overlay's layers. */
export function InspectorPanel() {
  return (
    <aside className="flex min-h-0 flex-col border-l border-line bg-surface">
      <SyncSection />
      <OverlaySection />
    </aside>
  )
}

function SyncSection() {
  const { video, session, offset, time: map } = useActivePair()
  const method = useProject((s) => s.project.syncs[0]?.method ?? 'manual')
  const run = useRuntime((s) => s.syncRun)
  const time = useRuntime((s) => s.time)
  const [draft, setDraft] = useState(offset.toFixed(3))
  useEffect(() => setDraft(offset.toFixed(3)), [offset])

  if (!video || !session) {
    return (
      <Section title="Sync">
        <p className="text-xs leading-relaxed text-fg-subtle">Add a video and a data file to line them up.</p>
      </Section>
    )
  }

  const canAutoSync = !!video.probe.camera?.motionSource
  const frame = 1 / video.probe.video.fps
  const commit = () => {
    const value = Number(draft)
    if (Number.isFinite(value)) setOffset(value)
    else setDraft(offset.toFixed(3))
  }
  const nudges: Array<[string, string, number]> = [
    ['−1s', 'Data 1 second earlier', -1],
    ['−1f', 'Data 1 frame earlier', -frame],
    ['+1f', 'Data 1 frame later', frame],
    ['+1s', 'Data 1 second later', 1],
  ]
  const result = run.status === 'done' ? run.output.sync : null

  return (
    <Section
      title="Sync"
      action={
        canAutoSync && (
          <Button variant="ghost" icon={RefreshCw} disabled={run.status === 'running'} title="Find the offset from camera motion" onClick={() => void autoSync()}>
            Auto-sync
          </Button>
        )
      }
    >
      <SyncStatus canAutoSync={canAutoSync} manual={method === 'manual'} />

      <p className="mt-3 mb-3 text-xs leading-relaxed text-fg-muted">
        Data starts at <span className="font-mono tabular text-fg">{formatClock(offset)}</span> in the video.
      </p>
      <label className="mb-1 block text-xs text-fg-subtle" htmlFor="sync-offset">
        Offset (seconds)
      </label>
      <input
        id="sync-offset"
        className={`${inputClass} font-mono tabular`}
        value={draft}
        inputMode="decimal"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit()
        }}
      />
      <div className="mt-2 grid grid-cols-4 overflow-hidden rounded-md border border-line" role="group" aria-label="Nudge offset">
        {nudges.map(([text, title, delta]) => (
          <button
            key={text}
            type="button"
            title={title}
            onClick={() => setOffset(offset + delta)}
            className="h-7 border-l border-line font-mono text-xs text-fg-muted transition-colors first:border-l-0 hover:bg-hover hover:text-fg"
          >
            {text}
          </button>
        ))}
      </div>

      {run.status === 'done' && result && (
        <>
          <SyncPlot
            logger={run.logger}
            camera={{ times: run.output.camera.times, values: run.output.camera.yawRate }}
            toData={map.toData}
            videoTime={time}
            sign={Math.sign(result.correlation) || 1}
          />
          {result.candidates.length > 1 && (
            <Disclosure label={`Other matches (${result.candidates.length - 1})`}>
              <ul className="-mx-2 space-y-px">
                {result.candidates.map((candidate) => {
                  const isCurrent = Math.abs(candidate.offset - offset) < 0.0015
                  return (
                    <li key={candidate.offset} className="flex items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-hover">
                      <span className="font-mono tabular text-fg">{formatClock(candidate.offset)}</span>
                      <span className="flex-1 text-fg-subtle">
                        match {Math.abs(candidate.correlation).toFixed(2)}
                        {candidate.halfDrift !== null && ` · drift ${Math.abs(candidate.halfDrift).toFixed(2)} s`}
                      </span>
                      {isCurrent ? (
                        <span className="text-fg-subtle">in use</span>
                      ) : (
                        <button
                          type="button"
                          className="text-fg-muted hover:text-fg"
                          onClick={() => chooseSyncMatch(candidate.offset, candidate === result.candidates[0] ? result.drift : 0)}
                        >
                          Use
                        </button>
                      )}
                    </li>
                  )
                })}
              </ul>
              <p className="mt-2 text-[11px] leading-relaxed text-fg-subtle">
                Each is a place in the video where the data's turns line up. Drift is how far apart the data's first and second
                halves land; the right match drifts least.
              </p>
            </Disclosure>
          )}
        </>
      )}
    </Section>
  )
}

/** One line on what auto-sync did, is doing, or why it can't run. */
function SyncStatus({ canAutoSync, manual }: { canAutoSync: boolean; manual: boolean }) {
  const run = useRuntime((s) => s.syncRun)
  const { offset, video, session } = useActivePair()

  if (!canAutoSync) {
    return (
      <p className="flex gap-2 text-xs leading-relaxed text-fg-subtle">
        <CircleDashed size={14} className="mt-px shrink-0" aria-hidden />
        This camera doesn't record motion data, so set the offset by hand for now.
      </p>
    )
  }
  if (run.status === 'running') {
    return (
      <p className="flex items-center gap-2 text-xs text-fg-muted">
        <LoaderCircle size={14} className="animate-spin" aria-hidden />
        {run.label}
      </p>
    )
  }
  if (run.status === 'error') {
    return (
      <p className="flex gap-2 text-xs leading-relaxed text-warn">
        <TriangleAlert size={14} className="mt-px shrink-0" aria-hidden />
        {run.message}
      </p>
    )
  }
  if (run.status !== 'done' || !run.output.sync) return null

  const result = run.output.sync
  const details = [
    `match ${Math.abs(result.correlation).toFixed(2)}`,
    result.precision !== null && !run.gpsDerived ? `±${Math.max(1, Math.round(result.precision * 1000))} ms` : null,
    run.gpsDerived ? `from ${run.loggerSource}, about ±0.1 s` : null,
    result.drift !== 0 ? `clock drift ${Math.round(Math.abs(result.drift) * 1e6)} ppm corrected` : null,
  ].filter(Boolean)
  const adjusted = manual || Math.abs(result.offset - offset) >= 0.0015
  // "Picked a lap" only makes sense when the data covers a small part of the video.
  const pickedLap =
    result.separation.by === 'half-drift' && !!video && !!session && session.duration < 0.6 * video.probe.duration
  const unmatched = result.coverage < 0.95 ? `${Math.round((1 - result.coverage) * 100)}% of the data didn't match the camera and was left out.` : null

  if (result.confidence === 'low') {
    return (
      <div className="text-xs leading-relaxed">
        <p className="flex gap-2 text-warn">
          <TriangleAlert size={14} className="mt-px shrink-0" aria-hidden />
          Not sure of this match. Check the plot below, or pick another under Other matches.
        </p>
        <p className="mt-1 pl-[22px] text-fg-subtle">{details.join(' · ')}</p>
      </div>
    )
  }
  return (
    <div className="text-xs leading-relaxed">
      <p className="flex gap-2 text-fg">
        <CircleCheck size={14} className="mt-px shrink-0 text-good" aria-hidden />
        {adjusted ? 'Auto-synced, then adjusted' : 'Synced from camera motion'}
      </p>
      <p className="pl-[22px] text-fg-subtle">
        {details.join(' · ')}
        {pickedLap && !adjusted && (
          <>
            <br />
            Picked the matching lap out of {result.candidates.length} similar ones.
          </>
        )}
        {unmatched && (
          <>
            <br />
            {unmatched}
          </>
        )}
      </p>
      {adjusted && (
        <button type="button" className="mt-1 pl-[22px] text-fg-muted hover:text-fg" onClick={() => chooseSyncMatch(result.offset, result.drift)}>
          Go back to {formatClock(result.offset)}
        </button>
      )}
    </div>
  )
}

/** Layer name: the bound channel for single-input widgets, else the widget type. */
function layerName(widget: WidgetInstance): string {
  const bindings = Object.values(widget.bindings)
  if (bindings.length === 1 && isCanonicalChannelId(bindings[0])) return CANONICAL_CHANNELS[bindings[0]].label
  if (bindings.length === 1) return bindings[0]!
  return WIDGETS[widget.type]?.label ?? widget.type
}

function OverlaySection() {
  const widgets = useProject((s) => s.project.layout.widgets)
  const { session } = useActivePair()
  return (
    <Section
      title="Overlay"
      grow
      action={
        session && (
          <Button variant="ghost" icon={RotateCcw} title="Replace the layout with the default one" onClick={resetLayout}>
            Reset
          </Button>
        )
      }
    >
      {!session ? (
        <p className="text-xs leading-relaxed text-fg-subtle">Gauges, a track map and a g-meter are added when data is loaded.</p>
      ) : (
        <ul className="-mx-2 space-y-px">
          {widgets.map((widget) => {
            const Icon = WIDGET_ICONS[widget.type] ?? Hash
            const typeLabel = WIDGETS[widget.type]?.label ?? widget.type
            const name = layerName(widget)
            const hidden = !!widget.hidden
            return (
              <li key={widget.id} className="group flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-hover">
                <Icon size={15} className={hidden ? 'text-fg-subtle' : 'text-fg-muted'} aria-hidden />
                <span className={`min-w-0 flex-1 truncate ${hidden ? 'text-fg-subtle' : 'text-fg'}`}>
                  {name}
                  {name !== typeLabel && <span className="ml-1.5 text-xs text-fg-subtle">{typeLabel}</span>}
                </span>
                <button
                  type="button"
                  onClick={() => toggleWidget(widget.id)}
                  title={hidden ? 'Show' : 'Hide'}
                  aria-label={`${hidden ? 'Show' : 'Hide'} ${name}`}
                  className={`grid size-6 place-items-center rounded text-fg-subtle hover:text-fg ${hidden ? '' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'}`}
                >
                  {hidden ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </Section>
  )
}
