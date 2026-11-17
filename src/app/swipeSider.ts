import { useEffect, type RefObject } from 'react'
import { MOBILE_SIDER_WIDTH } from '../components/sider/Sider.js'
import { setSiderDrag, settleSider, useMobileSider } from '../components/sider/mobileSiderState.js'

/** 判定横滑要走的像素：太小会把竖滑误判成横滑，太大手感发迟钝 */
const SLOP = 8
/** 松手时超过这个进度就吸附到打开，否则收回 */
const OPEN_THRESHOLD = 0.32

/**
 * 在聊天区任意位置向右拉出会话列表，跟手 + 松手吸附（官方那个弹簧感）。
 * 竖滑一律让给页面滚动，只有明确是横向右拖才接管，并阻止默认滚动。
 */
export const useSwipeSider = (ref: RefObject<HTMLElement>, enabled: boolean) => {
  useEffect(() => {
    const el = ref.current
    if (!enabled || !el) {
      return
    }
    let startX = 0
    let startY = 0
    let tracking = false
    let horizontal = false

    const onStart = (event: TouchEvent) => {
      if (event.touches.length !== 1 || useMobileSider.getState().open) {
        return
      }
      const touch = event.touches[0]
      startX = touch.clientX
      startY = touch.clientY
      tracking = true
      horizontal = false
    }

    const onMove = (event: TouchEvent) => {
      if (!tracking || event.touches.length !== 1) {
        return
      }
      const touch = event.touches[0]
      const dx = touch.clientX - startX
      const dy = touch.clientY - startY
      if (!horizontal) {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) {
          return
        }
        // 竖的、或者往左的，都不是拉抽屉，彻底放弃这次手势
        if (Math.abs(dy) >= Math.abs(dx) || dx < 0) {
          tracking = false
          return
        }
        horizontal = true
      }
      // 拖过抽屉宽度之后加阻尼，别让抽屉被拉出屏幕好几倍
      const raw = Math.max(0, dx) / MOBILE_SIDER_WIDTH()
      const damped = raw > 0.8 ? 0.8 + (raw - 0.8) * 0.35 : raw
      setSiderDrag(Math.min(1, damped))
      if (event.cancelable) {
        event.preventDefault()
      }
    }

    const onEnd = () => {
      if (!tracking) {
        return
      }
      tracking = false
      if (!horizontal) {
        return
      }
      settleSider(useMobileSider.getState().progress > OPEN_THRESHOLD)
    }

    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd)
    el.addEventListener('touchcancel', onEnd)
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
    }
  }, [enabled, ref])
}
