import { create } from 'zustand'

/** 记录小窗的开合状态 */
export const useRecordsPanel = create<{ open: boolean }>(() => ({ open: false }))

export const openRecordsPanel = () => useRecordsPanel.setState({ open: true })

export const closeRecordsPanel = () => useRecordsPanel.setState({ open: false })
