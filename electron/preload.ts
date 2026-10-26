import { contextBridge, ipcRenderer } from 'electron'
import type {
  ExportProgress,
  ExportVideoRequest,
} from './exportVideo.js'

const api = {
  openCsv: () =>
    ipcRenderer.invoke('csv:open') as Promise<{
      name: string
      text: string
    } | null>,
  chooseExportPath: (suggestedName: string) =>
    ipcRenderer.invoke(
      'export:choose-path',
      suggestedName,
    ) as Promise<string | null>,
  startExport: (request: ExportVideoRequest) =>
    ipcRenderer.invoke('export:start', request) as Promise<{
      outputPath: string
      totalFrames: number
    }>,
  cancelExport: (exportId: string) =>
    ipcRenderer.invoke('export:cancel', exportId) as Promise<void>,
  onExportProgress: (listener: (progress: ExportProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: ExportProgress) =>
      listener(progress)
    ipcRenderer.on('export:progress', handler)
    return () => ipcRenderer.removeListener('export:progress', handler)
  },
}

contextBridge.exposeInMainWorld('telemetryOverlay', api)
