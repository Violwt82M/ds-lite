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
 * thumb 高度按可视比例算，按住拖动时直接改滚动元素的 scrollTop（跟手），点轨道跳到对应位置。
 * 组件不持有滚动状态，每次从 scrollerRef 现读，所以切换会话、分页、搜索跳转后位置都由原生滚动驱动刷新。
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
  const dragRef = useRef<{ pointerId: number; grab: number; rectTop: number } | null>(null)
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
    const onTouchMove = (event: TouchEvent) => {
      if (event.cancelable) {
        event.preventDefault()
      }
      event.stopPropagation()
    }
    node.addEventListener('touchstart', onTouchStart, { passive: true })
    node.addEventListener('touchmove', onTouchMove, { passive: false })
    return () => {
      node.removeEventListener('touchstart', onTouchStart)
      node.removeEventListener('touchmove', onTouchMove)
    }
  }, [])

  /** 让 thumb 的抓取点对齐指针 y（相对轨道顶部）；拖动中内容变高也能按最新比例换算 */
  const scrollToPointer = (el: HTMLElement, y: number, grab: number) => {
    const next = measure(el)
    if (!next) {
      return
    }
    const travel = next.viewportHeight - next.thumbHeight
    el.scrollTop = (travel > 0 ? clamp((y - grab) / travel, 0, 1) : 0) * next.maxScroll
  }

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
    const onThumb = y >= next.thumbTop && y <= next.thumbTop + next.thumbHeight
    // 按在 thumb 上保住手指相对 thumb 的位置；按在轨道上先把 thumb 中心挪到手指处，再接着拖
    const grab = onThumb ? y - next.thumbTop : next.thumbHeight / 2
    if (!onThumb) {
      scrollToPointer(el, y, grab)
    }
    dragRef.current = { pointerId: event.pointerId, grab, rectTop: rect.top }
    node.setPointerCapture(event.pointerId)
    // 拖动期间不要选中文字，也不要让触摸滚动/页面手势插进来
    event.preventDefault()
    event.stopPropagation()
    onUserScroll?.()
    setDragging(true)
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    const el = scrollerRef.current
    if (!drag || !el || drag.pointerId !== event.pointerId) {
      return
    }
    scrollToPointer(el, event.clientY - drag.rectTop, drag.grab)
    event.preventDefault()
    event.stopPropagation()
  }

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) {
      return
    }
    dragRef.current = null
    setDragging(false)
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
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
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
