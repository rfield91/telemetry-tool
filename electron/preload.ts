import { contextBridge, ipcRenderer } from 'electron'

const api = {
  openCsv: () =>
    ipcRenderer.invoke('csv:open') as Promise<{
      path: string
      name: string
      text: string
    } | null>,
}

contextBridge.exposeInMainWorld('telemetryOverlay', api)
