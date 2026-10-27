import { isUserProfileDefinition } from '../data/profiles/user'
import { PROJECT_VERSION, type Project } from './schema'

export class ProjectFormatError extends Error {}

export function serializeProject(project: Project, now = new Date()): string {
  return `${JSON.stringify({ ...project, updatedAt: now.toISOString() }, null, 2)}\n`
}

const isString = (value: unknown): value is string => typeof value === 'string'
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new ProjectFormatError(message)
}

function checkArray(value: unknown, name: string, item: (entry: Record<string, unknown>, at: string) => void) {
  check(Array.isArray(value), `${name} must be a list`)
  value.forEach((entry, index) => {
    const at = `${name}[${index}]`
    check(isRecord(entry), `${at} must be an object`)
    item(entry, at)
  })
}

/** Parse and validate a project file. Throws ProjectFormatError with a reason. */
export function parseProject(text: string): Project {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new ProjectFormatError('Not a valid project file (bad JSON)')
  }
  check(isRecord(data), 'Not a valid project file')
  check(isFiniteNumber(data.version), 'Project file has no version')
  check(
    data.version <= PROJECT_VERSION,
    `Project was saved by a newer version of the app (format ${data.version})`,
  )
  // Future format versions migrate here, oldest first.

  check(isString(data.id) && isString(data.name), 'Project id and name are required')
  check(isString(data.createdAt) && isString(data.updatedAt), 'Project timestamps are required')

  checkArray(data.videos, 'videos', (video, at) => {
    check(isString(video.id) && isString(video.name), `${at} needs an id and name`)
    check(Array.isArray(video.paths) && video.paths.length > 0 && video.paths.every(isString), `${at} needs file paths`)
  })
  checkArray(data.telemetry, 'telemetry', (entry, at) => {
    check(isString(entry.id) && isString(entry.path) && isString(entry.name), `${at} needs an id, path and name`)
    check(isString(entry.profileId), `${at} needs a logger profile`)
    check(entry.userProfile === undefined || isUserProfileDefinition(entry.userProfile), `${at} has an invalid mapping`)
  })
  checkArray(data.syncs, 'syncs', (sync, at) => {
    check(isString(sync.id) && isString(sync.videoId) && isString(sync.telemetryId), `${at} needs ids`)
    check(isFiniteNumber(sync.offsetSeconds), `${at} needs an offset`)
    check(sync.drift === undefined || (isFiniteNumber(sync.drift) && Math.abs(sync.drift) < 0.01), `${at} has an invalid drift`)
    check(['camera-imu', 'image-motion', 'manual'].includes(sync.method as string), `${at} has an unknown method`)
    check(sync.confidence === null || isFiniteNumber(sync.confidence), `${at} has an invalid confidence`)
  })
  if (data.selection !== null) {
    const selection = data.selection
    check(isRecord(selection), 'selection must be an object or null')
    check(isString(selection.telemetryId), 'selection needs a telemetry id')
    check(Array.isArray(selection.laps) && selection.laps.every(isFiniteNumber), 'selection laps must be numbers')
    check(isFiniteNumber(selection.leadInSeconds) && isFiniteNumber(selection.leadOutSeconds), 'selection needs lead-in/out')
  }
  check(isRecord(data.layout), 'layout is required')
  checkArray(data.layout.widgets, 'layout.widgets', (widget, at) => {
    check(isString(widget.id) && isString(widget.type), `${at} needs an id and type`)
    const rect = widget.rect
    check(isRecord(rect) && [rect.x, rect.y, rect.w, rect.h].every(isFiniteNumber), `${at} needs a rect`)
    check(isRecord(widget.bindings) && Object.values(widget.bindings).every(isString), `${at} has invalid bindings`)
    check(widget.units === undefined || (isRecord(widget.units) && Object.values(widget.units).every(isString)), `${at} has invalid units`)
    check(isRecord(widget.style), `${at} needs a style object`)
  })
  const exportSettings = data.export
  check(isRecord(exportSettings), 'export settings are required')
  check(exportSettings.codec === 'hevc' || exportSettings.codec === 'avc', 'export codec must be hevc or avc')
  check(exportSettings.bitrateMbps === null || isFiniteNumber(exportSettings.bitrateMbps), 'export bitrate is invalid')
  check(
    exportSettings.resolution === 'source' ||
      (isRecord(exportSettings.resolution) &&
        isFiniteNumber(exportSettings.resolution.width) &&
        isFiniteNumber(exportSettings.resolution.height)),
    'export resolution is invalid',
  )
  check(typeof exportSettings.includeAudio === 'boolean', 'export audio flag is invalid')

  return data as unknown as Project
}
