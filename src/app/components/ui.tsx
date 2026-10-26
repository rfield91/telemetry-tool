import { ChevronRight, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

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
