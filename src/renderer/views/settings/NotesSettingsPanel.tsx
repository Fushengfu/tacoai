import type { ProjectTaskMemory, MemoryScopeStats } from '../../../shared/ipc'

type NotesSettingsPanelProps = {
  hasNotesScope: boolean
  memoryStats: MemoryScopeStats | null
  memoryStatsLoading: boolean
  memoryExporting: boolean
  memoryExportPath: string
  taskMemories: ProjectTaskMemory[]
  taskMemoriesLoading: boolean
  expandedTaskMemoryIds: Set<string>
  onRefreshNotes: () => void
  onExportMemoryScope: () => void
  onDeleteTaskMemory: (id: string) => void
  onToggleTaskMemoryExpanded: (id: string) => void
}

const formatBytes = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

const outcomeLabel = (outcome: ProjectTaskMemory['outcome']) => {
  if (outcome === 'success') return '完成'
  if (outcome === 'aborted') return '中止'
  return '失败'
}

export function NotesSettingsPanel({
  hasNotesScope,
  memoryStats,
  memoryStatsLoading,
  memoryExporting,
  memoryExportPath,
  taskMemories,
  taskMemoriesLoading,
  expandedTaskMemoryIds,
  onRefreshNotes,
  onExportMemoryScope,
  onDeleteTaskMemory,
  onToggleTaskMemoryExpanded,
}: NotesSettingsPanelProps) {
  if (!hasNotesScope) {
    return (
      <div className="notes-panel">
        <div className="notes-empty">请先创建会话或选择工作空间后再使用记忆</div>
      </div>
    )
  }

  return (
    <div className="notes-panel">
      {/* 记忆库状态卡片 */}
      <div className="note-card" style={{ marginBottom: 14 }}>
        <div className="note-card-header">
          <span className="note-card-category architecture">记忆库状态</span>
          <span className="note-card-title">SQLite / 当前作用域</span>
          <div className="note-card-actions">
            <button
              type="button"
              className="note-card-btn edit"
              onClick={onRefreshNotes}
              disabled={memoryStatsLoading}
              title="刷新"
            >
              刷新
            </button>
            <button
              type="button"
              className="note-card-btn edit"
              onClick={onExportMemoryScope}
              disabled={memoryExporting}
              title="导出当前作用域记忆"
            >
              {memoryExporting ? '导出中...' : '导出'}
            </button>
          </div>
        </div>
        <div className="note-card-content expanded">
          {memoryStatsLoading || !memoryStats ? '加载中...' : [
            `作用域：${memoryStats.scope}`,
            `数据库：${memoryStats.dbPath}`,
            `库大小：${formatBytes(memoryStats.dbSizeBytes)}`,
            `自动记忆（活动）：${memoryStats.activeTaskMemories}`,
            `自动记忆（归档）：${memoryStats.archivedTaskMemories}`,
            `自动记忆（软删除）：${memoryStats.deletedTaskMemories}`,
            `上下文快照：${memoryStats.snapshots}`,
            `整理审计：${memoryStats.maintainRuns}`,
            memoryStats.latestTaskMemoryUpdatedAt ? `最近自动记忆：${new Date(memoryStats.latestTaskMemoryUpdatedAt).toLocaleString()}` : '',
            memoryStats.latestSnapshotUpdatedAt ? `最近快照：${new Date(memoryStats.latestSnapshotUpdatedAt).toLocaleString()}` : '',
            memoryExportPath ? `最近导出：${memoryExportPath}` : '',
          ].filter(Boolean).join('\n')}
        </div>
      </div>

      {/* 自动记忆列表 */}
      <div className="notes-list-title">
        自动记忆 ({taskMemories.length})
        <span className="notes-list-hint">每轮用户提问自动记录"用户原问 + 处理结果要点"，用于后续上下文重放与召回。</span>
      </div>
      {taskMemoriesLoading ? (
        <div className="notes-loading">加载中...</div>
      ) : taskMemories.length === 0 ? (
        <div className="notes-empty">
          暂无自动记忆。发起提问后会自动生成。
        </div>
      ) : (
        <div className="notes-list">
          {taskMemories.map((memory) => {
            const expanded = expandedTaskMemoryIds.has(memory.id)
            const resultBody = (memory.assistantResult || '').trim()
            const detailLines = [
              `用户问题：${memory.userQuery || '无'}`,
              `结果：${outcomeLabel(memory.outcome)}`,
              `执行动作：${memory.tools.length > 0 ? memory.tools.join('、') : '无'}`,
              `修改文件：${memory.changedFiles.length > 0 ? memory.changedFiles.join('、') : '无'}`,
              memory.failures.length > 0 ? `异常：${memory.failures.slice(0, 3).join('；')}` : '',
            ].filter(Boolean)
            const detailText = detailLines.join('\n')
            const contentText = [
              resultBody ? `AI回复：\n${resultBody}` : '',
              detailText ? `结构化信息：\n${detailText}` : '',
            ].filter(Boolean).join('\n\n')
            const hasLongContent = contentText.length > 180 || contentText.includes('\n')
            return (
              <div key={memory.id} className="note-card">
                <div className="note-card-header">
                  <span className="note-card-category other">{outcomeLabel(memory.outcome)}</span>
                  <span className="note-card-title">{memory.userQuery || '（无提问）'}</span>
                  <div className="note-card-actions">
                    <button
                      type="button"
                      className="note-card-btn delete"
                      onClick={() => onDeleteTaskMemory(memory.id)}
                      title="删除"
                    >
                      ✕
                    </button>
                  </div>
                </div>
                <div className={`note-card-content ${expanded ? 'expanded' : ''}`}>
                  {contentText || '（无可展示内容）'}
                </div>
                <div className="note-card-footer">
                  <div className="note-card-meta">
                    更新时间 {new Date(memory.updatedAt).toLocaleString()}
                  </div>
                  {hasLongContent && (
                    <button
                      type="button"
                      className="note-card-toggle-btn"
                      onClick={() => onToggleTaskMemoryExpanded(memory.id)}
                    >
                      {expanded ? '收起' : '展开'}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
