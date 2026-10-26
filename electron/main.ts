import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
      path: filePath,
      name: path.basename(filePath),
      text: await readFile(filePath, 'utf8'),
    }
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
