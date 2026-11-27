import { Capacitor } from '@capacitor/core'

/**
 * 平台能力统一入口：
 * UI 与业务层只查询「具备哪些能力」，不再各自散落调用 Capacitor.isNativePlatform()，
 * 便于安卓、网页、鸿蒙多端统一维护。
 */
const isCapacitorNative = (): boolean => Capacitor.isNativePlatform()

const isHarmonyOs = (): boolean =>
  typeof window !== 'undefined' && window.__DS_LITE_PLATFORM__ === 'harmonyos'

export const platform = {
  /** 是否运行在 Capacitor 安卓原生外壳中 */
  isNativeApp: (): boolean => isCapacitorNative(),
  /** 是否运行在鸿蒙外壳中 */
  isHarmonyApp: (): boolean => isHarmonyOs(),
  /** 是否为任意原生外壳（不需要网页 PWA 添加到桌面引导） */
  isShellApp: (): boolean => isCapacitorNative() || isHarmonyOs(),
  /** 是否支持安卓原生私有目录文件存储 */
  hasNativeFs: (): boolean => isCapacitorNative(),
  /** 是否支持系统原生文件分享 */
  canShareFiles: (): boolean => isCapacitorNative(),
  /** 是否支持按下载链接直接拉取归档 ZIP */
  canDownloadArchiveByUrl: (): boolean => isCapacitorNative(),
  /** 是否支持接收系统分享传入的 ZIP 归档 */
  canReceiveSharedArchive: (): boolean => isCapacitorNative(),
  /** 是否支持开启临时局域网快传服务 */
  canHostLanTransfer: (): boolean => isCapacitorNative(),
  /** 是否支持应用内检查并安装 APK 更新 */
  canInstallApk: (): boolean => isCapacitorNative(),
} as const
