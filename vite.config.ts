import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import electron from 'vite-plugin-electron/simple'

const rootDir = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    electron({
      main: {
        entry: 'electron/main.ts',
      },
      preload: {
        input: path.join(rootDir, 'electron/preload.ts'),
      },
      renderer: {},
    }),
  ],
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
  },
})
