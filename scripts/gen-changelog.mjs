import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** 把 CHANGELOG.md 转成关于页里的数据源，避免同一份更新日志维护两次 */
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');

/** 关于页只放最近几版，太老的翻仓库 */
const MAX_VERSIONS = 8;

const entries = [];
let current = null;
for (const rawLine of source.split(/\r?\n/)) {
  const line = rawLine.trim();
  const heading = /^##\s+v?([0-9][0-9A-Za-z.\-]*)/.exec(line);
  if (heading) {
    current = { version: heading[1], items: [] };
    entries.push(current);
    continue;
  }
  if (!current || !line.startsWith('- ')) {
    continue;
  }
  const item = line.slice(2).trim();
  if (item !== '') {
    current.items.push(item);
  }
}

const kept = entries.filter((entry) => entry.items.length > 0).slice(0, MAX_VERSIONS);

const escape = (value) => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

const body = kept
  .map(
    (entry) =>
      `  {\n    version: '${escape(entry.version)}',\n    items: [\n${entry.items
        .map((item) => `      '${escape(item)}',`)
        .join('\n')}\n    ],\n  },`
  )
  .join('\n');

const output = `/* 由 scripts/gen-changelog.mjs 从 CHANGELOG.md 生成，请勿手改 */
export type ChangelogEntry = { version: string; items: string[] }

export const CHANGELOG: ChangelogEntry[] = [
${body}
]
`;

writeFileSync(join(root, 'src/components/about/changelogData.ts'), output);
console.log(`更新日志已生成：${kept.length} 个版本`);
