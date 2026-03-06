import type { Thread } from '../types'
import { formatTime } from '../lib/storage'
import { DragBar } from './DragBar'
import { useState } from 'react'

type SidebarProps = {
  sortedThreads: Thread[]
  activeThreadId: string
  editingThreadId: string | null
  editingTitle: string
  onEditingTitleChange: (title: string) => void
  onNewThread: () => void
  onSwitchThread: (id: string) => void
  onRenameStart: (thread: Thread) => void
  onRenameCommit: (threadId: string) => void
  onCancelRename: () => void
  onDeleteThread: (threadId: string) => void
  onReorderThread: (sourceId: string, targetId: string) => void
  onOpenSettings: () => void
  /** 判断某 thread 是否正在发送 */
  isSending: (threadId: string) => boolean
  /** 判断某 thread 是否刚完成 */
  isCompleted: (threadId: string) => boolean
  /** 当前会话上下文窗口占用百分比 */
  contextPercent: number
}

export function Sidebar({
  sortedThreads,
  activeThreadId,
  editingThreadId,
  editingTitle,
  onEditingTitleChange,
  onNewThread,
  onSwitchThread,
  onRenameStart,
  onRenameCommit,
  onCancelRename,
  onDeleteThread,
  onReorderThread,
  onOpenSettings,
  isSending,
  isCompleted,
  contextPercent,
}: Readonly<SidebarProps>) {
  const [draggingThreadId, setDraggingThreadId] = useState<string | null>(null)
  const [dragOverThreadId, setDragOverThreadId] = useState<string | null>(null)

  return (
    <aside className="sidebar">
      <DragBar />

      <div className="sidebar-group">
        <button className="ghost-btn" type="button" onClick={onNewThread}>
          <span className="icon">+</span>
          新建项目
        </button>
      </div>

      <div className="sidebar-main">
        <div className="sidebar-section">项目</div>
        <div className="thread-list">
          {sortedThreads.map((item) => {
            const isEditing = editingThreadId === item.id
            const sending = isSending(item.id)
            const completed = isCompleted(item.id)
            return (
              <div
                key={item.id}
                className={`thread-item ${item.id === activeThreadId ? 'active' : ''}${sending ? ' sending' : ''}${completed ? ' completed' : ''}${draggingThreadId === item.id ? ' dragging' : ''}${dragOverThreadId === item.id ? ' drag-over' : ''}`}
                draggable
                onDragStart={(e) => {
                  setDraggingThreadId(item.id)
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', item.id)
                }}
                onDragOver={(e) => {
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  setDragOverThreadId(item.id)
                }}
                onDragLeave={() => {
                  if (dragOverThreadId === item.id) setDragOverThreadId(null)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  const sourceId = e.dataTransfer.getData('text/plain') || draggingThreadId
                  if (sourceId && sourceId !== item.id) onReorderThread(sourceId, item.id)
                  setDraggingThreadId(null)
                  setDragOverThreadId(null)
                }}
                onDragEnd={() => {
                  setDraggingThreadId(null)
                  setDragOverThreadId(null)
                }}
                onClick={() => onSwitchThread(item.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onSwitchThread(item.id)
                }}
              >
                <div className="thread-body">
                  {isEditing ? (
                    <input
                      className="thread-input"
                      value={editingTitle}
                      onChange={(e) => onEditingTitleChange(e.target.value)}
                      onBlur={() => onRenameCommit(item.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          onRenameCommit(item.id)
                        }
                        if (e.key === 'Escape') onCancelRename()
                      }}
                      autoFocus
                    />
                  ) : (
                    <div className="thread-title">{item.title}</div>
                  )}
                  <div className="thread-time">
                    {sending && <span className="thread-status-badge sending">处理中</span>}
                    {!sending && completed && <span className="thread-status-badge done">已完成</span>}
                    {!sending && !completed && formatTime(item.updatedAt)}
                  </div>
                </div>
                <div className="thread-actions">
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={(e) => {
                      e.stopPropagation()
                      onRenameStart(item)
                    }}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    className="icon-btn danger"
                    onClick={(e) => {
                      e.stopPropagation()
                      onDeleteThread(item.id)
                    }}
                  >
                    ✕
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <div className="sidebar-footer">
        <div className="context-bar">
          <div className="context-bar-label">
            <span>上下文</span>
            <span>{contextPercent}%</span>
          </div>
          <div className="context-bar-track">
            <div
              className={`context-bar-fill${contextPercent > 80 ? ' warn' : ''}`}
              style={{ width: `${contextPercent}%` }}
            />
          </div>
        </div>
        <div className="sidebar-footer-divider" />
        <button className="ghost-btn sidebar-settings-btn" type="button" onClick={onOpenSettings}>
          Settings
        </button>
      </div>
    </aside>
  )
}
