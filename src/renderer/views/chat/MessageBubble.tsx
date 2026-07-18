import { useRef, useCallback } from 'react'
import type { ChatMsg, AgentStep, AttachedAsset } from '../../types'
import { MarkdownBubble } from './MarkdownBubble'
import { PlanTracker, formatTaskTimingLabel } from './PlanTracker'
import { AgentStepBody } from './AgentSteps'
import { sanitizeAssistantContentForDisplay, stepStatusIcon, stepHeaderSummary, stepGroupOperationSummary, collectMessageScreenshotUrls } from './agent-helpers'

/* ------------------------------------------------------------------ */
/*  MessageBubble — 单条消息气泡（用户 / AI）                             */
/* ------------------------------------------------------------------ */

interface MessageBubbleProps {
  msg: ChatMsg
  isEditing: boolean
  sending: boolean
  activeTaskStartedAt?: number
  lastAssistantMessageId: string | null
  nowTs: number
  /** 上一条消息的 index（用于找到下一条 assistant 的 commitHash） */
  messages: ChatMsg[]
  /** 展开的 agent 步骤 */
  expandedSteps: Set<string>
  /** 展开的工具块 */
  expandedToolBlocks: Set<string>
  /** 展开的思考块 */
  expandedThinkBlocks: Set<string>
  /** 步骤组折叠状态 */
  stepGroupExpandedMap: Record<string, boolean>
  /** 已响应的确认 */
  respondedConfirms: Map<string, boolean>
  /** 已响应的重试 */
  respondedRetries: Map<string, boolean>
  /** 步骤切换 */
  toggleStep: (key: string) => void
  /** 工具块切换 */
  toggleToolBlock: (key: string) => void
  /** 思考块切换 */
  toggleThinkBlock: (key: string) => void
  /** 步骤组切换 */
  toggleStepGroup: (messageId: string, fallbackExpanded: boolean) => void
  /** 确认响应 */
  handleConfirmResponse: (confirmId: string, approved: boolean) => void
  /** 重试响应 */
  handleRetryResponse: (retryId: string, shouldRetry: boolean) => void
  /** 工作空间 */
  workspace: string
  /** 打开文件（项目内） */
  onOpenFileView?: (filePath: string, forceDiff?: boolean, selection?: { line: number; column: number } | null) => void
  /** 打开文件 */
  openFile: (filePath: string) => void
  /** 编辑器 ID */
  editor: string
  /** 图片预览 */
  setPreviewImageUrl: (url: string | null) => void
  /** 编辑状态 */
  editingText: string
  editingAttachments: AttachedAsset[]
  setEditingAttachments: React.Dispatch<React.SetStateAction<AttachedAsset[]>>
  editingInputDivRef: React.RefObject<HTMLDivElement>
  /** 编辑操作 */
  startEdit: (msg: ChatMsg) => void
  confirmEdit: (msgId: string) => void
  cancelEdit: () => void
  updateEditingTextFromDiv: () => void
  insertEditingFileChip: (path: string) => void
  toAssetName: (filePath: string) => string
  /** 消息操作 */
  onResend: (msgId: string) => void
  onRollbackBeforeMsg?: (commitHash: string) => Promise<void>
  rollingBackHash: string | null
  setRollingBackHash: (hash: string | null) => void
  onEditResend: (msgId: string, newContent: string) => void
}

export function MessageBubble({
  msg,
  isEditing,
  sending,
  activeTaskStartedAt,
  lastAssistantMessageId,
  nowTs,
  messages,
  expandedSteps,
  expandedToolBlocks,
  expandedThinkBlocks,
  stepGroupExpandedMap,
  respondedConfirms,
  respondedRetries,
  toggleStep,
  toggleToolBlock,
  toggleThinkBlock,
  toggleStepGroup,
  handleConfirmResponse,
  handleRetryResponse,
  workspace,
  onOpenFileView,
  openFile,
  editor: _editor,
  setPreviewImageUrl,
  editingText,
  editingAttachments,
  setEditingAttachments,
  editingInputDivRef,
  startEdit,
  confirmEdit: _confirmEdit,
  cancelEdit: _cancelEdit,
  updateEditingTextFromDiv,
  insertEditingFileChip,
  toAssetName,
  onResend,
  onRollbackBeforeMsg,
  rollingBackHash,
  setRollingBackHash,
  onEditResend,
}: MessageBubbleProps) {
  if (msg.role === 'assistant') {
    const isExecutingAssistant = Boolean(
      sending &&
      lastAssistantMessageId &&
      msg.id === lastAssistantMessageId &&
      activeTaskStartedAt,
    )
    const taskTimingLabel = formatTaskTimingLabel(
      isExecutingAssistant ? { startedAt: Number(activeTaskStartedAt) } : msg.taskTiming,
      nowTs,
      isExecutingAssistant ? activeTaskStartedAt : undefined,
    )

    return (
      <div className="bubble">
        {taskTimingLabel && <div className="assistant-task-meta">{taskTimingLabel}</div>}
        {/* Agent 步骤 + PlanTracker */}
        {msg.agentSteps && msg.agentSteps.length > 0 && renderAgentSteps()}
        {/* 执行计划进度 */}
        {msg.activePlan && <PlanTracker plan={msg.activePlan} />}
        {/* 最终回复文本 */}
        {(() => {
          const toolNames = msg.agentSteps?.flatMap((s) => s.toolCalls.map((tc) => tc.name)) ?? []
          const visibleContent = sanitizeAssistantContentForDisplay(msg.content, toolNames)
          return visibleContent ? (
            <MarkdownBubble
              content={visibleContent}
              workspace={workspace}
              onOpenProjectFile={(path) => openFile(path)}
              onImagePreview={setPreviewImageUrl}
            />
          ) : null
        })()}
        {/* 自动化截图缩略图 */}
        {(() => {
          const screenshotUrls = collectMessageScreenshotUrls(msg)
          if (screenshotUrls.length === 0) return null
          return (
            <div className="automation-shots">
              {screenshotUrls.map((url, idx) => (
                <button
                  key={`${msg.id}-shot-${idx}`}
                  type="button"
                  className="automation-shot-btn"
                  onClick={() => setPreviewImageUrl(url)}
                  title="点击查看大图"
                >
                  <img src={url} alt={`automation-screenshot-${idx + 1}`} className="automation-shot-thumb" />
                </button>
              ))}
            </div>
          )
        })()}
      </div>
    )
  }

  // --- 用户消息 ---

  if (isEditing) {
    return (
      <div className="bubble editing">
        {editingAttachments.length > 0 && (
          <div className="msg-assets" style={{ marginBottom: '8px' }}>
            {editingAttachments.map((asset) => (
              <div key={asset.id} className="msg-asset-chip" title={asset.path}>
                <span className="msg-asset-name">{asset.name}</span>
                <button
                  type="button"
                  className="msg-asset-remove"
                  onClick={() => {
                    setEditingAttachments(prev => prev.filter(a => a.id !== asset.id))
                    if (editingInputDivRef.current) {
                      const chips = editingInputDivRef.current.querySelectorAll('.file-attachment-chip')
                      chips.forEach(chip => {
                        if (chip.getAttribute('data-file-path') === asset.path) {
                          chip.remove()
                        }
                      })
                    }
                  }}
                  title="移除附件"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div
          ref={editingInputDivRef}
          className="bubble-edit-input"
          contentEditable
          suppressContentEditableWarning
          onInput={updateEditingTextFromDiv}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              _confirmEdit(msg.id)
            }
            if (e.key === 'Escape') _cancelEdit()
          }}
          style={{
            width: '100%',
            minWidth: '100%',
            minHeight: '2.5em',
            maxHeight: '12em',
            overflowY: 'auto',
          }}
        />
        <div style={{ marginTop: '8px', display: 'flex', gap: '6px', alignItems: 'center' }}>
          <button
            type="button"
            className="msg-action-btn"
            title="添加附件"
            onClick={() => {
              const input = document.createElement('input')
              input.type = 'file'
              input.multiple = true
              input.onchange = async (e) => {
                const files = (e.target as HTMLInputElement).files
                if (!files) return
                for (const file of Array.from(files)) {
                  const asset: AttachedAsset = {
                    id: `edit-asset-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                    path: (file as any).path || file.name,
                    name: file.name,
                  }
                  setEditingAttachments(prev => [...prev, asset])
                  insertEditingFileChip(asset.path)
                }
              }
              input.click()
            }}
          >
            +
          </button>
          <span style={{ fontSize: '11px', color: 'var(--muted)', opacity: 0.6 }}>
            添加附件
          </span>
        </div>
        <div className="bubble-edit-hint">
          Enter 确认 · Esc 取消
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="bubble">
        {msg.images && msg.images.length > 0 && (
          <div className="msg-images">
            {msg.images.map((img) => {
              const imageSrc = img.dataUrl || img.cloudUrl
              if (!imageSrc) return null
              return (
                <img
                  key={img.id}
                  src={imageSrc}
                  alt={img.name}
                  className="msg-image-thumb"
                  title="点击预览"
                  onClick={() => setPreviewImageUrl(imageSrc)}
                />
              )
            })}
          </div>
        )}
        {msg.attachments && msg.attachments.length > 0 && (
          <div className="msg-assets">
            {msg.attachments.map((asset) => (
              <div key={asset.id} className="msg-asset-chip" title={asset.path}>
                <span className="msg-asset-name">{asset.name}</span>
              </div>
            ))}
          </div>
        )}
        {renderUserContent()}
      </div>
      <div className="msg-actions">
        <button
          type="button"
          className="msg-action-btn"
          title="编辑"
          onClick={() => startEdit(msg)}
          disabled={sending}
        >
          ✎
        </button>
        <button
          type="button"
          className="msg-action-btn"
          title="重新发送"
          onClick={() => onResend(msg.id)}
          disabled={sending}
        >
          ↻
        </button>
        {(() => {
          const msgIdx = messages.indexOf(msg)
          const nextAssistant = msgIdx >= 0 ? messages[msgIdx + 1] : undefined
          const commitHash = nextAssistant?.role === 'assistant' ? nextAssistant.gitCommitHash : undefined
          if (!commitHash || !onRollbackBeforeMsg) return null
          const isRolling = rollingBackHash === commitHash
          return (
            <button
              type="button"
              className="msg-action-btn rollback"
              title="回滚到此消息之前的版本"
              disabled={sending || rollingBackHash !== null}
              onClick={async () => {
                setRollingBackHash(commitHash)
                try {
                  await onRollbackBeforeMsg(commitHash)
                } finally {
                  setRollingBackHash(null)
                }
              }}
            >
              {isRolling ? '⏳' : '↩'}
            </button>
          )
        })()}
      </div>
    </>
  )

  /** 渲染用户消息内容（解析 [FILE] 标签） */
  function renderUserContent() {
    const content = msg.content
    const fileRegex = /\[FILE\]([^\[]+)\[\/FILE\]/g
    const parts: Array<{ type: 'text' | 'file'; content: string; path?: string }> = []
    let lastIndex = 0
    let match

    while ((match = fileRegex.exec(content)) !== null) {
      if (match.index > lastIndex) {
        parts.push({ type: 'text', content: content.slice(lastIndex, match.index) })
      }
      parts.push({ type: 'file', content: match[1], path: match[1] })
      lastIndex = match.index + match[0].length
    }
    if (lastIndex < content.length) {
      parts.push({ type: 'text', content: content.slice(lastIndex) })
    }
    if (parts.length === 0) {
      parts.push({ type: 'text', content })
    }

    return (
      <>
        {parts.filter(p => p.type === 'file').length > 0 && (
          <div className="msg-assets">
            {parts.filter(p => p.type === 'file').map((file, idx) => {
              const fileName = file.path?.split('/').pop() || file.path || ''
              return (
                <div key={`file-${idx}`} className="msg-asset-chip" title={file.path}>
                  <span className="msg-asset-name">📄 {fileName}</span>
                </div>
              )
            })}
          </div>
        )}
        {parts.filter(p => p.type === 'text').map((part, i) => {
          if (!part.content.trim()) return null
          return part.content.split('\n').map((line, j) => (
            <p key={`text-${i}-${j}`}>{line}</p>
          ))
        })}
      </>
    )
  }

  function renderAgentSteps() {
    const agentSteps = msg.agentSteps!
    const stepCount = agentSteps.length
    const activeCount = agentSteps.filter((s) => s.status === 'running' || s.status === 'calling' || s.status === 'confirm' || s.status === 'retry_confirm').length
    const doneCount = agentSteps.filter((s) => s.status === 'done').length
    const failedCount = agentSteps.filter((s) => s.status === 'done' && s.toolResults.some((r) => !r.success)).length
    const hasActiveSteps = activeCount > 0
    const isMessageExecuting = Boolean(sending && lastAssistantMessageId && msg.id === lastAssistantMessageId)
    const defaultExpanded = hasActiveSteps || stepCount <= 4
    const hasExplicitExpanded = Object.prototype.hasOwnProperty.call(stepGroupExpandedMap, msg.id)
    const isStepsExpanded = isMessageExecuting
      ? true
      : (hasExplicitExpanded ? stepGroupExpandedMap[msg.id] : defaultExpanded)
    const groupOperation = stepGroupOperationSummary(agentSteps)
    const groupSummary = hasActiveSteps
      ? `${activeCount} 个执行中`
      : `${doneCount}/${stepCount} 已完成${failedCount > 0 ? ` · ${failedCount} 异常` : ''}`

    const planStepIdx = agentSteps.findIndex((s) =>
      s.risks?.some((r) => r.toolName === 'propose_plan')
    )
    const hasPlanSplit = planStepIdx >= 0
    const beforePlan = hasPlanSplit ? agentSteps.slice(0, planStepIdx + 1) : []
    const afterPlan = hasPlanSplit ? agentSteps.slice(planStepIdx + 1) : agentSteps

    return (
      <div className={`agent-steps-group ${isStepsExpanded ? 'open' : 'closed'} ${hasActiveSteps ? 'active' : ''}`}>
        <button
          type="button"
          className="agent-steps-group-header"
          onClick={() => toggleStepGroup(msg.id, defaultExpanded)}
        >
          <span className="agent-steps-group-main">
            <span className="agent-steps-group-title">执行步骤</span>
            <span className="agent-steps-group-op" title={groupOperation}>{groupOperation}</span>
            <span className="agent-steps-group-count">{stepCount} 条</span>
            <span className="agent-steps-group-summary">{groupSummary}</span>
          </span>
          <span className={`agent-steps-group-chevron ${isStepsExpanded ? 'open' : ''}`}>›</span>
        </button>
        {isStepsExpanded && (
          <div className="agent-steps-group-body">
            <div className="agent-steps">
              {[...beforePlan, ...afterPlan].map((step, idxInList) => {
                const stepKey = step.retryId ? `${msg.id}-retry-${step.retryId}` : `${msg.id}-${step.round}-${idxInList}`
                const isStepRunning = step.status === 'running' || step.status === 'calling'
                const isStepConfirm = step.status === 'confirm'
                const isStepRetryConfirm = step.status === 'retry_confirm'
                const isStepExpanded = isStepRunning || isStepConfirm || isStepRetryConfirm || expandedSteps.has(stepKey)
                const summary = stepHeaderSummary(step)
                return (
                  <div key={stepKey} className={`agent-step ${step.status}`}>
                    <div className="agent-step-header">
                      <button type="button" className="agent-step-toggle" onClick={() => toggleStep(stepKey)}>
                        <span className={`agent-step-icon ${step.status}`}>{stepStatusIcon(step)}</span>
                        <span className="agent-step-label-text">{summary.label}</span>
                      </button>
                      <span className="agent-step-detail" onClick={() => toggleStep(stepKey)}>
                        {summary.filePath ? (
                          <span className="agent-step-path-link" title="点击预览打开" onClick={(e) => { e.stopPropagation(); openFile(summary.filePath!) }}>{summary.detail}</span>
                        ) : summary.detail}
                      </span>
                      <button type="button" className="agent-step-chevron-btn" onClick={() => toggleStep(stepKey)}>
                        <span className={`agent-step-chevron ${isStepExpanded ? 'open' : ''}`}>›</span>
                      </button>
                    </div>
                    {isStepExpanded && (
                      <AgentStepBody
                        msg={msg}
                        step={step}
                        isStepRunning={isStepRunning}
                        isStepConfirm={isStepConfirm}
                        expandedThinkBlocks={expandedThinkBlocks}
                        expandedToolBlocks={expandedToolBlocks}
                        toggleThinkBlock={toggleThinkBlock}
                        toggleToolBlock={toggleToolBlock}
                        respondedConfirms={respondedConfirms}
                        respondedRetries={respondedRetries}
                        sending={sending}
                        handleConfirmResponse={handleConfirmResponse}
                        handleRetryResponse={handleRetryResponse}
                        workspace={workspace}
                        openFile={openFile}
                        setPreviewImageUrl={setPreviewImageUrl}
                      />
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    )
  }
}
