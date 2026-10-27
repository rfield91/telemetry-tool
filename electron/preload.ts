import { contextBridge, ipcRenderer, webUtils } from 'electron'

interface ByteRange {
  offset: number
  length: number
}

const api = {
  pickFile: (kind: 'video' | 'csv') => ipcRenderer.invoke('file:pick', kind) as Promise<string | null>,
  /**
   * Path of a dropped file, allowed for reading. Only a real dropped File
   * yields a path, so the main process's picked-files rule still holds.
   */
  pathForDroppedFile: async (file: File) => {
    const path = webUtils.getPathForFile(file)
    if (!path) return null
    await ipcRenderer.invoke('file:allowDropped', path)
    return path
  },
  fileSize: (path: string) => ipcRenderer.invoke('file:size', path) as Promise<number>,
  readRanges: (path: string, ranges: ByteRange[]) =>
    ipcRenderer.invoke('file:readRanges', path, ranges) as Promise<Uint8Array[]>,
  readText: (path: string) => ipcRenderer.invoke('file:readText', path) as Promise<string>,
  pickSavePath: (defaultPath: string) => ipcRenderer.invoke('file:pickSave', defaultPath) as Promise<string | null>,
  openOutput: (path: string) => ipcRenderer.invoke('file:openOutput', path) as Promise<number>,
  writeOutput: (id: number, position: number, bytes: Uint8Array) =>
    ipcRenderer.invoke('file:writeOutput', id, position, bytes) as Promise<void>,
  finishOutput: (id: number) => ipcRenderer.invoke('file:finishOutput', id) as Promise<void>,
  abortOutput: (id: number) => ipcRenderer.invoke('file:abortOutput', id) as Promise<void>,
  revealFile: (path: string) => ipcRenderer.invoke('file:reveal', path) as Promise<void>,
  writeLog: (level: 'info' | 'warn' | 'error', message: string) => ipcRenderer.invoke('log:write', level, message) as Promise<void>,
  revealLogs: () => ipcRenderer.invoke('log:reveal') as Promise<string>,
  loadProfiles: () => ipcRenderer.invoke('profiles:load') as Promise<unknown>,
  saveProfiles: (profiles: unknown) => ipcRenderer.invoke('profiles:save', profiles) as Promise<void>,
  loadTemplates: () => ipcRenderer.invoke('templates:load') as Promise<unknown>,
  saveTemplates: (templates: unknown) => ipcRenderer.invoke('templates:save', templates) as Promise<void>,
}

contextBridge.exposeInMainWorld('telemetryOverlay', api)
