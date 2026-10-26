import type { OverlayDefinition } from '../renderer/export/OverlayFrame'

declare global {
interface ExportOverlaySetup {
  width: number
  height: number
  overlay: OverlayDefinition
}

interface ExportTelemetryPoint {
  time: number
  value: number
}

interface ExportGpsPoint {
  time: number
  lat: number
  lon: number
}

interface ExportGaugeDefinition {
  id: string
  type: 'gauge'
  label: string
  unit: string
  min: number
  max: number
  accent?: string
  x: number
  y: number
  size: number
  points: ExportTelemetryPoint[]
}

interface ExportTrackMapDefinition {
  id: string
  type: 'track-map'
  label: string
  accent?: string
  x: number
  y: number
  size: number
  points: ExportGpsPoint[]
}

interface ExportBarDefinition {
  id: string
  type: 'bar'
  label: string
  min: number
  max: number
  accent?: string
  x: number
  y: number
  size: number
  points: ExportTelemetryPoint[]
}

interface ExportKeyValueEntryDefinition {
  id: string
  label: string
  unit: string
  accent?: string
  points: ExportTelemetryPoint[]
}

interface ExportKeyValueDefinition {
  id: string
  type: 'key-value'
  accent?: string
  stack: 'vertical' | 'horizontal'
  x: number
  y: number
  size: number
  entries: ExportKeyValueEntryDefinition[]
}

interface ExportGMeterDefinition {
  id: string
  type: 'g-meter'
  label: string
  maxG: number
  accent?: string
  x: number
  y: number
  size: number
  lateralPoints: ExportTelemetryPoint[]
  longitudinalPoints: ExportTelemetryPoint[]
}

type ExportOverlayComponent =
  | ExportGaugeDefinition
  | ExportTrackMapDefinition
  | ExportBarDefinition
  | ExportKeyValueDefinition
  | ExportGMeterDefinition

interface ExportVideoRequest {
  id: string
  outputPath: string
  width: number
  height: number
  fps: number
  /** Telemetry time (seconds) of the first exported frame. Defaults to 0. */
  startTime?: number
  /** Length of the exported clip in seconds. */
  duration: number
  overlay: {
    components: ExportOverlayComponent[]
  }
}

interface ExportProgress {
  id: string
  frame: number
  totalFrames: number
  percent: number
  status: 'rendering' | 'encoding' | 'complete'
}

interface TelemetryOverlayApi {
  openCsv(): Promise<{ name: string; text: string } | null>
  chooseExportPath(suggestedName: string): Promise<string | null>
  startExport(
    request: ExportVideoRequest,
  ): Promise<{ outputPath: string; totalFrames: number }>
  cancelExport(exportId: string): Promise<void>
  onExportProgress(listener: (progress: ExportProgress) => void): () => void
}

  interface Window {
    telemetryOverlay?: TelemetryOverlayApi
    setExportOverlay?: (setup: ExportOverlaySetup) => Promise<boolean>
    renderOverlayFrame?: (time: number) => Promise<boolean>
  }
}

export {}
