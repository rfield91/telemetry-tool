import { ChevronDown, Search, TriangleAlert } from 'lucide-react'
import { useMemo, useState } from 'react'
import { CANONICAL_CHANNELS, isCanonicalChannelId } from '../../core/data/channels'
import type { TelemetryChannel, TelemetrySession } from '../../core/data/import'
import { sampleAt } from '../../core/data/series'
import { findBoundChannel, resolveInputs } from '../../core/widgets/data'
import { useActivePair, useRuntime } from '../state'
import { inputClass, Popover } from './ui'

/** Readable number with precision by magnitude. */
function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  const magnitude = Math.abs(value)
  const decimals = magnitude >= 100 ? 0 : magnitude >= 10 ? 1 : 2
  return value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

function channelName(channel: TelemetryChannel): string {
  return channel.canonical ? CANONICAL_CHANNELS[channel.canonical].label : channel.label
}

/** A channel's value at a time and its range, both in display units. */
function describe(session: TelemetrySession, channel: TelemetryChannel, time: number) {
  const resolved = resolveInputs(session, { value: channel.key }).value!
  const raw = sampleAt(channel.series, time)
  const unit = resolved.unit === 'rpm' ? 'RPM' : (resolved.unit ?? '')
  return {
    value: raw === null ? null : resolved.toDisplay(raw),
    min: channel.range ? resolved.toDisplay(channel.range.min) : null,
    max: channel.range ? resolved.toDisplay(channel.range.max) : null,
    unit,
  }
}

/**
 * Picks the channel a widget input shows. Each entry shows the channel's
 * value at the playhead and its range over the session, so it's easy to
 * tell which column is which.
 */
export function ChannelPicker({ binding, onChange, id }: { binding: string; onChange: (binding: string) => void; id?: string }) {
  const { session, time: map } = useActivePair()
  const videoTime = useRuntime((s) => s.time)
  const [filter, setFilter] = useState('')
  const dataTime = map.toData(videoTime)
  const current = findBoundChannel(session, binding)

  const channels = useMemo(() => {
    if (!session) return []
    // Recognised channels first, then the rest, each alphabetically.
    return [...session.channels].sort(
      (a, b) => Number(!a.canonical) - Number(!b.canonical) || channelName(a).localeCompare(channelName(b)),
    )
  }, [session])

  const query = filter.trim().toLowerCase()
  const shown = channels.filter((c) => !query || `${channelName(c)} ${c.key}`.toLowerCase().includes(query))
  const missingLabel = isCanonicalChannelId(binding) ? CANONICAL_CHANNELS[binding].label : binding

  return (
    <Popover
      align="end"
      className="w-80"
      trigger={({ toggle, open }) => (
        <button
          id={id}
          type="button"
          onClick={() => {
            setFilter('')
            toggle()
          }}
          aria-expanded={open}
          className={`${inputClass} flex items-center gap-2 text-left`}
        >
          {current ? (
            <>
              <span className="min-w-0 flex-1 truncate">{channelName(current)}</span>
              {session && (
                <span className="shrink-0 font-mono text-xs tabular text-fg-subtle">
                  {formatNumber(describe(session, current, dataTime).value)}
                </span>
              )}
            </>
          ) : (
            <span className="flex min-w-0 flex-1 items-center gap-1.5 text-warn">
              <TriangleAlert size={13} className="shrink-0" aria-hidden />
              <span className="truncate">{missingLabel}</span>
            </span>
          )}
          <ChevronDown size={13} className="shrink-0 text-fg-subtle" aria-hidden />
        </button>
      )}
    >
      {(close) =>
        !session ? (
          <p className="p-2 text-xs text-fg-subtle">Load a data file to choose channels.</p>
        ) : (
          <>
            <div className="relative mb-1">
              <Search size={13} className="pointer-events-none absolute top-2 left-2 text-fg-subtle" aria-hidden />
              <input
                autoFocus
                className={`${inputClass} pl-7`}
                placeholder="Find a channel"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && shown[0]) {
                    onChange(shown[0].canonical ?? shown[0].key)
                    close()
                  }
                }}
              />
            </div>
            {!current && (
              <p className="mx-2 mb-1 text-[11px] leading-relaxed text-warn">This data has no {missingLabel} channel. Pick another.</p>
            )}
            <ul className="max-h-72 overflow-y-auto" role="listbox">
              {shown.map((channel) => {
                const info = describe(session, channel, dataTime)
                const name = channelName(channel)
                const isCurrent = channel === current
                return (
                  <li key={channel.key}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={isCurrent}
                      onClick={() => {
                        onChange(channel.canonical ?? channel.key)
                        close()
                      }}
                      className={`grid w-full grid-cols-[1fr_auto] gap-x-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-hover ${
                        isCurrent ? 'bg-accent-soft' : ''
                      }`}
                    >
                      <span className="truncate text-[13px] text-fg">{name}</span>
                      <span className="text-right font-mono text-xs tabular text-fg">
                        {formatNumber(info.value)}
                        {info.unit && <span className="ml-1 font-sans text-fg-subtle">{info.unit}</span>}
                      </span>
                      <span className="truncate text-[11px] text-fg-subtle">{name !== channel.key ? channel.key : ''}</span>
                      <span className="text-right font-mono text-[11px] tabular text-fg-subtle">
                        {formatNumber(info.min)} – {formatNumber(info.max)}
                      </span>
                    </button>
                  </li>
                )
              })}
              {shown.length === 0 && <li className="px-2 py-1.5 text-xs text-fg-subtle">No channel matches “{filter}”.</li>}
            </ul>
          </>
        )
      }
    </Popover>
  )
}
