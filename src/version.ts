/**
 * 版本号的唯一来源。
 *
 * 0.9.31 之前版本号散在四处且互相不一致：package.json 的 0.1.1、构建注入到 HTML meta 的 0.1.1、
 * 关于页的 APP_VERSION 0.9.30、android/app/build.gradle 的 0.9.29。
 * 「自动检测更新」要拿当前版本去和 GitHub Release 比，基准错了就永远显示「已是最新」。
 *
 * 以后要改版本，只改这里 + android/app/build.gradle（Gradle 读不到 TS，必须手动同步）。
 */
export const APP_VERSION = '0.9.57'

/**
 * 发布渠道：beta = 公开测试版（关于页/更新内容弹窗带标记，提示可能有问题、请走反馈），
 * release = 正式版。只影响界面文案与标记，不参与版本比较（更新检测仍用 APP_VERSION）。
 */
export const APP_CHANNEL: 'beta' | 'release' = 'release'

/** 上游开源项目 chat-demo 的版本，展示用；不参与更新比较 */
export const UPSTREAM_VERSION = '0.1.1'
