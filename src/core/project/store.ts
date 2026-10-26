import { applyPatches, enablePatches, produceWithPatches, type Draft, type Patch } from 'immer'
import { createStore } from 'zustand/vanilla'
import { createProject, type Project } from './schema'

enablePatches()

interface HistoryEntry {
  label: string
  patches: Patch[]
  inverse: Patch[]
  /** Edits with the same key in quick succession merge into one undo step. */
  coalesceKey?: string
  at: number
}

export interface UpdateOptions {
  /** e.g. `move:<widgetId>` so a drag is one undo step. */
  coalesceKey?: string
}

export interface ProjectState {
  project: Project
  past: HistoryEntry[]
  future: HistoryEntry[]
  /** True when there are changes since the last load or save. */
  dirty: boolean
  update(label: string, recipe: (draft: Draft<Project>) => void, options?: UpdateOptions): void
  undo(): void
  redo(): void
  /** Replace the project (open/new) and clear history. */
  load(project: Project): void
  markSaved(): void
}

const HISTORY_LIMIT = 200
const COALESCE_MS = 1000

export function createProjectStore(initial: Project = createProject(), now: () => number = Date.now) {
  return createStore<ProjectState>()((set, get) => ({
    project: initial,
    past: [],
    future: [],
    dirty: false,

    update(label, recipe, options = {}) {
      const { project, past } = get()
      const [next, patches, inverse] = produceWithPatches(project, recipe)
      if (patches.length === 0) return
      const at = now()
      const last = past[past.length - 1]
      if (options.coalesceKey && last?.coalesceKey === options.coalesceKey && at - last.at < COALESCE_MS) {
        const merged: HistoryEntry = {
          ...last,
          patches: [...last.patches, ...patches],
          // Undo the newest change first, then the older ones.
          inverse: [...inverse, ...last.inverse],
          at,
        }
        set({ project: next, past: [...past.slice(0, -1), merged], future: [], dirty: true })
        return
      }
      const entry: HistoryEntry = { label, patches, inverse, coalesceKey: options.coalesceKey, at }
      set({ project: next, past: [...past, entry].slice(-HISTORY_LIMIT), future: [], dirty: true })
    },

    undo() {
      const { project, past, future } = get()
      const entry = past[past.length - 1]
      if (!entry) return
      set({
        project: applyPatches(project, entry.inverse),
        past: past.slice(0, -1),
        future: [entry, ...future],
        dirty: true,
      })
    },

    redo() {
      const { project, past, future } = get()
      const entry = future[0]
      if (!entry) return
      set({
        project: applyPatches(project, entry.patches),
        past: [...past, entry],
        future: future.slice(1),
        dirty: true,
      })
    },

    load(project) {
      set({ project, past: [], future: [], dirty: false })
    },

    markSaved() {
      set({ dirty: false })
    },
  }))
}

export type ProjectStore = ReturnType<typeof createProjectStore>

export const undoLabel = (state: ProjectState) => state.past[state.past.length - 1]?.label ?? null
export const redoLabel = (state: ProjectState) => state.future[0]?.label ?? null
