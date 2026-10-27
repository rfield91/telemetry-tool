import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  abortOutput,
  allowFile,
  allowWrite,
  fileSize,
  finishOutput,
  isWritable,
  openOutput,
  readRanges,
  serveFile,
  writeOutput,
  type ByteRange,
} from './files.js'

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

// Hardware HEVC encoding through WebCodecs (export) is behind a feature flag.
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCEncoderSupport')

// `media://local/<encoded path>` streams picked files to <video> with ranges.
protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])

const FILE_FILTERS = {
  video: [{ name: 'Videos', extensions: ['mp4', 'mov', 'MP4', 'MOV'] }],
  csv: [{ name: 'CSV files', extensions: ['csv'] }],
}

/**
 * Dev-only export test: TELEMETRY_OVERLAY_AUTOTEST='{"video":…,"csv":…,"export":…,"laps":"5,7"}'
 * opens the files, exports, prints the renderer's EXPORT_RESULT line and quits.
 */
function autotestQuery(): Record<string, string> | null {
  const raw = process.env.TELEMETRY_OVERLAY_AUTOTEST
  if (!raw || app.isPackaged) return null
  const job = JSON.parse(raw) as Record<string, string>
  for (const file of [job.video, job.csv]) if (file) allowFile(file)
  if (job.export) allowWrite(job.export)
  return Object.fromEntries(Object.entries(job).filter(([, value]) => typeof value === 'string'))
}

function createWindow() {
  const query = autotestQuery()
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

  if (query) {
    window.webContents.on('console-message', (event) => {
      if (event.level === 'warning' || event.level === 'error') console.log(`[renderer ${event.level}] ${event.message}`)
      if (!event.message.startsWith('EXPORT_RESULT')) return
      console.log(event.message)
      app.quit()
    })
    window.webContents.on('render-process-gone', (_event, details) => console.log(`[renderer gone] ${JSON.stringify(details)}`))
    app.on('child-process-gone', (_event, details) => console.log(`[child process gone] ${JSON.stringify(details)}`))
  }

  const devServerUrl = process.env.VITE_DEV_SERVER_URL
  if (devServerUrl) {
    void window.loadURL(query ? `${devServerUrl}?${new URLSearchParams(query)}` : devServerUrl)
  } else {
    void window.loadFile(path.join(appRoot, 'dist/index.html'), query ? { query } : undefined)
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

  ipcMain.handle('file:pickSave', async (_event, defaultPath: string) => {
    const result = await dialog.showSaveDialog({
      title: 'Export video',
      defaultPath,
      filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
    })
    if (result.canceled || !result.filePath) return null
    allowWrite(result.filePath)
    return result.filePath
  })
  ipcMain.handle('file:openOutput', (_event, filePath: string) => openOutput(filePath))
  ipcMain.handle('file:writeOutput', (_event, id: number, position: number, bytes: Uint8Array) => writeOutput(id, position, bytes))
  ipcMain.handle('file:finishOutput', (_event, id: number) => finishOutput(id))
  ipcMain.handle('file:abortOutput', (_event, id: number) => abortOutput(id))
  ipcMain.handle('file:reveal', (_event, filePath: string) => {
    if (isWritable(filePath)) shell.showItemInFolder(filePath)
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
