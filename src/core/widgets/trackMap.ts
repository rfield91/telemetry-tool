import { fitToBox, localPoint, projectToLocal, toBox, type BoxFit, type LocalProjection } from '../data/gps'
import { roundedPanel, TEXT } from './draw'
import type { WidgetDefinition } from './types'

export interface TrackMapStyle {
  [key: string]: unknown
  accent: string
  lineColor: string
}

const DESIGN = 320
const MAX_POINTS = 3000

interface Prepared {
  projection: LocalProjection
  fit: BoxFit
}

/** Track outline from the session's GPS, with the car's position. */
export const trackMapWidget: WidgetDefinition<TrackMapStyle, Prepared | null> = {
  type: 'trackMap',
  label: 'Track map',
  inputs: [
    { name: 'latitude', label: 'Latitude', channel: 'latitude' },
    { name: 'longitude', label: 'Longitude', channel: 'longitude' },
  ],
  aspect: 1,
  styleFields: [
    { key: 'accent', label: 'Car colour', kind: 'color' },
    { key: 'lineColor', label: 'Track colour', kind: 'color' },
  ],
  defaultStyle() {
    return { accent: '#38bdf8', lineColor: 'rgba(255,255,255,0.4)' }
  },
  drawStatic(ctx, size, style, data) {
    const s = Math.min(size.width, size.height) / DESIGN
    roundedPanel(ctx, 0, 0, size.width, size.height, 18 * s)
    const lat = data.series('latitude')
    const lon = data.series('longitude')
    if (!lat || !lon || lat.times.length < 2) return null

    // Sample both channels on the latitude timeline, decimated: the outline
    // is static, so a few thousand points are plenty.
    const step = Math.max(1, Math.floor(lat.times.length / MAX_POINTS))
    const lats: number[] = []
    const lons: number[] = []
    for (let i = 0; i < lat.times.length; i += step) {
      const lonValue = data.valueAt('longitude', lat.times[i]!)
      if (lonValue === null) continue
      lats.push(lat.values[i]!)
      lons.push(lonValue)
    }
    const projection = projectToLocal(lats, lons)
    const fit = fitToBox(projection, size.width, size.height, 28 * s)

    ctx.strokeStyle = style.lineColor
    ctx.lineWidth = 4 * s
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.beginPath()
    for (let i = 0; i < projection.x.length; i += 1) {
      const p = toBox(fit, projection.x[i]!, projection.y[i]!)
      if (i === 0) ctx.moveTo(p.x, p.y)
      else ctx.lineTo(p.x, p.y)
    }
    ctx.stroke()
    return { projection, fit }
  },
  drawDynamic(ctx, size, style, data, prepared) {
    if (!prepared) return
    const lat = data.value('latitude')
    const lon = data.value('longitude')
    if (lat === null || lon === null) return
    const s = Math.min(size.width, size.height) / DESIGN
    const local = localPoint(prepared.projection, lat, lon)
    const p = toBox(prepared.fit, local.x, local.y)
    ctx.fillStyle = style.accent
    ctx.strokeStyle = TEXT
    ctx.lineWidth = 3 * s
    ctx.beginPath()
    ctx.arc(p.x, p.y, 9 * s, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
  },
}
