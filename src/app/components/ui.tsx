import { ChevronRight, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'

export function Section({
  title,
  action,
  children,
  grow,
}: {
  title: string
  action?: ReactNode
  children: ReactNode
  /** Fill remaining height and scroll internally. */
  grow?: boolean
}) {
  return (
    <section className={`flex flex-col border-b border-line last:border-b-0 ${grow ? 'min-h-0 flex-1' : ''}`}>
      <div className="flex h-10 shrink-0 items-center justify-between px-4">
        <h2 className="text-xs font-semibold text-fg-muted">{title}</h2>
        {action}
      </div>
      <div className={`px-4 pb-4 ${grow ? 'min-h-0 flex-1 overflow-y-auto' : ''}`}>{children}</div>
    </section>
  )
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost'

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover font-semibold',
  secondary: 'bg-raised text-fg hover:bg-hover border border-line',
  ghost: 'text-fg-muted hover:bg-hover hover:text-fg',
}

export function Button({
  children,
  onClick,
  disabled,
  variant = 'secondary',
  icon: Icon,
  title,
  className = '',
}: {
  children?: ReactNode
  onClick?: () => void
  disabled?: boolean
  variant?: ButtonVariant
  icon?: LucideIcon
  title?: string
  className?: string
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-7 items-center justify-center gap-1.5 rounded-md px-2.5 text-[13px] transition-colors disabled:pointer-events-none disabled:opacity-40 ${BUTTON_STYLES[variant]} ${className}`}
    >
      {Icon && <Icon size={14} strokeWidth={2} aria-hidden />}
      {children}
    </button>
  )
}

export function IconButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  active,
  size = 'md',
}: {
  icon: LucideIcon
  label: string
  onClick: () => void
  disabled?: boolean
  active?: boolean
  size?: 'sm' | 'md' | 'lg'
}) {
  const box = { sm: 'size-6', md: 'size-8', lg: 'size-9' }[size]
  const iconSize = { sm: 14, md: 16, lg: 18 }[size]
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`grid ${box} shrink-0 place-items-center rounded-md transition-colors disabled:pointer-events-none disabled:opacity-35 ${
        active ? 'bg-accent-soft text-accent' : 'text-fg-muted hover:bg-hover hover:text-fg'
      }`}
    >
      <Icon size={iconSize} strokeWidth={2} aria-hidden />
    </button>
  )
}

/** Collapsible secondary details, closed by default. */
export function Disclosure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="group mt-2">
      <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-fg-subtle hover:text-fg-muted [&::-webkit-details-marker]:hidden">
        <ChevronRight size={12} className="transition-transform group-open:rotate-90" aria-hidden />
        {label}
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  )
}

/** Label/value rows for metadata lists. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3 py-0.5 text-xs">
      <dt className="text-fg-subtle">{label}</dt>
      <dd className="truncate text-right text-fg-muted">{children}</dd>
    </div>
  )
}

export const inputClass =
  'h-7 w-full rounded-md border border-line bg-canvas px-2 text-[13px] text-fg outline-none transition-colors hover:border-line-strong focus:border-accent'

/**
 * A button that opens a floating panel below it. Closes on Escape, on a
 * click outside, or when the panel calls `close`.
 */
export function Popover({
  trigger,
  children,
  align = 'end',
  className = 'w-56',
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode
  children: (close: () => void) => ReactNode
  align?: 'start' | 'end'
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])
  return (
    <div ref={ref} className="relative">
      {trigger({ open, toggle: () => setOpen((value) => !value) })}
      {open && (
        <div
          className={`absolute top-full z-30 mt-1 rounded-lg border border-line bg-raised p-1 shadow-xl shadow-black/40 ${
            align === 'end' ? 'right-0' : 'left-0'
          } ${className}`}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

export function MenuItem({
  icon: Icon,
  children,
  onClick,
  trailing,
  disabled,
}: {
  icon?: LucideIcon
  children: ReactNode
  onClick: () => void
  trailing?: ReactNode
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-fg transition-colors hover:bg-hover disabled:pointer-events-none disabled:opacity-40"
    >
      {Icon && <Icon size={14} className="shrink-0 text-fg-muted" aria-hidden />}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
    </button>
  )
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <p className="px-2 pt-1.5 pb-1 text-[11px] font-medium text-fg-subtle">{children}</p>
}

export function MenuSeparator() {
  return <div className="my-1 h-px bg-line" />
}

/** Label on the left, control on the right, for inspector rows. */
export function PropertyRow({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[5.5rem_1fr] items-center gap-2">
      <label htmlFor={htmlFor} className="truncate text-xs text-fg-subtle">
        {label}
      </label>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

/** Text input that edits a draft and commits on Enter or blur. */
export function CommitInput({
  value,
  onCommit,
  id,
  className = '',
  inputMode,
}: {
  value: string
  onCommit: (text: string) => void
  id?: string
  className?: string
  inputMode?: 'decimal' | 'numeric' | 'text'
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <input
      id={id}
      className={`${inputClass} ${className}`}
      value={draft}
      inputMode={inputMode}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => (draft === value ? undefined : onCommit(draft))}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onCommit(draft)
        if (event.key === 'Escape') setDraft(value)
      }}
    />
  )
}

/** Number input: commits on Enter/blur, ↑/↓ step (Shift ×10), clamps to range. */
export function NumberInput({
  value,
  onCommit,
  id,
  min = -Infinity,
  max = Infinity,
  step = 1,
}: {
  value: number
  onCommit: (value: number) => void
  id?: string
  min?: number
  max?: number
  step?: number
}) {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)))
  const text = Number.isFinite(value) ? String(Number(value.toFixed(Math.max(decimals, 3)))) : ''
  const [draft, setDraft] = useState(text)
  useEffect(() => setDraft(text), [text])
  const commit = (next: number) => {
    if (!Number.isFinite(next)) return setDraft(text)
    const clamped = Math.min(max, Math.max(min, next))
    onCommit(clamped)
    setDraft(String(Number(clamped.toFixed(Math.max(decimals, 3)))))
  }
  return (
    <input
      id={id}
      className={`${inputClass} font-mono tabular`}
      value={draft}
      inputMode="decimal"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => draft !== text && commit(Number(draft))}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit(Number(draft))
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault()
          const delta = (event.key === 'ArrowUp' ? 1 : -1) * step * (event.shiftKey ? 10 : 1)
          commit(Number((Number(draft) + delta).toFixed(decimals)))
        }
      }}
    />
  )
}

export function Switch({ checked, onChange, id, label }: { checked: boolean; onChange: (value: boolean) => void; id?: string; label?: string }) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-4 w-7 rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-line-strong'}`}
    >
      <span className={`absolute top-0.5 left-0 size-3 rounded-full bg-fg transition-transform ${checked ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
    </button>
  )
}
