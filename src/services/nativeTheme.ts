/**
 * Android 系统状态栏图标的明暗。
 * Capacitor 8 在 Android 15 上是边到边（内容画在状态栏下面），所以壁纸一变深，
 * 系统的时间/电量/信号（默认深色图标）就整个看不见了；只能由原生侧改图标外观。
 * 非 Android（网页版 / PWA）没有这个桥，静默跳过。
 */
type NativeBridge = { setLightIcons?: (light: boolean) => void }

const bridge = (): NativeBridge | undefined =>
  (window as unknown as { DSLiteNative?: NativeBridge }).DSLiteNative

/** dark = 背景是深色，此时状态栏图标要反过来用浅色 */
export const setStatusBarIconsDark = (dark: boolean) => {
  try {
    // 名字是「浅色图标」：深色背景 → light=true
    bridge()?.setLightIcons?.(dark)
  } catch {
    // 老 APK 没有这个桥
  }
}

/** 浏览器/PWA 的地址栏颜色跟着背景走 */
export const setThemeColor = (color: string) => {
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) {
    meta.setAttribute('content', color)
  }
}
