import { app, BrowserWindow, dialog, ipcMain, protocol } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { allowFile, fileSize, readRanges, serveFile, type ByteRange } from './files.js'

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.join(currentDir, '..')
const profilesPath = () => path.join(app.getPath('userData'), 'logger-profiles.json')
const templatesPath = () => path.join(app.getPath('userData'), 'layout-templates.json')

async function readJsonList(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown
  } catch {
    return []
  }
}

// `media://local/<encoded path>` streams picked files to <video> with ranges.
protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])

const FILE_FILTERS = {
  video: [{ name: 'Videos', extensions: ['mp4', 'mov', 'MP4', 'MOV'] }],
  csv: [{ name: 'CSV files', extensions: ['csv'] }],
}

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
  protocol.handle('media', (request) => {
    const url = new URL(request.url)
    const filePath = decodeURIComponent(url.pathname.slice(1))
    return serveFile(filePath, request.headers.get('range'))
  })

  ipcMain.handle('file:pick', async (_event, kind: keyof typeof FILE_FILTERS) => {
    const result = await dialog.showOpenDialog({
      title: kind === 'video' ? 'Open video' : 'Open telemetry CSV',
      filters: FILE_FILTERS[kind],
      properties: ['openFile'],
    })
    const filePath = result.canceled ? null : (result.filePaths[0] ?? null)
    if (filePath) allowFile(filePath)
    return filePath
  })

  // Only reachable through the preload's pathForDroppedFile.
  ipcMain.handle('file:allowDropped', (_event, filePath: string) => allowFile(filePath))
  ipcMain.handle('file:size', (_event, filePath: string) => fileSize(filePath))
  ipcMain.handle('file:readRanges', (_event, filePath: string, ranges: ByteRange[]) => readRanges(filePath, ranges))
  ipcMain.handle('file:readText', async (_event, filePath: string) => {
    const size = await fileSize(filePath)
    const [bytes] = await readRanges(filePath, [{ offset: 0, length: size }])
    return new TextDecoder().decode(bytes)
  })

  ipcMain.handle('profiles:load', () => readJsonList(profilesPath()))
  ipcMain.handle('profiles:save', (_event, profiles: unknown) =>
    writeFile(profilesPath(), `${JSON.stringify(profiles, null, 2)}\n`),
  )
  ipcMain.handle('templates:load', () => readJsonList(templatesPath()))
  ipcMain.handle('templates:save', (_event, templates: unknown) =>
    writeFile(templatesPath(), `${JSON.stringify(templates, null, 2)}\n`),
  )

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
