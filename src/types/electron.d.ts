declare global {
  interface TelemetryOverlayApi {
    pickFile(kind: 'video' | 'csv'): Promise<string | null>
    pathForDroppedFile(file: File): Promise<string | null>
    fileSize(path: string): Promise<number>
    readRanges(path: string, ranges: Array<{ offset: number; length: number }>): Promise<Uint8Array[]>
    readText(path: string): Promise<string>
    pickSavePath(defaultPath: string): Promise<string | null>
    openOutput(path: string): Promise<number>
    writeOutput(id: number, position: number, bytes: Uint8Array): Promise<void>
    finishOutput(id: number): Promise<void>
    abortOutput(id: number): Promise<void>
    revealFile(path: string): Promise<void>
    loadProfiles(): Promise<unknown>
    saveProfiles(profiles: unknown): Promise<void>
    loadTemplates(): Promise<unknown>
    saveTemplates(templates: unknown): Promise<void>
  }

  interface Window {
    telemetryOverlay?: TelemetryOverlayApi
  }
}

export {}
