import { Activity, ChevronsLeft, ChevronsRight, Pause, Play, StepBack, StepForward } from 'lucide-react'
import { useRef, useState, type PointerEvent } from 'react'
import { bestLap, formatLapTime } from '../../core/laps/laps'
import { formatClock } from '../format'
import { player } from '../player'
import { runtimeStore, useActivePair, useProject, useRuntime } from '../state'
import { IconButton } from './ui'

const NO_LAPS: number[] = []

/** Playback controls, timecode and the timeline. */
export function Transport() {
  const { video, session, time: map } = useActivePair()
  const time = useRuntime((s) => s.time)
  const playing = useRuntime((s) => s.playing)
  const showStats = useRuntime((s) => s.showStats)
  const duration = video?.probe.duration ?? session?.duration ?? 0
  const fps = video?.probe.video.fps ?? 30
  const disabled = duration <= 0
  const dataTime = map.toData(time)

  return (
    <div className="flex h-16 shrink-0 items-center gap-4 border-t border-line bg-surface px-4">
      <div className="flex items-center gap-0.5">
        <IconButton icon={ChevronsLeft} label="Back 1 second (Shift+←)" disabled={disabled} onClick={() => player.seek(player.time - 1)} />
        <IconButton icon={StepBack} label="Previous frame (←)" disabled={disabled} onClick={() => player.step(-1)} />
        <button
          type="button"
          onClick={() => player.toggle()}
          disabled={disabled}
          title={playing ? 'Pause (Space)' : 'Play (Space)'}
          aria-label={playing ? 'Pause' : 'Play'}
          className="mx-1 grid size-9 place-items-center rounded-full bg-fg text-canvas transition-colors hover:bg-white disabled:opacity-35"
        >
          {playing ? <Pause size={16} fill="currentColor" aria-hidden /> : <Play size={16} fill="currentColor" className="translate-x-px" aria-hidden />}
        </button>
        <IconButton icon={StepForward} label="Next frame (→)" disabled={disabled} onClick={() => player.step(1)} />
        <IconButton icon={ChevronsRight} label="Forward 1 second (Shift+→)" disabled={disabled} onClick={() => player.seek(player.time + 1)} />
      </div>

      <div className="w-28 shrink-0 leading-tight">
        <div className="font-mono text-[15px] text-fg tabular">{formatClock(Math.min(time, duration))}</div>
        <div className="font-mono text-[11px] text-fg-subtle tabular">
          {video ? `frame ${Math.floor(time * fps + 1e-6).toLocaleString('en-US')}` : `of ${formatClock(duration)}`}
        </div>
      </div>

      <Timeline duration={duration} time={time} disabled={disabled} />

      <div className="w-28 shrink-0 text-right leading-tight">
        <div className="text-[11px] text-fg-subtle">Data time</div>
        <div className={`font-mono text-[13px] tabular ${session && dataTime >= 0 && dataTime <= session.duration ? 'text-fg-muted' : 'text-fg-subtle'}`}>
          {session ? formatClock(dataTime) : '—'}
        </div>
      </div>
      <IconButton
        icon={Activity}
        label={showStats ? 'Hide performance stats' : 'Show performance stats'}
        active={showStats}
        onClick={() => runtimeStore.setState({ showStats: !showStats })}
      />
    </div>
  )
}

function Timeline({ duration, time, disabled }: { duration: number; time: number; disabled: boolean }) {
  const { session, time: map } = useActivePair()
  const trackRef = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<number | null>(null)
  const best = session ? bestLap(session.laps) : null
  const selected = useProject((s) => s.project.selection?.laps ?? NO_LAPS)

  const timeAt = (clientX: number) => {
    const rect = trackRef.current!.getBoundingClientRect()
    return Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1) * duration
  }
  const percent = (t: number) => `${(Math.min(Math.max(t / duration, 0), 1) * 100).toFixed(3)}%`

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled) return
    event.currentTarget.setPointerCapture(event.pointerId)
    player.seek(timeAt(event.clientX))
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled) return
    const t = timeAt(event.clientX)
    setHover(t)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) player.seek(t)
  }

  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={-1}
      aria-label="Playback position"
      aria-valuemin={0}
      aria-valuemax={duration}
      aria-valuenow={time}
      className={`relative h-10 min-w-0 flex-1 select-none ${disabled ? 'opacity-40' : 'cursor-pointer'}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerLeave={() => setHover(null)}
    >
      {/* Lap bands, placed on the video timeline through the sync. */}
      {duration > 0 &&
        session?.laps.map((lap) => {
          const start = map.toVideo(lap.start)
          const end = map.toVideo(lap.end)
          if (end < 0 || start > duration) return null
          const isBest = lap === best
          return (
            <div
              key={lap.index}
              title={`${lap.kind === 'timed' ? `Lap ${lap.loggerNumber ?? lap.index}` : lap.kind === 'out' ? 'Out lap' : 'In lap'} · ${formatLapTime(lap.duration)}`}
              className={`absolute top-1 h-3.5 overflow-hidden rounded-sm border-l px-1 text-[10px] leading-3.5 ${
                isBest ? 'border-accent bg-accent-soft text-accent' : 'border-line-strong bg-white/[0.04] text-fg-subtle'
              } ${selected.includes(lap.index) ? 'ring-1 ring-fg-muted ring-inset' : ''}`}
              style={{ left: percent(start), width: `calc(${percent(end)} - ${percent(start)})` }}
            >
              {lap.kind === 'timed' ? `L${lap.loggerNumber ?? lap.index}` : lap.kind}
            </div>
          )
        })}

      <div className="absolute inset-x-0 bottom-2.5 h-1 rounded-full bg-line">
        <div className="h-full rounded-full bg-fg-subtle" style={{ width: duration > 0 ? percent(time) : 0 }} />
      </div>

      {duration > 0 && (
        <div className="pointer-events-none absolute inset-y-0 -ml-px w-0.5 rounded-full bg-accent" style={{ left: percent(time) }}>
          <div className="absolute -left-[3px] bottom-1.5 size-2 rounded-full bg-accent" />
        </div>
      )}

      {hover !== null && duration > 0 && (
        <div
          className="pointer-events-none absolute -top-6 -translate-x-1/2 rounded bg-raised px-1.5 py-0.5 font-mono text-[11px] text-fg-muted tabular shadow ring-1 ring-line"
          style={{ left: percent(hover) }}
        >
          {formatClock(hover)}
        </div>
      )}
    </div>
  )
}
