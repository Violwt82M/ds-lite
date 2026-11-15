import clsx from 'clsx'
import { useRef, useState, type ReactNode } from 'react'
import {
  IconDarkOutline16,
  IconDataOutline16,
  IconDownloadOutline16,
  IconFollowsystemOutline16,
  IconLightOutline16,
  IconGlobeLanguageOutline14,
  IconSettingsOutline16,
  IconThinkOutline16,
  IconUploadOutline14,
} from '../base/icons.js'
import {
  BackupError,
  clearHistory,
  exportHistory,
  exportMemoryNotes,
  importHistory,
  readImportSessions,
  readLocalSessionIds,
} from '../../services/chat/backup.js'
import type { ImportSessionOption } from '../../services/chat/history/importIndex.js'
import { useIsMobile } from '../../app/viewport.js'
import { useChatStore } from '../../services/chat/store.js'
import { useTransfer } from '../../services/chat/transfer.js'
import { saveFile } from '../../services/export/saveFile.js'
import { regionCodes, getRegionName, provinces } from '../../services/location.js'
import {
  isChineseBrowser,
  setLocale,
  setLocation,
  setThemePreference,
  setThinkingEffort,
  setTtsVoice,
  useSettings,
  type ThemePreference,
  type ThinkingEffort,
} from '../../services/settings.js'
import { translate, useTranslate, type TranslationKey, type TranslationMessage } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import { ApiKeyConfirm, ApiKeyField, useApiKeyEditor } from './ApiKeyField.js'
import { PersonaSetting } from './PersonaSetting.js'
import { AboutPanel } from '../about/AboutPanel.js'
import { closeSettings, useSettingsDialog, type SettingsSection } from './settingsDialogState.js'
import styles from './Settings.module.css'

/**
 * 设置弹窗：分「通用设置」（主题、语言、朗读音色、位置）与「数据管理」（API Key、导入、导出、删除）。
 * 桌面端为居中弹窗、左侧导航；移动端为底部弹层、导航横排在内容上方
 */
export const SettingsDialog = () => {
  const open = useSettingsDialog((state) => state.open)
  return open ? <SettingsContent /> : null
}

/** 选择列表一次最多渲染多少行，其余用搜索收窄 */
const PICKER_RENDER_LIMIT = 200

/** 秒数/毫秒转「x 分 y 秒」 */
const formatDuration = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  if (seconds < 60) {
    return `${seconds} 秒`
  }
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}

const sections: { value: SettingsSection; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'general',
    label: 'settingDialogAsideGeneralOptionLabel',
    icon: <IconSettingsOutline16 />,
  },
  {
    value: 'persona',
    label: 'settingDialogAsidePersonaOptionLabel',
    icon: <IconThinkOutline16 />,
  },
  { value: 'data', label: 'settingDialogAsideDataOptionLabel', icon: <IconDataOutline16 /> },
  { value: 'about', label: 'settingDialogAsideAboutOptionLabel', icon: <IconGlobeLanguageOutline14 /> },
]

const SettingsContent = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  // 打开时按调用方指定的分组选中，之后在弹窗内切换
  const [section, setSection] = useState(() => useSettingsDialog.getState().section)
  // 切换分组不丢失正在输入的 API Key 与导入状态
  const apiKeyEditor = useApiKeyEditor()
  const historyImport = useHistoryImport()
  const historyDelete = useHistoryDelete()
  const replacingHistory = useChatStore((state) => state.importingHistory)
  const historyBusy = historyImport.busy || historyDelete.busy || replacingHistory
  return (
    <>
      <Modal
        title={t('settings')}
        closable
        className={styles.dialog}
        mainClassName={styles.dialogMain}
        onClose={() => {
          if (!historyDelete.busy) {
            closeSettings()
          }
        }}
      >
        <div role="tablist" className={styles.navigation}>
          {sections.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={section === item.value}
              className={clsx(styles.navItem, section === item.value && styles.navItemActive)}
              onClick={() => setSection(item.value)}
            >
              {item.icon}
              {t(item.label)}
            </button>
          ))}
        </div>
        <div role="tabpanel" className={styles.content}>
          {section === 'general' ? (
            <>
              <ThemeSetting />
              <ThinkingEffortSetting />
              <LocaleSetting />
              <TtsVoiceSetting />
              <LocationSetting />
            </>
          ) : section === 'persona' ? (
            <PersonaSetting />
          ) : section === 'about' ? (
            <AboutPanel />
          ) : (
            <>
              <ApiKeyField editor={apiKeyEditor} />
              <ImportHistory historyImport={historyImport} disabled={historyBusy} />
              <ExportHistory disabled={historyBusy} />
              <ExportMemory disabled={historyBusy} />
              <SettingCell
                label={t('deleteAllSessions')}
                status={null}
                action={
                  <Button
                    variant="dangerOutlined"
                    size="m"
                    className={styles.cellButton}
                    disabled={historyBusy}
                    onClick={historyDelete.open}
                  >
                    {t('delete')}
                  </Button>
                }
              />
              {isMobile ? <ApiKeyConfirm editor={apiKeyEditor} /> : null}
            </>
          )}
        </div>
      </Modal>
      {historyImport.file ? <ImportPicker historyImport={historyImport} /> : null}
      <ImportProgress />
      {historyDelete.opened ? <DeleteAllConfirm historyDelete={historyDelete} /> : null}
    </>
  )
}

/** 删除确认保留在设置之上；失败可重试，成功只关闭确认弹窗。 */
const DeleteAllConfirm = ({
  historyDelete,
}: {
  historyDelete: ReturnType<typeof useHistoryDelete>
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('deleteAllSessionsModalTitle')}
      className={styles.deleteConfirm}
      onClose={historyDelete.cancel}
      footer={
        <div className={styles.deleteActions} aria-busy={historyDelete.busy}>
          <Button
            variant="outlined"
            autoFocus
            disabled={historyDelete.busy}
            onClick={historyDelete.cancel}
          >
            {t('cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={historyDelete.busy}
            onClick={() => void historyDelete.confirm()}
          >
            {t(historyDelete.busy ? 'historyDeleting' : 'deleteAllSessions')}
          </Button>
        </div>
      }
    >
      {t('deleteAllSessionsModalDescription')}
    </Modal>
  )
}

const useHistoryDelete = () => {
  const [opened, setOpened] = useState(false)
  const [busy, setBusy] = useState(false)
  const deleting = useRef(false)

  const confirm = async () => {
    if (deleting.current) {
      return
    }
    deleting.current = true
    setBusy(true)
    try {
      await clearHistory()
      setOpened(false)
      showToast({ key: 'historyDeleted' })
    } catch {
      showToast({ key: 'historyDeleteFailed', type: 'error' })
    } finally {
      deleting.current = false
      setBusy(false)
    }
  }

  return {
    opened,
    busy,
    open: () => setOpened(true),
    cancel: () => {
      if (!deleting.current) {
        setOpened(false)
      }
    },
    confirm,
  }
}

const LocationSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const location = useSettings((state) => state.location)
  const province =
    location?.region === 'CN'
      ? provinces.find((item) => item.code === location.province)
      : undefined

  return (
    <SettingCell
      label={t('settingsLocation')}
      status={null}
      className={styles.locationCell}
      action={
        <div className={styles.locationSelectors}>
          {isChineseBrowser() ? (
            <>
              <Select
                ariaLabel={t('settingsLocationProvince')}
                className={styles.provinceSelect}
                value={province?.code ?? ''}
                placeholder={t('settingsLocationProvince')}
                options={provinces.map((item) => ({ value: item.code, label: item.name }))}
                onChange={(value) => {
                  if (value !== province?.code) {
                    setLocation({ region: 'CN', province: value })
                  }
                }}
              />
              <Select
                ariaLabel={t('settingsLocationCity')}
                className={styles.citySelect}
                value={province ? (location?.city ?? '') : ''}
                disabled={!province?.cities.length}
                placeholder={t('settingsLocationCity')}
                options={
                  province?.cities.map((item) => ({ value: item.code, label: item.name })) ?? []
                }
                onChange={(value) => {
                  if (province) {
                    setLocation({ region: 'CN', province: province.code, city: value })
                  }
                }}
              />
            </>
          ) : (
            <Select
              ariaLabel={t('settingsLocationRegion')}
              className={styles.regionSelect}
              value={location?.region ?? ''}
              placeholder={t('settingsLocationRegion')}
              options={regionCodes
                .map((code) => ({ value: code, label: getRegionName(code, locale) }))
                .sort((a, b) => a.label.localeCompare(b.label, locale))}
              onChange={(value) => setLocation({ region: value })}
            />
          )}
        </div>
      }
    />
  )
}

/** 思考强度：对应 API 的 output_config.effort；日常推荐低 */
const ThinkingEffortSetting = () => {
  const t = useTranslate()
  const thinkingEffort = useSettings((state) => state.thinkingEffort)
  return (
    <SettingCell
      label={t('settingsThinkingEffort')}
      description={t('settingsThinkingEffortHint')}
      status={null}
      action={
        <Select<ThinkingEffort>
          ariaLabel={t('settingsThinkingEffort')}
          value={thinkingEffort}
          options={[
            { value: 'low', label: t('thinkingEffortLow') },
            { value: 'high', label: t('thinkingEffortHigh') },
            { value: 'max', label: t('thinkingEffortMax') },
          ]}
          onChange={setThinkingEffort}
        />
      }
    />
  )
}

const LocaleSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  return (
    <SettingCell
      label={t('settingsLocalePreference')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsLocalePreference')}
          value={locale}
          options={[
            { value: 'zh-CN', label: t('settingsLocaleZhCN'), lang: 'zh-CN' },
            { value: 'en-US', label: t('settingsLocaleEnUS'), lang: 'en' },
          ]}
          onChange={setLocale}
        />
      }
    />
  )
}

/** 朗读音色：stella（海星，女声）/ tide（暗潮，男声） */
const TtsVoiceSetting = () => {
  const t = useTranslate()
  const ttsVoice = useSettings((state) => state.ttsVoice)
  return (
    <SettingCell
      label={t('settingsTtsVoice')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsTtsVoice')}
          value={ttsVoice}
          options={[
            { value: 'stella', label: t('settingsTtsVoiceStella') },
            { value: 'tide', label: t('settingsTtsVoiceTide') },
          ]}
          onChange={setTtsVoice}
        />
      }
    />
  )
}

/** 覆盖导入的二次确认，叠在设置弹窗上 */
const ImportPicker = ({
  historyImport,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
}) => {
  const t = useTranslate()
  const { file, sessions, existing, loadingSessions, selected, query, skipImages } = historyImport
  if (!file) {
    return null
  }
  const keyword = query.trim()
  const filtered = (sessions ?? []).filter(
    (item) => keyword === '' || item.title.includes(keyword) || item.id.includes(keyword)
  )
  // 上千条时只渲染前 200 条，其余靠搜索收窄，避免手机上卡顿
  const shown = filtered.slice(0, PICKER_RENDER_LIMIT)
  const total = sessions?.length ?? 0
  const canImport = !loadingSessions && selected.size > 0
  return (
    <Modal
      title={t('importPickerTitle')}
      className={styles.importPicker}
      mainClassName={styles.importPickerMain}
      onClose={historyImport.cancel}
      footer={
        <>
          <Button variant="outlined" size="m" onClick={historyImport.cancel}>
            {t('cancel')}
          </Button>
          <Button size="m" disabled={!canImport} onClick={() => void historyImport.confirm()}>
            {t('importPickerConfirm', { count: selected.size })}
          </Button>
        </>
      }
    >
      <div className={styles.importConfirmText}>{t('historyImportConfirmDescription')}</div>
      <div className={styles.importFileLine}>
        {t('importProgressFile', {
          name: file.name,
          size: (file.size / 1048576).toFixed(1),
        })}
      </div>
      <div className={styles.importAdvice}>{t('importPickerAdvice')}</div>
      {loadingSessions ? (
        <div className={styles.importPickerLoading}>{t('importPickerLoading')}</div>
      ) : (
        <>
          <div className={styles.importPickerToolbar}>
            <input
              className={styles.importSearch}
              value={query}
              placeholder={t('importPickerSearch')}
              onChange={(event) => historyImport.setQuery(event.target.value)}
            />
            <button type="button" className={styles.importLink} onClick={historyImport.selectAll}>
              {t('importPickerSelectAll')}
            </button>
            <button type="button" className={styles.importLink} onClick={historyImport.selectNone}>
              {t('importPickerSelectNone')}
            </button>
          </div>
          <div className={styles.importPickerCount}>
            {t('importPickerSelected', { selected: selected.size, total })}
            {selected.size === 0 ? (
              <span className={styles.importPickerHint}>{t('importPickerSelectHint')}</span>
            ) : null}
          </div>
          <div className={styles.importList}>
            {shown.map((item) => (
              <label key={item.id} className={styles.importRow}>
                <input
                  type="checkbox"
                  checked={selected.has(item.id)}
                  onChange={() => historyImport.toggle(item.id)}
                />
                <span className={styles.importRowText}>
                  <span className={styles.importRowTitle}>{item.title || t('untitledChat')}</span>
                  <span className={styles.importRowMeta}>
                    {existing.has(item.id) ? (
                      <span className={styles.importRowOwned}>{t('importPickerExisting')} · </span>
                    ) : null}
                    {t('importPickerMeta', {
                      count: item.messageCount,
                      date: new Date(item.updatedAt).toISOString().slice(0, 10),
                    })}
                  </span>
                </span>
              </label>
            ))}
            {filtered.length > shown.length ? (
              <div className={styles.importPickerMore}>
                {t('importPickerMore', { count: filtered.length - shown.length })}
              </div>
            ) : null}
            {filtered.length === 0 ? (
              <div className={styles.importPickerLoading}>{t('importPickerEmpty')}</div>
            ) : null}
          </div>
        </>
      )}
      <label className={styles.importSkip}>
        <input type="checkbox" checked={skipImages} onChange={historyImport.toggleSkipImages} />
        <span>
          <span className={styles.importSkipLabel}>{t('importSkipImages')}</span>
          <span className={styles.importSkipHint}>{t('importSkipImagesHint')}</span>
        </span>
      </label>
    </Modal>
  )
}

/**
 * 导入进行中的进度弹窗：文件名、进度条、当前阶段。
 * 不能点关闭（导入是不可中断的连续事务），只提示别退出应用。
 */
const ImportProgress = () => {
  const t = useTranslate()
  const importing = useTransfer((state) => state.importing)
  if (!importing) {
    return null
  }
  const percent = Math.round(Math.min(1, importing.ratio) * 100)
  // 按已读字节估剩余时间：条目大小差异很大，按条数估会跳
  const elapsed = Date.now() - importing.startedAt
  const remaining =
    importing.bytesDone > 0 && importing.bytesTotal > importing.bytesDone
      ? (elapsed / importing.bytesDone) * (importing.bytesTotal - importing.bytesDone)
      : null
  const phase =
    importing.phase === 'checking'
      ? t('importPhaseChecking')
      : importing.phase === 'scanning'
        ? t('importPhaseScanning', {
            done: importing.entriesDone,
            total: importing.entriesTotal,
          })
        : importing.phase === 'committing'
          ? t('importPhaseCommitting')
          : t('importPhaseReading', {
              done: importing.entriesDone,
              total: importing.entriesTotal,
            })
  return (
    <Modal
      title={t('importProgressTitle')}
      className={styles.importConfirm}
      onClose={() => {}}
    >
      <div className={styles.importProgress} role="status" aria-live="polite">
        <div className={styles.importProgressFile}>
          {t('importProgressFile', {
            name: importing.fileName,
            size: (importing.fileSize / 1048576).toFixed(1),
          })}
        </div>
        <div className={styles.progressTrack}>
          <div className={styles.progressFill} style={{ width: `${Math.max(2, percent)}%` }} />
        </div>
        <div className={styles.importProgressMeta}>
          <span>{phase}</span>
          <span>{percent}%</span>
        </div>
        {elapsed !== null ? (
          <div className={styles.importProgressMeta}>
            <span>{t('importElapsed', { time: formatDuration(elapsed) })}</span>
            <span>
              {remaining !== null ? t('importRemaining', { time: formatDuration(remaining) }) : ''}
            </span>
          </div>
        ) : null}
        <div className={styles.importProgressHint}>{t('importProgressHint')}</div>
      </div>
    </Modal>
  )
}

const themeOptions: { value: ThemePreference; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'light',
    label: 'avatarMenuSettingsDialogThemeSelectLightOption',
    icon: <IconLightOutline16 />,
  },
  {
    value: 'dark',
    label: 'avatarMenuSettingsDialogThemeSelectDarkOption',
    icon: <IconDarkOutline16 />,
  },
  {
    value: 'system',
    label: 'avatarMenuSettingsDialogThemeSelectSystemOption',
    icon: <IconFollowsystemOutline16 />,
  },
]

/**
 * 主题项：标题下方浅色 / 深色 / 跟随系统三个选块。
 * 与下方语言选项连续排列。
 */
const ThemeSetting = () => {
  const t = useTranslate()
  const themePreference = useSettings((state) => state.themePreference)
  const label = t('avatarMenuSettingsDialogThemeItemLabel')
  return (
    <div className={styles.theme}>
      {label}
      <div role="radiogroup" aria-label={label} className={styles.themeOptions}>
        {themeOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={themePreference === option.value}
            className={clsx(
              styles.themeOption,
              themePreference === option.value && styles.themeOptionSelected
            )}
            onClick={() => setThemePreference(option.value)}
          >
            {option.icon}
            {t(option.label)}
          </button>
        ))}
      </div>
    </div>
  )
}

/** `reason` 为失败原因的文案 key，展示时按当前语言翻译后填入 `message` 参数。 */
type Status = (TranslationMessage & { error?: boolean; reason?: TranslationKey }) | null

/** 导出失败附带原因：预期的错误用对应文案作原因，其他错误用错误信息。 */
const errorStatus = (key: TranslationKey, error: unknown): Status => ({
  key,
  ...(error instanceof BackupError
    ? { reason: error.key }
    : { params: { message: error instanceof Error ? error.message : String(error) } }),
  error: true,
})

const SettingCell = ({
  label,
  description,
  status,
  action,
  className,
}: {
  label: string
  description?: string
  status: Status
  action: ReactNode
  className?: string
}) => {
  const t = useTranslate()
  return (
    <div className={clsx(styles.cell, styles.row, className)}>
      <div className={styles.text}>
        <div className={styles.label}>{label}</div>
        {status || description ? (
          <div className={clsx(styles.description, status?.error && styles.error)}>
            {status
              ? t(status.key, status.reason ? { message: t(status.reason) } : status.params)
              : description}
          </div>
        ) : null}
      </div>
      {action}
    </div>
  )
}

/** 导入失败的原因：归档错误用对应文案，其他错误把信息带出来，方便用户反馈。 */
const importFailure = (error: unknown): TranslationMessage => {
  if (error instanceof BackupError) {
    return error.detail
      ? { key: 'historyImportFailedAt', params: { reason: translate(error.key), detail: error.detail } }
      : { key: error.key }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { key: 'historyImportFailedWithReason', params: { message } }
}

/** 选文件后先解析归档里的会话清单，让用户挑选；确认后把选中的会话追加进本机对话列表。 */
const useHistoryImport = () => {
  const [file, setFile] = useState<File | null>(null)
  const [sessions, setSessions] = useState<ImportSessionOption[] | null>(null)
  /** 本机已有的会话 id：列表里标出来，导入时跳过，不覆盖本机版本 */
  const [existing, setExisting] = useState<Set<string>>(new Set())
  const [loadingSessions, setLoadingSessions] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [skipImages, setSkipImages] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  const importing = useRef(false)

  const select = (next: File) => {
    setFile(next)
    // 30MB 以上的归档通常是图片占绝大部分，默认跳过附件，先让对话进来
    setSkipImages(next.size > 30 * 1024 * 1024)
    setSessions(null)
    setExisting(new Set())
    setSelected(new Set())
    setQuery('')
    setLoadingSessions(true)
    void Promise.all([readImportSessions(next), readLocalSessionIds()])
      .then(([list, localIds]) => {
        setSessions(list)
        setExisting(new Set(localIds))
        // 默认不勾选：勾了哪些就导入哪些，避免「想选一条却把整包都导入」
        setSelected(new Set())
      })
      .catch((error: unknown) => {
        // 读不到清单说明归档结构不对，导入也一定会失败，直接结束这次选择
        const failure = importFailure(error)
        setStatus({ ...failure, error: true })
        showToast({ ...failure, type: 'error' })
        setFile(null)
      })
      .finally(() => setLoadingSessions(false))
  }

  const confirm = async () => {
    if (!file || importing.current) {
      return
    }
    // 全部选中时走整包路径，少一层过滤
    const full = sessions !== null && selected.size === sessions.length
    importing.current = true
    setFile(null)
    setBusy(true)
    setStatus(null)
    try {
      const result = await importHistory(file, {
        skipImages,
        ...(full ? {} : { sessionIds: [...selected] }),
      })
      const done: TranslationMessage =
        result.skipped > 0
          ? {
              key:
                result.imported === 1 ? 'historyImportedOneSkipped' : 'historyImportedSkipped',
              params: { count: result.imported, skipped: result.skipped },
            }
          : {
              key: result.imported === 1 ? 'historyImportedOne' : 'historyImported',
              params: { count: result.imported },
            }
      setStatus(done)
      showToast(done)
    } catch (error) {
      const failure = importFailure(error)
      setStatus({ ...failure, error: true })
      showToast({ ...failure, type: 'error' })
    } finally {
      importing.current = false
      setBusy(false)
    }
  }

  return {
    file,
    sessions,
    existing,
    loadingSessions,
    selected,
    query,
    skipImages,
    busy,
    status,
    select,
    setQuery,
    toggle: (id: string) =>
      setSelected((current) => {
        const next = new Set(current)
        if (next.has(id)) {
          next.delete(id)
        } else {
          next.add(id)
        }
        return next
      }),
    // 本机已有的会话导入时会被跳过，全选就不把它们算进去
    selectAll: () =>
      setSelected(new Set((sessions ?? []).filter((item) => !existing.has(item.id)).map((item) => item.id))),
    selectNone: () => setSelected(new Set()),
    toggleSkipImages: () => setSkipImages((value) => !value),
    cancel: () => {
      setFile(null)
      setSessions(null)
      setQuery('')
    },
    confirm,
  }
}

/** 导入 = 覆盖：用选中文件替换本地全部会话与附件。 */
/** 导入教程：三步讲清「原版导出 → 下载 ZIP → 在这里上传」 */
const ImportGuide = ({ onClose }: { onClose: () => void }) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('historyImportGuideTitle')}
      className={styles.importGuide}
      closable
      onClose={onClose}
      footer={
        <Button size="m" onClick={onClose}>
          {t('confirm')}
        </Button>
      }
    >
      <ol className={styles.guideSteps}>
        <li>{t('historyImportGuideStep1')}</li>
        <li>{t('historyImportGuideStep2')}</li>
        <li>{t('historyImportGuideStep3')}</li>
      </ol>
      <div className={styles.guideNote}>{t('historyImportGuideNote')}</div>
    </Modal>
  )
}

const ImportHistory = ({
  historyImport,
  disabled,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
  disabled: boolean
}) => {
  const t = useTranslate()
  const inputRef = useRef<HTMLInputElement>(null)
  const [guideOpen, setGuideOpen] = useState(false)

  return (
    <>
      <SettingCell
        label={t('historyImport')}
        description={t('historyImportDescription')}
        status={historyImport.status}
        action={
          <>
            <button
              type="button"
              className={styles.importLink}
              onClick={() => setGuideOpen(true)}
            >
              {t('historyImportGuideLink')}
            </button>
            <Button
              variant="outlined"
              size="m"
              className={clsx(styles.cellButton, styles.uploadButton)}
              disabled={disabled}
              onClick={() => inputRef.current?.click()}
            >
              <IconUploadOutline14 />
              {t('upload')}
            </Button>
            <input
              ref={inputRef}
              type="file"
              accept=".zip,application/zip,application/x-zip-compressed,application/octet-stream"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) {
                  historyImport.select(file)
                }
              }}
            />
          </>
        }
      />
      {guideOpen ? <ImportGuide onClose={() => setGuideOpen(false)} /> : null}
    </>
  )
}

/** 把各会话的记忆笔记导出成一个 JSON：换机/重装时能对照恢复 */
const ExportMemory = ({ disabled }: { disabled: boolean }) => {
  const t = useTranslate()
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)

  const onExport = async () => {
    setBusy(true)
    setStatus(null)
    try {
      const { name, blob } = await exportMemoryNotes()
      await saveFile(blob, name)
    } catch (error) {
      setStatus(errorStatus('historyExportFailed', error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingCell
      label={t('exportMemoryLabel')}
      description={t('exportMemoryDescription')}
      status={status}
      action={
        <Button
          variant="outlined"
          size="m"
          className={styles.cellButton}
          disabled={disabled || busy}
          onClick={() => void onExport()}
        >
          <IconDownloadOutline16 />
          {t('exportAllDownload')}
        </Button>
      }
    />
  )
}

/** 将全部会话及图片导出为 ZIP 文件并下载 */
const ExportHistory = ({ disabled }: { disabled: boolean }) => {
  const t = useTranslate()
  const empty = useChatStore((state) => state.sessions.length === 0)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)

  const onExport = async () => {
    setBusy(true)
    setStatus(null)
    try {
      const { name, blob } = await exportHistory()
      // APK 里没有下载监听，saveFile 会改走系统分享面板
      await saveFile(blob, name)
    } catch (error) {
      setStatus(errorStatus('historyExportFailed', error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingCell
      label={t('exportAllLabel')}
      description={t('historyExportDescription')}
      status={status}
      action={
        <Button
          variant="outlined"
          size="m"
          className={styles.cellButton}
          disabled={disabled || busy || empty}
          onClick={() => void onExport()}
        >
          <IconDownloadOutline16 />
          {t('exportAllDownload')}
        </Button>
      }
    />
  )
}