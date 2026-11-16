const http = require('http')
const fs = require('fs')
const path = require('path')
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' }
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0])
  if (p === '/') p = '/index.html'
  const file = path.join('dist', p)
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('nf'); return }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' })
    res.end(data)
  })
}).listen(8765, '127.0.0.1', () => console.log('up'))
