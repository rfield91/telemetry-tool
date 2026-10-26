import Gauge from '../components/Gauge'
import TrackMap from '../components/TrackMap'
import Bar from '../components/Bar'
import KeyValue, {
  keyValueFrameSize,
  type KeyValueStack,
} from '../components/KeyValue'
import GMeter from '../components/GMeter'
import { samplePoints } from '../lib/gauge'
import type { GpsPoint, SeriesPoint } from '../lib/telemetry'

export interface GaugeDefinition {
  id: string
  type: 'gauge'
  label: string
  unit: string
  min: number
  max: number
  accent?: string
  /** Gauge center as a fraction of frame width (0..1). */
  x: number
  /** Gauge center as a fraction of frame height (0..1). */
  y: number
  /** Gauge diameter as a fraction of frame height (0..1). */
  size: number
  points: SeriesPoint[]
}

export interface TrackMapDefinition {
  id: string
  type: 'track-map'
  label: string
  accent?: string
  /** Center as a fraction of frame width (0..1). */
  x: number
  /** Center as a fraction of frame height (0..1). */
  y: number
  /** Diameter as a fraction of frame height (0..1). */
  size: number
  points: GpsPoint[]
}

export interface BarDefinition {
  id: string
  type: 'bar'
  label: string
  min: number
  max: number
  accent?: string
  /** Center as a fraction of frame width (0..1). */
  x: number
  /** Center as a fraction of frame height (0..1). */
  y: number
  /** Height as a fraction of frame height (0..1). */
  size: number
  points: SeriesPoint[]
}

export interface KeyValueEntryDefinition {
  id: string
  label: string
  unit: string
  accent?: string
  points: SeriesPoint[]
}

export interface KeyValueDefinition {
  id: string
  type: 'key-value'
  accent?: string
  stack: KeyValueStack
  /** Center as a fraction of frame width (0..1). */
  x: number
  /** Center as a fraction of frame height (0..1). */
  y: number
  /** Scale as a fraction of frame height (0..1); maps to vertical plate width. */
  size: number
  entries: KeyValueEntryDefinition[]
}

export interface GMeterDefinition {
  id: string
  type: 'g-meter'
  label: string
  /** Plot range is ±maxG on both axes. */
  maxG: number
  accent?: string
  /** Center as a fraction of frame width (0..1). */
  x: number
  /** Center as a fraction of frame height (0..1). */
  y: number
  /** Diameter as a fraction of frame height (0..1). */
  size: number
  lateralPoints: SeriesPoint[]
  longitudinalPoints: SeriesPoint[]
}

export type OverlayComponentDefinition =
  | GaugeDefinition
  | TrackMapDefinition
  | BarDefinition
  | KeyValueDefinition
  | GMeterDefinition

export interface OverlayDefinition {
  components: OverlayComponentDefinition[]
}

export interface OverlayFrameProps {
  time: number
  width: number
  height: number
  overlay: OverlayDefinition
}

function componentBox(
  component: OverlayComponentDefinition,
  frameHeight: number,
) {
  const sizePx = Math.round(component.size * frameHeight)
  if (component.type === 'bar') {
    // Tall narrow pedal bar: 120×320 aspect
    const height = sizePx
    const width = Math.round(sizePx * (120 / 320))
    return { width, height }
  }
  if (component.type === 'key-value') {
    return keyValueFrameSize(
      component.entries.length,
      component.stack,
      component.size,
      frameHeight,
    )
  }
  return { width: sizePx, height: sizePx }
}

export function OverlayFrame({
  time,
  width,
  height,
  overlay,
}: OverlayFrameProps) {
  return (
    <div
      data-testid="overlay-frame"
      className="relative overflow-hidden bg-transparent"
      style={{ width, height }}
    >
      {overlay.components.map((component) => {
        const box = componentBox(component, height)
        return (
          <div
            key={component.id}
            className="absolute -translate-x-1/2 -translate-y-1/2"
            style={{
              left: Math.round(component.x * width),
              top: Math.round(component.y * height),
              width: box.width,
              height: box.height,
            }}
          >
            {component.type === 'track-map' ? (
              <TrackMap
                points={component.points}
                time={time}
                label={component.label}
                accent={component.accent}
              />
            ) : component.type === 'bar' ? (
              <Bar
                value={samplePoints(component.points, time)}
                min={component.min}
                max={component.max}
                label={component.label}
                accent={component.accent}
              />
            ) : component.type === 'key-value' ? (
              <KeyValue
                stack={component.stack}
                items={component.entries.map((entry) => ({
                  id: entry.id,
                  value: samplePoints(entry.points, time),
                  label: entry.label,
                  unit: entry.unit,
                  accent: entry.accent,
                }))}
              />
            ) : component.type === 'g-meter' ? (
              <GMeter
                lateral={samplePoints(component.lateralPoints, time)}
                longitudinal={samplePoints(component.longitudinalPoints, time)}
                maxG={component.maxG}
                label={component.label}
                accent={component.accent}
              />
            ) : (
              <Gauge
                value={samplePoints(component.points, time)}
                min={component.min}
                max={component.max}
                label={component.label}
                unit={component.unit}
                accent={component.accent}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

export default OverlayFrame
