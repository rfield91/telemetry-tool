import { StrictMode, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import {
  OverlayFrame,
  type OverlayDefinition,
} from './renderer/export/OverlayFrame'

export interface ExportOverlaySetup {
  width: number
  height: number
  overlay: OverlayDefinition
}

const rootElement = document.getElementById('root')!
const root = createRoot(rootElement)
const isExportRenderer = new URLSearchParams(window.location.search).has(
  'export',
)

function waitForAnimationFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve())
  })
}

function ExportRenderer() {
  const setupRef = useRef<ExportOverlaySetup | null>(null)
  const [time, setTime] = useState<number | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    window.setExportOverlay = async (setup: ExportOverlaySetup) => {
      setupRef.current = setup
      flushSync(() => {
        setTime(null)
        setReady(true)
      })
      await document.fonts.ready
      await waitForAnimationFrame()
      return true
    }

    window.renderOverlayFrame = async (nextTime: number) => {
      flushSync(() => {
        setTime(nextTime)
      })
      await waitForAnimationFrame()
      await waitForAnimationFrame()
      return true
    }

    return () => {
      delete window.setExportOverlay
      delete window.renderOverlayFrame
    }
  }, [])

  const setup = setupRef.current
  if (!ready || !setup || time === null) return null
  return (
    <OverlayFrame
      time={time}
      width={setup.width}
      height={setup.height}
      overlay={setup.overlay}
    />
  )
}

if (isExportRenderer) {
  document.documentElement.style.background = 'transparent'
  document.body.style.background = 'transparent'
  document.body.style.overflow = 'hidden'
  root.render(<ExportRenderer />)
} else {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
