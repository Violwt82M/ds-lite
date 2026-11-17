/**
 * 单份文档 token 预算的取值域（0.9.35）。
 *
 * 单独一个文件的原因：settings.ts 要用这些常量做滑杆与夹取，attachments.ts 要用默认值做截断，
 * 但 settings 和 attachments 之间还有 i18n / api/client 的既有依赖 —— 让 settings 直接 import
 * attachments 会形成环（lint 的 import/no-cycle 会直接报错）。这里没有任何 import，两边都安全。
 *
 * 上限 95 万：服务端上下文 1,048,576，还得给历史消息和输出留余量；
 * 下限 20 万：再小长文档基本读不到东西。
 */
export const DOCUMENT_BUDGET_MIN = 200_000
export const DOCUMENT_BUDGET_MAX = 950_000
export const DOCUMENT_BUDGET_STEP = 50_000
export const DOCUMENT_BUDGET_DEFAULT = 350_000
