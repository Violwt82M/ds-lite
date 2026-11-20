/* 由 scripts/gen-changelog.mjs 从 CHANGELOG.md 生成，请勿手改 */
export type ChangelogEntry = { version: string; items: string[] }

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '0.9.60',
    items: [
      '新增「气泡不透明度」自定义滑杆（设置 → 通用 → 自定义外观，30%~100%，默认 68%），搭配聊天背景可自由调节毛玻璃通透度',
      '去掉气泡高光描边，恢复简洁细腻的边框观感',
    ],
  },
]
