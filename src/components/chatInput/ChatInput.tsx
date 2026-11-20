import { HIDDEN_FILE_INPUT_STYLE } from '../../utils/hiddenFileInput.js'
import clsx from 'clsx'
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  IconArrowUp18,
  IconGlobeLanguageOutline14,
  IconKeyboardCircle26,
  IconMoreCircle26,
  IconStopFill16,
  IconThinkOutline14,
  IconVoiceSignal26,
} from '../base/icons.js'
import {
  setSearch,
  setThinking,
  setThinkingEffort,
  useSettings,
  type ThinkingEffort,
} from '../../services/settings.js'
import { useIsMobile } from '../../app/viewport.js'
import { usesOpenAiProtocol } from '../../services/api/protocol.js'
import { sendMessage, stopReply, useChatStore } from '../../services/chat/store.js'
import {
  addDraftFiles,
  EMPTY_DRAFT,
  getDraft,
  prepareDraftMessage,
  removeDraftAttachment,
  retryDraftAttachment,
  setDraftText,
  useDrafts,
} from '../../services/chat/drafts.js'
import { stopReadAloud } from '../../services/speech/readAloud.js'
import { Tooltip } from '../base/Tooltip.js'
import { useDismiss } from '../base/anchored.js'
import { IconButton } from '../base/IconButton.js'
import { ImageLightbox } from '../base/ImageLightbox.js'
import { AttachmentPanel } from './AttachmentPanel.js'
import { ensureApiKey } from '../settings/settingsDialogState.js'
import { DragMask, useFileDrop } from './DragMask.js'
import { showToast } from '../base/toastState.js'
import { ACCEPT, useUploads } from '../../services/attachments.js'
import { DraftAttachments } from './DraftAttachments.js'
import { useVoiceInput } from './useVoiceInput.js'
import { Spectrum } from './Spectrum.js'
import { useTranslate } from '../../i18n/index.js'
import styles from './ChatInput.module.css'

/** 「点 ▾ 可以调思考强度」只提示一次 */
const EFFORT_HINT_KEY = 'chat-demo:thinking-effort-hint'

/**
 * 触屏设备（安卓 / iPhone / iPad，含网页版 PWA）：软键盘没有 Shift，回车一律当换行。
 * 个别 iOS 版本会把 pointer 报成 fine，这里用 maxTouchPoints 兜一层。
 */
const isTouchDevice = () =>
  window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0

/** 输入框：自适应高度的文本框 + 文件 + 深度思考与智能搜索开关 + 语音输入 + 发送 / 停止 */
export const ChatInput = memo(function ChatInput({ sessionId }: { sessionId: string | null }) {
  // 切换目标时释放录音、转写和 DOM 状态；文字与附件由草稿服务保留。
  return <Input key={sessionId === null ? 'new' : `session:${sessionId}`} sessionId={sessionId} />
})

const Input = ({ sessionId }: { sessionId: string | null }) => {
  const t = useTranslate()
  const draft = useDrafts((state) => state.drafts.get(sessionId) ?? EMPTY_DRAFT)
  const { text, attachments } = draft
  const setText = (value: string) => setDraftText(sessionId, value)
  const draftReady = useUploads((state) => prepareDraftMessage(draft, state.tasks) !== null)
  const streaming = useChatStore(
    (state) => sessionId !== null && Object.hasOwn(state.streaming, sessionId)
  )
  const thinking = useSettings((state) => state.thinking)
  const importingHistory = useChatStore((state) => state.importingHistory)
  const isMobile = useIsMobile()
  const search = useSettings((state) => state.search)
  const thinkingEffort = useSettings((state) => state.thinkingEffort)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const photoInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const togglesRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  // 「更多」展开的附件面板：点按钮后输入框连同面板一起上移，点外面 / Esc 收起
  const [moreOpen, setMoreOpen] = useState(false)
  useDismiss(moreOpen, [rootRef], () => setMoreOpen(false))
  // 思考强度的选择菜单 + 「点 ▾ 可以调强度」的一次性提示
  const [effortOpen, setEffortOpen] = useState(false)
  const [hintVisible, setHintVisible] = useState(false)
  const [hintSeen, setHintSeen] = useState(() => {
    try {
      return window.localStorage.getItem(EFFORT_HINT_KEY) === '1'
    } catch {
      return true
    }
  })

  const markHintSeen = useCallback(() => {
    setHintVisible(false)
    setHintSeen(true)
    try {
      window.localStorage.setItem(EFFORT_HINT_KEY, '1')
    } catch {
      // 存不进去就每次提醒一次，不致命
    }
  }, [])

  // 第一次开启深度思考时，冒一次「点 ▾ 可以调强度」，让从网页版搬过来的人也知道
  const toggleThinking = () => {
    const next = !thinking
    setThinking(next)
    if (next && !hintSeen) {
      setHintVisible(true)
      window.setTimeout(() => setHintVisible(false), 8000)
    }
  }

  // 菜单贴在按钮上方弹出：记下按钮位置，用 fixed 坐标放到 body 上，避免被输入框裁掉
  const [effortAnchorBox, setEffortAnchorBox] = useState<{ left: number; bottom: number } | null>(null)
  const effortAnchorRef = useRef<HTMLButtonElement>(null)
  const effortFloatingRef = useRef<HTMLDivElement>(null)

  const openEffortMenu = () => {
    const rect = effortAnchorRef.current?.getBoundingClientRect()
    if (rect) {
      setEffortAnchorBox({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - 200)),
        bottom: Math.max(8, window.innerHeight - rect.top + 8),
      })
    }
    setEffortOpen((open) => !open)
    markHintSeen()
  }

  useEffect(() => {
    if (!effortOpen) {
      return
    }
    const close = () => setEffortOpen(false)
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (
        effortAnchorRef.current?.contains(target) ||
        effortFloatingRef.current?.contains(target)
      ) {
        return
      }
      close()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [effortOpen])

  const effortOptions: { value: ThinkingEffort; label: string; desc: string }[] = [
    { value: 'low', label: t('thinkingEffortLow'), desc: t('thinkingEffortLowDesc') },
    { value: 'high', label: t('thinkingEffortHigh'), desc: t('thinkingEffortHighDesc') },
    { value: 'max', label: t('thinkingEffortMax'), desc: t('thinkingEffortMaxDesc') },
  ]
  const effortLabel =
    effortOptions.find((item) => item.value === thinkingEffort)?.label ?? t('thinkingEffortLow')

  useLayoutEffect(() => {
    const toggles = togglesRef.current
    if (!toggles) {
      return
    }

    const updateLabels = () => {
      toggles.classList.remove(styles.collapsedToggles)
      toggles.classList.toggle(styles.collapsedToggles, toggles.scrollWidth > toggles.clientWidth)
    }

    updateLabels()
    const observer = new ResizeObserver(updateLabels)
    observer.observe(toggles)
    return () => observer.disconnect()
  }, [t])

  const acceptFiles = (picked: File[]) => {
    if (picked.length === 0 || useChatStore.getState().importingHistory || !ensureApiKey()) {
      return
    }
    // v4 pro 不支持图片输入：选图时直接拦下，别等发送失败
    let files = picked
    if (useSettings.getState().model === 'deepseek-v4-pro') {
      const images = picked.filter((file) => file.type.startsWith('image/'))
      if (images.length > 0) {
        showToast({ key: 'modelProNoImage' })
        files = picked.filter((file) => !file.type.startsWith('image/'))
        if (files.length === 0) {
          return
        }
      }
    }
    void addDraftFiles(sessionId, files, useSettings.getState().apiKey ?? '').then((error) => {
      if (error) {
        showToast(error)
      }
    })
  }
  const retryFile = useCallback(
    (id: string) => {
      if (!useChatStore.getState().importingHistory && ensureApiKey()) {
        retryDraftAttachment(sessionId, id, useSettings.getState().apiKey ?? '')
      }
    },
    [sessionId]
  )
  const removeFile = useCallback(
    (id: string) => {
      if (!useChatStore.getState().importingHistory) {
        removeDraftAttachment(sessionId, id)
      }
    },
    [sessionId]
  )
  const dragging = useFileDrop(acceptFiles)
  /** 语音模式（原版：点麦克风后输入框变成「按住说话」） */
  const [voiceMode, setVoiceMode] = useState(false)
  /** 识别完成要自动发送（等 voice 回到 idle 再发） */
  const pendingVoiceSendRef = useRef(false)
  /** 点输入框里的图片预览：放大查看 */
  const [preview, setPreview] = useState<{ src: string; name: string } | null>(null)
  // 附件被删掉 / 发送后，把还挂着的预览一起关掉，别显示一张已经释放的图
  useEffect(() => {
    if (preview && !attachments.some((item) => item.previewUrl === preview.src)) {
      setPreview(null)
    }
  }, [attachments, preview])

  /** 语音模式：松手后把识别结果直接发出去（原版行为） */
  const voice = useVoiceInput((transcript) => {
    const current = getDraft(sessionId).text.trim()
    setText(current ? `${current} ${transcript}` : transcript)
    pendingVoiceSendRef.current = true
  })

  // 识别结束（status 回到 idle）时自动发送：草稿里已经是识别结果
  useEffect(() => {
    if (voice.status !== 'idle' || !pendingVoiceSendRef.current) {
      return
    }
    pendingVoiceSendRef.current = false
    if (useChatStore.getState().importingHistory || !ensureApiKey()) {
      return
    }
    if (sendMessage(sessionId) && isMobile) {
      textareaRef.current?.blur()
    }
  }, [voice.status, sessionId, isMobile])

  // 欢迎页导入后会话 ID 不变，不能依赖卸载取消语音；订阅开始事件也覆盖快速完成的导入。
  const cancelVoice = voice.cancel
  useEffect(
    () =>
      useChatStore.subscribe((state, previous) => {
        if (state.importingHistory && !previous.importingHistory) {
          cancelVoice()
        }
      }),
    [cancelVoice]
  )

  // 移动端录音时用频谱替代输入框内容
  const recording = voice.status === 'recording'

  // 排队、上传中或上传失败的附件都留在输入框，全部上传成功后才能发送
  const canSend = !importingHistory && !streaming && voice.status === 'idle' && draftReady
  // 有内容（文字或附件）就出现发送键；文字为空时语音键保留，附件也保留（对齐原版）
  const hasContent = text.trim() !== '' || attachments.length > 0
  // 带了附件又没输入文字时，给一排快捷提问（原版也有这排建议）
  const attachmentNoun = t(
    attachments.some((item) => !item.isImage) ? 'suggestionNounFile' : 'suggestionNounImage'
  )
  const suggestions =
    attachments.length > 0 && text.trim() === '' && !streaming && !voiceMode
      ? [
          { label: t('suggestionAnalyze'), text: t('suggestionAnalyzeText', { noun: attachmentNoun }) },
          {
            label: t('suggestionSummarize'),
            text: t('suggestionSummarizeText', { noun: attachmentNoun }),
          },
          {
            label: t('suggestionExplain'),
            text: t('suggestionExplainText', { noun: attachmentNoun }),
          },
          { label: t('suggestionWhatIs'), text: t('suggestionWhatIsText', { noun: attachmentNoun }) },
        ]
      : []

  /** 进入语音模式：输入框变成「按住说话」，键盘收起 */
  const enterVoiceMode = () => {
    if (!voice.available) {
      showToast({ key: 'voiceInputRequiresHttps' })
      return
    }
    if (!ensureApiKey()) {
      return
    }
    textareaRef.current?.blur()
    setVoiceMode(true)
  }

  /** 切回键盘模式：有在录的先取消，再把焦点还给输入框 */
  const exitVoiceMode = () => {
    if (voice.status !== 'idle') {
      voice.cancel()
    }
    setVoiceMode(false)
    requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }))
  }

  /** 按住说话：按下开始录音 */
  const holdStart = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // 部分 WebView 不支持指针捕获，按住仍能收到 pointerup
    }
    if (voice.status === 'idle') {
      void voice.toggle()
    }
  }

  /** 松手结束录音 → 转写 → 自动发送 */
  const holdEnd = () => {
    if (voice.status === 'recording') {
      void voice.toggle()
    }
  }

  const toggleMore = () => {
    const next = !moreOpen
    setMoreOpen(next)
    // 弹出面板时收起软键盘，否则面板 + 键盘一起挤占聊天区
    if (next) {
      textareaRef.current?.blur()
    }
  }

  const send = () => {
    if (
      useChatStore.getState().importingHistory ||
      voice.status !== 'idle' ||
      !prepareDraftMessage(getDraft(sessionId), useUploads.getState().tasks)
    ) {
      return
    }
    // 文本与上传完成态由提交动作读取最新快照，不使用上一次渲染的草稿。
    if (!ensureApiKey() || !sendMessage(sessionId)) {
      return
    }
    stopReadAloud()
    if (isMobile) {
      textareaRef.current?.blur()
    } else {
      textareaRef.current?.focus()
    }
  }

  return (
    <div className={styles.root} ref={rootRef}>
    <div
      className={clsx(styles.wrapper, sessionId === null ? styles.home : styles.session)}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          textareaRef.current?.focus({ preventScroll: true })
        }
      }}
    >
      <DraftAttachments
        items={attachments}
        onRetry={retryFile}
        onRemove={removeFile}
        onPreview={(item) => {
          if (item.previewUrl) {
            setPreview({ src: item.previewUrl, name: item.file.name })
          }
        }}
      />
      {/* 带了附件又没打字：给一排快捷提问，点一下填进输入框（原版同款建议条） */}
      {suggestions.length > 0 ? (
        <div className={styles.suggestions}>
          {suggestions.map((item) => (
            <button
              key={item.label}
              type="button"
              className={styles.suggestion}
              onClick={() => setText(item.text)}
            >
              {item.label}
              <span className={styles.suggestionArrow}>→</span>
            </button>
          ))}
        </div>
      ) : null}
      {voiceMode ? (
        /* 语音模式（原版图 2）：输入框变成「按住说话」，松手自动发送识别结果 */
        <div className={styles.voiceMode}>
          <button
            type="button"
            className={clsx(
              styles.holdButton,
              voice.status === 'recording' && styles.holding,
              voice.status === 'transcribing' && styles.transcribing
            )}
            disabled={!voice.available}
            onPointerDown={holdStart}
            onPointerUp={holdEnd}
            onPointerCancel={holdEnd}
            onContextMenu={(event) => event.preventDefault()}
          >
            {voice.status === 'recording'
              ? t('voiceHoldRelease', { seconds: voice.seconds })
              : voice.status === 'transcribing'
                ? t('voiceRecognizing')
                : t('voiceHoldToTalk')}
          </button>
        </div>
      ) : (
      <div className={styles.textareaWrapper}>
        <textarea
          ref={textareaRef}
          className={clsx(styles.textarea, recording && isMobile && styles.textareaHidden)}
          placeholder={t('chatInputPlaceholderChat')}
          rows={2}
          enterKeyHint="enter"
          // 移动端不自动聚焦，避免一打开就弹出键盘
          autoFocus={!isMobile}
          disabled={importingHistory}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onMouseDown={(event) => {
            // 首次点击时手动聚焦，避免 Safari 把整个页面滚到输入框位置。
            if (isMobile && event.button === 0 && document.activeElement !== event.currentTarget) {
              event.preventDefault()
              event.currentTarget.focus({ preventScroll: true })
            }
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) {
              return
            }
            // 触屏设备（手机 / 平板 / iOS 网页版）：回车当换行，发送交给右下角按钮
            if (isMobile || isTouchDevice()) {
              return
            }
            if (!event.shiftKey) {
              event.preventDefault()
              send()
            }
          }}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files)
            if (files.length > 0) {
              event.preventDefault()
              acceptFiles(files)
            }
          }}
        />
        {recording && isMobile ? <Spectrum getAnalyser={voice.getAnalyser} /> : null}
        <div className={styles.mirror} aria-hidden>
          {`${text}\n`}
        </div>
      </div>
      )}
      <div className={styles.functionRow}>
        {/* 深度思考 / 智能搜索开关，tooltip 在按钮上方 */}
        <div ref={togglesRef} className={styles.toggles}>
          <div className={styles.thinkGroup}>
            <Tooltip content={t('deactivatedThinkTooltip')}>
              <button
                type="button"
                className={clsx(styles.toggle, thinking && styles.selected)}
                aria-label={t('thinkingSwitch')}
                aria-pressed={thinking}
                onClick={toggleThinking}
              >
                <IconThinkOutline14 />
                <span className={styles.toggleLabel}>{t('thinkingSwitch')}</span>
              </button>
            </Tooltip>
            <button
              ref={effortAnchorRef}
              type="button"
              title={t('thinkingEffortTip', { level: effortLabel })}
              className={clsx(
                styles.caret,
                thinking && styles.caretSelected,
                thinkingEffort !== 'low' && styles.caretCustom
              )}
              aria-label={t('thinkingEffort')}
              aria-haspopup="menu"
              aria-expanded={effortOpen}
              onClick={openEffortMenu}
            >
              <span aria-hidden>▾</span>
            </button>
            {effortOpen
              ? createPortal(
                  <div
                    ref={effortFloatingRef}
                    className={styles.effortMenu}
                    style={
                      effortAnchorBox
                        ? { left: effortAnchorBox.left, bottom: effortAnchorBox.bottom }
                        : { left: 8, bottom: 80 }
                    }
                    role="menu"
                    aria-label={t('thinkingEffort')}
                  >
                    {effortOptions.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        role="menuitemradio"
                        aria-checked={thinkingEffort === option.value}
                        className={clsx(
                          styles.effortItem,
                          thinkingEffort === option.value && styles.effortItemActive
                        )}
                        onClick={() => {
                          setThinkingEffort(option.value)
                          setEffortOpen(false)
                          markHintSeen()
                        }}
                      >
                        <span>{option.label}</span>
                        <span className={styles.effortItemDesc}>{option.desc}</span>
                      </button>
                    ))}
                  </div>,
                  document.body
                )
              : null}
            {hintVisible ? (
              <div className={styles.effortHint} role="status">
                {t('thinkingEffortHint')}
              </div>
            ) : null}
          </div>
          <Tooltip content={t('deactivatedSearchTooltip')}>
            <button
              type="button"
              className={clsx(styles.toggle, search && styles.selected)}
              aria-label={t('search')}
              aria-pressed={search}
              onClick={() => {
                // OpenAI 兼容通道没有联网搜索工具：说清楚，别让人以为开了
                if (usesOpenAiProtocol()) {
                  showToast({ key: 'openAiSearchUnsupported' })
                  return
                }
                // v4 pro 已关闭服务端联网/读链接：点一下就说清楚，不假装能开
                if (useSettings.getState().model === 'deepseek-v4-pro') {
                  showToast({ key: 'modelProNoSearch' })
                  return
                }
                setSearch(!search)
              }}
            >
              <IconGlobeLanguageOutline14 />
              <span className={styles.toggleLabel}>{t('search')}</span>
            </button>
          </Tooltip>
        </div>
        <div className={styles.right}>
          {/* 更多 → 语音 / 发送（对齐原版）：点 ✛ 转 45° 并展开附件面板；
              文字为空时语音键在，有内容时出现发送键；语音模式里换成「切换键盘」 */}
          <IconButton
            size="m"
            tone="primary"
            tooltip={t('moreAttach')}
            disabled={importingHistory}
            aria-expanded={moreOpen}
            aria-haspopup="dialog"
            onClick={toggleMore}
            icon={
              <span className={clsx(styles.moreGlyph, moreOpen && styles.moreGlyphOpen)}>
                <IconMoreCircle26 />
              </span>
            }
          />
          {voiceMode ? (
            <IconButton
              size="m"
              tone="primary"
              tooltip={t('voiceSwitchKeyboard')}
              onClick={exitVoiceMode}
              icon={<IconKeyboardCircle26 />}
            />
          ) : (
            <>
              {text.trim() === '' ? (
                <IconButton
                  size="m"
                  tone="primary"
                  tooltip={t('voiceInput')}
                  disabled={!voice.available}
                  onClick={enterVoiceMode}
                  icon={<IconVoiceSignal26 />}
                />
              ) : null}
              {!streaming && hasContent ? (
                <button
                  type="button"
                  className={clsx(styles.sendButton, !canSend && styles.disabled)}
                  aria-label={t('send')}
                  aria-disabled={!canSend}
                  onClick={send}
                >
                  <IconArrowUp18 />
                </button>
              ) : null}
            </>
          )}
          {streaming && sessionId ? (
            <button
              type="button"
              className={styles.sendButton}
              aria-label={t('chatInputStopButtonTooltip')}
              onClick={() => {
                stopReadAloud()
                stopReply(sessionId)
              }}
            >
              <IconStopFill16 />
            </button>
          ) : null}
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            style={HIDDEN_FILE_INPUT_STYLE}
            onChange={(event) => {
              acceptFiles(Array.from(event.target.files ?? []))
              event.target.value = ''
            }}
          />
          <input
            ref={photoInputRef}
            type="file"
            accept="image/*"
            multiple
            style={HIDDEN_FILE_INPUT_STYLE}
            onChange={(event) => {
              acceptFiles(Array.from(event.target.files ?? []))
              event.target.value = ''
            }}
          />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={HIDDEN_FILE_INPUT_STYLE}
            accept={ACCEPT}
            onChange={(event) => {
              acceptFiles(Array.from(event.target.files ?? []))
              event.target.value = ''
            }}
          />
        </div>
      </div>
    </div>
      {moreOpen ? (
        <AttachmentPanel
          onCamera={() => {
            if (ensureApiKey()) {
              setMoreOpen(false)
              cameraInputRef.current?.click()
            }
          }}
          onPhoto={() => {
            if (ensureApiKey()) {
              setMoreOpen(false)
              photoInputRef.current?.click()
            }
          }}
          onFile={() => {
            if (ensureApiKey()) {
              setMoreOpen(false)
              fileInputRef.current?.click()
            }
          }}
        />
      ) : null}
      {dragging ? <DragMask /> : null}
      {/* 点输入框里已加的图片预览：放大查看（原版行为） */}
      {preview ? (
        <ImageLightbox src={preview.src} alt={preview.name} onClose={() => setPreview(null)} />
      ) : null}
    </div>
  )
}
