// 构建后生成 Service Worker：把这次构建的静态资源写进预缓存清单，
// 让网页版在第一次成功打开之后，即使站点连不上也能直接打开（安卓内嵌版本用不到这个文件）。
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');
const CACHEABLE = new Set([
  '.js',
  '.css',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.png',
  '.svg',
  '.jpg',
  '.jpeg',
  '.webp',
  '.ico',
  '.json',
  '.webmanifest',
]);

/** 递归收集需要预缓存的文件（相对 dist 的 posix 路径） */
const collect = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collect(full));
      continue;
    }
    const ext = extname(entry.name).toLowerCase();
    if (!CACHEABLE.has(ext) && entry.name !== 'index.html') continue;
    out.push(relative(dist, full).split(sep).join('/'));
  }
  return out;
};

const files = collect(dist).sort();
if (!files.includes('index.html')) {
  throw new Error('dist/index.html 不存在，构建似乎没有成功');
}

// 首屏必需的文件必须缓存成功；其余（懒加载的图表、公式字体等）尽力而为，
// 失败了不影响首次打开，等用户联网用到时再按需缓存。
const isCore = (file) =>
  file === 'index.html' ||
  file === 'manifest.webmanifest' ||
  file === 'LICENSE' ||
  /^icon-\d+\.png$/.test(file) ||
  /^static\/js\/[^/]+\.js$/.test(file) ||
  /^static\/css\/[^/]+\.css$/.test(file);
const core = files.filter(isCore);
const rest = files.filter((file) => !isCore(file));

// 版本号取自文件清单与内容，构建出任何差异都会换一个缓存名
const hash = createHash('sha256');
for (const file of files) {
  hash.update(file);
  hash.update(readFileSync(join(dist, file)));
  hash.update(String(statSync(join(dist, file)).size));
}
const version = hash.digest('hex').slice(0, 10);

const totalBytes = files.reduce((sum, file) => sum + statSync(join(dist, file)).size, 0);

const sw = `// 由 scripts/gen-sw.mjs 自动生成，请勿手动修改
const CACHE = 'ds-lite-${version}';
const CORE = ${JSON.stringify(core, null, 2)};
const REST = ${JSON.stringify(rest, null, 2)};

const cacheFile = async (cache, asset) => {
  const response = await fetch(asset, { cache: 'no-cache' });
  if (!response || !response.ok) throw new Error('fetch failed: ' + asset);
  await cache.put(asset, response);
};

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // 首屏文件严格缓存，缺一个就重来
      await Promise.all(CORE.map((asset) => cacheFile(cache, asset)));
      // 其余资源后台尽力缓存，失败不算错
      await Promise.allSettled(REST.map((asset) => cacheFile(cache, asset)));
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // 只接管本站静态资源，API 请求（api.deepseek.com）一律直连，不缓存
  if (url.origin !== self.location.origin) return;

  // 只有应用本体（站点根 / index.html）才走离线外壳，其他页面（如 check.html）交给浏览器
  const scopePath = new URL('./', self.registration.scope).pathname;
  const isShell = url.pathname === scopePath || url.pathname === scopePath + 'index.html';

  // 打开页面：有缓存就先给缓存（秒开），后台顺手拉一份新的
  if (request.mode === 'navigate') {
    if (!isShell) return;
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const cached = await cache.match('index.html');
        const network = fetch(request)
          .then((response) => {
            if (response && response.ok) cache.put('index.html', response.clone());
            return response;
          })
          .catch(() => undefined);
        if (cached) return cached;
        const response = await network;
        return response || Response.error();
      })()
    );
    return;
  }

  // 静态资源：文件名带内容哈希，缓存优先
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;
      try {
        const response = await fetch(request);
        if (response && response.ok) cache.put(request, response.clone());
        return response;
      } catch (error) {
        return Response.error();
      }
    })()
  );
});
`;

writeFileSync(join(dist, 'sw.js'), sw);
console.log(
  `Service Worker 已生成：${files.length} 个文件（首屏 ${core.length} 个 / ${(totalBytes / 1024 / 1024).toFixed(2)} MB），版本 ${version}`
);
