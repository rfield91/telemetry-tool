import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'
import electron from 'vite-plugin-electron/simple'
import { devFileServer } from './dev/fileServer.js'

const rootDir = path.dirname(fileURLToPath(import.meta.url))
const { version } = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8')) as { version: string }

/**
 * Content-Security-Policy for the built app only (the dev server needs
 * inline scripts for hot reload). Workers are inline blobs; video streams
 * from media://.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' media:",
  "connect-src 'self' media:",
  "font-src 'self' data:",
].join('; ')

function contentSecurityPolicy(): Plugin {
  return {
    name: 'content-security-policy',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace('<head>', `<head>
    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
  }
}

// `vite --mode browser` (npm run dev:browser) serves the renderer alone for
// testing in a plain browser, without launching Electron.
export default defineConfig(({ mode }) => ({
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [
    react(),
    tailwindcss(),
    devFileServer(),
    contentSecurityPolicy(),
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
