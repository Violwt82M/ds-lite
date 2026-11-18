import clsx from 'clsx'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { IconPanelLeftOutline16, IconSettingsOutline16, NewChatIcon } from '../base/icons.js'
import { setSiderCollapsed } from '../../services/settings.js'
import { groupSessions } from '../../services/chat/sessionGroups.js'
import { newChat, removeSession, useChatStore } from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { closeMobileSider, useMobileSider } from './mobileSiderState.js'
import { useSwipeSiderClose } from '../../app/swipeSider.js'
import { SessionItem } from './SessionItem.js'
import { SessionSearch } from './SessionSearch.js'
import { openSearchPage } from './searchPageState.js'
import styles from './Sider.module.css'

/** 展开的侧边栏：名称与收起按钮、开启新对话、按时间分组的会话列表、底部设置；移动端放在抽屉里，收起按钮关闭抽屉 */
export const Sider = ({ mobile = false }: { mobile?: boolean }) => {
  const t = useTranslate()
  const sessions = useChatStore((state) => state.sessions)
  const activeId = useChatStore((state) => state.activeId)
  const pins = useChatStore((state) => state.pins)
  const [now, setNow] = useState(Date.now)
  // 置顶单独成一组排在最前，其余照旧按时间分组（否则钉了三个月的会话会插进「今天」里）
  const groups = useMemo(() => {
    const pinned = sessions
      .filter((session) => pins[session.id])
      .sort((a, b) => (pins[b.id] ?? 0) - (pins[a.id] ?? 0))
    const rest = sessions.filter((session) => !pins[session.id])
    return [
      ...(pinned.length > 0
        ? [{ key: 'pinned', label: t('sessionGroupPinned'), sessions: pinned }]
        : []),
      ...groupSessions(rest, now, t),
    ]
  }, [sessions, pins, now, t])
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)
  // 搜索时把普通列表藏起来，只留结果区
  const [searchActive, setSearchActive] = useState(false)
  const [deletePending, setDeletePending] = useState(false)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const refresh = () => {
      clearTimeout(timer)
      const time = Date.now()
      setNow(time)
      const midnight = new Date(time).setHours(24, 0, 0, 0)
      timer = setTimeout(refresh, midnight - time)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refresh()
      }
    }
    refresh()
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', refresh)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  return (
    <div className={clsx(styles.sider, mobile && styles.mobile)}>
      <div className={styles.top}>
        <div className={styles.appName}>{t('appName')}</div>
        <IconButton
          size="m"
          icon={<IconPanelLeftOutline16 />}
          tooltip={t('collapseSiderbarButton')}
          tooltipPlacement="bottom"
          onClick={() => (mobile ? closeMobileSider() : setSiderCollapsed(true))}
        />
      </div>
      {/* 有对话时官方不显示这个入口：新建走聊天页顶栏的 +，列表只留搜索和会话。
          必须条件渲染而不是 hidden：.newChat 自带 display:flex，会盖掉 hidden 的 display:none */}
      {sessions.length === 0 ? (
        <button
          type="button"
          className={styles.newChat}
          onClick={() => {
            newChat()
            closeMobileSider()
          }}
        >
          <span className={styles.newChatIcon}>
            <NewChatIcon />
          </span>
          {t('newChat')}
        </button>
      ) : null}
      <SessionSearch
        onPick={() => setSearchActive(false)}
        onActiveChange={setSearchActive}
        onRequestPage={mobile ? openSearchPage : undefined}
      />
      {/* 搜索时只把里面的列表藏起来，外层仍占着 flex:1，底部「设置」才不会浮上去 */}
      <div className={styles.listWrap}>
        <div className={styles.list} hidden={searchActive}>
          {groups.map((group) => (
            <div key={group.key} className={styles.section}>
              <div className={styles.sectionHeader}>{group.label}</div>
              {group.sessions.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  active={session.id === activeId}
                  pinned={Boolean(pins[session.id])}
                  onDelete={() => setDeleting(session)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className={styles.bottom}>
        <button type="button" className={styles.settings} onClick={() => openSettings('general')}>
          <span className={styles.settingsIcon}>
            <IconSettingsOutline16 />
          </span>
          <span className={styles.settingsLabel}>{t('settings')}</span>
        </button>
      </div>
      {deleting ? (
        <Modal
          title={t('deleteSessionModalContentTitle')}
          onClose={() => {
            if (!deletePending) {
              setDeleting(null)
            }
          }}
          footer={
            <>
              <Button variant="outlined" disabled={deletePending} onClick={() => setDeleting(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={deletePending}
                onClick={async () => {
                  setDeletePending(true)
                  try {
                    if (await removeSession(deleting.id)) {
                      setDeleting(null)
                    } else {
                      showToast({ key: 'sessionDeleteFailed', type: 'error' })
                    }
                  } finally {
                    setDeletePending(false)
                  }
                }}
              >
                {t('delete')}
              </Button>
            </>
          }
        >
          {t('deleteSessionWithFilesDescription')}
        </Modal>
      ) : null}
    </div>
  )
}

export { MOBILE_SIDER_WIDTH } from './mobileSiderState.js'

/**
 * 移动端抽屉：可以点菜单按钮弹出，也可以从正文任意位置向右拖出来。
 * 拖动时去掉过渡让抽屉跟手，松手后按进度吸附——官方那种"弹簧感"就是这么来的。
 */
export const MobileSider = () => {
  const open = useMobileSider((state) => state.open)
  const progress = useMobileSider((state) => state.progress)
  const dragging = useMobileSider((state) => state.dragging)
  // 关的时候要留在 DOM 里把动画放完，不然抽屉会"啪"地消失
  const [rendered, setRendered] = useState(open || progress > 0)
  /**
   * 点按钮打开时 open/progress 是一次性置到 1 的，元素直接以终态挂载、CSS transition 没有起点，
   * 于是只有关闭有动画、打开是"啪"地出现。这里先以 0 挂载一帧，下一帧再放开。
   */
  const [entered, setEntered] = useState(false)
  useEffect(() => {
    if (open || progress > 0) {
      setRendered(true)
      return
    }
    const timer = window.setTimeout(() => setRendered(false), 240)
    return () => window.clearTimeout(timer)
  }, [open, progress])
  useEffect(() => {
    if (!rendered) {
      setEntered(false)
      return
    }
    // 手指已经在拖（从正文右滑拉出）时不需要入场动画，否则会从 0 跳一下
    if (dragging) {
      setEntered(true)
      return
    }
    const frame = window.requestAnimationFrame(() => setEntered(true))
    return () => window.cancelAnimationFrame(frame)
  }, [rendered, dragging])
  /**
   * 左滑关闭手势结束时，浏览器可能还会补发一次 click 打在遮罩上：
   * 如果这一滑没滑够、抽屉弹回打开，紧跟的 click 就会把抽屉关掉，用户会觉得「滑了一下反而被关」。
   * 用一个短命标记吃掉紧跟着的那次 click；没等到 click（touchend 的 preventDefault 生效）时
   * 到点自动放开，免得下一次正常点击被吞。
   */
  const ignoreMaskClick = useRef(false)
  const maskClickGuard = useRef<ReturnType<typeof setTimeout>>(undefined)
  const markSwipeEnded = useCallback(() => {
    ignoreMaskClick.current = true
    clearTimeout(maskClickGuard.current)
    maskClickGuard.current = setTimeout(() => {
      ignoreMaskClick.current = false
    }, 320)
  }, [])
  useEffect(() => () => clearTimeout(maskClickGuard.current), [])
  // 抽屉开着时可以从任意位置左划关回去（官方行为；以前只能从列表区划）
  useSwipeSiderClose(rendered, markSwipeEnded)
  if (!rendered) {
    return null
  }
  const shown = dragging ? progress : entered ? (open ? 1 : progress) : 0
  return (
    <>
      <div
        className={styles.drawerMask}
        onClick={() => {
          if (ignoreMaskClick.current) {
            ignoreMaskClick.current = false
            clearTimeout(maskClickGuard.current)
            return
          }
          closeMobileSider()
        }}
        style={{
          opacity: shown,
          transition: dragging ? 'none' : 'opacity 220ms ease',
        }}
      />
      <div
        className={styles.drawer}
        style={{
          transform: `translateX(${(shown - 1) * 100}%)`,
          transition: dragging ? 'none' : 'transform 220ms cubic-bezier(0.22, 0.61, 0.36, 1)',
        }}
      >
        <Sider mobile />
      </div>
    </>
  )
}
