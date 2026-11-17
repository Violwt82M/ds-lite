import clsx from 'clsx'
import { useEffect, useMemo, useState } from 'react'
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

/** 抽屉宽度与 CSS 保持一致（.mobile 的 width / max-width），拖动换算进度要用它 */
export const MOBILE_SIDER_WIDTH = () => Math.min(300, window.innerWidth - 48)

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
  useEffect(() => {
    if (open || progress > 0) {
      setRendered(true)
      return
    }
    const timer = window.setTimeout(() => setRendered(false), 240)
    return () => window.clearTimeout(timer)
  }, [open, progress])
  if (!rendered) {
    return null
  }
  const shown = open ? 1 : progress
  return (
    <>
      <div
        className={styles.drawerMask}
        onClick={closeMobileSider}
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
