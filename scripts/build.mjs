import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

rmSync(join(root, 'dist'), { recursive: true, force: true });

execFileSync(process.execPath, [join(root, 'node_modules/@rspack/cli/bin/rspack.js'), 'build', '-c', 'rspack.config.ts'], {
  stdio: 'inherit',
  cwd: root,
  env: { ...process.env, NODE_ENV: 'production' },
});
