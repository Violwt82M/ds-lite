import { useTranslate } from '../../i18n/index.js'
import clsx from 'clsx'
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { startMessageEditing, stopMessageEditing } from './editingState.js'
import {
  IconEditOutline16,
  IconForkOutline16,
  IconRefreshOutline16,
  IconWarningOutline16,
} from '../base/icons.js'
import { describeReply } from '../../services/chat/describe.js'
import { useSettings } from '../../services/settings.js'
import { formatTokens } from '../../services/usage.js'
import { canContinueReply } from '../../services/chat/reply.js'
import {
  continueReply,
  editAssistantReply,
  forkSession,
  regenerateReply,
} from '../../services/chat/store.js'
import { stopReadAloud } from '../../services/speech/readAloud.js'
import { showToast } from '../base/toastState.js'
import { closeMobileSider } from '../sider/mobileSiderState.js'
import type { AssistantMessage as AssistantMessageType } from '../../services/chat/types.js'

import { openSettings } from '../settings/settingsDialogState.js'
import { IconButton } from '../base/IconButton.js'
import { Button } from '../base/Button.js'
import { Menu } from '../base/Menu.js'
import { Markdown } from '../markdown/Markdown.js'
import { SiteThumbnails } from '../search/SiteLogo.js'
import { toggleSearchPanel, useSearchPanel } from '../search/searchPanelState.js'
import { ReadAloudButton } from './ReadAloudButton.js'
import { CopyButton } from './CopyButton.js'
import { ReplyArea } from './ReplyArea.js'
import { useReplyView } from './useReplyView.js'
import {
  BranchSwitcher,
  type MessageVersions,
  type SelectMessageVersion,
} from './BranchSwitcher.js'
import styles from './AssistantMessage.module.css'

const TOP_UP_URL = 'https://platform.deepseek.com/top_up'

export const AssistantMessage = memo(function AssistantMessage({
  sessionId,
  message,
  isLast,
  streaming,
  busy,
  versions,
  onSelectVersion,
  avatar,
}: {
  sessionId: string
  message: AssistantMessageType
  isLast: boolean
  streaming: boolean
  busy: boolean
  versions: MessageVersions
  onSelectVersion: SelectMessageVersion
  avatar?: { src: string | null; label: string } | null
}) {
  const t = useTranslate()
  // AI 输出气泡：独立开关，默认关（对齐原版：AI 回答是纯文本）；和「消息气泡」（用户气泡）互不影响
  const aiBubble = useSettings((state) => state.aiBubble)
  const showReadMark = useSettings((state) => state.showReadMark)
  const showTokenUsage = useSettings((state) => state.showTokenUsage)
  const readAloudEnabled = useSettings((state) => state.readAloudEnabled)
  const showBubble = aiBubble
  const view = useReplyView(message, streaming)
  const panelEntry = useSearchPanel((state) => state.entry)
  const notice = streaming ? null : describeReply(message)
  // 安全拒绝：已下发的思考与正文按协议丢弃，只显示模板答复。
  const refused = message.stopReason === 'refusal'
  const answer = refused ? null : view.answer
  const responseText = [answer?.text, notice?.presentation === 'response' ? notice.text : null]
    .filter(Boolean)
    .join('\n\n')
  const copyText = responseText || notice?.text
  // 每条回答的字数（用户要求显示字数、不显示 token）：不含空白字符
  const charCount = responseText ? responseText.replace(/\s/g, '').length : 0
  const waiting = streaming && view.steps.length === 0 && !view.answer && !message.thinking
  const summaryEntry = `${message.id}-summary`
  // 编辑回答：保存为同问题下的新版本（方式 B），原 AI 回复仍可用版本切换器切回
  const locale = useSettings((state) => state.locale)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // 只有已完成、不在流式输出、且有正文的回答可以编辑（拒答模板不参与）
  const canEdit = !streaming && message.status === 'done' && !!answer?.text && !refused
  const canSave = draft.trim() !== '' && !busy

  useEffect(() => {
    if (editing) {
      startMessageEditing(message.id)
      return () => stopMessageEditing(message.id)
    }
    stopMessageEditing(message.id)
    return undefined
  }, [editing, message.id])

  // 编辑框随内容高度自适应，超过上限后内部滚动（手机上不会撑破气泡）
  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (editing && textarea) {
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, 360)}px`
    }
  }, [editing, draft])

  const startEditing = () => {
    if (!answer) {
      return
    }
    stopReadAloud()
    setDraft(answer.text)
    setEditing(true)
  }

  const cancelEditing = () => {
    setEditing(false)
    setDraft('')
  }

  const saveEdit = () => {
    if (!canSave) {
      return
    }
    if (editAssistantReply(sessionId, message.id, draft)) {
      stopReadAloud()
      setEditing(false)
      setDraft('')
    }
  }
  return (
    <div
      className={clsx(styles.message, avatar && styles.withAvatar)}
      data-message-id={message.id}
    >
      {avatar ? (
        avatar.src ? (
          <img className={styles.avatar} src={avatar.src} alt="" />
        ) : (
          <span className={clsx(styles.avatar, styles.avatarText)}>{avatar.label.slice(0, 1)}</span>
        )
      ) : null}
      {/* 气泡皮肤：AI 输出气泡由「AI 输出气泡」开关控制（默认关），模型只输出纯文本 */}
      <div
        className={clsx(
          showBubble ? `${styles.bubbleBody} ds-ai-bubble` : styles.bubbleBodyOff,
          editing && styles.editingBody
        )}
      >
      {refused ? null : (
        <ReplyArea
          message={message}
          view={view}
          streaming={streaming}
          hasResponse={!!responseText}
        />
      )}
      {editing ? (
        <div className={styles.editor}>
          <textarea
            ref={textareaRef}
            className={styles.textarea}
            aria-label={t('editMessage')}
            value={draft}
            rows={2}
            autoFocus
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) {
                return
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                cancelEditing()
              } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                saveEdit()
              }
            }}
          />
          <div className={styles.editorActions}>
            <Button size="s" variant="outlined" onClick={cancelEditing}>
              {t('cancel')}
            </Button>
            <Button size="s" disabled={!canSave} onClick={saveEdit}>
              {locale === 'zh-CN' ? '保存为新版本' : 'Save as new version'}
            </Button>
          </div>
        </div>
      ) : answer ? (
        <Markdown
          className="ds-assistant-message-main-content"
          content={answer.markdown}
          loading={streaming}
          cacheKey={message.id}
          disableLink={false}
          sources={view.sources}
        />
      ) : null}
      {waiting ? (
        <div className={styles.waiting}>
          {[0, 1, 2].map((index) => (
            <span key={index} className={styles.waitingDot} />
          ))}
        </div>
      ) : null}
      {notice?.presentation === 'response' ? (
        <Markdown
          className="ds-assistant-message-main-content"
          content={notice.text}
          loading={false}
          cacheKey={`${message.id}-template`}
          disableLink={false}
        />
      ) : notice ? (
        <div className={styles.notice}>
          <IconWarningOutline16 />
          <div className={styles.noticeBody}>
            <span className={styles.noticeText}>
              {notice.text}
            {notice.action === 'apiKey' ? (
              <>
                {' '}
                <button
                  type="button"
                  className={styles.noticeAction}
                  onClick={() => openSettings('data')}
                >
                  {t('changeApiKey')}
                </button>
              </>
            ) : null}
              {notice.action === 'topUp' ? (
                <>
                  {' '}
                  <a
                    className={styles.noticeAction}
                    href={TOP_UP_URL}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t('topUp')}
                  </a>
                </>
              ) : null}
            </span>
            {notice.detail ? (
              <details className={styles.noticeDetail}>
                <summary className={styles.noticeDetailSummary}>{t('errorDetailLabel')}</summary>
                <span className={styles.noticeDetailText}>{notice.detail}</span>
              </details>
            ) : null}
          </div>
        </div>
      ) : null}
      {!streaming && !editing && charCount > 0 ? (
        <div className={styles.charCount}>{t('messageCharCount', { count: charCount })}</div>
      ) : null}
      {!streaming && !editing && showTokenUsage && message.usage ? (
        <div className={styles.charCount}>
          {t('messageTokenUsage', {
            input: formatTokens(
              message.usage.input_tokens +
                message.usage.cache_creation_input_tokens +
                message.usage.cache_read_input_tokens
            ),
            cached: formatTokens(message.usage.cache_read_input_tokens),
            output: formatTokens(message.usage.output_tokens),
          })}
        </div>
      ) : null}
      {!streaming && !editing && !refused && view.searchResults.length > 0 ? (
        <div
          className={clsx(styles.summary, panelEntry === summaryEntry && styles.summaryActive)}
          onClick={() => toggleSearchPanel(summaryEntry, view.searchResults)}
        >
          <SiteThumbnails sources={view.searchResults} />
          <span>
            {t(
              view.searchResults.length === 1 ? 'messageSearchSummary' : 'messageSearchSummaries',
              { count: view.searchResults.length }
            )}
          </span>
        </div>
      ) : null}
      {showBubble && showReadMark && !streaming && !editing && responseText ? (
        <span className={styles.readMark}>{t('readMark')}</span>
      ) : null}
      </div>
      {streaming || editing ? null : (
        <div className={styles.bottom}>

          <BranchSwitcher versions={versions} disabled={busy} onSelect={onSelectVersion} />
          <div className={clsx(styles.actions, isLast && styles.alwaysShow)}>
            {/* 分叉放最左边：它以前紧挨着「重新生成」，手机上连点容易误触（0.9.50 反馈） */}
            <IconButton
              icon={<IconForkOutline16 />}
              tooltip={t('forkChat')}
              tooltipPlacement="bottom"
              disabled={busy}
              onClick={() => {
                stopReadAloud()
                if (forkSession(sessionId, message.id)) {
                  showToast({ key: 'forkedToast' })
                  closeMobileSider()
                }
              }}
            />
            {copyText ? <CopyButton text={copyText} /> : null}
            {readAloudEnabled && responseText && !refused ? (
              <ReadAloudButton messageId={message.id} text={responseText} />
            ) : null}
            {canEdit ? (
              <IconButton
                icon={<IconEditOutline16 />}
                tooltip={t('editMessage')}
                tooltipPlacement="bottom"
                disabled={busy}
                onClick={startEditing}
              />
            ) : null}
            <Menu
              options={[
                {
                  key: 'default',
                  label: t('regenerateDefault'),
                  icon: <IconRefreshOutline16 />,
                  onSelect: () => {
                    stopReadAloud()
                    regenerateReply(sessionId, message.id)
                  },
                },
                {
                  key: 'detailed',
                  label: t('regenerateDetailed'),
                  icon: <IconRefreshOutline16 />,
                  onSelect: () => {
                    stopReadAloud()
                    regenerateReply(sessionId, message.id, { lengthOverride: 'detailed' })
                  },
                },
                {
                  key: 'concise',
                  label: t('regenerateConcise'),
                  icon: <IconRefreshOutline16 />,
                  onSelect: () => {
                    stopReadAloud()
                    regenerateReply(sessionId, message.id, { lengthOverride: 'concise' })
                  },
                },
              ]}
            >
              {({ toggle }) => (
                <IconButton
                  icon={<IconRefreshOutline16 />}
                  tooltip={t('regenerate')}
                  tooltipPlacement="bottom"
                  disabled={busy || refused}
                  onClick={toggle}
                />
              )}
            </Menu>
          </div>
          {isLast && canContinueReply(message) ? (
            <Button
              variant="outlined"
              size="s"
              className={styles.continueButton}
              disabled={busy}
              onClick={() => {
                stopReadAloud()
                continueReply(sessionId, message.id)
              }}
            >
              {t('continueGenerating')}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  )
})

/** 本轮 token 用量与按官方峰谷价估算的费用；拿不到用量时不渲染 */

