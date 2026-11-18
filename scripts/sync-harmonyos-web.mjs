import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = path.join(root, 'dist')
const dest = path.join(root, 'harmonyos', 'entry', 'src', 'main', 'resources', 'rawfile', 'web')

if (!fs.existsSync(path.join(src, 'index.html'))) {
  console.error('未找到 dist/index.html，请先完成前端生产构建。')
  process.exit(1)
}

fs.mkdirSync(dest, { recursive: true })
for (const name of fs.readdirSync(dest)) {
  if (name === '.gitkeep') {
    continue
  }
  fs.rmSync(path.join(dest, name), { recursive: true, force: true })
}

const copyDir = (from, to) => {
  fs.mkdirSync(to, { recursive: true })
  for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
    if (ent.name.endsWith('.map')) {
      continue
    }
    // Service Worker 在虚拟 https 源上会被前端注册；鸿蒙壳不使用离线 SW
    if (ent.name === 'sw.js' && path.resolve(from) === path.resolve(src)) {
      continue
    }
    const a = path.join(from, ent.name)
    const b = path.join(to, ent.name)
    if (ent.isDirectory()) {
      copyDir(a, b)
    } else {
      fs.copyFileSync(a, b)
    }
  }
}

copyDir(src, dest)
console.log(`已将前端静态资源同步到 ${dest}`)
