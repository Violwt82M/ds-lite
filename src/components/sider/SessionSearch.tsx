import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  searchAll,
  searchSessionHits,
  warmSearchIndex,
  type IndexProgress,
  type SearchGroup,
  type SearchHit,
  type SearchResult,
} from '../../services/chat/searchIndex.js'
import { splitByRanges, type SearchRange } from '../../services/chat/searchText.js'
import { selectSession, useChatStore } from '../../services/chat/store.js'
import { requestJump } from '../../services/chat/jumpTarget.js'
import { IconCloseOutline16, IconSearchOutline16 } from '../base/icons.js'
import { closeMobileSider } from './mobileSiderState.js'
import styles from './SessionSearch.module.css'

/** 输入停顿多久才去内存里扫一遍：30 万字的会话全库扫一遍只要几十毫秒，停顿短一点更跟手 */
const DEBOUNCE_MS = 80
/** 展开一个会话后一次渲染多少条命中：上千条一次性上屏会卡，分成 200 一页 */
const HITS_PAGE = 200

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
  const [result, setResult] = useState<SearchResult | null>(null)
  /** 展开的会话 → 该会话全部命中（'loading' 表示正在取） */
  const [expanded, setExpanded] = useState<Record<string, SearchHit[] | 'loading' | undefined>>({})
  /** 展开后每个会话已经渲染了多少条 */
  const [shownCount, setShownCount] = useState<Record<string, number>>({})
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
      setResult(null)
      setExpanded({})
      setShownCount({})
      setSettled('')
      return
    }
    setSettled('')
    let cancelled = false
    const timer = window.setTimeout(() => {
      searchAll(keyword, sessions)
        .then((next) => {
          if (cancelled) {
            return
          }
          setResult(next)
          setExpanded({})
          setShownCount({})
          setSettled(keyword)
        })
        .catch(() => {
          if (!cancelled) {
            setResult(null)
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

  /**
   * 点组头：展开/收起该会话的全部命中。
   * 只命中标题、没有正文命中的会话没有可展开的内容，直接进去。
   */
  const toggleGroup = (group: SearchGroup) => {
    if (expanded[group.sessionId] !== undefined) {
      // 置 undefined 而不是 delete：lint 禁止动态 delete，判定上两者等价（都不等于 undefined 检查）
      setExpanded((previous) => ({ ...previous, [group.sessionId]: undefined }))
      return
    }
    if (group.totalHits === 0) {
      pick(group.sessionId, null)
      return
    }
    setExpanded((previous) => ({ ...previous, [group.sessionId]: 'loading' }))
    void searchSessionHits(group.sessionId, keyword).then((hits) => {
      setExpanded((previous) => ({ ...previous, [group.sessionId]: hits }))
    })
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
              : keyword && result && result.pending > 0
                ? t('sessionSearchPartial', { count: result.totalHits })
                : keyword
                  ? result && result.groups.length > 0
                    ? t('sessionSearchSummary', {
                        hits: result.totalHits,
                        groups: result.groups.length,
                      })
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
          {result?.groups.map((group) => {
            const loaded = expanded[group.sessionId]
            const isExpanded = loaded !== undefined
            const allHits = Array.isArray(loaded) ? loaded : group.hits
            const limit = shownCount[group.sessionId] ?? HITS_PAGE
            const visible = isExpanded ? allHits.slice(0, limit) : group.hits
            const canExpand = group.totalHits > group.hits.length
            const capped = Array.isArray(loaded) && loaded.length < group.totalHits
            return (
              <div key={group.sessionId} className={styles.group}>
                <button
                  type="button"
                  className={styles.groupHead}
                  onClick={() => toggleGroup(group)}
                >
                  <span className={styles.hitTitle}>
                    {group.titleRanges.length > 0 ? (
                      <Highlighted text={group.title} ranges={group.titleRanges} />
                    ) : (
                      group.title || t('untitledChat')
                    )}
                  </span>
                  {group.totalHits > 0 ? (
                    <span className={styles.groupCount}>
                      {canExpand ? (isExpanded ? '▾ ' : '▸ ') : ''}
                      {t('sessionSearchHits', { count: group.totalHits })}
                    </span>
                  ) : null}
                </button>
                {visible.map((hit) => (
                  <button
                    key={hit.messageId}
                    type="button"
                    className={styles.hit}
                    onClick={() => pick(group.sessionId, hit.messageId)}
                  >
                    <span className={styles.hitSnippet}>
                      {hit.snippet?.clippedStart ? '…' : null}
                      {hit.snippet ? (
                        <Highlighted text={hit.snippet.text} ranges={hit.snippet.ranges} />
                      ) : null}
                      {hit.snippet?.clippedEnd ? '…' : null}
                    </span>
                  </button>
                ))}
                {isExpanded && loaded === 'loading' ? (
                  <div className={styles.empty}>{t('sessionSearching')}</div>
                ) : null}
                {isExpanded && allHits.length > limit ? (
                  <button
                    type="button"
                    className={styles.loadMore}
                    onClick={() =>
                      setShownCount((previous) => ({
                        ...previous,
                        [group.sessionId]: (previous[group.sessionId] ?? HITS_PAGE) + HITS_PAGE,
                      }))
                    }
                  >
                    {t('sessionSearchLoadMore', { count: Math.min(HITS_PAGE, allHits.length - limit) })}
                  </button>
                ) : null}
                {capped ? (
                  <div className={styles.empty}>
                    {t('sessionSearchHitCapped', { count: (loaded as SearchHit[]).length })}
                  </div>
                ) : null}
              </div>
            )
          })}
          {keyword && settled === keyword && (!result || result.groups.length === 0) && !building ? (
            <div className={styles.empty}>{t('sessionSearchNoResult')}</div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
