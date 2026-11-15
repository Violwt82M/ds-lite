// 本地静态服务器：只用于人工测试，把 dist 目录挂在 127.0.0.1 上
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('./dist/', import.meta.url))
const PORT = Number(process.argv[2] ?? 7788)
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  let path = normalize(join(ROOT, decodeURIComponent(url.pathname)))
  if (!path.startsWith(ROOT.replace(/\\/g, '/').replace(/\/$/, '')) && !path.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden')
    return
  }
  try {
    const info = await stat(path)
    if (info.isDirectory()) {
      path = join(path, 'index.html')
    }
  } catch {
    path = join(ROOT, 'index.html')
  }
  try {
    const body = await readFile(path)
    res.writeHead(200, {
      'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    })
    res.end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log('serving ' + ROOT + ' at http://127.0.0.1:' + PORT)
})