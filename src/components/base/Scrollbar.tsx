import clsx from 'clsx'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react'
import styles from './Scrollbar.module.css'

/** thumb 最小高度：再短就抓不住；手指的实际命中区由 CSS 里 20px 宽的轨道保证 */
const MIN_THUMB_HEIGHT = 36
/** 方向键单次滚动的像素；PageUp/PageDown 用视口高度的九成 */
const KEY_STEP = 40
/** 触摸设备上滚动结束后高亮保持的时长，让用户看清滑块挪到哪了 */
const ACTIVE_HOLD = 600

type Metrics = {
  thumbHeight: number
  thumbTop: number
  /** 可滚动距离：拖动映射和 aria-valuemax 都用它 */
  maxScroll: number
  /** 当前 scrollTop：aria-valuenow 用 */
  value: number
  /** 视口高度：thumb 比例和 PageUp/PageDown 步长都按它算 */
  viewportHeight: number
}

type DragState = {
  pointerId: number
  /** 手指按下时的 clientY，之后所有位移都相对它算 */
  startY: number
  /** 按下时的 scrollTop：拖动只在这个基础上加位移，不按「thumb 顶到哪」反推 */
  startScrollTop: number
  /** 手指每移动 1px，内容滚多少 px（= maxScroll / thumb 可走距离），按下时算好固定住 */
  ratio: number
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

/** 从滚动元素读几何；内容不超过一屏时返回 null（整个滚动条隐藏） */
const measure = (el: HTMLElement): Metrics | null => {
  const { scrollTop, scrollHeight, clientHeight } = el
  const maxScroll = scrollHeight - clientHeight
  // 留 1px 容差：非整数缩放时滚动高度可能只多出零点几像素，不该冒出一条滑块
  if (clientHeight <= 0 || maxScroll <= 1) {
    return null
  }
  const thumbHeight = Math.min(
    clientHeight,
    Math.max(MIN_THUMB_HEIGHT, (clientHeight * clientHeight) / scrollHeight)
  )
  const travel = clientHeight - thumbHeight
  return {
    thumbHeight,
    thumbTop: (scrollTop / maxScroll) * travel,
    maxScroll,
    value: scrollTop,
    viewportHeight: clientHeight,
  }
}

/**
 * 消息区的可拖动滚动条（overlay）。
 * 安卓 WebView 的原生 overlay 滚动条用手根本拖不动，只能看进度，所以自己画一条：
 * thumb 高度按可视比例算，拖动时按「手指位移」换算成 scrollTop（跟手），点轨道跳到对应位置。
 *
 * 拖动必须是相对位移，不能按「指针当前在轨道上的位置」反算 scrollTop：
 * 之前那样写，手指按在 thumb 偏下/偏上的位置时，一移动就会先跳一下，越拖越飘。
 * 现在按下时记下 scrollTop 和 clientY，之后 scrollTop = 起点 + 位移 × 比例，
 * 所以「手指往下一厘米，滑块也往下走一厘米」，和拖原生滑块的手感一致。
 */
export const Scrollbar = ({
  scrollerRef,
  scrollerId,
  onUserScroll,
  className,
}: {
  scrollerRef: RefObject<HTMLElement | null>
  /** 滚动元素的 id，供 aria-controls 指向 */
  scrollerId: string
  /** 用户开始操作滚动条时通知外面（比如停止「跟随底部」） */
  onUserScroll?: () => void
  className?: string
}) => {
  const rootRef = useRef<HTMLDivElement>(null)
  const [metrics, setMetrics] = useState<Metrics | null>(null)
  const [dragging, setDragging] = useState(false)
  const [active, setActive] = useState(false)
  const dragRef = useRef<DragState | null>(null)
  const activeTimerRef = useRef(0)

  const refresh = useCallback(() => {
    const el = scrollerRef.current
    setMetrics(el ? measure(el) : null)
  }, [scrollerRef])

  const markActive = useCallback(() => {
    setActive(true)
    window.clearTimeout(activeTimerRef.current)
    activeTimerRef.current = window.setTimeout(() => setActive(false), ACTIVE_HOLD)
  }, [])

  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (!el) {
      return
    }
    let frame = 0
    const schedule = () => {
      if (frame) {
        return
      }
      frame = requestAnimationFrame(() => {
        frame = 0
        refresh()
      })
    }
    const onScroll = () => {
      markActive()
      schedule()
    }
    refresh()
    el.addEventListener('scroll', onScroll, { passive: true })
    const observer = new ResizeObserver(schedule)
    // 滚动元素自身的尺寸（输入框长高、断点切换）和内容高度（流式输出、加载更早）都要重算；
    // ResizeObserver 只报被观察元素自己的尺寸，所以内容那层要单独观察
    observer.observe(el)
    const content = el.firstElementChild
    if (content) {
      observer.observe(content)
    }
    window.addEventListener('resize', schedule)
    return () => {
      el.removeEventListener('scroll', onScroll)
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      cancelAnimationFrame(frame)
      window.clearTimeout(activeTimerRef.current)
    }
  }, [markActive, refresh, scrollerRef])

  // 移动端 useSwipeSider 在 frame 上监听 touch，横向右拖会拉出会话列表；
  // 手指按住滚动条时在组件内部就截停，避免「拖着滑块往右上带一点」被当成右滑手势。
  // 这里必须用原生监听器：React 的事件挂在 #root，晚于 frame 上的原生监听器触发，stopPropagation 来不及。
  useEffect(() => {
    const node = rootRef.current
    if (!node) {
      return
    }
    const onTouchStart = (event: TouchEvent) => {
      event.stopPropagation()
    }
    node.addEventListener('touchstart', onTouchStart, { passive: true })
    return () => {
      node.removeEventListener('touchstart', onTouchStart)
    }
  }, [])

  /**
   * 拖动期间把 move/up 挂到 window，而不是只靠元素自身的 pointer 事件。
   * 实测：手指一旦离开右侧这条二十几像素的竖条，浏览器就可能不再把 pointermove 送到滚动条上，
   * 表现就是「手一横移就失去控制」。挂到 window 后，无论手指跑到哪都继续跟手；
   * 同时在这个阶段吞掉 touchmove，避免消息列表把这次拖动当成滚动。
   *
   * 拖动一旦开始就只认 pointerId：中途别的手指点上来、列表滚动、布局变化（键盘/tooltip）
   * 都不会把这次拖动抢走，直到抬手或 pointercancel。
   */
  useEffect(() => {
    const onMove = (event: globalThis.PointerEvent) => {
      const drag = dragRef.current
      const el = scrollerRef.current
      if (!drag || !el || drag.pointerId !== event.pointerId) {
        return
      }
      event.preventDefault()
      if (drag.ratio === 0) {
        return
      }
      const next = drag.startScrollTop + (event.clientY - drag.startY) * drag.ratio
      el.scrollTop = clamp(next, 0, el.scrollHeight - el.clientHeight)
    }
    const onEnd = (event: globalThis.PointerEvent) => {
      if (dragRef.current?.pointerId !== event.pointerId) {
        return
      }
      dragRef.current = null
      setDragging(false)
      markActive()
    }
    const onTouchMove = (event: TouchEvent) => {
      if (dragRef.current === null) {
        return
      }
      if (event.cancelable) {
        event.preventDefault()
      }
      event.stopPropagation()
    }
    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', onEnd)
    // capture：抢在消息列表的 touchmove 之前处理，stopPropagation 才来得及
    window.addEventListener('touchmove', onTouchMove, { passive: false, capture: true })
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onEnd)
      window.removeEventListener('pointercancel', onEnd)
      window.removeEventListener('touchmove', onTouchMove, true)
    }
  }, [markActive, scrollerRef])

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    // 只接管主键/单指；右键、多指缩放保持浏览器默认行为
    if (!event.isPrimary || event.button !== 0) {
      return
    }
    const el = scrollerRef.current
    const node = rootRef.current
    const next = el ? measure(el) : null
    if (!el || !node || !next) {
      return
    }
    const rect = node.getBoundingClientRect()
    const y = event.clientY - rect.top
    const travel = next.viewportHeight - next.thumbHeight
    const ratio = travel > 0 ? next.maxScroll / travel : 0
    const onThumb = y >= next.thumbTop && y <= next.thumbTop + next.thumbHeight
    if (!onThumb) {
      // 按在轨道上：先把 thumb 中心挪到手指处（点哪跳哪），后续再按位移继续拖
      const target = travel > 0 ? clamp((y - next.thumbHeight / 2) / travel, 0, 1) : 0
      el.scrollTop = target * next.maxScroll
    }
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startScrollTop: el.scrollTop,
      ratio,
    }
    node.setPointerCapture(event.pointerId)
    // 拖动期间不要选中文字，也不要让触摸滚动/页面手势插进来
    event.preventDefault()
    event.stopPropagation()
    onUserScroll?.()
    markActive()
    setDragging(true)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const el = scrollerRef.current
    if (!el) {
      return
    }
    const page = (measure(el)?.viewportHeight ?? el.clientHeight) * 0.9
    const steps: Record<string, number> = {
      ArrowUp: -KEY_STEP,
      ArrowDown: KEY_STEP,
      PageUp: -page,
      PageDown: page,
    }
    const delta = steps[event.key]
    if (!delta) {
      return
    }
    event.preventDefault()
    el.scrollTop += delta
    onUserScroll?.()
  }

  return (
    <div
      ref={rootRef}
      role="scrollbar"
      aria-controls={scrollerId}
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={metrics ? Math.round(metrics.maxScroll) : 0}
      aria-valuenow={metrics ? Math.round(metrics.value) : 0}
      tabIndex={0}
      className={clsx(styles.root, className)}
      data-visible={metrics ? 'true' : 'false'}
      data-dragging={dragging ? 'true' : 'false'}
      data-active={active ? 'true' : 'false'}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    >
      {metrics ? (
        <div
          className={styles.thumb}
          style={{ top: metrics.thumbTop, height: metrics.thumbHeight }}
        />
      ) : null}
    </div>
  )
}
