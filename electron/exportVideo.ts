import { BrowserWindow, app, type WebContents } from 'electron'
import { once } from 'node:events'
import { type FileHandle, copyFile, mkdtemp, open, rm, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { vp9AlphaOutputArgs } from './vp9AlphaArgs.js'

export interface ExportTelemetryPoint {
  time: number
  value: number
}

export interface ExportGpsPoint {
  time: number
  lat: number
  lon: number
}

export interface ExportGaugeDefinition {
  id: string
  type: 'gauge'
  label: string
  unit: string
  min: number
  max: number
  accent?: string
  x: number
  y: number
  size: number
  points: ExportTelemetryPoint[]
}

export interface ExportTrackMapDefinition {
  id: string
  type: 'track-map'
  label: string
  accent?: string
  x: number
  y: number
  size: number
  points: ExportGpsPoint[]
}

export interface ExportBarDefinition {
  id: string
  type: 'bar'
  label: string
  min: number
  max: number
  accent?: string
  x: number
  y: number
  size: number
  points: ExportTelemetryPoint[]
}

export interface ExportKeyValueEntryDefinition {
  id: string
  label: string
  unit: string
  accent?: string
  points: ExportTelemetryPoint[]
}

export interface ExportKeyValueDefinition {
  id: string
  type: 'key-value'
  accent?: string
  stack: 'vertical' | 'horizontal'
  x: number
  y: number
  size: number
  entries: ExportKeyValueEntryDefinition[]
}

export interface ExportGMeterDefinition {
  id: string
  type: 'g-meter'
  label: string
  maxG: number
  accent?: string
  x: number
  y: number
  size: number
  lateralPoints: ExportTelemetryPoint[]
  longitudinalPoints: ExportTelemetryPoint[]
}

export type ExportOverlayComponent =
  | ExportGaugeDefinition
  | ExportTrackMapDefinition
  | ExportBarDefinition
  | ExportKeyValueDefinition
  | ExportGMeterDefinition

export interface ExportVideoRequest {
  id: string
  outputPath: string
  width: number
  height: number
  fps: number
  /** Telemetry time (seconds) of the first exported frame. Defaults to 0. */
  startTime?: number
  /** Length of the exported clip in seconds. */
  duration: number
  overlay: {
    components: ExportOverlayComponent[]
  }
}

export interface ExportProgress {
  id: string
  frame: number
  totalFrames: number
  percent: number
  status: 'rendering' | 'encoding' | 'complete'
}

interface ExportJob {
  cancelled: boolean
  process?: ChildProcessWithoutNullStreams
}

const jobs = new Map<string, ExportJob>()
const currentDir = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.join(currentDir, '..')
const require = createRequire(import.meta.url)
const ffmpegStatic = require('ffmpeg-static') as string | null
const PAINT_TIMEOUT_MS = 15_000
/** Recycle the offscreen window to release native Chromium paint buffers. */
const FRAMES_PER_RENDER_WINDOW = 150
/** Render/encode this many frames per temp chunk (~2.5 GB at 1080p). */
const FRAMES_PER_CHUNK = 300
/** Rendering occupies this share of overall progress before final concat. */
const RENDER_PROGRESS_SHARE = 0.92

function getFfmpegPath(): string {
  if (!ffmpegStatic) {
    throw new Error('The bundled FFmpeg executable could not be located.')
  }

  return app.isPackaged
    ? ffmpegStatic.replace('app.asar', 'app.asar.unpacked')
    : ffmpegStatic
}

function validateRequest(request: ExportVideoRequest) {
  if (!request.id || !request.outputPath) {
    throw new Error('An export ID and output path are required.')
  }
  if (
    !Number.isInteger(request.width) ||
    !Number.isInteger(request.height) ||
    request.width < 64 ||
    request.height < 64
  ) {
    throw new Error('Export dimensions must be whole numbers of at least 64px.')
  }
  if (!Number.isFinite(request.fps) || request.fps < 1 || request.fps > 120) {
    throw new Error('Frame rate must be between 1 and 120 fps.')
  }
  const startTime = request.startTime ?? 0
  if (!Number.isFinite(startTime) || startTime < 0) {
    throw new Error('Export start time must be a non-negative number.')
  }
  if (
    !Number.isFinite(request.duration) ||
    request.duration <= 0 ||
    request.duration > 24 * 60 * 60
  ) {
    throw new Error('Export duration must be between 0 and 24 hours.')
  }
  if (request.overlay.components.length === 0) {
    throw new Error('At least one overlay component is required.')
  }
  if (request.overlay.components.some((component) => !hasTelemetry(component))) {
    throw new Error('Every overlay component needs telemetry points.')
  }
}

function hasTelemetry(component: ExportOverlayComponent): boolean {
  switch (component.type) {
    case 'gauge':
    case 'bar':
    case 'track-map':
      return component.points.length > 0
    case 'key-value':
      return (
        component.entries.length > 0 &&
        component.entries.every((entry) => entry.points.length > 0)
      )
    case 'g-meter':
      return (
        component.lateralPoints.length > 0 &&
        component.longitudinalPoints.length > 0
      )
  }
}

function createExportRenderWindow(
  width: number,
  height: number,
  fps: number,
) {
  const window = new BrowserWindow({
    width,
    height,
    show: false,
    transparent: true,
    frame: false,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      offscreen: { useSharedTexture: false },
    },
  })
  window.setContentSize(width, height)
  window.webContents.setFrameRate(fps)
  window.webContents.startPainting()
  return window
}

function destroyExportRenderWindow(window?: BrowserWindow) {
  if (!window || window.isDestroyed()) return
  window.webContents.stopPainting()
  window.destroy()
}

async function loadExportWindow(window: BrowserWindow) {
  const devServerUrl = process.env.VITE_DEV_SERVER_URL
  if (devServerUrl) {
    const url = new URL(devServerUrl)
    url.searchParams.set('export', '1')
    await window.loadURL(url.toString())
  } else {
    await window.loadFile(path.join(appRoot, 'dist/index.html'), {
      search: 'export=1',
    })
  }

  await window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        if (
          typeof window.setExportOverlay === 'function' &&
          typeof window.renderOverlayFrame === 'function'
        ) {
          return resolve(true);
        }
        if (Date.now() - started > 10000) {
          return reject(new Error('Export renderer did not initialize.'));
        }
        setTimeout(check, 20);
      };
      check();
    })
  `)
}

async function setupExportOverlay(
  window: BrowserWindow,
  overlaySetup: {
    width: number
    height: number
    overlay: ExportVideoRequest['overlay']
  },
) {
  await window.webContents.executeJavaScript(
    `window.setExportOverlay(${JSON.stringify(overlaySetup)})`,
  )
}

function frameBitmapFromImage(
  image: Electron.NativeImage,
  width: number,
  height: number,
) {
  const size = image.getSize()
  const sized =
    size.width === width && size.height === height
      ? image
      : image.resize({ width, height, quality: 'good' })
  return sized.toBitmap()
}

function waitForPaintFrame(
  webContents: WebContents,
  width: number,
  height: number,
) {
  webContents.removeAllListeners('paint')

  return new Promise<Buffer>((resolve, reject) => {
    const timeout = setTimeout(() => {
      webContents.removeListener('paint', onPaint)
      reject(new Error('Timed out waiting for rendered frame.'))
    }, PAINT_TIMEOUT_MS)

    const onPaint = (
      _details: Electron.Event,
      _dirtyRect: Electron.Rectangle,
      image: Electron.NativeImage,
    ) => {
      clearTimeout(timeout)
      try {
        resolve(frameBitmapFromImage(image, width, height))
      } catch (error) {
        reject(error)
      }
    }

    webContents.once('paint', onPaint)
  })
}

async function renderAndCaptureFrame(
  webContents: WebContents,
  width: number,
  height: number,
  time: number,
) {
  await webContents.executeJavaScript(
    `window.renderOverlayFrame(${JSON.stringify(time)})`,
  )
  const paintPromise = waitForPaintFrame(webContents, width, height)
  webContents.invalidate()
  return paintPromise
}

async function prepareExportRenderWindow(
  request: ExportVideoRequest,
  overlaySetup: {
    width: number
    height: number
    overlay: ExportVideoRequest['overlay']
  },
) {
  const window = createExportRenderWindow(
    request.width,
    request.height,
    request.fps,
  )
  await loadExportWindow(window)
  await setupExportOverlay(window, overlaySetup)
  return window
}

async function renderFrameRangeToRawFile(
  request: ExportVideoRequest,
  overlaySetup: {
    width: number
    height: number
    overlay: ExportVideoRequest['overlay']
  },
  rawFile: FileHandle,
  job: ExportJob,
  startFrame: number,
  endFrame: number,
  totalFrames: number,
  onProgress: (progress: ExportProgress) => void,
  renderWindow: BrowserWindow,
  framesInWindow: number,
) {
  const startTime = request.startTime ?? 0
  const endTime = startTime + request.duration
  let window = renderWindow
  let framesSinceWindowStart = framesInWindow

  for (let frame = startFrame; frame < endFrame; frame += 1) {
    if (job.cancelled) throw new Error('Export cancelled.')

    if (
      framesSinceWindowStart > 0 &&
      framesSinceWindowStart % FRAMES_PER_RENDER_WINDOW === 0
    ) {
      destroyExportRenderWindow(window)
      window = await prepareExportRenderWindow(request, overlaySetup)
      framesSinceWindowStart = 0
    }

    const time = Math.min(startTime + frame / request.fps, endTime)
    const bitmap = await renderAndCaptureFrame(
      window.webContents,
      request.width,
      request.height,
      time,
    )
    await rawFile.write(bitmap)
    framesSinceWindowStart += 1

    onProgress({
      id: request.id,
      frame: frame + 1,
      totalFrames,
      percent: ((frame + 1) / totalFrames) * RENDER_PROGRESS_SHARE,
      status: 'rendering',
    })
  }

  return { window, framesInWindow: framesSinceWindowStart }
}

function rawVideoInputArgs(
  request: ExportVideoRequest,
  inputPath: string,
  frameCount?: number,
) {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'bgra',
    '-s',
    `${request.width}x${request.height}`,
    '-framerate',
    String(request.fps),
    '-i',
    inputPath,
    ...(frameCount ? ['-frames:v', String(frameCount)] : []),
  ]
}

async function runFfmpeg(args: string[], job: ExportJob): Promise<void> {
  const ffmpeg = spawn(getFfmpegPath(), args, { windowsHide: true })
  job.process = ffmpeg

  let stderr = ''
  ffmpeg.stderr.setEncoding('utf8')
  ffmpeg.stderr.on('data', (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-8192)
  })

  const [exitCode] = (await once(ffmpeg, 'close')) as [number | null]
  job.process = undefined
  if (job.cancelled) throw new Error('Export cancelled.')
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `FFmpeg exited with code ${exitCode}.`)
  }
}

async function encodeRawChunk(
  rawPath: string,
  outputPath: string,
  request: ExportVideoRequest,
  frameCount: number,
  job: ExportJob,
) {
  await runFfmpeg(
    [
      ...rawVideoInputArgs(request, rawPath, frameCount),
      ...vp9AlphaOutputArgs(outputPath),
    ],
    job,
  )
}

async function concatWebmSegments(
  segmentPaths: string[],
  outputPath: string,
  job: ExportJob,
) {
  if (job.cancelled) throw new Error('Export cancelled.')

  if (segmentPaths.length === 1) {
    await copyFile(segmentPaths[0]!, outputPath)
    return
  }

  const listPath = path.join(path.dirname(segmentPaths[0]!), 'segments.txt')
  const listBody = segmentPaths
    .map((segmentPath) => {
      const normalized = segmentPath.replace(/\\/g, '/')
      return `file '${normalized.replace(/'/g, "'\\''")}'`
    })
    .join('\n')
  await writeFile(listPath, listBody)

  await runFfmpeg(
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listPath,
      '-c',
      'copy',
      '-y',
      outputPath,
    ],
    job,
  )
}

export function cancelExport(exportId: string) {
  const job = jobs.get(exportId)
  if (!job) return
  job.cancelled = true
  job.process?.stdin.destroy()
  job.process?.kill()
}

export async function exportOverlayVideo(
  request: ExportVideoRequest,
  onProgress: (progress: ExportProgress) => void,
) {
  validateRequest(request)
  if (jobs.has(request.id)) {
    throw new Error('An export with this ID is already running.')
  }

  const job: ExportJob = { cancelled: false }
  jobs.set(request.id, job)
  const totalFrames = Math.max(1, Math.ceil(request.duration * request.fps))
  const overlaySetup = {
    width: request.width,
    height: request.height,
    overlay: request.overlay,
  }
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), 'telemetry-overlay-export-'),
  )
  const segmentPaths: string[] = []
  let completed = false
  let renderWindow = await prepareExportRenderWindow(request, overlaySetup)
  let framesInWindow = 0

  try {
    for (let chunkStart = 0; chunkStart < totalFrames; chunkStart += FRAMES_PER_CHUNK) {
      if (job.cancelled) throw new Error('Export cancelled.')

      const chunkEnd = Math.min(chunkStart + FRAMES_PER_CHUNK, totalFrames)
      const chunkFrameCount = chunkEnd - chunkStart
      const chunkRawPath = path.join(tempDir, `chunk-${chunkStart}.raw`)
      const chunkVideoPath = path.join(tempDir, `chunk-${chunkStart}.webm`)
      const rawFile = await open(chunkRawPath, 'w')

      try {
        const next = await renderFrameRangeToRawFile(
          request,
          overlaySetup,
          rawFile,
          job,
          chunkStart,
          chunkEnd,
          totalFrames,
          onProgress,
          renderWindow,
          framesInWindow,
        )
        renderWindow = next.window
        framesInWindow = next.framesInWindow
      } finally {
        await rawFile.close()
      }

      await encodeRawChunk(
        chunkRawPath,
        chunkVideoPath,
        request,
        chunkFrameCount,
        job,
      )
      await unlink(chunkRawPath).catch(() => undefined)
      segmentPaths.push(chunkVideoPath)
    }

    onProgress({
      id: request.id,
      frame: totalFrames,
      totalFrames,
      percent: RENDER_PROGRESS_SHARE,
      status: 'encoding',
    })

    await concatWebmSegments(segmentPaths, request.outputPath, job)

    completed = true
    onProgress({
      id: request.id,
      frame: totalFrames,
      totalFrames,
      percent: 1,
      status: 'complete',
    })
    return { outputPath: request.outputPath, totalFrames }
  } finally {
    destroyExportRenderWindow(renderWindow)
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    if (!completed) {
      await unlink(request.outputPath).catch(() => undefined)
    }
    jobs.delete(request.id)
  }
}
