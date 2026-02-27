import { useEffect, useRef, useState } from 'react'
import type { ActivePlan, AgentStep, AttachedImage, ChatMsg, FileChangeInfo, FileChangeStatus, ProviderId, QueuedMessage, Session, ThreadMode } from '../types'
import type { EditorId } from '../../shared/ipc'
import { editorCommands } from '../../shared/ipc'
import { MarkdownBubble } from './MarkdownBubble'
import { DiffView } from './DiffView'
import { FileEditor } from './FileEditor'
import { ToolResultContent } from './ToolResultContent'
import { TerminalPanel } from './TerminalPanel'
import { useDrag } from '../hooks/useDrag'

/* ------------------------------------------------------------------ */
/*  PlanTracker — 实时计划进度追踪器                                      */
/* ------------------------------------------------------------------ */

const planStepIcons: Record<string, string> = {
  pending: '○',
  in_progress: '◉',
  done: '✓',
  failed: '✗',
}

function normalizePlanStepStatus(status: string): 'pending' | 'in_progress' | 'done' | 'failed' {
  const s = String(status ?? '').trim().toLowerCase()
  if (s === 'in-progress' || s === 'inprogress' || s === 'running') return 'in_progress'
  if (s === 'complete' || s === 'completed' || s === 'success' || s === 'succeeded') return 'done'
  if (s === 'error') return 'failed'
  if (s === 'pending' || s === 'in_progress' || s === 'done' || s === 'failed') return s
  return 'pending'
}

function formatElapsedHms(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  return `${h}h${m}m${s}s`
}

function PlanTracker({ plan }: { plan: ActivePlan }) {
  const [nowTs, setNowTs] = useState(() => Date.now())
  useEffect(() => {
    if (plan.endedAt) return
    const timer = window.setInterval(() => setNowTs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [plan.endedAt])

  const normalizedSteps = plan.steps.map((s) => ({
    ...s,
    status: normalizePlanStepStatus(s.status),
  }))
  const doneCount = normalizedSteps.filter((s) => s.status === 'done').length
  const failedCount = normalizedSteps.filter((s) => s.status === 'failed').length
  const totalCount = plan.steps.length
  const progress = totalCount > 0 ? Math.round(((doneCount + failedCount) / totalCount) * 100) : 0
  const allDone = doneCount + failedCount === totalCount && totalCount > 0
  const startedAt = plan.startedAt ?? nowTs
  const endedAt = plan.endedAt ?? nowTs
  const elapsedText = formatElapsedHms(Math.max(0, endedAt - startedAt))

  return (
    <div className={`plan-tracker ${allDone ? 'completed' : ''}`}>
      <div className="plan-tracker-header">
        <span className="plan-tracker-title">执行计划</span>
        <span className="plan-tracker-elapsed">耗时 {elapsedText}</span>
        <span className="plan-tracker-progress">{doneCount}/{totalCount}</span>
      </div>
      {plan.summary && (
        <div className="plan-tracker-summary">{plan.summary}</div>
      )}
      <div className="plan-tracker-bar">
        <div
          className={`plan-tracker-bar-fill ${allDone ? 'done' : ''}`}
          style={{ width: `${progress}%` }}
        />
      </div>
      <ol className="plan-tracker-steps">
        {normalizedSteps.map((step, i) => (
          <li key={i} className={`plan-tracker-step ${step.status}`}>
            <span className={`plan-step-icon ${step.status}`}>{planStepIcons[step.status]}</span>
            <span className="plan-step-text">{step.text}</span>
            {step.note && <span className="plan-step-note">{step.note}</span>}
          </li>
        ))}
      </ol>
    </div>
  )
}

type ChatPanelProps = {
  title: string
  messages: ChatMsg[]
  showStreamBubble: boolean
  streamingContent: string
  draft: string
  onDraftChange: (value: string) => void
  sending: boolean
  onSend: (images?: AttachedImage[]) => void
  onStop: () => void
  onClearChat: () => void
  /** 会话管理 */
  onNewSession: () => void
  onSwitchSession: (sessionId: string) => void
  onDeleteSession: (sessionId: string) => void
  sessions: Session[]
  activeSessionId: string
  onResend: (msgId: string) => void
  onEditResend: (msgId: string, newContent: string) => void
  mode: ThreadMode
  onModeChange: (mode: ThreadMode) => void
  workspace: string
  onSelectWorkspace: () => void
  provider: ProviderId
  onProviderChange: (id: ProviderId) => void
  configuredProviders: readonly { id: ProviderId; label: string }[]
  scrollRef: React.RefObject<HTMLDivElement>
  queue: QueuedMessage[]
  onRemoveFromQueue: (id: string) => void
  editor: EditorId
  onEditorChange: (id: EditorId) => void
  /** 当前选中要查看 diff 的文件变更 */
  selectedFileChange: FileChangeInfo | null
  /** 关闭 diff 视图的回调 */
  onCloseDiff: () => void
  /** 终端是否打开 */
  showTerminal: boolean
  /** 切换终端 */
  onToggleTerminal: () => void
  /** 终端工作目录 */
  terminalCwd?: string
  /** 当前选中文件的审核状态 */
  selectedFileStatus?: FileChangeStatus
  /** 保存文件回调 */
  onAcceptFile?: (filePath: string) => void
  /** 撤销文件回调 */
  onRejectFile?: (filePath: string) => void
  /** 回滚到某条消息之前的 Git 版本 */
  onRollbackBeforeMsg?: (commitHash: string) => Promise<void>
  /** 当前在编辑器中打开的文件路径（非变更文件） */
  viewingFile?: string | null
  /** 工作空间路径（FileEditor 需要） */
  viewingWorkspace?: string
  /** 关闭文件编辑器 */
  onCloseFileEditor?: () => void
  /** 文件保存后的回调（刷新目录树等） */
  onFileSaved?: () => void
  /** 从编辑器切换到 Diff 视图 */
  onViewDiffFromEditor?: () => void
}

export function ChatPanel({
  title,
  messages,
  showStreamBubble,
  streamingContent,
  draft,
  onDraftChange,
  sending,
  onSend,
  onStop,
  onClearChat,
  onNewSession,
  onSwitchSession,
  onDeleteSession,
  sessions,
  activeSessionId,
  onResend,
  onEditResend,
  mode,
  onModeChange,
  workspace,
  onSelectWorkspace,
  provider,
  onProviderChange,
  configuredProviders,
  scrollRef,
  queue,
  onRemoveFromQueue,
  editor,
  onEditorChange,
  selectedFileChange,
  onCloseDiff,
  showTerminal,
  onToggleTerminal,
  terminalCwd,
  selectedFileStatus,
  onAcceptFile,
  onRejectFile,
  onRollbackBeforeMsg,
  viewingFile,
  viewingWorkspace,
  onCloseFileEditor,
  onFileSaved,
  onViewDiffFromEditor,
}: Readonly<ChatPanelProps>) {
  const hasProviders = configuredProviders.length > 0
  const drag = useDrag()
  const showWindowControls = globalThis.window.taco.system.platform === 'win32'

  // ── 图片附件状态 ──
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

  /** 读取文件为 base64 data URL */
  function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }

  /** 添加图片（去重，限制 5 张） */
  async function addImages(files: File[]) {
    const MAX_IMAGES = 5
    const MAX_SIZE = 10 * 1024 * 1024 // 10MB
    const validFiles = files.filter((f) => f.type.startsWith('image/') && f.size <= MAX_SIZE)
    if (validFiles.length === 0) return

    const newImages: AttachedImage[] = []
    for (const file of validFiles) {
      if (attachedImages.length + newImages.length >= MAX_IMAGES) break
      const dataUrl = await readFileAsDataUrl(file)
      newImages.push({
        id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        dataUrl,
        name: file.name,
      })
    }
    setAttachedImages((prev) => [...prev, ...newImages].slice(0, MAX_IMAGES))
  }

  function removeImage(id: string) {
    setAttachedImages((prev) => prev.filter((img) => img.id !== id))
  }

  /** 粘贴事件处理：提取图片 */
  function handlePaste(e: React.ClipboardEvent) {
    const items = e.clipboardData?.items
    if (!items) return
    const imageFiles: File[] = []
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) imageFiles.push(file)
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault()
      addImages(imageFiles)
    }
  }

  /** 文件选择处理 */
  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files
    if (files && files.length > 0) {
      addImages(Array.from(files))
    }
    // 清空 input 以便再次选择同一文件
    e.target.value = ''
  }

  /** 发送消息（携带图片后清空） */
  function handleSend() {
    const imgs = attachedImages.length > 0 ? [...attachedImages] : undefined
    setAttachedImages([])
    onSend(imgs)
  }

  // 编辑中的用户消息
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState('')

  // 已响应的确认请求（防止重复点击）
  const [respondedConfirms, setRespondedConfirms] = useState<Map<string, boolean>>(new Map())

  // 回滚中的 commit hash
  const [rollingBackHash, setRollingBackHash] = useState<string | null>(null)

  // 展开的 agent 步骤
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set())
  // 展开的工具块（多操作时每个操作独立折叠）
  const [expandedToolBlocks, setExpandedToolBlocks] = useState<Set<string>>(new Set())
  // 展开的思考块
  const [expandedThinkBlocks, setExpandedThinkBlocks] = useState<Set<string>>(new Set())
  // 每条 assistant 消息的「步骤总卡片」折叠状态
  const [stepGroupExpandedMap, setStepGroupExpandedMap] = useState<Record<string, boolean>>({})
  // 自动化截图预览
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null)

  function normalizeScreenshotPath(raw: unknown): string | null {
    const text = String(raw ?? '').trim()
    if (!text) return null
    return text.startsWith('/') ? text : null
  }

  function extractScreenshotPathsFromResultContent(content: string): string[] {
    const paths = new Set<string>()
    const text = String(content ?? '')
    if (!text) return []
    try {
      const parsed = JSON.parse(text) as { screenshotPath?: unknown; screenshotPaths?: unknown }
      if (Array.isArray(parsed?.screenshotPaths)) {
        for (const p of parsed.screenshotPaths) {
          const normalized = normalizeScreenshotPath(p)
          if (normalized) paths.add(normalized)
        }
      }
      const single = normalizeScreenshotPath(parsed?.screenshotPath)
      if (single) paths.add(single)
    } catch {
      // ignore non-json tool result
    }
    const regex = /"screenshotPath"\s*:\s*"([^"]+)"/g
    let match: RegExpExecArray | null = null
    while ((match = regex.exec(text)) !== null) {
      const normalized = normalizeScreenshotPath(match[1])
      if (normalized) paths.add(normalized)
    }
    return Array.from(paths)
  }

  function toImageUrl(raw: string): string {
    if (raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('data:') || raw.startsWith('file://')) {
      return raw
    }
    if (raw.startsWith('/')) return `file://${encodeURI(raw)}`
    return raw
  }

  function collectMessageScreenshotUrls(msg: ChatMsg): string[] {
    const paths = new Set<string>()
    if (msg.agentSteps) {
      for (const step of msg.agentSteps) {
        for (const result of step.toolResults) {
          for (const p of extractScreenshotPathsFromResultContent(result.content)) {
            paths.add(p)
          }
        }
      }
    }
    return Array.from(paths).map((p) => toImageUrl(p))
  }

  function toggleStep(key: string) {
    setExpandedSteps((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function toggleToolBlock(key: string) {
    setExpandedToolBlocks((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function toggleThinkBlock(key: string) {
    setExpandedThinkBlocks((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function toggleStepGroup(messageId: string, fallbackExpanded: boolean) {
    setStepGroupExpandedMap((prev) => {
      const hasExplicit = Object.prototype.hasOwnProperty.call(prev, messageId)
      const current = hasExplicit ? prev[messageId] : fallbackExpanded
      return { ...prev, [messageId]: !current }
    })
  }

  function stepStatusIcon(step: AgentStep): string {
    if (step.status === 'calling') return '⏳'
    if (step.status === 'running') return '⚡'
    if (step.status === 'confirm') return '🔒'
    const allSuccess = step.toolResults.every((r) => r.success)
    return allSuccess ? '✓' : '⚠'
  }

  /** 用户授权或拒绝风险操作（防重复点击） */
  function handleConfirmResponse(confirmId: string, approved: boolean) {
    if (respondedConfirms.has(confirmId)) return // 已响应，忽略
    setRespondedConfirms((prev) => new Map(prev).set(confirmId, approved))
    globalThis.window.taco.agent.confirmResponse(confirmId, approved)
  }

  /** 解析工具参数 JSON */
  function parseArgs(argsStr: string): Record<string, unknown> {
    try { return JSON.parse(argsStr) } catch { return {} }
  }

  /** 生成每个工具调用的富摘要 + 可悬停路径 */
  function toolCallSummary(tc: { name: string; arguments: string }): { label: string; detail: string; filePath?: string } {
    const args = parseArgs(tc.arguments)
    switch (tc.name) {
      case 'read_file': {
        const p = String(args.path ?? '')
        return { label: '读取文件', detail: p, filePath: p }
      }
      case 'write_file': {
        const p = String(args.path ?? '')
        return { label: '写入文件', detail: p, filePath: p }
      }
      case 'list_directory': {
        const p = String(args.path ?? '.')
        return { label: '列出目录', detail: p, filePath: p }
      }
      case 'run_command': {
        const cmd = String(args.command ?? '')
        // 截断长命令
        const short = cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd
        return { label: '执行命令', detail: short }
      }
      case 'search_files': {
        const pattern = String(args.pattern ?? '')
        const dir = String(args.directory ?? '')
        return { label: '搜索文件', detail: `"${pattern}" in ${dir}` }
      }
      default:
        return { label: tc.name, detail: '' }
    }
  }

  /** 步骤折叠标题（多个工具时合并显示） */
  function stepHeaderSummary(step: AgentStep): { label: string; detail: string; filePath?: string } {
    if (step.toolCalls.length === 0) return { label: '思考中', detail: '...' }
    if (step.toolCalls.length === 1) return toolCallSummary(step.toolCalls[0])
    // 多工具：显示数量
    const names = [...new Set(step.toolCalls.map((tc) => toolCallSummary(tc).label))]
    return { label: names.join(' + '), detail: `(${step.toolCalls.length} 个操作)` }
  }

  /** 步骤总卡片标题：显示当前（或最近）正在执行的操作 */
  function stepGroupOperationSummary(steps: AgentStep[]): string {
    if (steps.length === 0) return '暂无操作'
    const active = [...steps].reverse().find((s) =>
      s.status === 'running' || s.status === 'calling' || s.status === 'confirm'
    )
    const recent = active
      ?? [...steps].reverse().find((s) => s.toolCalls.length > 0 || s.toolResults.length > 0)
      ?? steps[steps.length - 1]
    const summary = stepHeaderSummary(recent)
    if (summary.detail.trim()) return `${summary.label} · ${summary.detail}`
    return summary.label
  }

  /** 用选中的编辑器打开文件路径 */
  function openFile(filePath: string) {
    if (!filePath) return
    // 相对路径时，拼接 workspace
    const fullPath = filePath.startsWith('/') ? filePath : (workspace ? `${workspace}/${filePath}` : filePath)
    globalThis.window.taco.shell.openInEditor(fullPath, editor).catch(() => {
      // 静默失败，不影响 UI
    })
  }

  function startEdit(msg: ChatMsg) {
    if (sending) return
    setEditingMsgId(msg.id)
    setEditingText(msg.content)
  }

  function confirmEdit(msgId: string) {
    const text = editingText.trim()
    setEditingMsgId(null)
    if (!text) return
    onEditResend(msgId, text)
  }

  function cancelEdit() {
    setEditingMsgId(null)
  }

  const showPendingThinkingHint = sending && !showStreamBubble && !selectedFileChange && !viewingFile
  /* ---- Agent 步骤内部渲染辅助函数 ---- */

  function renderStepThinking(msg: ChatMsg, step: AgentStep, isStepRunning: boolean) {
    if (!step.thinking) return null
    const cleaned = step.thinking.replace(/<think>/gi, '').replace(/<\/think>/gi, '').trim()
    if (!cleaned) return null
    const thinkKey = `think-${msg.id}-${step.round}`
    const isThinkOpen = expandedThinkBlocks.has(thinkKey)
    const preview = cleaned.length > 80 ? cleaned.slice(0, 80).replace(/\n/g, ' ') + '...' : cleaned.replace(/\n/g, ' ')
    return (
      <div className={`step-thinking-block ${isStepRunning ? 'streaming' : 'done'}`}>
        <button type="button" className="step-thinking-header" onClick={() => toggleThinkBlock(thinkKey)}>
          <span className={`step-thinking-chevron ${isThinkOpen ? 'open' : ''}`}>›</span>
          <span className="step-thinking-label">
            💭 思考
            {isStepRunning && <span className="dot-pulse inline" />}
          </span>
          {!isThinkOpen && <span className="step-thinking-preview">{preview}</span>}
        </button>
        {isThinkOpen && (
          <div className="step-thinking-body"><MarkdownBubble content={cleaned} /></div>
        )}
      </div>
    )
  }

  function renderStepConfirm(msg: ChatMsg, step: AgentStep, isStepRunning: boolean, isStepConfirm: boolean) {
    if (!step.risks || !step.confirmId) return null
    const isPlanConfirm = step.risks.some((r) => r.toolName === 'propose_plan')

    const resolveConfirmStatus = (): 'pending' | 'approved' | 'denied' => {
      const responded = respondedConfirms.get(step.confirmId!)
      if (responded === true) return 'approved'
      if (responded === false) return 'denied'
      if (!isStepConfirm) return 'approved'
      return 'pending'
    }
    const confirmStatus = resolveConfirmStatus()

    const renderConfirmStatusUI = () => {
      if (confirmStatus === 'approved') {
        return (
          <div className="agent-confirm-responded">
            {isStepRunning ? <span className="agent-confirm-responded-icon spinning">⏳</span> : <span className="agent-confirm-responded-icon">✓</span>}
            {isPlanConfirm ? (isStepRunning ? '已确认，正在执行中...' : '已确认执行') : (isStepRunning ? '已授权，正在执行中...' : '已授权执行')}
          </div>
        )
      }
      if (confirmStatus === 'denied') {
        return (
          <div className="agent-confirm-responded denied">
            {isStepRunning ? <span className="agent-confirm-responded-icon spinning">⏳</span> : <span className="agent-confirm-responded-icon">✗</span>}
            {isPlanConfirm ? (isStepRunning ? '已要求调整，等待 AI 响应...' : '已要求调整') : (isStepRunning ? '已拒绝，等待 AI 响应...' : '已拒绝')}
          </div>
        )
      }
      return (
        <div className="agent-confirm-actions">
          <button type="button" className="agent-confirm-btn approve" onClick={() => handleConfirmResponse(step.confirmId!, true)}>
            {isPlanConfirm ? '确认执行' : '允许执行'}
          </button>
          <button type="button" className="agent-confirm-btn deny" onClick={() => handleConfirmResponse(step.confirmId!, false)}>
            {isPlanConfirm ? '需要调整' : '拒绝'}
          </button>
        </div>
      )
    }

    if (isPlanConfirm) {
      let plan: { summary?: string; steps?: string[]; reasoning?: string } = {}
      try { plan = JSON.parse(step.risks[0].detail) } catch { /* ignore */ }
      return (
        <div className="agent-confirm-card plan">
          <div className="agent-confirm-title">
            <span className="agent-confirm-icon">📋</span>
            执行计划{confirmStatus === 'pending' ? ' — 需要你的确认' : ''}
          </div>
          {plan.summary && <div className="agent-plan-summary">{plan.summary}</div>}
          {plan.steps && plan.steps.length > 0 && (
            <ol className="agent-plan-steps">{plan.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
          )}
          {plan.reasoning && (
            <div className="agent-plan-reasoning"><span className="agent-plan-reasoning-label">理由：</span>{plan.reasoning}</div>
          )}
          {renderConfirmStatusUI()}
        </div>
      )
    }

    return (
      <div className="agent-confirm-card">
        <div className="agent-confirm-title">
          <span className="agent-confirm-icon">⚠</span>
          {confirmStatus === 'pending' ? '需要你的授权' : '授权信息'}
        </div>
        <div className="agent-confirm-risks">
          {step.risks.map((risk) => (
            <div key={risk.toolCallId} className={`agent-confirm-risk ${risk.level}`}>
              <span className="agent-confirm-risk-badge">{risk.level === 'danger' ? '危险' : '注意'}</span>
              <span className="agent-confirm-risk-reason">{risk.reason}</span>
              <pre className="agent-confirm-risk-detail">{risk.detail}</pre>
            </div>
          ))}
        </div>
        {renderConfirmStatusUI()}
      </div>
    )
  }

  function renderStepToolResults(msg: ChatMsg, step: AgentStep, isStepRunning: boolean) {
    if (step.toolCalls.length === 1) {
      const tc = step.toolCalls[0]
      const result = step.toolResults.find((r) => r.tool_call_id === tc.id)
      const isToolRunning = !result && isStepRunning
      return result ? (
        <div className={`agent-step-result ${result.success ? 'success' : 'error'}`}>
          <ToolResultContent toolName={tc.name} toolArgs={parseArgs(tc.arguments)} result={result} />
        </div>
      ) : isToolRunning ? (
        <div className="agent-step-running-hint"><span className="agent-step-spinner" />执行中...</div>
      ) : null
    }
    if (step.toolCalls.length > 1) {
      return (
        <>
          {step.toolCalls.map((tc) => {
            const sm = toolCallSummary(tc)
            const result = step.toolResults.find((r) => r.tool_call_id === tc.id)
            const tbKey = `${msg.id}-${step.round}-${tc.id}`
            const isToolRunning = !result && isStepRunning
            const isToolBlockOpen = isToolRunning || expandedToolBlocks.has(tbKey)
            return (
              <div key={tc.id} className={`agent-tool-block ${isToolRunning ? 'running' : ''}`}>
                <div className="agent-tool-block-header">
                  <button type="button" className="agent-tool-block-toggle" onClick={() => toggleToolBlock(tbKey)}>
                    <span className="agent-tool-block-label">{sm.label}</span>
                  </button>
                  <span className="agent-tool-block-path" onClick={() => toggleToolBlock(tbKey)}>
                    {sm.filePath ? (
                      <span className="agent-step-path-link" title={`点击用 ${editorCommands[editor].label} 打开`} onClick={(e) => { e.stopPropagation(); openFile(sm.filePath!) }}>{sm.detail}</span>
                    ) : sm.detail}
                  </span>
                  <button type="button" className="agent-tool-block-chevron-btn" onClick={() => toggleToolBlock(tbKey)}>
                    <span className={`agent-tool-block-chevron ${isToolBlockOpen ? 'open' : ''}`}>›</span>
                  </button>
                </div>
                {isToolBlockOpen && (
                  <div className="agent-tool-block-body">
                    {result ? (
                      <div className={`agent-step-result ${result.success ? 'success' : 'error'}`}>
                        <ToolResultContent toolName={tc.name} toolArgs={parseArgs(tc.arguments)} result={result} />
                      </div>
                    ) : isToolRunning ? (
                      <div className="agent-step-running-hint"><span className="agent-step-spinner" />执行中...</div>
                    ) : null}
                  </div>
                )}
              </div>
            )
          })}
        </>
      )
    }
    if (isStepRunning) {
      return <div className="agent-step-running-hint"><span className="agent-step-spinner" />执行中...</div>
    }
    return null
  }

  return (
    <main className="main-panel">
      {/* Topbar */}
      <header
        className="topbar draggable"
        {...drag}
        onDoubleClick={() => globalThis.window.taco.window.toggleMaximize()}
      >
        <div className="topbar-title">{title}</div>
        <div className="topbar-actions no-drag">
          <div className="topbar-main-actions">
            <select
              className="editor-select"
              value={editor}
              onChange={(e) => onEditorChange(e.target.value as EditorId)}
              title="选择打开文件的编辑器"
            >
              {Object.entries(editorCommands).map(([id, { label }]) => (
                <option key={id} value={id}>{label}</option>
              ))}
            </select>
            <button
              className={`pill terminal-toggle ${showTerminal ? 'active' : ''}`}
              type="button"
              onClick={onToggleTerminal}
              title={showTerminal ? '关闭终端' : '打开终端'}
            >
              {'>'}_
            </button>
            {messages.length > 0 && (
              <button className="pill" type="button" onClick={onClearChat}>
                清空
              </button>
            )}
            <button className="pill new-session-btn" type="button" onClick={onNewSession} title="在当前项目中新建会话">
              + 新建会话
            </button>
          </div>
          {showWindowControls && (
            <div className="window-controls">
              <button
                type="button"
                className="window-control-btn"
                onClick={() => globalThis.window.taco.window.minimize()}
                title="最小化"
                aria-label="最小化"
              >
                <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                  <path d="M3 8.5h10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
              <button
                type="button"
                className="window-control-btn"
                onClick={() => globalThis.window.taco.window.toggleMaximize()}
                title="最大化/还原"
                aria-label="最大化"
              >
                <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                  <rect x="3.25" y="3.25" width="9.5" height="9.5" fill="none" stroke="currentColor" strokeWidth="1.5" rx="1" />
                </svg>
              </button>
              <button
                type="button"
                className="window-control-btn close"
                onClick={() => globalThis.window.taco.window.close()}
                title="关闭"
                aria-label="关闭"
              >
                <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                  <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          )}
        </div>
      </header>

      {/* 会话标签页 */}
      {sessions.length > 1 && (
        <div className="session-tabs">
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`session-tab ${s.id === activeSessionId ? 'active' : ''}`}
              onClick={() => onSwitchSession(s.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter') onSwitchSession(s.id) }}
            >
              <span className="session-tab-title">{s.title}</span>
              {sessions.length > 1 && (
                <button
                  type="button"
                  className="session-tab-close"
                  onClick={(e) => {
                    e.stopPropagation()
                    onDeleteSession(s.id)
                  }}
                  title="关闭会话"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Diff 视图（选中变更文件时覆盖对话区域） */}
      {selectedFileChange && !viewingFile && (
        <section className="diff-overlay">
          <DiffView
            change={selectedFileChange}
            onClose={onCloseDiff}
            status={selectedFileStatus}
            onAccept={onAcceptFile ? () => onAcceptFile(selectedFileChange.filePath) : undefined}
            onReject={onRejectFile ? () => onRejectFile(selectedFileChange.filePath) : undefined}
            workspace={viewingWorkspace}
            onSaved={onFileSaved}
          />
        </section>
      )}

      {/* 文件编辑器（点击目录树中的普通文件时覆盖对话区域） */}
      {viewingFile && viewingWorkspace && onCloseFileEditor && (
        <section className="diff-overlay">
          <FileEditor
            filePath={viewingFile}
            workspace={viewingWorkspace}
            onClose={onCloseFileEditor}
            onSaved={onFileSaved}
            onViewDiff={onViewDiffFromEditor}
          />
        </section>
      )}

      {/* Conversation */}
      <section
        className={`conversation ${showTerminal && !selectedFileChange && !viewingFile ? 'with-terminal' : ''}`}
        ref={scrollRef}
        style={selectedFileChange || viewingFile ? { display: 'none' } : undefined}
      >
        {messages.length === 0 && !showStreamBubble && (
          <div className="empty-state">
            <div className="empty-title">Taco AI</div>
            <div className="empty-sub">
              {!hasProviders
                ? '请先在 Settings 中配置至少一个模型的 API Key'
                : mode === 'agent' && !workspace
                  ? '请先选择一个工作空间目录，作为 Agent 可操作的安全空间'
                  : '发送一条消息开始对话'}
            </div>
            {mode === 'agent' && !workspace && hasProviders && (
              <button
                type="button"
                className="workspace-select-btn"
                onClick={onSelectWorkspace}
              >
                📁 选择工作空间
              </button>
            )}
          </div>
        )}

        <div className="chat-thread">
          {messages.map((msg) => {
            const isEditing = editingMsgId === msg.id

            return (
              <div key={msg.id} className={`chat-row ${msg.role}`}>
                {msg.role === 'assistant' ? (
                  <div className="bubble">
                    {/* Agent 步骤 + PlanTracker 插入在计划确认和执行步骤之间 */}
                    {msg.agentSteps && msg.agentSteps.length > 0 && (() => {
                      const stepCount = msg.agentSteps.length
                      const activeCount = msg.agentSteps.filter((s) => s.status === 'running' || s.status === 'calling' || s.status === 'confirm').length
                      const doneCount = msg.agentSteps.filter((s) => s.status === 'done').length
                      const failedCount = msg.agentSteps.filter((s) => s.status === 'done' && s.toolResults.some((r) => !r.success)).length
                      const hasActiveSteps = activeCount > 0
                      const defaultExpanded = hasActiveSteps || stepCount <= 4
                      const hasExplicitExpanded = Object.prototype.hasOwnProperty.call(stepGroupExpandedMap, msg.id)
                      const isStepsExpanded = hasExplicitExpanded ? stepGroupExpandedMap[msg.id] : defaultExpanded
                      const groupOperation = stepGroupOperationSummary(msg.agentSteps)
                      const groupSummary = hasActiveSteps
                        ? `${activeCount} 个执行中`
                        : `${doneCount}/${stepCount} 已完成${failedCount > 0 ? ` · ${failedCount} 异常` : ''}`

                      // 找到计划确认步骤的位置
                      const planStepIdx = msg.agentSteps.findIndex((s) =>
                        s.risks?.some((r) => r.toolName === 'propose_plan')
                      )
                      const hasPlanSplit = planStepIdx >= 0
                      const beforePlan = hasPlanSplit ? msg.agentSteps.slice(0, planStepIdx + 1) : []
                      const afterPlan = hasPlanSplit ? msg.agentSteps.slice(planStepIdx + 1) : msg.agentSteps

                      const renderStep = (step: AgentStep) => {
                        const stepKey = `${msg.id}-${step.round}`
                        const isStepRunning = step.status === 'running' || step.status === 'calling'
                        const isStepConfirm = step.status === 'confirm'
                        const isStepExpanded = isStepRunning || isStepConfirm || expandedSteps.has(stepKey)
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
                                  <span className="agent-step-path-link" title={`点击用 ${editorCommands[editor].label} 打开`} onClick={(e) => { e.stopPropagation(); openFile(summary.filePath!) }}>{summary.detail}</span>
                                ) : summary.detail}
                              </span>
                              <button type="button" className="agent-step-chevron-btn" onClick={() => toggleStep(stepKey)}>
                                <span className={`agent-step-chevron ${isStepExpanded ? 'open' : ''}`}>›</span>
                              </button>
                            </div>
                            {isStepExpanded && (
                              <div className="agent-step-body">
                                {renderStepThinking(msg, step, isStepRunning)}
                                {renderStepConfirm(msg, step, isStepRunning, isStepConfirm)}
                                {renderStepToolResults(msg, step, isStepRunning)}
                              </div>
                            )}
                          </div>
                        )
                      }

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
                                {beforePlan.map(renderStep)}
                                {afterPlan.map(renderStep)}
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })()}
                    {/* 执行计划进度：紧贴在最终总结文本上方 */}
                    {msg.activePlan && <PlanTracker plan={msg.activePlan} />}
                    {/* 最终回复文本 */}
                    {msg.content && <MarkdownBubble content={msg.content} />}
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
                ) : isEditing ? (
                  <div className="bubble editing">
                    <textarea
                      className="bubble-edit-input"
                      value={editingText}
                      onChange={(e) => setEditingText(e.target.value)}
                      onKeyDown={(e) => {
                        // 输入法组合中按 Enter 不提交
                        if (e.nativeEvent.isComposing || e.keyCode === 229) return
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault()
                          confirmEdit(msg.id)
                        }
                        if (e.key === 'Escape') cancelEdit()
                      }}
                      onBlur={() => cancelEdit()}
                      autoFocus
                      rows={Math.min(editingText.split('\n').length, 8)}
                    />
                    <div className="bubble-edit-hint">
                      Enter 确认 · Esc 取消
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="bubble">
                      {msg.images && msg.images.length > 0 && (
                        <div className="msg-images">
                          {msg.images.map((img) => (
                            <img key={img.id} src={img.dataUrl} alt={img.name} className="msg-image-thumb" />
                          ))}
                        </div>
                      )}
                      {msg.content
                        .split('\n')
                        .map((line, i) => <p key={`${msg.id}-${i}`}>{line}</p>)}
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
                      {/* 回滚按钮：如果此用户消息后的 assistant 消息有 git commit */}
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
                            title="回滚到此消息之前的版本（撤销此次 Agent 的所有文件变更）"
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
                )}
              </div>
            )
          })}

          {showStreamBubble && (
            <div className="chat-row assistant">
              <div className="bubble">
                {streamingContent ? (
                  <MarkdownBubble content={streamingContent} streaming />
                ) : (
                  <div className="typing-indicator">
                    <span />
                    <span />
                    <span />
                  </div>
                )}
              </div>
            </div>
          )}

          {showPendingThinkingHint && (
            <div className="chat-row assistant">
              <div className="assistant-thinking-inline" aria-live="polite">
                <span>思考中</span>
                <span className="dot-pulse inline" />
              </div>
            </div>
          )}
        </div>

      </section>

      {/* Terminal（打开时显示在对话区域下方） */}
      {showTerminal && !selectedFileChange && !viewingFile && (
        <TerminalPanel cwd={terminalCwd} onClose={onToggleTerminal} />
      )}

      {previewImageUrl && (
        <div className="image-lightbox" onClick={() => setPreviewImageUrl(null)}>
          <button
            type="button"
            className="image-lightbox-close"
            onClick={(e) => {
              e.stopPropagation()
              setPreviewImageUrl(null)
            }}
            aria-label="Close image preview"
          >
            ×
          </button>
          <img
            src={previewImageUrl}
            alt="automation-screenshot-preview"
            className="image-lightbox-content"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      {/* Queue + Composer */}
      <footer className="composer">
        {queue.length > 0 && (
          <div className="queue-list">
            <div className="queue-header">排队中 ({queue.length})</div>
            {queue.map((item) => (
              <div key={item.id} className="queue-item">
                <span className="queue-text">{item.content}</span>
                <button
                  type="button"
                  className="queue-remove"
                  onClick={() => onRemoveFromQueue(item.id)}
                  aria-label="Remove from queue"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="composer-card">
          {/* 图片预览区 */}
          {attachedImages.length > 0 && (
            <div className="composer-images">
              {attachedImages.map((img) => (
                <div key={img.id} className="composer-image-item">
                  <img src={img.dataUrl} alt={img.name} className="composer-image-thumb" />
                  <button
                    type="button"
                    className="composer-image-remove"
                    onClick={() => removeImage(img.id)}
                    title="移除图片"
                  >×</button>
                </div>
              ))}
            </div>
          )}
          <textarea
            className="composer-input"
            placeholder={
              !hasProviders
                ? '请先在 Settings 中配置模型...'
                : mode === 'agent' && !workspace
                  ? '请先选择工作空间...'
                  : sending
                    ? '输入消息, Enter 加入队列等待发送'
                    : '输入消息, Enter 发送, Shift+Enter 换行, 可粘贴图片'
            }
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            onPaste={handlePaste}
            rows={1}
            disabled={!hasProviders || (mode === 'agent' && !workspace)}
            onKeyDown={(e) => {
              // 输入法组合中（如拼音选字）按 Enter 不发送
              if (e.nativeEvent.isComposing || e.keyCode === 229) return
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
          />
          {/* 隐藏的文件选择 input */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: 'none' }}
            onChange={handleFileSelect}
          />
          <div className="composer-row">
            <div className="composer-left">
              <button
                type="button"
                className="composer-attach-btn"
                onClick={() => fileInputRef.current?.click()}
                title="添加图片（支持粘贴）"
                disabled={!hasProviders || (mode === 'agent' && !workspace)}
              >
                🖼
              </button>
              <button
                type="button"
                className={`mode-toggle ${mode}`}
                onClick={() => onModeChange(mode === 'chat' ? 'agent' : 'chat')}
                title={mode === 'chat' ? '切换到 Agent 模式（可调用工具）' : '切换到 Chat 模式（纯对话）'}
              >
                {mode === 'agent' ? '⚙ Agent' : '💬 Chat'}
              </button>
              {mode === 'agent' && (
                <button
                  type="button"
                  className={`workspace-btn ${workspace ? 'active' : ''}`}
                  onClick={onSelectWorkspace}
                  title={workspace ? `工作空间: ${workspace}` : '选择工作空间'}
                >
                  📁 {workspace ? workspace.split('/').pop() || workspace : '选择工作空间'}
                </button>
              )}
              <select
                className="provider-select"
                value={provider}
                onChange={(e) => onProviderChange(e.target.value as ProviderId)}
                disabled={!hasProviders}
                aria-label="Select AI provider"
              >
                {!hasProviders ? (
                  <option value="deepseek">请先配置模型</option>
                ) : (
                  configuredProviders.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))
                )}
              </select>
            </div>
            <div className="composer-right">
              {sending ? (
                <button
                  className="send-btn stop"
                  type="button"
                  onClick={onStop}
                  title="停止生成"
                >
                  <span className="stop-icon" />
                </button>
              ) : (
                <button
                  className="send-btn"
                  type="button"
                  onClick={handleSend}
                  disabled={!hasProviders || (mode === 'agent' && !workspace)}
                >
                  {'\u2191'}
                </button>
              )}
            </div>
          </div>
        </div>
      </footer>
    </main>
  )
}
