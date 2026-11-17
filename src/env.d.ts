declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.css' {}

/** 公开 API 的地址，见 rspack.config.ts 的 createConfig */
declare const __API_ORIGIN__: string

/** Prism 语言包通过副作用注册到全局 Prism */
declare module 'prismjs/components/*' {}

/** KaTeX 化学公式扩展通过副作用注册到 KaTeX */
declare module 'katex/contrib/mhchem' {}

interface DsLiteHarmonyBridge {
  beginExport(fileName: string): string
  appendExport(token: string, base64Chunk: string): string
  cancelExport(token: string): string
  finishExport(token: string): void
}

interface Window {
  __DS_LITE_PLATFORM__?: 'harmonyos'
  DsLiteHarmony?: DsLiteHarmonyBridge
  __dsLiteHarmonyShareDone?: (result: { ok: boolean; error?: string }) => void
}
