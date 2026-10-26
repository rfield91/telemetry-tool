declare global {
  interface TelemetryOverlayApi {
    pickFile(kind: 'video' | 'csv'): Promise<string | null>
    pathForDroppedFile(file: File): Promise<string | null>
    fileSize(path: string): Promise<number>
    readRanges(path: string, ranges: Array<{ offset: number; length: number }>): Promise<Uint8Array[]>
    readText(path: string): Promise<string>
    loadProfiles(): Promise<unknown>
    saveProfiles(profiles: unknown): Promise<void>
  }

  interface Window {
    telemetryOverlay?: TelemetryOverlayApi
  }
}

export {}
