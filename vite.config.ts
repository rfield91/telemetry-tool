import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import electron from 'vite-plugin-electron/simple'
import { devFileServer } from './dev/fileServer.js'

const rootDir = path.dirname(fileURLToPath(import.meta.url))

// `vite --mode browser` (npm run dev:browser) serves the renderer alone for
// testing in a plain browser, without launching Electron.
export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    tailwindcss(),
    devFileServer(),
    ...(mode === 'browser'
      ? []
      : [
          electron({
            main: {
              entry: 'electron/main.ts',
            },
            preload: {
              input: path.join(rootDir, 'electron/preload.ts'),
            },
            renderer: {},
          }),
        ]),
  ],
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
  },
}))
