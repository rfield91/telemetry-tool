import { ChartColumn, Crosshair, Eye, EyeOff, Gauge, Hash, RotateCcw, Route, type LucideIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { CANONICAL_CHANNELS, isCanonicalChannelId } from '../../core/data/channels'
import type { WidgetInstance } from '../../core/project/schema'
import { WIDGETS } from '../../core/widgets/registry'
import { resetLayout, setOffset, toggleWidget } from '../actions'
import { formatClock } from '../format'
import { useActivePair, useProject } from '../state'
import { Button, inputClass, Section } from './ui'

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
  const { video, session, offset } = useActivePair()
  const [draft, setDraft] = useState(offset.toFixed(3))
  useEffect(() => setDraft(offset.toFixed(3)), [offset])

  if (!video || !session) {
    return (
      <Section title="Sync">
        <p className="text-xs leading-relaxed text-fg-subtle">Add a video and a data file to line them up.</p>
      </Section>
    )
  }

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

  return (
    <Section title="Sync">
      <p className="mb-3 text-xs leading-relaxed text-fg-muted">
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
    </Section>
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
