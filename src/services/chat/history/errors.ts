import { translate, type TranslationKey } from '../../../i18n/index.js'

/**
 * 导入导出失败的原因，key 对应界面提示文案。
 * detail 记录失败位置（ZIP 条目名等），便于用户反馈时定位问题。
 */
export class BackupError extends Error {
  constructor(
    readonly key: TranslationKey,
    readonly detail?: string
  ) {
    super(detail ? `${translate(key)} (${detail})` : translate(key))
    this.name = 'BackupError'
  }
}

export const fail = (key: TranslationKey): never => {
  throw new BackupError(key)
}
