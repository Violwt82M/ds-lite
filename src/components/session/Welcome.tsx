import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { setDraftText } from '../../services/chat/drafts.js'
import { BUILTIN_HELPER_ID, isBuiltinPersona } from '../../services/persona/builtin.js'
import { setDraftPersona, useChatPersona } from '../../services/persona/scope.js'
import { useSettings } from '../../services/settings.js'
import { showToast } from '../base/toastState.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MobileHeader } from './MobileHeader.js'
import { PersonaButton } from './PersonaPicker.js'
import styles from './Welcome.module.css'

const HELPER_SAMPLES = ['helperSampleImport', 'helperSampleBubble', 'helperSampleBackup'] as const

/** 新对话：问候语 + 内置使用助手快捷入口 + 输入框。桌面端居中；移动端输入框吸底 */
export const Welcome = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const hasApiKey = useSettings((state) => Boolean(state.apiKey))
  const persona = useChatPersona(null)
  const usingHelper = isBuiltinPersona(persona.cardId)

  const activateHelper = () => {
    setDraftPersona(BUILTIN_HELPER_ID)
    showToast({ key: 'helperActivatedToast' })
  }

  return (
    <div className={styles.container}>
      {isMobile ? (
        <MobileHeader />
      ) : (
        <div className={styles.personaCorner}>
          <PersonaButton sessionId={null} />
        </div>
      )}
      <div className={styles.welcome}>
        <div className={styles.greeting}>{t('welcomeMessageChat250808')}</div>
        {hasApiKey ? (
          usingHelper ? (
            <div className={styles.helperCardActive}>
              <div className={styles.helperTop}>
                <span className={styles.helperTitle}>💡 {t('helperBannerActive')}</span>
                <button
                  type="button"
                  className={styles.helperExit}
                  onClick={() => setDraftPersona('none')}
                >
                  {t('helperBannerExit')}
                </button>
              </div>
              <div className={styles.helperChips}>
                {HELPER_SAMPLES.map((key) => {
                  const text = t(key)
                  return (
                    <button
                      key={key}
                      type="button"
                      className={styles.helperChip}
                      onClick={() => setDraftText(null, text)}
                    >
                      {text}
                    </button>
                  )
                })}
              </div>
            </div>
          ) : (
            <button type="button" className={styles.helperCard} onClick={activateHelper}>
              <span className={styles.helperIcon} aria-hidden>
                💡
              </span>
              <span className={styles.helperText}>
                <span className={styles.helperTitle}>{t('helperBannerTitle')}</span>
                <span className={styles.helperDesc}>{t('helperBannerDesc')}</span>
              </span>
              <span className={styles.helperAction}>{t('helperBannerAction')}</span>
            </button>
          )
        ) : null}
        <ChatInput sessionId={null} />
        {isMobile ? <div className={styles.caveat}>{t('contentCaveat')}</div> : null}
      </div>
    </div>
  )
}
