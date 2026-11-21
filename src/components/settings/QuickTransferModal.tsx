import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { exportHistory } from '../../services/chat/backup.js'
import {
  isLanServerSupported,
  onLanFileReceived,
  pullLanArchive,
  startLanTransferServer,
  stopLanTransferServer,
  type LanServerInfo,
} from '../../services/sync/lanTransfer.js'
import {
  startWebRtcReceiver,
  startWebRtcSender,
  type TransferProgress,
  type WebRtcReceiverHandle,
  type WebRtcSenderHandle,
} from '../../services/sync/webrtcTransfer.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import styles from './QuickTransferModal.module.css'

type TransferTab = 'lan' | 'webrtc'
type WebRtcRole = 'send' | 'receive'

const formatMb = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(2)} MB`

const copyText = async (text: string, label: string) => {
  try {
    await navigator.clipboard.writeText(text)
    showToast(`已复制${label}`)
  } catch {
    showToast('复制失败，请手动长按选中复制')
  }
}

export const QuickTransferModal = ({
  onReceivedFile,
  onClose,
}: {
  onReceivedFile: (file: File) => void
  onClose: () => void
}) => {
  const nativeLan = isLanServerSupported()
  const [tab, setTab] = useState<TransferTab>(nativeLan ? 'lan' : 'webrtc')

  // ===== 方案 2：安卓局域网临时网页快传 =====
  const [lanServer, setLanServer] = useState<LanServerInfo | null>(null)
  const [lanBusy, setLanBusy] = useState(false)
  const [lanError, setLanError] = useState('')
  const [pullAddress, setPullAddress] = useState('')
  const [pullPin, setPullPin] = useState('')
  const [pullBusy, setPullBusy] = useState(false)

  // ===== 方案 1：全端 WebRTC 点对点口令快传 =====
  const [role, setRole] = useState<WebRtcRole>('send')
  const [rtcBusy, setRtcBusy] = useState(false)
  const [rtcError, setRtcError] = useState('')
  const [rtcStatus, setRtcStatus] = useState('')
  const [rtcProgress, setRtcProgress] = useState<TransferProgress | null>(null)
  const [offerCode, setOfferCode] = useState('')
  const [answerCode, setAnswerCode] = useState('')
  const [remoteInput, setRemoteInput] = useState('')

  const senderRef = useRef<WebRtcSenderHandle | null>(null)
  const receiverRef = useRef<WebRtcReceiverHandle | null>(null)
  const onReceivedRef = useRef(onReceivedFile)
  onReceivedRef.current = onReceivedFile
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // 监听局域网接收到的上传文件
  useEffect(() => {
    if (!lanServer) {
      return
    }
    const handlePromise = onLanFileReceived(
      (file) => {
        showToast('已收到局域网传来的备份包')
        void stopLanTransferServer()
        setLanServer(null)
        onCloseRef.current()
        onReceivedRef.current(file)
      },
      (err) => {
        setLanError(err.message)
      }
    )
    return () => {
      void handlePromise?.then((h) => h.remove())
    }
  }, [lanServer])

  // 关窗自动清理局域网端口与 WebRTC 连接
  useEffect(
    () => () => {
      void stopLanTransferServer()
      senderRef.current?.close()
      receiverRef.current?.close()
    },
    []
  )

  const resetWebRtc = () => {
    senderRef.current?.close()
    senderRef.current = null
    receiverRef.current?.close()
    receiverRef.current = null
    setOfferCode('')
    setAnswerCode('')
    setRemoteInput('')
    setRtcError('')
    setRtcStatus('')
    setRtcProgress(null)
    setRtcBusy(false)
  }

  const handleStartLan = async () => {
    if (lanBusy) {
      return
    }
    setLanBusy(true)
    setLanError('')
    try {
      const { name, blob } = await exportHistory({ includeExtras: true })
      const info = await startLanTransferServer(blob, name)
      setLanServer(info)
    } catch (err) {
      setLanError(err instanceof Error ? err.message : String(err))
    } finally {
      setLanBusy(false)
    }
  }

  const handleStopLan = async () => {
    await stopLanTransferServer()
    setLanServer(null)
  }

  const handlePullLan = async () => {
    if (pullBusy || !pullAddress.trim() || !pullPin.trim()) {
      return
    }
    setPullBusy(true)
    setLanError('')
    try {
      const file = await pullLanArchive(pullAddress, pullPin)
      await stopLanTransferServer()
      onClose()
      onReceivedFile(file)
    } catch (err) {
      setLanError(err instanceof Error ? err.message : String(err))
    } finally {
      setPullBusy(false)
    }
  }

  const handleCreateOffer = async () => {
    if (rtcBusy) {
      return
    }
    resetWebRtc()
    setRtcBusy(true)
    setRtcStatus('正在打包对话、附件、记忆笔记与人设…')
    try {
      const { name, blob } = await exportHistory({ includeExtras: true })
      setRtcStatus('正在生成发送口令…')
      const sender = await startWebRtcSender({
        fileName: name,
        blob,
        onState: (state, msg) => {
          if (state === 'connecting') {
            setRtcStatus('正在建立加密点对点连接…')
          } else if (state === 'sending') {
            setRtcStatus('已连接，正在传输数据…')
          } else if (state === 'done') {
            setRtcStatus('传输完成！对方已完整收到数据。')
            showToast('数据发送完成')
          } else if (state === 'error') {
            setRtcError(msg || '传输失败')
            setRtcStatus('')
          }
        },
        onProgress: (p) => setRtcProgress(p),
      })
      senderRef.current = sender
      setOfferCode(sender.offerCode)
      setRtcStatus('发送口令已生成：请复制发给接收设备，再把对方回执口令粘贴到下方。')
    } catch (err) {
      setRtcError(err instanceof Error ? err.message : String(err))
      setRtcStatus('')
    } finally {
      setRtcBusy(false)
    }
  }

  const handleAcceptAnswer = async () => {
    if (!senderRef.current || !remoteInput.trim()) {
      return
    }
    setRtcError('')
    try {
      await senderRef.current.acceptAnswer(remoteInput)
    } catch (err) {
      setRtcError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleCreateAnswer = async () => {
    if (rtcBusy || !remoteInput.trim()) {
      return
    }
    senderRef.current?.close()
    receiverRef.current?.close()
    setRtcBusy(true)
    setRtcError('')
    setRtcStatus('正在解析发送口令并生成回执…')
    try {
      const receiver = await startWebRtcReceiver({
        offerCode: remoteInput,
        onState: (state, msg) => {
          if (state === 'waiting') {
            setRtcStatus('请把下方「回执口令」复制发回发送方，对方确认后将自动接收…')
          } else if (state === 'receiving') {
            setRtcStatus('已连接，正在接收数据…')
          } else if (state === 'done') {
            setRtcStatus('接收完成！')
          } else if (state === 'error') {
            setRtcError(msg || '接收失败')
            setRtcStatus('')
          }
        },
        onProgress: (p) => setRtcProgress(p),
        onReceived: (file) => {
          showToast('已收到快传数据，请挑选要导入的会话')
          onCloseRef.current()
          onReceivedRef.current(file)
        },
      })
      receiverRef.current = receiver
      setAnswerCode(receiver.answerCode)
    } catch (err) {
      setRtcError(err instanceof Error ? err.message : String(err))
      setRtcStatus('')
    } finally {
      setRtcBusy(false)
    }
  }

  const pct =
    rtcProgress && rtcProgress.total > 0
      ? Math.min(100, Math.round((rtcProgress.done / rtcProgress.total) * 100))
      : 0

  return (
    <Modal title="设备快传（多端同步）" className={styles.modal} closable onClose={onClose}>
      <div className={styles.tabs} role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'lan'}
          className={clsx(styles.tab, tab === 'lan' && styles.tabActive)}
          onClick={() => setTab('lan')}
        >
          <span className={styles.tabTitle}>局域网快传</span>
          <span className={styles.tabSub}>6 位口令 · 同 Wi-Fi 一步直连</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'webrtc'}
          className={clsx(styles.tab, tab === 'webrtc' && styles.tabActive)}
          onClick={() => setTab('webrtc')}
        >
          <span className={styles.tabTitle}>口令快传</span>
          <span className={styles.tabSub}>全端通用 · 加密点对点直传</span>
        </button>
      </div>

      {tab === 'lan' ? (
        <div className={styles.panel}>
          <div className={styles.hint}>
            无需云服务，自动附带完整上下文、附件、记忆笔记与人设（绝不含 API Key）。关闭本窗口自动停用端口。
          </div>

          {nativeLan ? (
            <>
              <div className={styles.card}>
                <div className={styles.cardTitle}>1. 开启本机局域网服务（手机 ↔ 电脑 / 手机）</div>
                {lanServer ? (
                  <>
                    <div className={styles.serverInfo}>
                      <div className={styles.infoRow}>
                        <div>
                          <div className={styles.infoLabel}>电脑/另一台手机浏览器打开：</div>
                          <div className={styles.infoUrl}>{lanServer.url}</div>
                        </div>
                        <Button
                          variant="outlined"
                          size="s"
                          onClick={() => void copyText(lanServer.url, '网址')}
                        >
                          复制网址
                        </Button>
                      </div>
                      <div className={styles.infoRow}>
                        <div>
                          <div className={styles.infoLabel}>6 位数字口令：</div>
                          <div className={styles.pinValue}>{lanServer.pin}</div>
                        </div>
                        <Button
                          variant="outlined"
                          size="s"
                          onClick={() => void copyText(lanServer.pin, '6位口令')}
                        >
                          复制口令
                        </Button>
                      </div>
                    </div>
                    <div className={styles.hint}>
                      同一 Wi-Fi 下，电脑浏览器打开上述网址并输入 6 位口令，可一键下载本机数据，也可把电脑上的备份 ZIP 直接推送回本机。
                    </div>
                    <Button variant="outlined" size="m" onClick={() => void handleStopLan()}>
                      停止局域网服务
                    </Button>
                  </>
                ) : (
                  <Button size="m" disabled={lanBusy} onClick={() => void handleStartLan()}>
                    {lanBusy ? '正在打包并开启…' : '开启本机局域网快传'}
                  </Button>
                )}
              </div>

              <div className={styles.card}>
                <div className={styles.cardTitle}>2. 从另一台安卓手机直接拉取</div>
                <div className={styles.inputRow}>
                  <input
                    type="text"
                    className={styles.input}
                    placeholder="对方地址，如 192.168.1.8:18666"
                    value={pullAddress}
                    disabled={pullBusy}
                    onChange={(event) => setPullAddress(event.target.value)}
                  />
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    className={clsx(styles.input, styles.pinInput)}
                    placeholder="6位口令"
                    value={pullPin}
                    disabled={pullBusy}
                    onChange={(event) => setPullPin(event.target.value)}
                  />
                </div>
                <Button
                  variant="outlined"
                  size="m"
                  disabled={pullBusy || !pullAddress.trim() || pullPin.trim().length < 6}
                  onClick={() => void handlePullLan()}
                >
                  {pullBusy ? '正在拉取…' : '拉取并进入勾选导入'}
                </Button>
              </div>
            </>
          ) : (
            <div className={styles.card}>
              <div className={styles.cardTitle}>电脑 / 网页端如何使用局域网快传？</div>
              <div className={styles.hint}>
                1. 在安卓手机版 DS Lite 里打开「设置 → 数据管理 → 设备快传」并开启局域网服务；
                <br />
                2. 确保电脑和手机连在同一个 Wi-Fi，在电脑浏览器新标签页直接打开手机屏幕上显示的{' '}
                <code>http://192.168.x.x:18666</code> 地址并输入 6 位数字口令，即可高速收发 ZIP 备份包。
                <br />
                3. 如果两端都是网页版或包含 iOS 设备，请切换到上方「口令快传（全端通用）」。
              </div>
            </div>
          )}

          {lanError ? <div className={styles.errorText}>{lanError}</div> : null}
        </div>
      ) : (
        <div className={styles.panel}>
          <div className={styles.hint}>
            纯点对点加密直连，安卓 / iOS / 电脑网页全通用，不需要摄像头，自动包含对话、附件、记忆笔记与人设（不含 API Key）。
          </div>

          <div className={styles.roleRow}>
            <Button
              variant={role === 'send' ? 'primary' : 'outlined'}
              size="m"
              className={styles.roleBtn}
              onClick={() => {
                resetWebRtc()
                setRole('send')
              }}
            >
              我要发送数据
            </Button>
            <Button
              variant={role === 'receive' ? 'primary' : 'outlined'}
              size="m"
              className={styles.roleBtn}
              onClick={() => {
                resetWebRtc()
                setRole('receive')
              }}
            >
              我要接收数据
            </Button>
          </div>

          {role === 'send' ? (
            <div className={styles.card}>
              <div className={styles.actionsRow}>
                <Button size="m" disabled={rtcBusy} onClick={() => void handleCreateOffer()}>
                  {rtcBusy ? '准备中…' : offerCode ? '重新生成发送口令' : '1. 打包并生成发送口令'}
                </Button>
                {offerCode ? (
                  <Button
                    variant="outlined"
                    size="m"
                    onClick={() => void copyText(offerCode, '发送口令')}
                  >
                    一键复制发送口令
                  </Button>
                ) : null}
              </div>

              {offerCode ? (
                <>
                  <textarea className={styles.textarea} readOnly value={offerCode} />
                  <textarea
                    className={styles.textarea}
                    placeholder="2. 在此粘贴接收方发回的「回执口令（DSL1:...）」"
                    value={remoteInput}
                    onChange={(event) => setRemoteInput(event.target.value)}
                  />
                  <Button
                    size="m"
                    disabled={!remoteInput.trim()}
                    onClick={() => void handleAcceptAnswer()}
                  >
                    建立直连并发送
                  </Button>
                </>
              ) : null}
            </div>
          ) : (
            <div className={styles.card}>
              <textarea
                className={styles.textarea}
                placeholder="1. 在此粘贴发送方的「发送口令（DSL1:...）」"
                value={remoteInput}
                onChange={(event) => setRemoteInput(event.target.value)}
              />
              <div className={styles.actionsRow}>
                <Button
                  size="m"
                  disabled={rtcBusy || !remoteInput.trim()}
                  onClick={() => void handleCreateAnswer()}
                >
                  {rtcBusy ? '生成中…' : '2. 生成回执口令'}
                </Button>
                {answerCode ? (
                  <Button
                    variant="outlined"
                    size="m"
                    onClick={() => void copyText(answerCode, '回执口令')}
                  >
                    一键复制回执口令
                  </Button>
                ) : null}
              </div>
              {answerCode ? <textarea className={styles.textarea} readOnly value={answerCode} /> : null}
            </div>
          )}

          {rtcProgress ? (
            <div className={styles.progressWrap}>
              <div className={styles.progressTrack}>
                <div className={styles.progressFill} style={{ width: `${pct}%` }} />
              </div>
              <div className={styles.hint}>
                {pct}% · {formatMb(rtcProgress.done)} / {formatMb(rtcProgress.total)}
              </div>
            </div>
          ) : null}

          {rtcStatus ? <div className={styles.statusText}>{rtcStatus}</div> : null}
          {rtcError ? <div className={styles.errorText}>{rtcError}</div> : null}
        </div>
      )}
    </Modal>
  )
}
