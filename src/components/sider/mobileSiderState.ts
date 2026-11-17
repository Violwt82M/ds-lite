import { create } from 'zustand'

/**
 * 移动端侧边栏抽屉：顶栏菜单按钮打开，也可以从正文任意位置向右拖出来。
 * progress 是 0~1 的跟手进度（1 = 完全展开），dragging 表示手指还在屏幕上——
 * 拖动时必须关掉过渡，否则抽屉会追着手指"打滑"。
 */
type MobileSiderState = { open: boolean; progress: number; dragging: boolean }

export const useMobileSider = create<MobileSiderState>(() => ({
  open: false,
  progress: 0,
  dragging: false,
}))

export const openMobileSider = () =>
  useMobileSider.setState({ open: true, progress: 1, dragging: false })

export const closeMobileSider = () =>
  useMobileSider.setState({ open: false, progress: 0, dragging: false })

/** 拖动中：progress 跟手，先不做过渡 */
export const setSiderDrag = (progress: number) =>
  useMobileSider.setState({ open: false, progress, dragging: true })

/** 松手后按进度吸附到开或关 */
export const settleSider = (open: boolean) =>
  useMobileSider.setState({ open, progress: open ? 1 : 0, dragging: false })
