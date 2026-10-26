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
  loadProfiles: () => ipcRenderer.invoke('profiles:load') as Promise<unknown>,
  saveProfiles: (profiles: unknown) => ipcRenderer.invoke('profiles:save', profiles) as Promise<void>,
  loadTemplates: () => ipcRenderer.invoke('templates:load') as Promise<unknown>,
  saveTemplates: (templates: unknown) => ipcRenderer.invoke('templates:save', templates) as Promise<void>,
}

contextBridge.exposeInMainWorld('telemetryOverlay', api)
