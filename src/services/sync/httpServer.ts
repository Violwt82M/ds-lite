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
  setPairingOffer(call: { code: string }): Promise<{ ok: boolean }>
  clearPairing(): Promise<void>
  addListener(
    event: 'answer',
    cb: (data: { code: string }) => void
  ): Promise<{ remove(): Promise<void> }>
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

/** 把本机 Offer 发布到 HTTP server 的 /offer，供浏览器或其他设备拉取 */
export async function publishPairingOffer(code: string): Promise<void> {
  const p = getPlugin()
  if (!p) return
  await p.setPairingOffer({ code })
}

export async function clearPairingOffer(): Promise<void> {
  const p = getPlugin()
  if (!p) return
  await p.clearPairing()
}

/** 监听其他设备 POST 回来的 Answer（仅 APK） */
export async function onLanAnswer(
  cb: (code: string) => void
): Promise<() => void> {
  const p = getPlugin()
  if (!p) return () => {}
  const handle = await p.addListener('answer', (data) => cb(data.code))
  return () => { void handle.remove() }
}

// ============ 同步保活（仅 APK） ============

interface KeepAlivePlugin {
  acquire(): Promise<void>
  release(): Promise<void>
}

function getKeepAlivePlugin(): KeepAlivePlugin | null {
  try {
    const win = window as unknown as {
      Capacitor?: { Plugins?: Record<string, unknown> }
    }
    return (win.Capacitor?.Plugins?.SyncKeepAlive as KeepAlivePlugin | undefined) ?? null
  } catch {
    return null
  }
}

/** 连接建立后调用：WiFi 锁 + CPU 锁 + 屏幕常亮 + 前台服务 */
export async function acquireKeepAlive(): Promise<void> {
  try { await getKeepAlivePlugin()?.acquire() } catch {}
}

/** 断开后调用：释放所有保活资源 */
export async function releaseKeepAlive(): Promise<void> {
  try { await getKeepAlivePlugin()?.release() } catch {}
}
