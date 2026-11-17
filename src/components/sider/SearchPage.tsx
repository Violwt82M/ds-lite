import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import { IconButton } from '../base/IconButton.js'
import { IconChevronRightOutline14 } from '../base/icons.js'
import { SessionSearch } from './SessionSearch.js'
import { closeSearchPage, useSearchPage } from './searchPageState.js'
import styles from './SearchPage.module.css'

/**
 * 全屏搜索页：官方把搜索做成独立一页（返回箭头 + 搜索框 + 结果占满屏），
 * 而不是塞在抽屉顶部——抽屉只有 300px 宽，结果很容易被挤成一两行。
 */
export const SearchPage = () => {
  const t = useTranslate()
  const open = useSearchPage((state) => state.open)
  if (!open) {
    return null
  }
  return createPortal(
    <div className={styles.page}>
      <SessionSearch
        page
        autoFocus
        leading={
          <IconButton
            size="m"
            icon={
              <span className={styles.back}>
                <IconChevronRightOutline14 />
              </span>
            }
            aria-label={t('back')}
            onClick={closeSearchPage}
          />
        }
        onPick={closeSearchPage}
      />
    </div>,
    document.body
  )
}
