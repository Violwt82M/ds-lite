import clsx from 'clsx'
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import { IconCloseOutline16 } from './icons.js'
import { IconButton } from './IconButton.js'
import { ScrollPane } from './ScrollPane.js'
import styles from './Modal.module.css'

/** 当前打开的弹窗，后打开的在末尾；叠放时 Esc 只关闭最上层 */
const openModals: object[] = []

/** 遮罩 + 居中卡片，Esc / 点遮罩关闭 */
export const Modal = ({
  title,
  children,
  footer,
  closable = false,
  className,
  mainClassName,
  scrollable = false,
  onClose,
}: {
  title: ReactNode
  children?: ReactNode
  footer?: ReactNode
  /** 标题栏右侧显示关闭按钮 */
  closable?: boolean
  className?: string
  /** 内容区的 class */
  mainClassName?: string
  /** 内容区自身是滚动容器（自带 max-height + overflow-y）时给可拖滚动条 */
  scrollable?: boolean
  onClose: () => void
}) => {
  const t = useTranslate()
  const titleId = useId()
  const contentRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  /**
   * 安卓 WebView 里，全局的 touchmove 防页面滚动会让原生 range 滑杆拖不动。
   * 这里在弹窗内容上接管 range 的指针拖动：按下即定位、捕获指针后跟手移动，
   * 不依赖浏览器的原生滑块手势；桌面端原生拖动和键盘操作不受影响。
   */
  useEffect(() => {
    const root = contentRef.current
    if (root === null) {
      return
    }
    let active: { input: HTMLInputElement; pointerId: number } | null = null

    const write = (input: HTMLInputElement, clientX: number) => {
      const rect = input.getBoundingClientRect()
      if (rect.width <= 0) {
        return
      }
      const min = input.min === '' ? 0 : Number(input.min)
      const max = input.max === '' ? 100 : Number(input.max)
      if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
        return
      }
      const step = input.step === '' || input.step === 'any' ? 0 : Number(input.step)
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
      let value = min + ratio * (max - min)
      if (Number.isFinite(step) && step > 0) {
        value = min + Math.round((value - min) / step) * step
      }
      const next = String(Number(value.toFixed(6)))
      // 走原型 setter，避免 React 的 value tracker 认为值没变而吞掉 onChange
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      if (setter) {
        setter.call(input, next)
      } else {
        input.value = next
      }
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }

    const rangeOf = (target: EventTarget | null) =>
      target instanceof HTMLInputElement && target.type === 'range' && !target.disabled
        ? target
        : null

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' && event.button !== 0) {
        return
      }
      const input = rangeOf(event.target)
      if (input === null) {
        return
      }
      active = { input, pointerId: event.pointerId }
      try {
        input.setPointerCapture(event.pointerId)
      } catch {
        // 老内核不支持指针捕获时，仍可在滑杆范围内拖动
      }
      write(input, event.clientX)
    }

    const onPointerMove = (event: PointerEvent) => {
      if (active === null || event.pointerId !== active.pointerId) {
        return
      }
      write(active.input, event.clientX)
    }

    const onPointerEnd = (event: PointerEvent) => {
      if (active === null || event.pointerId !== active.pointerId) {
        return
      }
      try {
        active.input.releasePointerCapture(event.pointerId)
      } catch {
        // 已经释放或内核不支持，忽略
      }
      active = null
    }

    root.addEventListener('pointerdown', onPointerDown)
    root.addEventListener('pointermove', onPointerMove)
    root.addEventListener('pointerup', onPointerEnd)
    root.addEventListener('pointercancel', onPointerEnd)
    return () => {
      root.removeEventListener('pointerdown', onPointerDown)
      root.removeEventListener('pointermove', onPointerMove)
      root.removeEventListener('pointerup', onPointerEnd)
      root.removeEventListener('pointercancel', onPointerEnd)
    }
  }, [])
  useEffect(() => {
    const token = {}
    openModals.push(token)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && openModals.at(-1) === token) {
        onCloseRef.current()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      openModals.splice(openModals.indexOf(token), 1)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  return createPortal(
    <div
      className={styles.overlay}
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={contentRef}
        className={clsx(styles.content, className)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className={styles.header}>
          <div id={titleId} className={styles.title}>
            {title}
          </div>
          {closable ? (
            <IconButton
              className={styles.close}
              tone="primary"
              icon={<IconCloseOutline16 />}
              aria-label={t('close')}
              onClick={onClose}
            />
          ) : null}
        </div>
        {children ? (
          scrollable ? (
            <ScrollPane contentClassName={clsx(styles.main, mainClassName)}>{children}</ScrollPane>
          ) : (
            <div className={clsx(styles.main, mainClassName)}>{children}</div>
          )
        ) : null}
        {footer ? <div className={styles.footer}>{footer}</div> : null}
      </div>
    </div>,
    document.body
  )
}