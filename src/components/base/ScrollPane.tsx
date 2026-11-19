import clsx from 'clsx'
import { useId, useRef, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import { Scrollbar } from './Scrollbar.js'
import styles from './ScrollPane.module.css'

/**
 * 带可拖动滚动条的滚动容器。
 *
 * 消息区之外的面板（设置、记忆、搜索、会话列表、更新日志…）以前用的是系统滚动条：
 * 安卓 WebView 的原生 overlay 滚动条基本只能看、拖不动，长面板翻起来很难受。
 * 这里把「滚动容器 + 可拖 Scrollbar」包成一个组件，谁要滚动就套一层：
 * - 原来的尺寸/flex/padding 类放在 contentClassName（套在内层滚动元素上），布局不变；
 * - 原生滚动条由 .scroller 隐藏，画出来的是 Scrollbar 的 thumb；
 * - 内容不超过一屏时 Scrollbar 自己会隐藏，不需要额外判断。
 *
 * 不要用在外层还有横向滑动手势的地方（比如消息区，那边自己包了一层实现跟随底部）。
 */
export const ScrollPane = ({
  className,
  contentClassName,
  children,
  ...rest
}: {
  className?: string
  /** 滚动元素自己的类（原来的类放这里） */
  contentClassName?: string
  children: ReactNode
} & Omit<ComponentPropsWithoutRef<'div'>, 'className' | 'children'>) => {
  const id = useId()
  const scrollerRef = useRef<HTMLDivElement>(null)
  return (
    <div className={clsx(styles.root, className)}>
      <div
        {...rest}
        id={id}
        ref={scrollerRef}
        className={clsx(styles.scroller, contentClassName)}
      >
        {children}
      </div>
      <Scrollbar scrollerRef={scrollerRef} scrollerId={id} />
    </div>
  )
}
