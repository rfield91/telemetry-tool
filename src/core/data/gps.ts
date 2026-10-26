const EARTH_RADIUS_M = 6_378_137

export interface LocalProjection {
  /** East offset in metres from the reference point, per sample. */
  x: Float64Array
  /** North offset in metres from the reference point, per sample. */
  y: Float64Array
  refLat: number
  refLon: number
}

/**
 * Project lat/lon (degrees) onto a local east/north plane in metres around
 * the track's mid-latitude. Accurate to well under a metre across a circuit.
 */
export function projectToLocal(lat: ArrayLike<number>, lon: ArrayLike<number>): LocalProjection {
  let minLat = Infinity
  let maxLat = -Infinity
  let minLon = Infinity
  let maxLon = -Infinity
  for (let i = 0; i < lat.length; i += 1) {
    minLat = Math.min(minLat, lat[i]!)
    maxLat = Math.max(maxLat, lat[i]!)
    minLon = Math.min(minLon, lon[i]!)
    maxLon = Math.max(maxLon, lon[i]!)
  }
  const refLat = lat.length > 0 ? (minLat + maxLat) / 2 : 0
  const refLon = lat.length > 0 ? (minLon + maxLon) / 2 : 0
  const metersPerDegLat = (Math.PI / 180) * EARTH_RADIUS_M
  const metersPerDegLon = metersPerDegLat * Math.cos((refLat * Math.PI) / 180)

  const x = new Float64Array(lat.length)
  const y = new Float64Array(lat.length)
  for (let i = 0; i < lat.length; i += 1) {
    x[i] = (lon[i]! - refLon) * metersPerDegLon
    y[i] = (lat[i]! - refLat) * metersPerDegLat
  }
  return { x, y, refLat, refLon }
}

export interface BoxFit {
  scale: number
  offsetX: number
  offsetY: number
}

/**
 * Uniform scale and offset that fit local points into a `width`×`height` box
 * (screen coordinates, y down, north up) with `padding`, preserving aspect.
 */
export function fitToBox(projection: LocalProjection, width: number, height: number, padding = 0): BoxFit {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (let i = 0; i < projection.x.length; i += 1) {
    minX = Math.min(minX, projection.x[i]!)
    maxX = Math.max(maxX, projection.x[i]!)
    minY = Math.min(minY, projection.y[i]!)
    maxY = Math.max(maxY, projection.y[i]!)
  }
  if (!Number.isFinite(minX)) return { scale: 1, offsetX: width / 2, offsetY: height / 2 }
  // A stationary track still gets a small envelope so a marker can be drawn.
  const spanX = Math.max(maxX - minX, 1)
  const spanY = Math.max(maxY - minY, 1)
  const innerW = Math.max(width - padding * 2, 1)
  const innerH = Math.max(height - padding * 2, 1)
  const scale = Math.min(innerW / spanX, innerH / spanY)
  // Centre the track in the box. Screen y grows downward, so north (larger
  // y) maps to smaller screen y.
  return {
    scale,
    offsetX: width / 2 - ((minX + maxX) / 2) * scale,
    offsetY: height / 2 + ((minY + maxY) / 2) * scale,
  }
}

export function toBox(fit: BoxFit, x: number, y: number): { x: number; y: number } {
  return { x: fit.offsetX + x * fit.scale, y: fit.offsetY - y * fit.scale }
}
