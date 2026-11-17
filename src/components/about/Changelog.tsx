import { useTranslate } from '../../i18n/index.js'
import { CHANGELOG } from './changelogData.js'
import styles from './Tutorials.module.css'

/** **重点** 加粗：更新日志和教程用同一套纯文本标记 */
const renderText = (text: string) =>
  text.split('**').map((part, index) => (index % 2 === 1 ? <strong key={index}>{part}</strong> : part))

/**
 * 更新日志：数据由 scripts/gen-changelog.mjs 从 CHANGELOG.md 生成。
 * only：只显示指定版本（升级弹窗用）；withHead=false 时不渲染标题行。
 */
export const Changelog = ({
  current,
  only,
  withHead = true,
}: {
  current: string
  only?: string
  withHead?: boolean
}) => {
  const t = useTranslate()
  const entries = only ? CHANGELOG.filter((entry) => entry.version === only) : CHANGELOG

  return (
    <div className={styles.wrap}>
      {withHead ? (
        <div className={styles.head}>
          <div className={styles.headTitle}>{t('changelogTitle')}</div>
          <div className={styles.headHint}>{t('changelogHint')}</div>
        </div>
      ) : null}
      {entries.map((entry, index) => (
        <details key={entry.version} className={styles.item} open={index === 0}>
          <summary className={styles.summary}>
            <span className={styles.summaryText}>
              v{entry.version}
              {entry.version === current ? (
                <span className={styles.badge}>{t('changelogCurrent')}</span>
              ) : null}
            </span>
            <span className={styles.arrow} aria-hidden>
              ▾
            </span>
          </summary>
          <ul className={styles.body}>
            {entry.items.map((item, itemIndex) => (
              <li key={itemIndex} className={styles.listItem}>
                {renderText(item)}
              </li>
            ))}
          </ul>
        </details>
      ))}
    </div>
  )
}
