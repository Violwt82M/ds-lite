import { useState } from 'react'
import { platform } from '../../services/platform.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { useDisclaimer } from './disclaimerState.js'
import styles from './WebPwaGuideDialog.module.css'

const DISMISS_KEY = 'ds-lite:pwa-guide-dismissed'

const isStandaloneApp = (): boolean => {
  if (typeof window === 'undefined') {
    return true
  }
  if (platform.isShellApp()) {
    return true
  }
  const nav = window.navigator as Navigator & { standalone?: boolean }
  if (nav.standalone === true) {
    return true
  }
  return window.matchMedia?.('(display-mode: standalone)').matches === true
}

const isDismissed = (): boolean => {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * 网页版首次引导：建议将 DS Lite 添加到主屏幕 / 桌面应用（PWA），
 * 减少浏览器清理缓存导致的记录丢失风险，并提供 Safari / Chrome / Edge 官方浏览器步骤。
 */
export const WebPwaGuideDialog = () => {
  const disclaimerAccepted = useDisclaimer((state) => state.accepted && !state.open)
  const [visible, setVisible] = useState(() => !isStandaloneApp() && !isDismissed())

  if (!disclaimerAccepted || !visible) {
    return null
  }

  const closeOnce = () => setVisible(false)

  const dismissForever = () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1')
    } catch {
      // 存储不可用时仅本次关闭
    }
    setVisible(false)
  }

  return (
    <Modal
      title="建议将网页版保存到桌面"
      className={styles.modal}
      closable
      onClose={closeOnce}
      footer={
        <div className={styles.footer}>
          <Button variant="outlined" size="m" onClick={closeOnce}>
            下次再说
          </Button>
          <Button size="m" onClick={dismissForever}>
            我知道了，不再提示
          </Button>
        </div>
      }
    >
      <div className={styles.body}>
        <div className={styles.intro}>
          当前正在使用浏览器网页版。直接放在浏览器标签页里容易被系统清理缓存（尤其是 iOS Safari
          长时间未打开可能清空本地记录），建议将其添加到桌面或主屏幕作为独立应用使用，体验更接近客户端且更稳妥：
        </div>
        <div className={styles.list}>
          <div className={styles.browserCard}>
            <div className={styles.browserName}>Safari（iOS 苹果手机 / iPad）</div>
            <div className={styles.browserSteps}>
              点击底部工具栏的「分享」图标（带向上箭头的方框）→ 向下滑动选择「添加到主屏幕」→ 点击右上角「添加」。
            </div>
          </div>
          <div className={styles.browserCard}>
            <div className={styles.browserName}>Chrome（电脑 / 安卓）</div>
            <div className={styles.browserSteps}>
              电脑端点击地址栏最右侧的「安装」图标（或右上角 ⋮ →「投射、保存和分享」→「将页面作为应用安装」）；安卓端点击右上角
              ⋮ →「添加到主屏幕」→「安装」。
            </div>
          </div>
          <div className={styles.browserCard}>
            <div className={styles.browserName}>Edge（电脑 / 手机）</div>
            <div className={styles.browserSteps}>
              电脑端点击地址栏最右侧的「安装应用」图标（或右上角 ⋯ →「应用」→「将此站点安装为应用」）；手机端点击底部
              ≡ 菜单 →「添加到手机」。
            </div>
          </div>
          <div className={styles.browserCard}>
            <div className={styles.browserName}>华为 / 鸿蒙浏览器</div>
            <div className={styles.browserSteps}>
              点击底部「≡（菜单）」或右上角「⋮」→ 找到「添加至 / 收藏」→ 选择「添加至桌面」或「添加桌面快捷方式」→ 确认添加。
            </div>
          </div>
        </div>
      </div>
    </Modal>
  )
}
