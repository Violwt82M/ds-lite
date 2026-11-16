import { create } from 'zustand'
import { fetchBalance, type BalanceInfo } from './api/client.js'
import { useSettings } from './settings.js'

/**
 * 账户余额：直接用官方 /user/balance 查真实数字，不再按 token 估算费用。
 * 结果只在内存里缓存，切回前台或点刷新时重查，避免每秒打接口。
 */
type BalanceState = {
  /** 最近一次查询的余额（多币种，一般只有 CNY） */
  infos: BalanceInfo[]
  /** 账户是否可用（余额不足时官方会返回 false） */
  available: boolean
  /** 上次查询成功的时间戳；0 表示还没查过 */
  updatedAt: number
  loading: boolean
  /** 查询失败的原因（已转成给人看的中文），成功后清空 */
  error: string | null
}

export const useBalance = create<BalanceState>(() => ({
  infos: [],
  available: true,
  updatedAt: 0,
  loading: false,
  error: null,
}))

let inflight: Promise<void> | null = null

/** 查询余额；并发调用复用同一次请求 */
export const refreshBalance = async (): Promise<void> => {
  if (inflight) {
    return inflight
  }
  const apiKey = useSettings.getState().apiKey
  if (!apiKey) {
    useBalance.setState({ infos: [], updatedAt: 0, error: null, loading: false })
    return
  }
  useBalance.setState({ loading: true })
  inflight = (async () => {
    try {
      const result = await fetchBalance(apiKey)
      useBalance.setState({
        infos: result.infos,
        available: result.available,
        updatedAt: Date.now(),
        error: null,
        loading: false,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      useBalance.setState({ error: message, loading: false })
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/** 距上次查询超过这个时间才自动重查（切回应用、发完一条回复时用） */
const STALE_MS = 60_000

export const refreshBalanceIfStale = async (): Promise<void> => {
  const { updatedAt, loading } = useBalance.getState()
  if (loading || Date.now() - updatedAt < STALE_MS) {
    return
  }
  await refreshBalance()
}

/** 清除缓存（换 Key 时调用，避免显示上一个账号的余额） */
export const clearBalance = () => {
  useBalance.setState({ infos: [], available: true, updatedAt: 0, error: null, loading: false })
}
