import { createReadStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'

/**
 * Dev-only file access for running the renderer in a plain browser (the
 * Electron app uses IPC and the media:// protocol instead). Serves local
 * files by absolute path to loopback clients only; never part of a build.
 *
 *   GET  /__dev/file?path=…    file with HTTP range support
 *   GET  /__dev/size?path=…    file size in bytes
 *   POST /__dev/ranges?path=…  body [{offset,length}] → bytes concatenated
 */
export function devFileServer(): Plugin {
  return {
    name: 'dev-file-server',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__dev', (req, res) => {
        handle(req, res).catch((error: unknown) => {
          res.statusCode = 500
          res.end(String(error))
        })
      })
    },
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) {
    res.statusCode = 403
    res.end()
    return
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  const filePath = url.searchParams.get('path')
  if (!filePath) {
    res.statusCode = 400
    res.end('path is required')
    return
  }
  const size = (await stat(filePath)).size

  if (url.pathname === '/size') {
    res.end(String(size))
    return
  }

  if (url.pathname === '/ranges' && req.method === 'POST') {
    const ranges = JSON.parse(await readBody(req)) as Array<{ offset: number; length: number }>
    const handle = await open(filePath, 'r')
    try {
      const parts = await Promise.all(
        ranges.map(async ({ offset, length }) => {
          const clamped = Math.max(0, Math.min(length, size - offset))
          const buffer = Buffer.alloc(clamped)
          if (clamped > 0) await handle.read(buffer, 0, clamped, offset)
          return buffer
        }),
      )
      res.setHeader('Content-Type', 'application/octet-stream')
      res.end(Buffer.concat(parts))
    } finally {
      await handle.close()
    }
    return
  }

  if (url.pathname === '/file') {
    const type = /\.(mp4|m4v)$/i.test(filePath) ? 'video/mp4' : /\.mov$/i.test(filePath) ? 'video/quicktime' : 'text/plain; charset=utf-8'
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Content-Type', type)
    const match = req.headers.range?.match(/bytes=(\d*)-(\d*)/)
    if (!match) {
      res.setHeader('Content-Length', String(size))
      createReadStream(filePath).pipe(res)
      return
    }
    const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
    const end = Math.min(match[1] && match[2] ? Number(match[2]) : size - 1, size - 1)
    if (start > end) {
      res.statusCode = 416
      res.setHeader('Content-Range', `bytes */${size}`)
      res.end()
      return
    }
    res.statusCode = 206
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
    res.setHeader('Content-Length', String(end - start + 1))
    createReadStream(filePath, { start, end }).pipe(res)
    return
  }

  res.statusCode = 404
  res.end()
}
