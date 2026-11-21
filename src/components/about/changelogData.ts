/* 由 scripts/gen-changelog.mjs 从 CHANGELOG.md 生成，请勿手改 */
export type ChangelogEntry = { version: string; items: string[] }

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '0.9.61',
    items: [
      '修复聊天过程中偶发「写入本机存储失败」且点击重试无效的问题：新增本地存储连接断线自动重连与串行写入队列，并申请持久化存储权限以降低系统清理风险',
    ],
  },
]
