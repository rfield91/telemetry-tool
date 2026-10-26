/** `m:ss.SSS` (or `h:mm:ss.SSS`); negative times keep their sign. */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—'
  const totalMs = Math.round(Math.abs(seconds) * 1000)
  // Sign from the rounded value, so -0.0002 shows as 0:00.000.
  const sign = seconds < 0 && totalMs > 0 ? '-' : ''
  const h = Math.floor(totalMs / 3_600_000)
  const m = Math.floor((totalMs % 3_600_000) / 60_000)
  const s = (totalMs % 60_000) / 1000
  const ss = s.toFixed(3).padStart(6, '0')
  return h > 0 ? `${sign}${h}:${String(m).padStart(2, '0')}:${ss}` : `${sign}${m}:${ss}`
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  return `${Math.round(bytes / 1e3)} KB`
}

export function formatFps(fps: number): string {
  return Number.isInteger(Math.round(fps * 100) / 100) ? String(Math.round(fps)) : fps.toFixed(2)
}
