import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  cancelExport,
  exportOverlayVideo,
  type ExportVideoRequest,
} from './exportVideo.js'

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.join(currentDir, '..')

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: '#070b12',
    title: 'Telemetry Overlay',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(currentDir, 'preload.mjs'),
    },
  })

  const devServerUrl = process.env.VITE_DEV_SERVER_URL
  if (devServerUrl) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(path.join(appRoot, 'dist/index.html'))
  }
}

app.whenReady().then(() => {
  ipcMain.handle('csv:open', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Open telemetry CSV',
      filters: [{ name: 'CSV files', extensions: ['csv'] }],
      properties: ['openFile'],
    })

    if (result.canceled || !result.filePaths[0]) return null
    const filePath = result.filePaths[0]

    return {
      name: path.basename(filePath),
      text: await readFile(filePath, 'utf8'),
    }
  })

  ipcMain.handle(
    'export:choose-path',
    async (_event, suggestedName: string) => {
      const result = await dialog.showSaveDialog({
        title: 'Export transparent overlay',
        defaultPath: suggestedName,
        filters: [{ name: 'WebM video', extensions: ['webm'] }],
      })
      return result.canceled ? null : result.filePath
    },
  )

  ipcMain.handle(
    'export:start',
    async (event, request: ExportVideoRequest) =>
      exportOverlayVideo(request, (progress) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('export:progress', progress)
        }
      }),
  )

  ipcMain.handle('export:cancel', (_event, exportId: string) => {
    cancelExport(exportId)
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
