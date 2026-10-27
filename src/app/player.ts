import { runtimeStore } from './state'

type Listener = () => void

/**
 * Playback clock for the preview. Drives the attached <video> element, or a
 * virtual clock when only telemetry is loaded.
 */
class Player {
  private video: HTMLVideoElement | null = null
  private virtualTime = 0
  private virtualStart: { wall: number; time: number } | null = null
  private raf = 0
  private readonly listeners = new Set<Listener>()
  /** Seconds; set from the video or telemetry duration. */
  duration = 0
  fps = 30

  attach(video: HTMLVideoElement | null) {
    this.stopVirtual()
    this.video = video
    if (video) {
      video.onplay = () => runtimeStore.setState({ playing: true })
      video.onpause = () => runtimeStore.setState({ playing: false })
      video.onended = () => runtimeStore.setState({ playing: false })
    }
    runtimeStore.setState({ playing: false })
  }

  /** Called on each virtual-clock tick (no video). */
  onTick(listener: Listener) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  get time(): number {
    if (this.video) return this.video.currentTime
    if (this.virtualStart) {
      return Math.min(this.duration, this.virtualStart.time + (performance.now() - this.virtualStart.wall) / 1000)
    }
    return this.virtualTime
  }

  get playing(): boolean {
    return this.video ? !this.video.paused : this.virtualStart !== null
  }

  play() {
    if (this.video) {
      void this.video.play()
      return
    }
    if (this.virtualStart || this.duration <= 0) return
    if (this.virtualTime >= this.duration) this.virtualTime = 0
    this.virtualStart = { wall: performance.now(), time: this.virtualTime }
    runtimeStore.setState({ playing: true })
    const tick = () => {
      this.listeners.forEach((listener) => listener())
      if (this.time >= this.duration) {
        this.pause()
        return
      }
      this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)
  }

  pause() {
    if (this.video) {
      this.video.pause()
      return
    }
    this.virtualTime = this.time
    this.stopVirtual()
    runtimeStore.setState({ playing: false })
    this.listeners.forEach((listener) => listener())
  }

  toggle() {
    if (this.playing) this.pause()
    else this.play()
  }

  seek(time: number) {
    const clamped = Math.min(Math.max(0, time), this.duration || 0)
    if (this.video) {
      this.video.currentTime = clamped
    } else {
      this.virtualTime = clamped
      if (this.virtualStart) this.virtualStart = { wall: performance.now(), time: clamped }
      this.listeners.forEach((listener) => listener())
    }
    runtimeStore.setState({ time: clamped })
  }

  /** Step whole frames (pauses first). */
  step(frames: number) {
    this.pause()
    const frame = Math.floor(this.time * this.fps + 1e-6) + frames
    // Aim mid-frame so the decoder lands on the intended frame.
    this.seek((frame + 0.5) / this.fps)
  }

  private stopVirtual() {
    cancelAnimationFrame(this.raf)
    this.virtualStart = null
  }
}

export const player = new Player()
