import { LoaderCircle, Redo2, Undo2, Upload, X } from 'lucide-react'
import { useEffect, useState, type DragEvent } from 'react'
import { dismissError, loadUserProfiles, openDroppedFiles, openTelemetry, openVideo, setOffset } from './app/actions'
import { InspectorPanel } from './app/components/InspectorPanel'
import { MappingDialog } from './app/components/MappingDialog'
import { MediaPanel } from './app/components/MediaPanel'
import { Stage } from './app/components/Stage'
import { Transport } from './app/components/Transport'
import { IconButton } from './app/components/ui'
import { host } from './app/host'
import { deleteSelection, duplicateSelection, loadTemplates, nudgeSelection, select, selectAll } from './app/layout'
import { player } from './app/player'
import { projectStore, runtimeStore, useProject, useRuntime } from './app/state'
import { redoLabel, undoLabel } from './core/project/store'

/** Dev harness: `?video=<path>&csv=<path>&offset=<s>` loads files in a plain browser. */
async function loadFromQuery() {
  if (host.kind !== 'browser') return
  const params = new URLSearchParams(window.location.search)
  const video = params.get('video')
  const csv = params.get('csv')
  if (video) await openVideo(video)
  if (csv) await openTelemetry(csv)
  const offset = Number(params.get('offset'))
  if (params.has('offset') && Number.isFinite(offset)) setOffset(offset)
}

function isTyping(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName))
}

const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files')

export default function App() {
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    void loadTemplates()
    void loadUserProfiles().then(loadFromQuery)
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) projectStore.getState().redo()
        else projectStore.getState().undo()
        return
      }
      if (mod && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        projectStore.getState().redo()
        return
      }
      if (isTyping(event.target)) return
      const hasSelection = runtimeStore.getState().selection.length > 0
      const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
      if (mod && event.key.toLowerCase() === 'd') {
        event.preventDefault()
        duplicateSelection()
      } else if (mod && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        selectAll()
      } else if (hasSelection && arrows[event.key]) {
        // With widgets selected, arrows nudge them instead of stepping frames.
        event.preventDefault()
        const [dx, dy] = arrows[event.key]!
        const step = event.shiftKey ? 10 : 1
        nudgeSelection(dx * step, dy * step)
      } else if (hasSelection && (event.key === 'Delete' || event.key === 'Backspace')) {
        event.preventDefault()
        deleteSelection()
      } else if (event.key === 'Escape') {
        select([])
      } else if (event.key === ' ') {
        event.preventDefault()
        player.toggle()
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        if (event.shiftKey) player.seek(player.time - 1)
        else player.step(-1)
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        if (event.shiftKey) player.seek(player.time + 1)
        else player.step(1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div
      className="grid h-full grid-rows-[2.75rem_1fr] bg-canvas text-fg"
      onDragOver={(event) => {
        if (!hasFiles(event)) return
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target || !event.relatedTarget) setDragging(false)
      }}
      onDrop={(event) => {
        if (!hasFiles(event)) return
        event.preventDefault()
        setDragging(false)
        void openDroppedFiles([...event.dataTransfer.files])
      }}
    >
      <Header />
      <div className="grid min-h-0 grid-cols-[19rem_1fr_19rem]">
        <MediaPanel />
        <main className="flex min-h-0 min-w-0 flex-col">
          <div className="flex min-h-0 min-w-0 flex-1 p-5">
            <Stage />
          </div>
          <Transport />
        </main>
        <InspectorPanel />
      </div>
      <MappingDialog />
      <ErrorToast />
      {dragging && (
        <div className="pointer-events-none fixed inset-3 z-30 grid place-items-center rounded-xl border-2 border-dashed border-accent bg-canvas/80">
          <div className="flex flex-col items-center gap-2 text-fg">
            <Upload size={24} className="text-accent" aria-hidden />
            <p className="font-medium">Drop a video or data file</p>
            <p className="text-xs text-fg-subtle">MP4 / MOV / CSV</p>
          </div>
        </div>
      )}
    </div>
  )
}

function Header() {
  const busy = useRuntime((s) => s.busy)
  const projectName = useProject((s) => s.project.name)
  const undo = useProject(undoLabel)
  const redo = useProject(redoLabel)
  return (
    <header className="flex items-center justify-between gap-4 border-b border-line bg-surface px-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <svg viewBox="0 0 24 24" className="size-5 shrink-0 text-accent" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
          <path d="M4.5 16.5a8 8 0 1 1 15 0" />
          <path d="m12 13.5 4.5-4.5" />
        </svg>
        <span className="font-semibold">Telemetry Overlay</span>
        <span className="text-fg-subtle">/</span>
        <span className="truncate text-fg-muted">{projectName}</span>
        {busy && (
          <span className="ml-2 flex items-center gap-1.5 text-xs text-fg-muted">
            <LoaderCircle size={13} className="animate-spin" aria-hidden />
            {busy}
          </span>
        )}
      </div>
      <div className="flex items-center gap-0.5">
        <IconButton icon={Undo2} label={undo ? `Undo ${undo} (Ctrl+Z)` : 'Nothing to undo'} disabled={!undo} onClick={() => projectStore.getState().undo()} />
        <IconButton icon={Redo2} label={redo ? `Redo ${redo} (Ctrl+Y)` : 'Nothing to redo'} disabled={!redo} onClick={() => projectStore.getState().redo()} />
      </div>
    </header>
  )
}

function ErrorToast() {
  const error = useRuntime((s) => s.error)
  if (!error) return null
  return (
    <div role="alert" className="fixed bottom-20 left-1/2 z-20 flex max-w-lg -translate-x-1/2 items-start gap-3 rounded-lg border border-danger/40 bg-raised px-4 py-3 shadow-xl">
      <span className="mt-1 size-2 shrink-0 rounded-full bg-danger" aria-hidden />
      <p className="text-[13px] text-fg">{error}</p>
      <button type="button" onClick={dismissError} aria-label="Dismiss" className="-mr-1 text-fg-subtle hover:text-fg">
        <X size={15} aria-hidden />
      </button>
    </div>
  )
}
