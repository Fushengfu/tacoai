/**
 * 文件查看器状态 hook
 *
 * 职责：
 * - 管理 selectedFile（差异对比模式）
 * - 管理 viewingFile（文件查看模式）
 * - 管理 viewingSelection（光标位置）
 * - 提供打开/关闭/切换视图的回调
 */

import { useCallback, useState } from 'react'

export type FileViewerState = {
  selectedFile: string | null
  viewingFile: string | null
  viewingSelection: { line: number; column: number } | null
  handleOpenFileView: (filePath: string, forceDiff?: boolean, selection?: { line: number; column: number } | null) => void
  handleCloseFileEditor: () => void
  handleViewDiffFromEditor: () => void
  reset: () => void
}

export function useFileViewer(opts: { onSwitchToChat?: () => void } = {}): FileViewerState {
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [viewingFile, setViewingFile] = useState<string | null>(null)
  const [viewingSelection, setViewingSelection] = useState<{ line: number; column: number } | null>(null)

  const handleOpenFileView = useCallback((filePath: string, forceDiff?: boolean, selection?: { line: number; column: number } | null) => {
    opts.onSwitchToChat?.()
    if (forceDiff) {
      setSelectedFile((prev) => (prev === filePath ? null : filePath))
      setViewingFile(null)
      setViewingSelection(null)
    } else {
      if (selection) {
        setViewingFile(filePath)
        setViewingSelection({
          line: Math.max(1, Math.floor(selection.line)),
          column: Math.max(1, Math.floor(selection.column)),
        })
      } else {
        setViewingFile((prev) => (prev === filePath ? null : filePath))
        setViewingSelection(null)
      }
      setSelectedFile(null)
    }
  }, [opts.onSwitchToChat])

  const handleCloseFileEditor = useCallback(() => {
    setViewingFile(null)
    setViewingSelection(null)
  }, [])

  const handleViewDiffFromEditor = useCallback(() => {
    setViewingFile((prev) => {
      if (prev) {
        setSelectedFile(prev)
      }
      return null
    })
    setViewingSelection(null)
  }, [])

  const reset = useCallback(() => {
    setSelectedFile(null)
    setViewingFile(null)
    setViewingSelection(null)
  }, [])

  return {
    selectedFile,
    viewingFile,
    viewingSelection,
    handleOpenFileView,
    handleCloseFileEditor,
    handleViewDiffFromEditor,
    reset,
  }
}
