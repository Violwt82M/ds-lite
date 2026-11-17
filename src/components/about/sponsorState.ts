import { create } from 'zustand'

/** 赞助二维码弹窗（0.9.34）：关于页里点「查看」打开 */
export const useSponsor = create(() => ({ open: false }))

export const openSponsor = () => useSponsor.setState({ open: true })

export const closeSponsor = () => useSponsor.setState({ open: false })
