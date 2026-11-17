import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  searchAll,
  warmSearchIndex,
  type IndexProgress,
  type SearchRow,
} from '../../services/chat/searchIndex.js'
import { splitByRanges, type SearchRange } from '../../services/chat/searchText.js'
import { selectSession, useChatStore } from '../../services/chat/store.js'
import { requestJump } from '../../services/chat/jumpTarget.js'
import { IconCloseOutline16, IconSearchOutline16 } from '../base/icons.js'
import { closeMobileSider } from './mobileSiderState.js'
import styles from './SessionSearch.module.css'

/** 输入停顿多久才去内存里扫一遍：30 万字的会话全库扫一遍只要几十毫秒，停顿短一点更跟手 */
const DEBOUNCE_MS = 80

/** 把纯文本按命中下标切开渲染：命中词加高亮，不拼 HTML，标题和正文片段共用。 */
const Highlighted = ({ text, ranges }: { text: string; ranges: readonly SearchRange[] }) => (
  <>
    {splitByRanges(text, ranges).map((part, index) =>
      part.match ? (
        <mark key={index} className={styles.match}>
          {part.text}
        </mark>
      ) : (
        <span key={index}>{part.text}</span>
      )
    )}
  </>
)

/**
 * 会话搜索：标题和正文一起搜，一条命中的消息就是一条结果
 * （官方模板：第一行会话标题，第二行带关键词的正文片段，超出两行省略）。
 * 正文靠常驻内存的索引（searchIndex.ts），不在这里读 IndexedDB。
 */
export const SessionSearch = ({
  onPick,
  onActiveChange,
  page = false,
  autoFocus = false,
  leading,
  onRequestPage,
}: {
  onPick: (sessionId: string) => void
  /** 有关键词时通知父级：普通列表要暂时让位给结果区，避免两套列表叠在一起 */
  onActiveChange?: (active: boolean) => void
  /** 全屏搜索页里用：输入框和结果占满整屏 */
  page?: boolean
  autoFocus?: boolean
  /** 输入框左边的返回按钮（全屏页用） */
  leading?: React.ReactNode
  /** 抽屉里点输入框直接打开全屏搜索页，而不是就地输入 */
  onRequestPage?: () => void
}) => {
  const t = useTranslate()
  const sessions = useChatStore((state) => state.sessions)
  const [query, setQuery] = useState('')
  /** 已提交的关键词：输入法组字期间停在旧值，结束组字才更新，避免用拼音中间态去搜索 */
  const [committed, setCommitted] = useState('')
  const [rows, setRows] = useState<SearchRow[]>([])
  const [pending, setPending] = useState(0)
  const [truncated, setTruncated] = useState(false)
  /** 已经算完结果的关键词：算完之前不显示「没有找到」，否则刚敲第一个字会闪一下空状态 */
  const [settled, setSettled] = useState('')
  const [progress, setProgress] = useState<IndexProgress | null>(null)
  /** 索引补齐后加一：让已有结果重新扫一遍（第一次搜索可能只搜到一半的会话） */
  const [indexVersion, setIndexVersion] = useState(0)
  const composing = useRef(false)
  const keyword = committed.trim()

  useEffect(() => {
    onActiveChange?.(keyword !== '')
  }, [keyword, onActiveChange])

  // 启动时补齐索引（只补缺的和过期的）；全屏页一打开就开始，抽屉里进搜索页也不必等
  useEffect(() => {
    let cancelled = false
    void warmSearchIndex((next) => {
      if (!cancelled) {
        setProgress(next)
      }
    }).then(() => {
      if (!cancelled) {
        setProgress(null)
        setIndexVersion((version) => version + 1)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  // 关键词变了就重新扫索引：命中即停，最多 MAX_ROWS 条
  useEffect(() => {
    if (!keyword) {
      setRows([])
      setPending(0)
      setTruncated(false)
      setSettled('')
      return
    }
    setSettled('')
    let cancelled = false
    const timer = window.setTimeout(() => {
      searchAll(keyword, sessions)
        .then((result) => {
          if (cancelled) {
            return
          }
          setRows(result.rows)
          setPending(result.pending)
          setTruncated(result.truncated)
          setSettled(keyword)
        })
        .catch(() => {
          if (!cancelled) {
            setRows([])
            setSettled(keyword)
          }
        })
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [keyword, sessions, indexVersion])

  const clear = () => {
    composing.current = false
    setQuery('')
    setCommitted('')
  }

  const pick = (sessionId: string, messageId: string | null) => {
    // 和列表项一样直接进入会话并收起抽屉；正文命中还要滚到那条消息。
    if (messageId) {
      requestJump(sessionId, messageId)
    }
    selectSession(sessionId)
    closeMobileSider()
    onPick(sessionId)
  }

  // 全屏页没有输入时先列出全部会话（官方搜索页一进来就是会话列表）
  const allSessions = useMemo(
    () => (page && !keyword ? sessions.map((session) => ({ id: session.id, title: session.title })) : []),
    [page, keyword, sessions]
  )
  const building = progress !== null && progress.total > 0

  return (
    <div className={page ? `${styles.root} ${styles.pageRoot}` : styles.root}>
      <div className={styles.row}>
        {leading ?? null}
        <div className={styles.field}>
          <span className={styles.icon} aria-hidden>
            <IconSearchOutline16 />
          </span>
          <input
            className={styles.input}
            type="text"
            value={query}
            placeholder={t('sessionSearchPlaceholder')}
            aria-label={t('sessionSearchPlaceholder')}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="search"
            autoFocus={autoFocus}
            readOnly={Boolean(onRequestPage)}
            onFocus={(event) => {
              // 抽屉里点一下就直接进全屏搜索页，不在 300px 宽的抽屉里就地输入
              if (onRequestPage) {
                event.currentTarget.blur()
                onRequestPage()
              }
            }}
            onChange={(event) => {
              const value = event.currentTarget.value
              setQuery(value)
              // 组字期间只有输入框跟着走，compositionend 才提交，拼音中间态不触发搜索。
              // 再查一次 isComposing：个别输入法不给 compositionstart，只靠 ref 会漏判。
              const native = event.nativeEvent
              const composingNow = native instanceof InputEvent && native.isComposing
              if (!composing.current && !composingNow) {
                setCommitted(value)
              }
            }}
            onCompositionStart={() => {
              composing.current = true
            }}
            onCompositionEnd={(event) => {
              composing.current = false
              setCommitted(event.currentTarget.value)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && (query || committed)) {
                event.preventDefault()
                clear()
              }
            }}
          />
          {query ? (
            <button
              type="button"
              className={styles.clear}
              aria-label={t('sessionSearchClear')}
              onClick={clear}
            >
              <IconCloseOutline16 />
            </button>
          ) : null}
        </div>
      </div>
      <div className={styles.results}>
        {keyword || allSessions.length > 0 ? (
          <div className={styles.status} aria-live="polite">
            {building
              ? t('sessionSearchIndexing', { done: progress.done, total: progress.total })
              : keyword && pending > 0
                ? t('sessionSearchPartial', { count: rows.length })
                : keyword
                  ? rows.length > 0
                    ? truncated
                      ? t('sessionSearchTruncated', { count: rows.length })
                      : t('sessionSearchResults', { count: rows.length })
                    : ''
                  : t('sessionSearchAll', { count: allSessions.length })}
          </div>
        ) : null}
        <div className={styles.list}>
          {allSessions.map((session) => (
            <button
              key={session.id}
              type="button"
              className={styles.hit}
              onClick={() => pick(session.id, null)}
            >
              <span className={styles.hitTitle}>{session.title || t('untitledChat')}</span>
            </button>
          ))}
          {rows.map((row, index) => (
            <button
              key={`${row.sessionId}:${row.messageId ?? 'title'}:${index}`}
              type="button"
              className={styles.hit}
              onClick={() => pick(row.sessionId, row.messageId)}
            >
              <span className={styles.hitTitle}>
                {row.source === 'title' ? (
                  <Highlighted text={row.title} ranges={row.titleRanges} />
                ) : (
                  row.title || t('untitledChat')
                )}
              </span>
              {row.snippet ? (
                <span className={styles.hitSnippet}>
                  {row.snippet.clippedStart ? '…' : null}
                  <Highlighted text={row.snippet.text} ranges={row.snippet.ranges} />
                  {row.snippet.clippedEnd ? '…' : null}
                </span>
              ) : null}
            </button>
          ))}
          {keyword && settled === keyword && rows.length === 0 && !building ? (
            <div className={styles.empty}>{t('sessionSearchNoResult')}</div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
