import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import {
  buildMessageVersions,
  getVisibleMessages,
  type MessageVersions,
} from '../../services/chat/branches.js'
import { selectMessageVersion } from '../../services/chat/store.js'
import { useSessionPersona } from '../../services/persona/scope.js'
import { usePersona } from '../../services/persona/store.js'
import type { Session } from '../../services/chat/types.js'
import { useTranslate } from '../../i18n/index.js'
import { closeSearchPanel } from '../search/searchPanelState.js'
import { Scrollbar } from '../base/Scrollbar.js'
import { AssistantMessage } from './AssistantMessage.js'
import { ScrollToBottomContext } from './scrollContext.js'
import { clearJump, useJumpTarget } from '../../services/chat/jumpTarget.js'
import { UserMessage } from './UserMessage.js'
import type { Message } from '../../services/chat/types.js'
import styles from './MessageList.module.css'

/**
 * 会话共用可重试的附件上传失败入口，覆盖当前提问与历史消息中的附件。
 * 点击后按失败的回答重新补传附件并请求。
 */
const getUploadRetryId = (messages: Message[], streaming: boolean) => {
  const last = messages.at(-1)
  return !streaming &&
    last?.role === 'assistant' &&
    last.status === 'error' &&
    last.error?.kind === 'upload' &&
    last.error.retryable
    ? last.id
    : null
}

/** 距底部小于该值时视为在底部，流式内容增长时跟随 */
const STICKY_THRESHOLD = 40
/** 一次渲染的消息条数上限；导入的长会话可能有几千条，全渲染会卡死 */
const RENDER_PAGE = 200
/**
 * 从搜索结果跳进来时只渲染目标前后各这么多条。
 * 旧实现为了跳一条消息把「从这条到最新」全部渲染出来，4000 条的会话要渲染 4000 个
 * Markdown 组件，这就是「点结果跳转卡半天」的根因。
 */
const JUMP_CONTEXT = 30
/** 滚动元素的 id：滚动条用它做 aria-controls，也能让读屏软件知道滑块控制的是消息区 */
const SCROLLER_ID = 'message-list-scroller'
const EMPTY_VERSIONS: MessageVersions = { ids: [], index: -1 }

/** 当前渲染窗口：从 start 开始渲染，尾部留 tail 条不渲染（tail>0 说明跳进了历史里） */
type WindowState = { sessionId: string; start: number; tail: number }

const defaultWindow = (sessionId: string, length: number): WindowState => ({
  sessionId,
  start: Math.max(0, length - RENDER_PAGE),
  tail: 0,
})

const windowAround = (sessionId: string, index: number, length: number): WindowState => ({
  sessionId,
  start: Math.max(0, index - JUMP_CONTEXT),
  tail: Math.max(0, length - index - JUMP_CONTEXT),
})

export const MessageList = ({
  session,
  streaming,
  footer,
}: {
  session: Session
  streaming: boolean
  footer: React.ReactNode
}) => {
  const isMobile = useIsMobile()
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const stickyRef = useRef(true)
  const scrollTopRef = useRef(0)
  const restoreScrollRef = useRef<{ messageId: string; top: number } | null>(null)
  const t = useTranslate()
  const messages = getVisibleMessages(session)
  // 从搜索结果点进来时，首帧就直接渲染目标附近：先渲染 200 条再改窗口是白费一次重排
  const [windowState, setWindowState] = useState<WindowState>(() => {
    const target = useJumpTarget.getState().target
    if (target && target.sessionId === session.id) {
      const index = messages.findIndex((message) => message.id === target.messageId)
      if (index >= 0) {
        return windowAround(session.id, index, messages.length)
      }
    }
    return defaultWindow(session.id, messages.length)
  })
  // 会话切走后 state 还留着上一个会话的数字：用会话 id 判断，不额外发一次 setState
  const current =
    windowState.sessionId === session.id ? windowState : defaultWindow(session.id, messages.length)
  const start = Math.min(Math.max(0, current.start), messages.length)
  const tail = Math.min(Math.max(0, current.tail), messages.length - start)
  const hiddenCount = start
  const shown = messages.slice(start, messages.length - tail)
  const winRef = useRef({ start, tail, sessionId: session.id })
  winRef.current = { start, tail, sessionId: session.id }
  // AI 消息左上角的角色头像：默认关闭，开关在「设置 → 角色扮演」
  const showAvatar = usePersona((state) => state.showAvatar)
  const persona = useSessionPersona(session.id)
  const avatar =
    showAvatar && persona.entry
      ? { src: persona.entry.avatar ?? null, label: persona.entry.card.name }
      : null
  // 上滑离底部太远、或正停在被跳转到的历史位置时浮出「回到底部」
  const [showJumpDown, setShowJumpDown] = useState(false)
  // 往上翻过一屏、或正停在历史窗口里时浮出「回到顶部」
  const [showJumpUp, setShowJumpUp] = useState(false)
  const expandAnchor = useRef<{ scrollTop: number; scrollHeight: number } | null>(null)
  const bottomAfterRender = useRef(false)
  const topAfterRender = useRef(false)
  // 加载更早的消息后，保持视线位置不跳动
  useLayoutEffect(() => {
    const el = scrollRef.current
    const anchor = expandAnchor.current
    if (el && anchor) {
      el.scrollTop = anchor.scrollTop + (el.scrollHeight - anchor.scrollHeight)
      expandAnchor.current = null
    }
    if (bottomAfterRender.current) {
      bottomAfterRender.current = false
      if (el) {
        el.scrollTop = el.scrollHeight
        scrollTopRef.current = el.scrollTop
      }
    }
    if (topAfterRender.current) {
      topAfterRender.current = false
      if (el) {
        el.scrollTop = 0
        scrollTopRef.current = 0
      }
    }
  }, [start, tail])
  const [previousVersions, setPreviousVersions] = useState(() =>
    buildMessageVersions(session, new Map())
  )
  const versions = useMemo(
    () => buildMessageVersions(session, previousVersions),
    [session, previousVersions]
  )
  if (versions !== previousVersions) {
    setPreviousVersions(versions)
  }
  const lastMessageId = messages.at(-1)?.id
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (el && stickyRef.current) {
      el.scrollTop = el.scrollHeight
      scrollTopRef.current = el.scrollTop
    }
  }, [])

  // 用户开始操作滚动条（拖动/点轨道/键盘翻页）就停止跟随底部：
  // 只靠 onScroll 判断「向上滚」不够，流式输出会在拖动途中把视图再拽回底部。
  const stopFollowing = useCallback(() => {
    stickyRef.current = false
  }, [])

  // 内容、键盘和输入框高度变化时，继续遵循当前跟随状态。
  useLayoutEffect(() => {
    const content = contentRef.current
    const scroll = scrollRef.current
    if (!content || !scroll) {
      return
    }
    const observer = new ResizeObserver(scrollToBottom)
    observer.observe(content)
    observer.observe(scroll)
    return () => observer.disconnect()
  }, [isMobile, scrollToBottom])

  // 切换版本后将选择器留在原位置，避免回答长短变化导致操作区跳出视口。
  useLayoutEffect(() => {
    const anchor = restoreScrollRef.current
    const scroll = scrollRef.current
    if (anchor && scroll) {
      const switcher = scroll.querySelector<HTMLElement>(
        `[data-message-version="${CSS.escape(anchor.messageId)}"]`
      )
      if (switcher) {
        scroll.scrollTop += switcher.getBoundingClientRect().top - anchor.top
      }
      restoreScrollRef.current = null
      return
    }
    stickyRef.current = true
    scrollToBottom()
  }, [session.id, lastMessageId, scrollToBottom])

  useEffect(closeSearchPanel, [session.id, lastMessageId])

  const selectVersion = useCallback(
    (messageId: string, anchorTop: number) => {
      if (streaming) {
        return
      }
      restoreScrollRef.current = { messageId, top: anchorTop }
      stickyRef.current = false
      closeSearchPanel()
      selectMessageVersion(session.id, messageId)
    },
    [session.id, streaming]
  )

  // 跨移动端断点时切换滚动层，并保持输入框及当前阅读位置。
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) {
      return
    }
    if (stickyRef.current) {
      scrollToBottom()
    } else {
      el.scrollTop = scrollTopRef.current
    }
    const onScroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICKY_THRESHOLD
      // 仅在用户向上滚动时停止跟随底部，布局或内容增高时保持跟随状态。
      if (nearBottom && winRef.current.tail === 0) {
        stickyRef.current = true
      } else if (el.scrollTop < scrollTopRef.current) {
        stickyRef.current = false
      }
      // 停在历史位置往下滑到窗口末尾时，继续补后面的消息（内容追加在下方，视线不跳）
      if (nearBottom && winRef.current.tail > 0) {
        const state = winRef.current
        setWindowState({
          sessionId: state.sessionId,
          start: state.start,
          tail: Math.max(0, state.tail - RENDER_PAGE),
        })
      }
      setShowJumpDown(
        winRef.current.tail > 0 || el.scrollHeight - el.scrollTop - el.clientHeight > 360
      )
      setShowJumpUp(winRef.current.start > 0 || el.scrollTop > 360)
      scrollTopRef.current = el.scrollTop
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [isMobile, scrollToBottom])

  // 搜索结果点进来时要定位到具体那条消息；消息不在当前窗口里就换成以它为中心的窗口
  const jumpTarget = useJumpTarget((state) => state.target)
  useEffect(() => {
    if (!jumpTarget || jumpTarget.sessionId !== session.id) {
      return
    }
    const node = scrollRef.current?.querySelector(
      `[data-message-id="${CSS.escape(jumpTarget.messageId)}"]`
    )
    if (node) {
      stickyRef.current = false
      node.scrollIntoView({ block: 'center' })
      clearJump()
      return
    }
    const index = messages.findIndex((message) => message.id === jumpTarget.messageId)
    if (index < 0) {
      return
    }
    const next = windowAround(session.id, index, messages.length)
    // 只在窗口真的需要变时才 set：messages 每次渲染可能是新数组，无脑 set 会陷进渲染循环
    setWindowState((previous) =>
      previous.sessionId === next.sessionId &&
      previous.start === next.start &&
      previous.tail === next.tail
        ? previous
        : next
    )
  }, [jumpTarget, session.id, messages])

  const lastIndex = shown.length - 1
  const uploadRetryId = getUploadRetryId(messages, streaming)
  const loadEarlier = () => {
    const el = scrollRef.current
    if (el) {
      expandAnchor.current = { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight }
    }
    setWindowState({ sessionId: session.id, start: Math.max(0, start - RENDER_PAGE), tail })
  }
  const jumpToBottom = () => {
    const el = scrollRef.current
    if (tail > 0) {
      // 现在是「跳进历史」的窗口：先换回最新的一段，渲染完再滚到底
      stickyRef.current = true
      bottomAfterRender.current = true
      setShowJumpDown(false)
      setWindowState(defaultWindow(session.id, messages.length))
      return
    }
    stickyRef.current = true
    setShowJumpDown(false)
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    }
  }
  const jumpToTop = () => {
    const el = scrollRef.current
    if (start > 0) {
      // 换到最前面那一段窗口。注意必须同时算 tail：只把 start 置 0、tail 留 0，
      // shown = messages.slice(0, len) 会把几千条一次性渲染出来 —— 那就是白屏/卡死的根因。
      stickyRef.current = false
      topAfterRender.current = true
      setShowJumpUp(false)
      setWindowState({
        sessionId: session.id,
        start: 0,
        tail: Math.max(0, messages.length - RENDER_PAGE),
      })
      return
    }
    stickyRef.current = false
    setShowJumpUp(false)
    if (el) {
      el.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }
  return (
    <ScrollToBottomContext.Provider value={scrollToBottom}>
      <div className={styles.container}>
        <div className={styles.scrollWrap}>
          <div ref={scrollRef} id={SCROLLER_ID} className={styles.scroll}>
            <div ref={contentRef} className={styles.column}>
              {showJumpUp ? (
                <button
                  type="button"
                  className={`${styles.jumpDown} ${styles.jumpUp}`}
                  aria-label={t('scrollToTop')}
                  title={t('scrollToTop')}
                  onClick={jumpToTop}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
                    <path
                      d="M8 13V4m0 0 4 4m-4-4-4 4"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              ) : null}
              {hiddenCount > 0 ? (
                <button type="button" className={styles.loadEarlier} onClick={loadEarlier}>
                  {t('loadEarlierMessages', { count: hiddenCount })}
                </button>
              ) : null}
              {shown.map((message, index) =>
                message.role === 'user' ? (
                  <UserMessage
                    key={message.id}
                    sessionId={session.id}
                    message={message}
                    retryUploadId={uploadRetryId}
                    isFirst={start === 0 && index === 0}
                    isLast={index === lastIndex || index === lastIndex - 1}
                    busy={streaming}
                    versions={versions.get(message.id) ?? EMPTY_VERSIONS}
                    onSelectVersion={selectVersion}
                  />
                ) : (
                  <AssistantMessage
                    key={message.id}
                    sessionId={session.id}
                    message={message}
                    isLast={index === lastIndex}
                    streaming={streaming && index === lastIndex && tail === 0}
                    busy={streaming}
                    versions={versions.get(message.id) ?? EMPTY_VERSIONS}
                    onSelectVersion={selectVersion}
                    avatar={avatar}
                  />
                )
              )}
              {showJumpDown || tail > 0 ? (
                <button
                  type="button"
                  className={styles.jumpDown}
                  aria-label={t('scrollToBottom')}
                  title={t('scrollToBottom')}
                  onClick={jumpToBottom}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
                    <path
                      d="M8 3v9m0 0 4-4m-4 4-4-4"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              ) : null}
            </div>
          </div>
          <Scrollbar
            scrollerRef={scrollRef}
            scrollerId={SCROLLER_ID}
            onUserScroll={stopFollowing}
          />
        </div>
        {footer}
      </div>
    </ScrollToBottomContext.Provider>
  )
}
