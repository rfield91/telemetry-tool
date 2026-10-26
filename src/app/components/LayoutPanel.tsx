import {
  ArrowLeftRight,
  ChartColumn,
  Copy,
  Crosshair,
  Eye,
  EyeOff,
  Gauge,
  Hash,
  LayoutTemplate,
  Lock,
  LockOpen,
  Plus,
  RotateCcw,
  Route,
  Save,
  Timer,
  Trash2,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useState, type DragEvent, type ReactNode } from 'react'
import { CANONICAL_CHANNELS, isCanonicalChannelId } from '../../core/data/channels'
import { getUnit, unitsFor } from '../../core/data/units'
import type { WidgetInstance } from '../../core/project/schema'
import { findBoundChannel, resolveInputs } from '../../core/widgets/data'
import { WIDGETS } from '../../core/widgets/registry'
import type { StyleField } from '../../core/widgets/types'
import { frameSize } from '../actions'
import {
  addWidget,
  applyLayoutTemplate,
  clearLayout,
  deleteSelection,
  deleteTemplate,
  duplicateSelection,
  missingChannels,
  reorderWidget,
  resetLayout,
  saveTemplate,
  select,
  setBinding,
  setStyle,
  setUnit,
  setWidgetBox,
  toggleHidden,
  toggleLocked,
  toggleSelected,
} from '../layout'
import { useActivePair, useProject, useRuntime, useSelectedWidgets } from '../state'
import { ChannelPicker } from './ChannelPicker'
import {
  Button,
  CommitInput,
  inputClass,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  NumberInput,
  Popover,
  PropertyRow,
  Section,
  Switch,
} from './ui'

const WIDGET_ICONS: Record<string, LucideIcon> = {
  gauge: Gauge,
  bar: ChartColumn,
  readout: Hash,
  lapTimer: Timer,
  delta: ArrowLeftRight,
  trackMap: Route,
  gMeter: Crosshair,
}

/** Layer name: the bound channel for single-input widgets, else the widget type. */
function layerName(widget: WidgetInstance): string {
  const bindings = Object.values(widget.bindings)
  if (widget.type === 'delta') return WIDGETS.delta!.label
  if (bindings.length === 1 && isCanonicalChannelId(bindings[0])) return CANONICAL_CHANNELS[bindings[0]].label
  if (bindings.length === 1) return bindings[0]!
  return WIDGETS[widget.type]?.label ?? widget.type
}

/** Right-column Layout tab: the layer list and the selected widget's properties. */
export function LayoutPanel() {
  const { session } = useActivePair()
  if (!session) {
    return (
      <Section title="Layout">
        <p className="text-xs leading-relaxed text-fg-subtle">Gauges, lap timing, a track map and a g-meter are added when data is loaded.</p>
      </Section>
    )
  }
  return (
    <>
      <LayersSection />
      <PropertiesSection />
    </>
  )
}

function AddWidgetMenu() {
  return (
    <Popover
      className="w-48"
      trigger={({ toggle, open }) => (
        <Button variant="ghost" icon={Plus} title="Add a widget" onClick={toggle} className={open ? 'bg-hover text-fg' : ''}>
          Add
        </Button>
      )}
    >
      {(close) =>
        Object.values(WIDGETS).map((definition) => (
          <MenuItem
            key={definition.type}
            icon={WIDGET_ICONS[definition.type] ?? Hash}
            onClick={() => {
              addWidget(definition.type)
              close()
            }}
          >
            {definition.label}
          </MenuItem>
        ))
      }
    </Popover>
  )
}

function TemplatesMenu() {
  const templates = useRuntime((s) => s.templates)
  const hasWidgets = useProject((s) => s.project.layout.widgets.length > 0)
  const [name, setName] = useState('')
  return (
    <Popover
      className="w-64"
      trigger={({ toggle, open }) => (
        <Button variant="ghost" icon={LayoutTemplate} title="Layout templates" onClick={toggle} className={open ? 'bg-hover text-fg' : ''}>
          Templates
        </Button>
      )}
    >
      {(close) => (
        <>
          <MenuLabel>Apply</MenuLabel>
          <MenuItem
            icon={RotateCcw}
            onClick={() => {
              resetLayout()
              close()
            }}
          >
            Default layout
          </MenuItem>
          {templates.map((template) => (
            <div key={template.id} className="group flex items-center">
              <MenuItem
                icon={LayoutTemplate}
                onClick={() => {
                  applyLayoutTemplate(template)
                  close()
                }}
              >
                {template.name}
              </MenuItem>
              <button
                type="button"
                title={`Delete “${template.name}”`}
                aria-label={`Delete template ${template.name}`}
                onClick={() => void deleteTemplate(template.id)}
                className="ml-0.5 grid size-7 shrink-0 place-items-center rounded-md text-fg-subtle opacity-0 hover:bg-hover hover:text-fg group-hover:opacity-100 focus-visible:opacity-100"
              >
                <X size={13} aria-hidden />
              </button>
            </div>
          ))}
          <MenuItem
            icon={Trash2}
            disabled={!hasWidgets}
            onClick={() => {
              clearLayout()
              close()
            }}
          >
            Empty layout
          </MenuItem>
          <MenuSeparator />
          <MenuLabel>Save this layout</MenuLabel>
          <form
            className="flex gap-1 px-1 pb-1"
            onSubmit={(event) => {
              event.preventDefault()
              if (!name.trim()) return
              void saveTemplate(name)
              setName('')
              close()
            }}
          >
            <input
              className={inputClass}
              placeholder="Template name"
              value={name}
              aria-label="Template name"
              onChange={(event) => setName(event.target.value)}
            />
            <button
              type="submit"
              disabled={!name.trim() || !hasWidgets}
              title="Save template"
              aria-label="Save template"
              className="grid size-7 shrink-0 place-items-center rounded-md bg-accent text-accent-fg hover:bg-accent-hover disabled:opacity-40"
            >
              <Save size={14} aria-hidden />
            </button>
          </form>
          <p className="px-2 pb-1 text-[11px] leading-relaxed text-fg-subtle">
            Templates use channel types, not column names, so they work with any logger.
          </p>
        </>
      )}
    </Popover>
  )
}

function LayersSection() {
  const widgets = useProject((s) => s.project.layout.widgets)
  const selection = useRuntime((s) => s.selection)
  const { session } = useActivePair()
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)
  // Front-most first, like a design tool's layer list.
  const rows = [...widgets].reverse()

  const onDragOver = (event: DragEvent, row: number) => {
    if (!dragging) return
    event.preventDefault()
    const box = event.currentTarget.getBoundingClientRect()
    setDropAt(event.clientY < box.top + box.height / 2 ? row : row + 1)
  }
  const onDrop = () => {
    if (dragging && dropAt !== null) {
      const from = rows.findIndex((w) => w.id === dragging)
      const position = from < dropAt ? dropAt - 1 : dropAt
      reorderWidget(dragging, widgets.length - 1 - position)
    }
    setDragging(null)
    setDropAt(null)
  }

  return (
    <Section
      title="Layers"
      action={
        <div className="-mr-1.5 flex items-center">
          <TemplatesMenu />
          <AddWidgetMenu />
        </div>
      }
    >
      {rows.length === 0 ? (
        <p className="text-xs leading-relaxed text-fg-subtle">No widgets. Add one, or apply a template.</p>
      ) : (
        <ul className="-mx-2 max-h-64 space-y-px overflow-y-auto" onDragLeave={(event) => event.currentTarget === event.target && setDropAt(null)}>
          {rows.map((widget, row) => {
            const Icon = WIDGET_ICONS[widget.type] ?? Hash
            const typeLabel = WIDGETS[widget.type]?.label ?? widget.type
            const name = layerName(widget)
            const hidden = !!widget.hidden
            const locked = !!widget.locked
            const selected = selection.includes(widget.id)
            const missing = missingChannels(widget, session)
            return (
              <li
                key={widget.id}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'move'
                  setDragging(widget.id)
                }}
                onDragOver={(event) => onDragOver(event, row)}
                onDrop={onDrop}
                onDragEnd={() => {
                  setDragging(null)
                  setDropAt(null)
                }}
                onClick={(event) => (event.shiftKey || event.ctrlKey || event.metaKey ? toggleSelected(widget.id) : select([widget.id]))}
                className={`group relative flex cursor-default items-center gap-2.5 rounded-md px-2 py-1.5 ${
                  selected ? 'bg-accent-soft' : 'hover:bg-hover'
                } ${dragging === widget.id ? 'opacity-50' : ''}`}
              >
                {dropAt === row && <span className="absolute inset-x-1 -top-px h-0.5 rounded bg-accent" />}
                {dropAt === row + 1 && row === rows.length - 1 && <span className="absolute inset-x-1 -bottom-px h-0.5 rounded bg-accent" />}
                <Icon size={15} className={hidden ? 'text-fg-subtle' : selected ? 'text-accent' : 'text-fg-muted'} aria-hidden />
                <span className={`min-w-0 flex-1 truncate ${hidden ? 'text-fg-subtle' : 'text-fg'}`}>
                  {name}
                  {name !== typeLabel && <span className="ml-1.5 text-xs text-fg-subtle">{typeLabel}</span>}
                </span>
                {missing.length > 0 && (
                  <span title={`This data has no ${missing.join(', ')} channel`} className="text-warn">
                    <TriangleAlert size={13} aria-label="Missing data" />
                  </span>
                )}
                <LayerToggle
                  on={locked}
                  label={`${locked ? 'Unlock' : 'Lock'} ${name}`}
                  icon={locked ? Lock : LockOpen}
                  onClick={() => toggleLocked(widget.id)}
                />
                <LayerToggle
                  on={hidden}
                  label={`${hidden ? 'Show' : 'Hide'} ${name}`}
                  icon={hidden ? EyeOff : Eye}
                  onClick={() => toggleHidden(widget.id)}
                />
              </li>
            )
          })}
        </ul>
      )}
    </Section>
  )
}

/** Lock/visibility button: always shown when on, otherwise on row hover. */
function LayerToggle({ on, label, icon: Icon, onClick }: { on: boolean; label: string; icon: LucideIcon; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      title={label}
      aria-label={label}
      aria-pressed={on}
      className={`grid size-6 place-items-center rounded text-fg-subtle hover:text-fg ${on ? '' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'}`}
    >
      <Icon size={14} aria-hidden />
    </button>
  )
}

function PropertiesSection() {
  const selected = useSelectedWidgets()
  if (selected.length === 0) {
    return (
      <Section title="Properties" grow>
        <p className="text-xs leading-relaxed text-fg-subtle">
          Select a widget on the video or in the list. Drag to move it and drag a corner to resize; it snaps to edges, the centre
          and other widgets (hold Alt to place freely). Arrow keys nudge by a pixel, Shift+arrows by ten.
        </p>
      </Section>
    )
  }
  if (selected.length > 1) {
    return (
      <Section title="Properties" grow>
        <p className="text-xs text-fg-muted">{selected.length} widgets selected</p>
        <SelectionActions />
      </Section>
    )
  }
  return <WidgetProperties widget={selected[0]!} />
}

function SelectionActions() {
  return (
    <div className="mt-3 flex gap-1.5">
      <Button icon={Copy} title="Duplicate (Ctrl+D)" onClick={duplicateSelection}>
        Duplicate
      </Button>
      <Button icon={Trash2} title="Delete (Del)" onClick={deleteSelection}>
        Delete
      </Button>
    </div>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-4 first:mt-0">
      <h3 className="mb-2 text-[11px] font-medium text-fg-subtle">{title}</h3>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

function WidgetProperties({ widget }: { widget: WidgetInstance }) {
  const definition = WIDGETS[widget.type]
  const { width, height } = frameSize()
  if (!definition) return null
  const Icon = WIDGET_ICONS[widget.type] ?? Hash
  return (
    <Section
      title="Properties"
      grow
      action={
        widget.locked && (
          <span className="flex items-center gap-1 text-xs text-fg-subtle">
            <Lock size={12} aria-hidden /> Locked
          </span>
        )
      }
    >
      <p className="mb-4 flex items-center gap-2 text-fg">
        <Icon size={15} className="text-fg-muted" aria-hidden />
        {definition.label}
      </p>

      {definition.inputs.length > 0 && (
        <Group title="Data">
          {definition.inputs.map((input) => (
            <InputBinding key={input.name} widget={widget} input={input.name} label={definition.inputs.length > 1 ? input.label : 'Channel'} />
          ))}
        </Group>
      )}

      <Group title="Style">
        {definition.styleFields.map((field) => (
          <StyleControl key={field.key} widget={widget} field={field} />
        ))}
      </Group>

      <Group title="Position (px)">
        <div className="grid grid-cols-3 gap-1.5">
          {(
            [
              ['X', 'x', widget.rect.x * width],
              ['Y', 'y', widget.rect.y * height],
              ['Height', 'height', widget.rect.h * height],
            ] as const
          ).map(([label, key, value]) => (
            <label key={key} className="block">
              <span className="mb-1 block text-[11px] text-fg-subtle">{label}</span>
              <NumberInput value={Math.round(value)} min={0} onCommit={(next) => setWidgetBox(widget.id, { [key]: next })} />
            </label>
          ))}
        </div>
      </Group>

      <SelectionActions />
    </Section>
  )
}

function InputBinding({ widget, input, label }: { widget: WidgetInstance; input: string; label: string }) {
  const { session } = useActivePair()
  const binding = widget.bindings[input] ?? ''
  const channel = findBoundChannel(session, binding)
  const id = `bind-${widget.id}-${input}`
  const units = channel?.unit ? unitsFor(getUnit(channel.unit).quantity) : []
  const defaultUnit = channel && session ? resolveInputs(session, { value: binding }).value?.unit : null
  const current = widget.units?.[input] && units.some((u) => u.id === widget.units![input]) ? widget.units[input] : defaultUnit
  return (
    <>
      <PropertyRow label={label} htmlFor={id}>
        <ChannelPicker id={id} binding={binding} onChange={(next) => setBinding(widget.id, input, next)} />
      </PropertyRow>
      {units.length > 1 && (
        <PropertyRow label="Unit" htmlFor={`${id}-unit`}>
          <select
            id={`${id}-unit`}
            className={inputClass}
            value={current ?? ''}
            onChange={(event) => setUnit(widget.id, input, event.target.value === defaultUnit ? null : event.target.value)}
          >
            {units.map((unit) => (
              <option key={unit.id} value={unit.id}>
                {unit.id}
              </option>
            ))}
          </select>
        </PropertyRow>
      )}
    </>
  )
}

const HEX = /^#[0-9a-f]{6}$/i

function StyleControl({ widget, field }: { widget: WidgetInstance; field: StyleField }) {
  const id = `style-${widget.id}-${field.key}`
  const value = widget.style[field.key]
  const set = (next: unknown) => setStyle(widget.id, field.key, next)
  switch (field.kind) {
    case 'text':
      return (
        <PropertyRow label={field.label} htmlFor={id}>
          <input id={id} className={inputClass} value={String(value ?? '')} onChange={(event) => set(event.target.value)} />
        </PropertyRow>
      )
    case 'color': {
      const text = String(value ?? '')
      return (
        <PropertyRow label={field.label} htmlFor={id}>
          <div className="flex items-center gap-1.5">
            <span className="relative size-7 shrink-0 overflow-hidden rounded-md border border-line" style={{ background: text }}>
              <input
                type="color"
                aria-label={`${field.label} picker`}
                className="absolute inset-0 size-full cursor-pointer opacity-0"
                value={HEX.test(text) ? text : '#ffffff'}
                onChange={(event) => set(event.target.value)}
              />
            </span>
            <CommitInput
              id={id}
              className="font-mono text-xs"
              value={text}
              onCommit={(next) => (CSS.supports('color', next.trim()) ? set(next.trim()) : undefined)}
            />
          </div>
        </PropertyRow>
      )
    }
    case 'number':
      return (
        <PropertyRow label={field.label} htmlFor={id}>
          <NumberInput id={id} value={Number(value)} min={field.min} max={field.max} step={field.step} onCommit={set} />
        </PropertyRow>
      )
    case 'toggle':
      return (
        <PropertyRow label={field.label} htmlFor={id}>
          <Switch id={id} checked={!!value} onChange={set} />
        </PropertyRow>
      )
  }
}
