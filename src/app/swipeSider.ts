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
const startedInDialog = (target: EventTarget | null): boolean =>
  (target instanceof Element && target.closest('[role="dialog"], [aria-modal="true"]') !== null) ||
  document.querySelector('[role="dialog"], [aria-modal="true"]') !== null

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
      if (startedInDialog(event.target) || startedInHScroller(event.target)) {
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
 * 抽屉开着时，从任意位置向左划关回聊天界面（官方就是这样）。
 * 以前只能从正文右划拉出来，拉出来之后手指划不回去，只能点遮罩或左上角「收起」。
 *
 * 监听挂在 document 上而不是抽屉上：抽屉打开后右侧对话区被遮罩盖住，
 * 挂在抽屉元素上收不到从那边开始的滑动，用户就会觉得「只有列表区能滑」。
 *
 * onSwipeEnd 在横向手势结束时回调：touchend 之后浏览器仍可能补发一次 click（落在遮罩上），
 * 调用方据此忽略紧跟着的那次遮罩点击，避免「没滑够、抽屉弹回打开」又被 click 顺手关掉。
 */
export const useSwipeSiderClose = (enabled: boolean, onSwipeEnd: () => void) => {
  useEffect(() => {
    if (!enabled) {
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
      // 横向滚动区域里的左滑是用户在翻内容，不能拿来关抽屉
      if (startedInDialog(event.target) || startedInHScroller(event.target)) {
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

    const onEnd = (event: TouchEvent) => {
      if (!tracking) {
        return
      }
      const wasHorizontal = horizontal
      tracking = false
      horizontal = false
      if (!wasHorizontal) {
        return
      }
      const staysOpen = useMobileSider.getState().progress > 1 - CLOSE_THRESHOLD
      // 主要手段：阻止这次触摸序列补发鼠标事件。touchcancel 不会补发 click，别跟着抑制
      if (event.type === 'touchend') {
        if (event.cancelable) {
          event.preventDefault()
        }
        // 「没拖够、抽屉弹回打开」时才需要调用方吃掉跟手的 click：
        // 否则遮罩的 click 会把抽屉关掉，用户会觉得「滑了一下反而被关」
        if (staysOpen) {
          onSwipeEnd()
        }
      }
      settleSider(staysOpen)
    }

    // bubble 阶段监听 document：抽屉和遮罩上的触摸都能收到，也不用给抽屉元素再挂一套
    document.addEventListener('touchstart', onStart, { passive: true })
    document.addEventListener('touchmove', onMove, { passive: false })
    document.addEventListener('touchend', onEnd)
    document.addEventListener('touchcancel', onEnd)
    return () => {
      document.removeEventListener('touchstart', onStart)
      document.removeEventListener('touchmove', onMove)
      document.removeEventListener('touchend', onEnd)
      document.removeEventListener('touchcancel', onEnd)
    }
  }, [enabled, onSwipeEnd])
}
