/**
 * HttpServer Plugin 前端封装。
 * - APK 里走 Capacitor Plugins.HttpServer（原生）
 * - 浏览器 dev server 里自动降级（返回 null，B tab 提示用户用扫码）
 */

export interface HttpServerResult {
  url: string
  ip: string
  port: number
  alreadyRunning: boolean
}

export interface LocalIpResult {
  ip: string
}

export interface AllIpsResult {
  ips: string[]
}

interface HttpServerPlugin {
  startServer(call: { port?: number }): Promise<HttpServerResult>
  stopServer(): Promise<{ stopped: boolean }>
  getLocalIp(): Promise<LocalIpResult>
  getAllIps(): Promise<AllIpsResult>
}

function getPlugin(): HttpServerPlugin | null {
  try {
    // Capacitor 在 WebView 里挂在 window.Capacitor.Plugins 上
    const win = window as unknown as {
      Capacitor?: { Plugins?: Record<string, unknown> }
    }
    const p = win.Capacitor?.Plugins?.HttpServer as HttpServerPlugin | undefined
    return p ?? null
  } catch {
    return null
  }
}

export function isCapacitor(): boolean {
  return !!getPlugin()
}

export async function startServer(port = 7321): Promise<HttpServerResult> {
  const p = getPlugin()
  if (!p) throw new Error('HttpServer 插件不可用（浏览器里没有，要用 APK）')
  return await p.startServer({ port })
}

export async function stopServer(): Promise<{ stopped: boolean }> {
  const p = getPlugin()
  if (!p) return { stopped: false }
  return await p.stopServer()
}

export async function getLocalIp(): Promise<LocalIpResult> {
  const p = getPlugin()
  if (!p) return { ip: '' }
  return await p.getLocalIp()
}

export async function getAllIps(): Promise<AllIpsResult> {
  const p = getPlugin()
  if (!p) return { ips: [] }
  return await p.getAllIps()
}
