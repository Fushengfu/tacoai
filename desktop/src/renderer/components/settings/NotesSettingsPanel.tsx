import type { ProjectNote, ProjectTaskMemory, NoteCategory, MemoryScopeStats } from '../../../shared/ipc'

const NOTE_CATEGORIES: { value: NoteCategory; label: string }[] = [
  { value: 'convention', label: '代码规范' },
  { value: 'credential', label: '凭证/账号' },
  { value: 'architecture', label: '架构设计' },
  { value: 'config', label: '配置信息' },
  { value: 'other', label: '其他' },
]

type NotesSettingsPanelProps = {
  hasNotesScope: boolean
  memoryStats: MemoryScopeStats | null
  memoryStatsLoading: boolean
  memoryExporting: boolean
  memoryExportPath: string
  notes: ProjectNote[]
  notesLoading: boolean
  taskMemories: ProjectTaskMemory[]
  taskMemoriesLoading: boolean
  editingNote: Partial<ProjectNote & { category: NoteCategory }> | null
  expandedNoteIds: Set<string>
  expandedTaskMemoryIds: Set<string>
  onRefreshNotes: () => void
  onExportMemoryScope: () => void
  onEditingNoteChange: (note: Partial<ProjectNote & { category: NoteCategory }> | null) => void
  onSaveNote: () => void
  onDeleteNote: (id: string) => void
  onDeleteTaskMemory: (id: string) => void
  onToggleNoteExpanded: (id: string) => void
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
  notes,
  notesLoading,
  taskMemories,
  taskMemoriesLoading,
  editingNote,
  expandedNoteIds,
  expandedTaskMemoryIds,
  onRefreshNotes,
  onExportMemoryScope,
  onEditingNoteChange,
  onSaveNote,
  onDeleteNote,
  onDeleteTaskMemory,
  onToggleNoteExpanded,
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
            `手工记忆：${memoryStats.manualNotes}`,
            `自动记忆（活动）：${memoryStats.activeTaskMemories}`,
            `自动记忆（归档）：${memoryStats.archivedTaskMemories}`,
            `自动记忆（软删除）：${memoryStats.deletedTaskMemories}`,
            `上下文快照：${memoryStats.snapshots}`,
            `整理审计：${memoryStats.maintainRuns}`,
            memoryStats.latestNoteUpdatedAt ? `最近手工记忆：${new Date(memoryStats.latestNoteUpdatedAt).toLocaleString()}` : '',
            memoryStats.latestTaskMemoryUpdatedAt ? `最近自动记忆：${new Date(memoryStats.latestTaskMemoryUpdatedAt).toLocaleString()}` : '',
            memoryStats.latestSnapshotUpdatedAt ? `最近快照：${new Date(memoryStats.latestSnapshotUpdatedAt).toLocaleString()}` : '',
            memoryExportPath ? `最近导出：${memoryExportPath}` : '',
          ].filter(Boolean).join('\n')}
        </div>
      </div>

      {/* 新增/编辑笔记表单 */}
      {editingNote ? (
        <div className="note-form">
          <div className="note-form-title">
            {editingNote.id ? '编辑记忆' : '新增记忆'}
          </div>
          <div className="note-form-fields">
            <input
              className="note-form-input"
              value={editingNote.title || ''}
              onChange={(e) => onEditingNoteChange({ ...editingNote, title: e.target.value })}
              placeholder="标题（如：数据库配置）"
            />
            <select
              className="note-form-select"
              value={editingNote.category || 'other'}
              onChange={(e) => onEditingNoteChange({ ...editingNote, category: e.target.value as NoteCategory })}
              aria-label="记忆分类"
            >
              {NOTE_CATEGORIES.map((cat) => (
                <option key={cat.value} value={cat.value}>{cat.label}</option>
              ))}
            </select>
            <textarea
              className="note-form-textarea"
              value={editingNote.content || ''}
              onChange={(e) => onEditingNoteChange({ ...editingNote, content: e.target.value })}
              placeholder="记忆内容（如：MySQL 地址 127.0.0.1:3306，用户名 root，密码 xxx）"
              rows={4}
            />
          </div>
          <div className="note-form-actions">
            <button
              type="button"
              className="note-form-btn save"
              onClick={onSaveNote}
              disabled={!(editingNote.title?.trim()) || !(editingNote.content?.trim())}
            >
              保存
            </button>
            <button
              type="button"
              className="note-form-btn cancel"
              onClick={() => onEditingNoteChange(null)}
            >
              取消
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="notes-add-btn"
          onClick={() => onEditingNoteChange({ category: 'other' })}
        >
          + 新增记忆
        </button>
      )}

      {/* 记忆列表 */}
      <div className="notes-list-title">
        手动记忆 ({notes.length})
        <span className="notes-list-hint">由你手动维护或 AI 通过 save_note 写入的长期项目记忆。</span>
      </div>
      {notesLoading ? (
        <div className="notes-loading">加载中...</div>
      ) : notes.length === 0 ? (
        <div className="notes-empty">
          暂无记忆。你可以手动添加，或在对话中提到重要信息时 AI 会自动记录。
        </div>
      ) : (
        <div className="notes-list">
          {notes.map((note) => {
            const expanded = expandedNoteIds.has(note.id)
            const hasLongContent = note.content.length > 140 || note.content.includes('\n')
            return (
              <div key={note.id} className="note-card">
                <div className="note-card-header">
                  <span className={`note-card-category ${note.category}`}>
                    {NOTE_CATEGORIES.find((c) => c.value === note.category)?.label || note.category}
                  </span>
                  <span className="note-card-title">{note.title}</span>
                  <div className="note-card-actions">
                    <button
                      type="button"
                      className="note-card-btn edit"
                      onClick={() => onEditingNoteChange(note)}
                      title="编辑"
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className="note-card-btn delete"
                      onClick={() => onDeleteNote(note.id)}
                      title="删除"
                    >
                      ✕
                    </button>
                  </div>
                </div>
                <div className={`note-card-content ${expanded ? 'expanded' : ''}`}>{note.content}</div>
                <div className="note-card-footer">
                  <div className="note-card-meta">
                    更新于 {new Date(note.updatedAt).toLocaleString()}
                  </div>
                  {hasLongContent && (
                    <button
                      type="button"
                      className="note-card-toggle-btn"
                      onClick={() => onToggleNoteExpanded(note.id)}
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

      {/* 任务记忆列表（自动生成，仅查看） */}
      <div className="notes-list-title" style={{ marginTop: 14 }}>
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
