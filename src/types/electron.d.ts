declare global {
  interface TelemetryOverlayApi {
    openCsv(): Promise<{ path: string; name: string; text: string } | null>
  }

  interface Window {
    telemetryOverlay?: TelemetryOverlayApi
  }
}

export {}
