import { useEffect, type RefObject } from 'react'
import {
  MOBILE_SIDER_WIDTH,
  setSiderDrag,
  settleSider,
  useMobileSider,
} from '../components/sider/mobileSiderState.js'

/** 判定横滑要走的像素：太小会把竖滑误判成横滑，太大手感发迟钝 */
const SLOP = 8

/**
 * 手指是不是按在一个「自己能横向滚动」的区域里（宽表格、代码块、公式）。
 * 是的话这次横滑是用户在翻内容，不能拿去开抽屉 —— 否则正文一长，
 * 用户为了看右边被裁掉的文字往左/右滑，抽屉就跟着出来了。
 */
const startedInHScroller = (target: EventTarget | null): boolean => {
  let node = target instanceof Element ? target : null
  while (node && node !== document.body) {
    if (node.scrollWidth - node.clientWidth > 1) {
      const overflowX = getComputedStyle(node).overflowX
      if (overflowX === 'auto' || overflowX === 'scroll' || overflowX === 'overlay') {
        return true
      }
    }
    node = node.parentElement
  }
  return false
}
/** 松手时超过这个进度就吸附到打开，否则收回 */
const OPEN_THRESHOLD = 0.32
/** 抽屉开着时左划：拖过抽屉宽度的这个比例就关回去 */
const CLOSE_THRESHOLD = 0.32

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
      if (startedInHScroller(event.target)) {
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

/**
 * 抽屉开着时，在抽屉上向左划关回聊天界面（官方就是这样）。
 * 以前只能从正文右划拉出来，拉出来之后手指划不回去，只能点遮罩或左上角「收起」。
 * 竖划一律让给会话列表滚动，只有明确横向左拖才接管。
 */
export const useSwipeSiderClose = (ref: RefObject<HTMLElement>, enabled: boolean) => {
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
      if (event.touches.length !== 1 || !useMobileSider.getState().open) {
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
        // 竖划让给列表滚动；往右划不是关闭，放弃
        if (Math.abs(dy) >= Math.abs(dx) || dx > 0) {
          tracking = false
          return
        }
        horizontal = true
      }
      const raw = Math.max(0, -dx) / MOBILE_SIDER_WIDTH()
      const damped = raw > 0.8 ? 0.8 + (raw - 0.8) * 0.35 : raw
      setSiderDrag(Math.max(0, 1 - Math.min(1, damped)))
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
      // progress 还大于 0.68 说明没拖够，弹回打开
      settleSider(useMobileSider.getState().progress > 1 - CLOSE_THRESHOLD)
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
