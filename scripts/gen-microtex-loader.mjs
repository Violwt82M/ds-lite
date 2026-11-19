// 生成 public/microtex 下的两个资源：
//   microtex-loader.js —— 官方前端（chat.deepseek.com）异步 chunk 55223 的模块表包装成普通脚本，
//                        执行后 window.__dsMicrotexFactory 就是引擎工厂；
//   microtex.wasm      —— 官方 microtex-wasm.c7b36d1fce.wasm（MicroTeX 编译产物）。
//
// 什么时候要重新生成：官网升级后 chunk 哈希/内容会变（旧资源还能用，但和线上版本会漂移）。
// 用法（先把官方这两个文件下载到本地）：
//   node scripts/gen-microtex-loader.mjs <55223.xxx.js> <microtex-wasm.xxx.wasm>
// 官方文件地址在 chat.deepseek.com 的 main.*.js 里：h.u / h.k 两张表能查到 katex / 55223 的哈希。
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const out = join(root, 'public', 'microtex')
const [chunkPath, wasmPath] = process.argv.slice(2)
if (!chunkPath || !wasmPath) {
  console.error('用法：node scripts/gen-microtex-loader.mjs <chunk.js> <microtex-wasm.wasm>')
  process.exit(1)
}

const chunk = readFileSync(chunkPath, 'utf8')
const header = [
  '/* 由 scripts/gen-microtex-loader.mjs 生成，不要手改。',
  ' * 引擎：MicroTeX（https://github.com/NanoMichael/MicroTeX），wasm 与胶水层来自 DeepSeek 官方前端，',
  ' * 用途：KaTeX 解析失败的公式（美化包那类）按官方同一条链降级成 SVG 渲染。',
  ' * 这里把官方 rspack 异步 chunk 包成普通脚本：捕获模块表 → 执行胶水模块 58378 → 挂出工厂函数。',
  ' */',
  '(function () {',
  '  var chunk = []',
  '  self.rspackChunk_deepseek_chat = chunk',
].join('\n')
// 胶水层会 t(64038) 这样引入一堆 core-js polyfill；浏览器原生都有，用可调用的桩顶掉
const footer = [
  '  var modules = chunk[0][1]',
  '  var cache = {}',
  '  var stub = new Proxy(function () { return stub }, {',
  '    get: function () { return stub },',
  '    apply: function () { return stub },',
  '    construct: function () { return stub },',
  '  })',
  '  function req(id) {',
  '    if (cache[id]) return cache[id].exports',
  '    var fn = modules[id]',
  '    if (!fn) return stub',
  '    var mod = { exports: {} }',
  '    cache[id] = mod',
  '    fn(mod, mod.exports, req)',
  '    return mod.exports',
  '  }',
  '  req.d = function (obj, defs) {',
  '    Object.keys(defs).forEach(function (key) {',
  '      Object.defineProperty(obj, key, { get: defs[key], enumerable: true, configurable: true })',
  '    })',
  '  }',
  // wasm 由调用方通过 wasmBinary 传入，这里只兜 emscripten 自己的 URL 推导
  "  req.p = ''",
  '  req.n = function (m) { return m && m.__esModule ? m.default : m }',
  "  self.__dsMicrotexFactory = req('58378').default",
  '})()',
].join('\n')

writeFileSync(join(out, 'microtex-loader.js'), header + '\n' + chunk + '\n' + footer)
copyFileSync(wasmPath, join(out, 'microtex.wasm'))
console.log('已生成：', join(out, 'microtex-loader.js'), '与', join(out, 'microtex.wasm'))
