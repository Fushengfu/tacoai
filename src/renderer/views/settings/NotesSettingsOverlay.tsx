import { useState, useEffect, useCallback } from 'react'
import type { ProjectTaskMemory, MemoryScopeStats } from '../../../shared/ipc'
import { NotesSettingsPanel } from './NotesSettingsPanel'

type NotesSettingsOverlayProps = {
  onClose: () => void
  workspace?: string | null
  projectId?: string
}

export function NotesSettingsOverlay({ onClose, workspace, projectId }: Readonly<NotesSettingsOverlayProps>) {
  const [taskMemories, setTaskMemories] = useState<ProjectTaskMemory[]>([])
  const [taskMemoriesLoading, setTaskMemoriesLoading] = useState(false)
  const [expandedTaskMemoryIds, setExpandedTaskMemoryIds] = useState<Set<string>>(new Set())
  const [memoryStats, setMemoryStats] = useState<MemoryScopeStats | null>(null)
  const [memoryStatsLoading, setMemoryStatsLoading] = useState(false)
  const [memoryExporting, setMemoryExporting] = useState(false)
  const [memoryExportPath, setMemoryExportPath] = useState('')

  const notesWorkspace = (workspace ?? '').trim()
  const notesProjectId = (projectId ?? '').trim()
  const hasNotesScope = Boolean(notesWorkspace || notesProjectId)

  const loadNotes = useCallback(async () => {
    if (!hasNotesScope) {
      setTaskMemories([])
      setMemoryStats(null)
      setMemoryExportPath('')
      return
    }
    setTaskMemoriesLoading(true)
    setMemoryStatsLoading(true)
    try {
      const [memories, stats] = await Promise.all([
        window.taco.notes.listTaskMemories(notesWorkspace, notesProjectId || undefined),
        window.taco.notes.stats(notesWorkspace, notesProjectId || undefined),
      ])
      setTaskMemories(memories)
      setMemoryStats(stats)
    } catch (err) {
      console.error('加载笔记失败:', err)
    } finally {
      setTaskMemoriesLoading(false)
      setMemoryStatsLoading(false)
    }
  }, [hasNotesScope, notesWorkspace, notesProjectId])

  useEffect(() => { loadNotes() }, [loadNotes])

  const toggleTaskMemoryExpanded = (id: string) => {
    setExpandedTaskMemoryIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleDeleteTaskMemory = async (id: string) => {
    if (!hasNotesScope) return
    try {
      await window.taco.notes.deleteTaskMemory(notesWorkspace, id, notesProjectId || undefined)
      setTaskMemories((prev) => prev.filter((item) => item.id !== id))
      setExpandedTaskMemoryIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    } catch (err) {
      console.error('删除任务记忆失败:', err)
    }
  }

  const handleExportMemoryScope = async () => {
    if (!hasNotesScope || memoryExporting) return
    setMemoryExporting(true)
    try {
      const exported = await window.taco.notes.exportScope(notesWorkspace, notesProjectId || undefined)
      setMemoryExportPath(exported.filePath)
      await loadNotes()
    } catch (err) {
      console.error('导出记忆失败:', err)
    } finally {
      setMemoryExporting(false)
    }
  }

  return (
    <main className="settings-page">
          <header className="settings-header">
            <button className="settings-back-btn" type="button" onClick={onClose} title="返回">
              <svg className="settings-back-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M14.75 6.5L9.25 12L14.75 17.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M10 12H20" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
              </svg>
              <span>返回</span>
            </button>
            <div className="settings-title">记忆</div>
          </header>
          <div className="settings-body">
            <NotesSettingsPanel
              hasNotesScope={hasNotesScope}
              memoryStats={memoryStats}
              memoryStatsLoading={memoryStatsLoading}
              memoryExporting={memoryExporting}
              memoryExportPath={memoryExportPath}
              taskMemories={taskMemories}
              taskMemoriesLoading={taskMemoriesLoading}
              expandedTaskMemoryIds={expandedTaskMemoryIds}
              onRefreshNotes={loadNotes}
              onExportMemoryScope={handleExportMemoryScope}
              onDeleteTaskMemory={handleDeleteTaskMemory}
              onToggleTaskMemoryExpanded={toggleTaskMemoryExpanded}
            />
          </div>
        </main>
  )
}
