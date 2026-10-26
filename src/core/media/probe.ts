import { detectCamera } from './cameras/registry'
import type { RandomAccessFile } from './file'
import { readMp4, trackFrameRate, type Mp4Info } from './mp4'

const CODEC_NAMES: Record<string, string> = {
  hvc1: 'HEVC',
  hev1: 'HEVC',
  avc1: 'H.264',
  avc3: 'H.264',
  av01: 'AV1',
  vp09: 'VP9',
  mp4a: 'AAC',
}

export interface VideoProbe {
  fileSize: number
  duration: number
  /** Camera clock at recording start (ISO string); often wrong, a hint only. */
  creationTime: string | null
  video: {
    trackId: number
    codec: string
    width: number
    height: number
    fps: number
    frameCount: number
    rotation: 0 | 90 | 180 | 270
  }
  audio: { codec: string } | null
  camera: {
    adapterId: string
    label: string
    model: string | null
    /** Motion data available for auto-sync, or null. */
    motionSource: string | null
  } | null
}

export async function probeVideo(file: RandomAccessFile): Promise<{ probe: VideoProbe; info: Mp4Info }> {
  const info = await readMp4(file)
  // Cameras add thumbnail tracks (e.g. DJI's MJPEG), so pick the longest
  // visual track rather than the first.
  const video = info.tracks
    .filter((track) => track.handler === 'vide' && track.samples.sizes.length > 1)
    .sort((a, b) => b.samples.sizes.length - a.samples.sizes.length)[0]
  if (!video) throw new Error('No video track found in this file')
  const audio = info.tracks.find((track) => track.handler === 'soun')

  const adapter = detectCamera(info)
  const identity = adapter?.identify ? await adapter.identify(file, info) : { model: null }

  return {
    info,
    probe: {
      fileSize: file.size,
      duration: info.duration || video.duration,
      creationTime: info.creationTime?.toISOString() ?? null,
      video: {
        trackId: video.id,
        codec: CODEC_NAMES[video.format] ?? video.format,
        width: video.width ?? 0,
        height: video.height ?? 0,
        fps: trackFrameRate(video) ?? 30,
        frameCount: video.samples.sizes.length,
        rotation: video.rotation,
      },
      audio: audio ? { codec: CODEC_NAMES[audio.format] ?? audio.format } : null,
      camera: adapter
        ? { adapterId: adapter.id, label: adapter.label, model: identity.model, motionSource: adapter.motionSource(info) }
        : null,
    },
  }
}
