import type { Ctx2D } from './types'

/** Shared drawing helpers and theme for overlay widgets. */
export const FONT_FAMILY = '"Inter", "Segoe UI", system-ui, sans-serif'
export const PANEL_FILL = 'rgba(8, 12, 20, 0.62)'
export const TRACK_FILL = 'rgba(255, 255, 255, 0.14)'
export const TEXT = '#f8fafc'
export const MUTED = '#94a3b8'

export function font(px: number, weight = 600): string {
  return `${weight} ${Math.max(1, Math.round(px))}px ${FONT_FAMILY}`
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** 0..1 position of value in [min, max]; 0 for degenerate ranges. */
export function fraction(value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || !(max > min)) return 0
  return clamp((value - min) / (max - min), 0, 1)
}

export function roundedPanel(ctx: Ctx2D, x: number, y: number, w: number, h: number, radius: number) {
  ctx.fillStyle = PANEL_FILL
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, radius)
  ctx.fill()
}

export function formatValue(value: number | null, decimals: number): string {
  if (value === null || !Number.isFinite(value)) return '—'
  return value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

/** Round a maximum up to a readable dial limit (1, 2, 2.5, 5 × 10^n). */
export function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  for (const step of [1, 1.2, 1.4, 1.5, 1.6, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (step * magnitude >= value) return step * magnitude
  }
  return 10 * magnitude
}

/** Tick spacing giving roughly 5–10 major ticks across a range. */
export function niceStep(range: number): number {
  if (!(range > 0)) return 1
  const raw = range / 8
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const normalized = raw / magnitude
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10
  return step * magnitude
}
