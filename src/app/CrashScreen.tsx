import { Component, useState, type ReactNode } from 'react'
import { APP_VERSION } from '../version.js'

/**
 * 界面崩了别只给一片白：React 渲染/生命周期里抛出的错误会走到这里，
 * 显示错误原文 + 堆栈，并提供「重新加载」和「复制错误信息」。
 * 启动阶段的错误（脚本还没跑起来）由 index.html 里的兜底页负责。
 */
function copyText(text: string): boolean {
  try {
    void navigator.clipboard?.writeText(text)
    return true
  } catch {
    /* 老内核没有 clipboard */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

function CrashScreen({ error }: { error: Error }) {
  const [copied, setCopied] = useState(false)
  const detail = [
    '版本 ' + APP_VERSION,
    '内核 ' + (navigator.userAgent.match(/Chrom(?:e|ium)\/(\d+)/)?.[1] ?? '未知'),
    error.name + ': ' + error.message,
    error.stack ?? '',
  ].join('\n')
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 99998,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: 12,
        padding: 24,
        background: '#fff',
        color: '#1b1d21',
        fontSize: 15,
        lineHeight: 1.7,
      }}
    >
      <h1 style={{ margin: 0, fontSize: 19 }}>DS Lite 出错了</h1>
      <p style={{ margin: 0 }}>界面遇到一个错误，已经停在这里。聊天记录不会丢，点「重新加载」就能继续用。</p>
      <p style={{ margin: 0, fontSize: 13, color: '#7a7f88' }}>如果点几次都这样，请复制下面的信息发给开发者。</p>
      <pre
        style={{
          margin: 0,
          padding: '8px 10px',
          borderRadius: 8,
          background: '#fbf3f2',
          color: '#b3261e',
          font: '12px/1.6 ui-monospace, Consolas, monospace',
          maxHeight: '38vh',
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          userSelect: 'text',
        }}
      >
        {detail}
      </pre>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #ccc', background: '#f5f6f8', fontSize: 15 }}
          onClick={() => window.location.reload()}
        >
          重新加载
        </button>
        <button
          type="button"
          style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #ccc', background: '#f5f6f8', fontSize: 15 }}
          onClick={() => setCopied(copyText(detail))}
        >
          {copied ? '已复制' : '复制错误信息'}
        </button>
      </div>
    </div>
  )
}

export class CrashBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  override render() {
    if (this.state.error) {
      return <CrashScreen error={this.state.error} />
    }
    return this.props.children
  }
}
