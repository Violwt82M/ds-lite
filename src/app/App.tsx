import { useEffect } from 'react'
import { useTranslate } from '../i18n/index.js'
import { useSettings } from '../services/settings.js'
import { useIsMobile, useMobileViewport, usePreventPageScroll } from './viewport.js'
import { useSwipeSider } from './swipeSider.js'
import {
  bindChatPersistence,
  initChat,
  retrySaveSessions,
  selectSession,
  useChatStore,
} from '../services/chat/store.js'
import { SearchPanel } from '../components/search/SearchPanel.js'
import { closeSearchPanel } from '../components/search/searchPanelState.js'
import { SessionView } from '../components/session/SessionView.js'
import { MobileHeader } from '../components/session/MobileHeader.js'
import { Welcome } from '../components/session/Welcome.js'
import { ensureApiKey, openSettings } from '../components/settings/settingsDialogState.js'
import { SettingsDialog } from '../components/settings/SettingsDialog.js'
import { DisclaimerDialog } from '../components/about/DisclaimerDialog.js'
import { ContextGuideDialog } from '../components/memory/ContextGuideDialog.js'
import { useDisclaimer } from '../components/about/disclaimerState.js'
import { Toast } from '../components/base/Toast.js'
import { showToast } from '../components/base/toastState.js'
import { onUploadNotice } from '../services/attachments.js'
import { setupWallpaper } from '../services/wallpaper.js'
import { initSharedArchive, useSharedArchive } from '../services/chat/history/sharedArchive.js'
import { warmSearchIndex } from '../services/chat/searchIndex.js'
import { requestPersistentStorage } from '../services/storage.js'
import { Button } from '../components/base/Button.js'
import { stopReadAloud } from '../services/speech/readAloud.js'
import { CollapsedSider } from '../components/sider/CollapsedSider.js'
import { closeMobileSider } from '../components/sider/mobileSiderState.js'
import { MobileSider, Sider } from '../components/sider/Sider.js'
import { SearchPage } from '../components/sider/SearchPage.js'
import styles from './App.module.css'

export const App = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const locale = useSettings((state) => state.locale)
  // 移动端侧边栏以独立抽屉管理开合状态
  const siderCollapsed = useSettings((state) => state.siderCollapsed) && !isMobile
  const ready = useChatStore((state) => state.ready)
  const initError = useChatStore((state) => state.initError)
  const saveError = useChatStore((state) => Object.values(state.sessionSaveErrors).some(Boolean))
  const importingHistory = useChatStore((state) => state.importingHistory)
  const session = useChatStore((state) =>
    state.activeId !== null && Object.hasOwn(state.sessionCache, state.activeId)
      ? state.sessionCache[state.activeId]
      : undefined
  )
  const sessionLoadError = useChatStore((state) =>
    state.activeId === null ? false : state.sessionLoadErrors[state.activeId] === true
  )
  const frameRef = useMobileViewport(isMobile)
  // 正文任意位置右滑拉出会话列表（跟手 + 松手吸附）
  useSwipeSider(frameRef, isMobile)
  const streaming = useChatStore((state) =>
    state.activeId === null ? false : Object.hasOwn(state.streaming, state.activeId)
  )
  const activeId = useChatStore((state) => state.activeId)

  usePreventPageScroll(isMobile)

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  // 文件数、存储空间达到上限时，附件上只显示「上传失败」，原因用 toast 说明
  useEffect(() => onUploadNotice(showToast), [])
  useEffect(bindChatPersistence, [])

  // 搜索结果面板只属于当前会话
  useEffect(closeSearchPanel, [activeId])
  // 切换会话时停止朗读
  useEffect(stopReadAloud, [activeId])
  // 移动端选中会话、切换布局后收起抽屉
  useEffect(closeMobileSider, [activeId, isMobile])

  // 背景图：预设走 CSS，自定义图从 IndexedDB 读回来
  useEffect(setupWallpaper, [])

  // 申请持久化存储：网页版的对话/附件都在浏览器里，别让系统清理时把数据一起收走
  useEffect(() => {
    void requestPersistentStorage()
  }, [])

  // 系统分享 / 打开方式传进来归档：直接跳到「数据管理 → 导入历史对话」
  useEffect(() => {
    void initSharedArchive()
    return useSharedArchive.subscribe((state) => {
      if (state.pending !== null) {
        openSettings('data')
      }
    })
  }, [])

  useEffect(() => {
    void initChat()
    // 首次打开先让用户看完免责声明，确认后再引导填 API Key，避免两个弹窗叠在一起
    if (useDisclaimer.getState().accepted) {
      ensureApiKey()
    }
  }, [])

  // 会话列表就绪后，空闲时补齐正文搜索索引（新装/刚导入的库在这里一次建好，
  // 之后搜索只扫内存，不会出现「点开搜索先卡两秒」）
  useEffect(() => {
    let cancelled = false
    const run = () => {
      if (!cancelled) {
        void warmSearchIndex()
      }
    }
    const timer = window.setTimeout(() => {
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(run, { timeout: 3000 })
      } else {
        run()
      }
    }, 800)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [])

  return (
    <>
      <div ref={frameRef} className={`${styles.frame} app-frame`}>
        {isMobile ? <MobileSider /> : siderCollapsed ? null : <Sider />}
        <SearchPage />
        <main className={styles.main}>
          {saveError ? (
            <div className={styles.saveError} role="alert">
              <span>{t('sessionSaveFailed')}</span>
              <Button
                variant="outlined"
                size="s"
                disabled={importingHistory}
                onClick={retrySaveSessions}
              >
                {t('retry')}
              </Button>
            </div>
          ) : null}
          <div className={styles.content}>
            {siderCollapsed ? <CollapsedSider /> : null}
            {!ready || (activeId !== null && !session) ? (
              <div className={styles.loadingView}>
                {isMobile ? <MobileHeader /> : null}
                <div className={styles.loadingState} role="status" aria-live="polite">
                  <span>
                    {(!ready ? initError : sessionLoadError)
                      ? t(!ready ? 'sessionListLoadFailed' : 'sessionLoadFailed')
                      : t('sessionLoading')}
                  </span>
                  {(!ready ? initError : sessionLoadError) ? (
                    <Button
                      variant="outlined"
                      size="m"
                      onClick={() => {
                        if (!ready) {
                          void initChat()
                        } else if (activeId !== null) {
                          selectSession(activeId)
                        }
                      }}
                    >
                      {t('retry')}
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : session ? (
              <SessionView
                session={session}
                streaming={streaming}
                siderCollapsed={siderCollapsed}
              />
            ) : (
              <Welcome />
            )}
          </div>
        </main>
        <SearchPanel />
      </div>
      <SettingsDialog />
      <DisclaimerDialog />
      <ContextGuideDialog />
      <Toast />
    </>
  )
}
