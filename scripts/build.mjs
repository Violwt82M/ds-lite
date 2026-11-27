import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// 断言三处版本号一致，防止发版漏改（package.json / src/version.ts / android/app/build.gradle）
const pkgVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const tsVersion = /export const APP_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(
  readFileSync(join(root, 'src/version.ts'), 'utf8')
)?.[1];
const gradleVersion = /versionName\s+["']([^"']+)["']/.exec(
  readFileSync(join(root, 'android/app/build.gradle'), 'utf8')
)?.[1];
if (!pkgVersion || pkgVersion !== tsVersion || pkgVersion !== gradleVersion) {
  throw new Error(
    `版本号不一致：package.json=${pkgVersion}，src/version.ts=${tsVersion}，android/app/build.gradle=${gradleVersion}`
  );
}

rmSync(join(root, 'dist'), { recursive: true, force: true });

// 更新日志由 CHANGELOG.md 生成，保证关于页和仓库同一份来源
execFileSync(process.execPath, [join(root, 'scripts/gen-changelog.mjs')], {
  stdio: 'inherit',
  cwd: root,
});

execFileSync(process.execPath, [join(root, 'node_modules/@rspack/cli/bin/rspack.js'), 'build', '-c', 'rspack.config.ts'], {
  stdio: 'inherit',
  cwd: root,
  env: { ...process.env, NODE_ENV: 'production' },
});

// 生成离线缓存用的 Service Worker（网页版专用，安卓包内不影响）
execFileSync(process.execPath, [join(root, 'scripts/gen-sw.mjs')], {
  stdio: 'inherit',
  cwd: root,
});
