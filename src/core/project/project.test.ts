import { describe, expect, it } from 'vitest'
import { createProject, type Project } from './schema'
import { parseProject, ProjectFormatError, serializeProject } from './serialize'
import { createProjectStore, redoLabel, undoLabel } from './store'

function sampleProject(): Project {
  const project = createProject('SVT Canaan', new Date('2026-10-24T19:00:00Z'))
  project.videos.push({ id: 'v1', name: 'DJI 0016', paths: ['C:/videos/DJI_0016_D.MP4'] })
  project.telemetry.push({
    id: 't1',
    name: 'SVT Canaan.csv',
    path: 'C:/data/SVT Canaan.csv',
    profileId: 'solostorm',
  })
  project.syncs.push({ id: 's1', videoId: 'v1', telemetryId: 't1', offsetSeconds: 127.835, drift: 46e-6, method: 'camera-imu', confidence: 0.95 })
  project.selection = { telemetryId: 't1', laps: [5], leadInSeconds: 2, leadOutSeconds: 2 }
  project.layout.widgets.push({
    id: 'w1',
    type: 'gauge',
    rect: { x: 0.05, y: 0.6, w: 0.2, h: 0.35 },
    bindings: { value: 'speed' },
    style: { accent: '#2dd4bf', max: 140 },
  })
  return project
}

describe('project files', () => {
  it('round-trips through serialize/parse', () => {
    const project = sampleProject()
    const saved = new Date('2026-10-26T10:00:00Z')
    const parsed = parseProject(serializeProject(project, saved))
    expect(parsed).toEqual({ ...project, updatedAt: saved.toISOString() })
  })

  it('rejects files from a newer app version', () => {
    const text = JSON.stringify({ ...sampleProject(), version: 2 })
    expect(() => parseProject(text)).toThrow(/newer version/)
  })

  it('reports what is wrong with an invalid file', () => {
    const broken = { ...sampleProject(), syncs: [{ id: 's1', videoId: 'v1', telemetryId: 't1', offsetSeconds: 'soon', method: 'manual', confidence: null }] }
    expect(() => parseProject(JSON.stringify(broken))).toThrow(ProjectFormatError)
    expect(() => parseProject(JSON.stringify(broken))).toThrow(/syncs\[0\] needs an offset/)
    expect(() => parseProject('{nope')).toThrow(/bad JSON/)
  })
})

describe('project store', () => {
  it('undoes and redoes edits', () => {
    const store = createProjectStore(sampleProject())
    const { update } = store.getState()
    update('Rename project', (draft) => {
      draft.name = 'Renamed'
    })
    update('Widen gauge', (draft) => {
      draft.layout.widgets[0]!.rect.w = 0.3
    })
    expect(store.getState().dirty).toBe(true)
    expect(undoLabel(store.getState())).toBe('Widen gauge')

    store.getState().undo()
    expect(store.getState().project.layout.widgets[0]!.rect.w).toBe(0.2)
    expect(redoLabel(store.getState())).toBe('Widen gauge')

    store.getState().undo()
    expect(store.getState().project.name).toBe('SVT Canaan')

    store.getState().redo()
    store.getState().redo()
    expect(store.getState().project.name).toBe('Renamed')
    expect(store.getState().project.layout.widgets[0]!.rect.w).toBe(0.3)
  })

  it('coalesces rapid edits with the same key into one undo step', () => {
    let clock = 0
    const store = createProjectStore(sampleProject(), () => clock)
    const drag = (x: number) =>
      store.getState().update('Move gauge', (draft) => {
        draft.layout.widgets[0]!.rect.x = x
      }, { coalesceKey: 'move:w1' })

    drag(0.1)
    clock = 200
    drag(0.2)
    clock = 400
    drag(0.3)
    expect(store.getState().past).toHaveLength(1)

    clock = 5000
    drag(0.4)
    expect(store.getState().past).toHaveLength(2)

    store.getState().undo()
    expect(store.getState().project.layout.widgets[0]!.rect.x).toBe(0.3)
    store.getState().undo()
    expect(store.getState().project.layout.widgets[0]!.rect.x).toBe(0.05)
  })

  it('ignores no-op edits and clears redo on a new edit', () => {
    const store = createProjectStore(sampleProject())
    store.getState().update('Nothing', () => {})
    expect(store.getState().past).toHaveLength(0)
    store.getState().update('Rename', (draft) => {
      draft.name = 'A'
    })
    store.getState().undo()
    store.getState().update('Rename again', (draft) => {
      draft.name = 'B'
    })
    expect(store.getState().future).toHaveLength(0)
  })

  it('loads a project with fresh history', () => {
    const store = createProjectStore()
    store.getState().update('Rename', (draft) => {
      draft.name = 'A'
    })
    store.getState().load(sampleProject())
    expect(store.getState()).toMatchObject({ past: [], future: [], dirty: false })
    expect(store.getState().project.name).toBe('SVT Canaan')
  })
})
