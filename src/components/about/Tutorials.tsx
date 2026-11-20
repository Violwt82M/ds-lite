import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import styles from './Tutorials.module.css'

/**
 * 使用教程：关于页里的折叠条目。
 * 每条只写「怎么做 → 会怎样」，不写原理；概念那一条例外，专门解释 API、token、上下文这些词。
 */
const SECTIONS = [
  'Concept',
  'Start',
  'Billing',
  'Memory',
  'Records',
  'Model',
  'Look',
  'Import',
  'ThirdParty',
  'Qa',
] as const

/** **重点** 用加粗渲染：教程正文是纯文本，这里只认这一种标记 */
const renderBody = (text: string) =>
  text.split('**').map((part, index) =>
    index % 2 === 1 ? <strong key={index}>{part}</strong> : part
  )

export const Tutorials = () => {
  const t = useTranslate()

  return (
    <details className={styles.outer}>
      <summary className={styles.head}>
        <div className={styles.headText}>
          <div className={styles.headTitle}>{t('tutorialTitle')}</div>
          <div className={styles.headHint}>{t('tutorialHint')}</div>
        </div>
        <span className={styles.outerBadge} aria-hidden>
          <span className={styles.outerLabelClosed}>{t('foldExpand')}</span>
          <span className={styles.outerLabelOpen}>{t('foldCollapse')}</span>
          <span className={styles.outerArrow}>▾</span>
        </span>
      </summary>
      <div className={styles.wrap}>
        {SECTIONS.map((section) => (
          <details key={section} className={styles.item}>
            <summary className={styles.summary}>
              <span>{t(`tutorial${section}Title` as TranslationKey)}</span>
              <span className={styles.arrow} aria-hidden>
                ▾
              </span>
            </summary>
            <div className={styles.body}>{renderBody(t(`tutorial${section}Body` as TranslationKey))}</div>
          </details>
        ))}
      </div>
    </details>
  )
}
