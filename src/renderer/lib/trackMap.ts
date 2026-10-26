import type { GpsPoint } from './telemetry'

export interface ProjectedPoint {
  x: number
  y: number
}

export interface TrackProjection {
  projected: ProjectedPoint[]
  /** Bounding box used for the fit (degrees / local meters). */
  minLat: number
  maxLat: number
  minLon: number
  maxLon: number
}

const EARTH_RADIUS_M = 6_378_137

/**
 * Project GPS points into a local east/north plane (meters), then fit them into
 * an SVG viewBox while preserving aspect ratio.
 */
export function projectGpsTrack(
  points: Array<{ lat: number; lon: number }>,
  width: number,
  height: number,
  padding = 24,
): TrackProjection {
  if (points.length === 0) {
    return {
      projected: [],
      minLat: 0,
      maxLat: 0,
      minLon: 0,
      maxLon: 0,
    }
  }

  let minLat = Infinity
  let maxLat = -Infinity
  let minLon = Infinity
  let maxLon = -Infinity
  for (const point of points) {
    minLat = Math.min(minLat, point.lat)
    maxLat = Math.max(maxLat, point.lat)
    minLon = Math.min(minLon, point.lon)
    maxLon = Math.max(maxLon, point.lon)
  }

  // Degenerate / stationary GPS — give a tiny envelope so we still draw a dot.
  if (maxLat - minLat < 1e-9) {
    minLat -= 1e-5
    maxLat += 1e-5
  }
  if (maxLon - minLon < 1e-9) {
    minLon -= 1e-5
    maxLon += 1e-5
  }

  const midLatRad = ((minLat + maxLat) / 2) * (Math.PI / 180)
  const metersPerDegLat = (Math.PI / 180) * EARTH_RADIUS_M
  const metersPerDegLon = metersPerDegLat * Math.cos(midLatRad)

  const local = points.map((point) => ({
    x: (point.lon - minLon) * metersPerDegLon,
    // North-up: larger latitude → smaller SVG y
    y: (maxLat - point.lat) * metersPerDegLat,
  }))

  let maxX = 0
  let maxY = 0
  for (const point of local) {
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }

  const innerW = Math.max(width - padding * 2, 1)
  const innerH = Math.max(height - padding * 2, 1)
  const scale = Math.min(innerW / Math.max(maxX, 1e-9), innerH / Math.max(maxY, 1e-9))
  const offsetX = padding + (innerW - maxX * scale) / 2
  const offsetY = padding + (innerH - maxY * scale) / 2

  return {
    projected: local.map((point) => ({
      x: offsetX + point.x * scale,
      y: offsetY + point.y * scale,
    })),
    minLat,
    maxLat,
    minLon,
    maxLon,
  }
}

export function sampleGpsPoints(
  points: GpsPoint[],
  time: number,
): { lat: number; lon: number } | null {
  if (points.length === 0) return null
  const first = points[0]!
  const last = points[points.length - 1]!
  if (time <= first.time) return { lat: first.lat, lon: first.lon }
  if (time >= last.time) return { lat: last.lat, lon: last.lon }

  let low = 0
  let high = points.length - 1
  while (high - low > 1) {
    const middle = (low + high) >> 1
    if (points[middle]!.time <= time) low = middle
    else high = middle
  }

  const before = points[low]!
  const after = points[high]!
  if (after.time === before.time) return { lat: before.lat, lon: before.lon }

  const progress = (time - before.time) / (after.time - before.time)
  return {
    lat: before.lat + (after.lat - before.lat) * progress,
    lon: before.lon + (after.lon - before.lon) * progress,
  }
}

/** Index of the last GPS sample at or before `time` (for trail drawing). */
export function trackIndexAt(points: GpsPoint[], time: number): number {
  if (points.length === 0) return -1
  if (time <= points[0]!.time) return 0
  if (time >= points[points.length - 1]!.time) return points.length - 1

  let low = 0
  let high = points.length - 1
  while (high - low > 1) {
    const middle = (low + high) >> 1
    if (points[middle]!.time <= time) low = middle
    else high = middle
  }
  return low
}

export function pointsToPath(projected: ProjectedPoint[]): string {
  if (projected.length === 0) return ''
  const first = projected[0]!
  let path = `M ${first.x.toFixed(2)} ${first.y.toFixed(2)}`
  for (let i = 1; i < projected.length; i += 1) {
    const point = projected[i]!
    path += ` L ${point.x.toFixed(2)} ${point.y.toFixed(2)}`
  }
  return path
}

/** Build a trail SVG path, subsampling when the track has many points. */
export function buildTrailPath(
  projected: ProjectedPoint[],
  endIndex: number,
  markerPoint: ProjectedPoint | null,
  maxVertices = 800,
): string {
  const end = Math.max(endIndex, 0)
  if (projected.length === 0 || end < 0) return ''

  const includeMarker =
    markerPoint !== null && markerPoint !== projected[end]
  const vertexCount = end + 1 + (includeMarker ? 1 : 0)
  if (vertexCount <= 0) return ''

  if (vertexCount <= maxVertices) {
    const trail = projected.slice(0, end + 1)
    if (includeMarker) trail.push(markerPoint!)
    return pointsToPath(trail)
  }

  const indices = new Set<number>([0, end])
  const budget = maxVertices - (includeMarker ? 1 : 0)
  for (let i = 1; i < budget - 1; i += 1) {
    indices.add(Math.round((end * i) / (budget - 1)))
  }

  const trail = [...indices]
    .sort((left, right) => left - right)
    .map((index) => projected[index]!)
  if (includeMarker) trail.push(markerPoint!)
  return pointsToPath(trail)
}

/** AiM CSV column names for GPS coordinates. */
export const AIM_GPS_LATITUDE = 'GPS Latitude'
export const AIM_GPS_LONGITUDE = 'GPS Longitude'

export function hasAimGpsColumns(headers: string[]): boolean {
  return headers.includes(AIM_GPS_LATITUDE) && headers.includes(AIM_GPS_LONGITUDE)
}
