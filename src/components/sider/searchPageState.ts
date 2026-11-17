import { create } from 'zustand'

/** 全屏搜索页：抽屉里点搜索框打开，点结果或返回键关闭（官方也是这个交互） */
export const useSearchPage = create<{ open: boolean }>(() => ({ open: false }))

export const openSearchPage = () => useSearchPage.setState({ open: true })
export const closeSearchPage = () => useSearchPage.setState({ open: false })
