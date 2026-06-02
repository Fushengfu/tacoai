import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ActivePlan, AgentStep, AttachedAsset, AttachedImage, ChatMsg, FileChangeInfo, FileChangeStatus, QueuedMessage, Session } from '../types'
import type { EditorId } from '../../shared/ipc'
import { MarkdownBubble } from './MarkdownBubble'
import { DiffView } from './DiffView'
import { FileEditor } from './FileEditor'
import { ToolResultContent } from './ToolResultContent'
import { TerminalPanel } from './TerminalPanel'
import { useLanguage } from '../hooks/useLanguage'
import { ProviderSelect } from './ProviderSelect'

/* ------------------------------------------------------------------ */
/*  PlanTracker — 实时计划进度追踪器                                      */
/* ------------------------------------------------------------------ */

const planStepIcons: Record<string, string> = {
  pending: '○',
  in_progress: '◉',
  done: '✓',
  failed: '✗',
}

const INITIAL_VISIBLE_MESSAGE_COUNT = 60
const LOAD_MORE_MESSAGE_BATCH = 40
const LOAD_MORE_SCROLL_THRESHOLD_PX = 72

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

function formatTaskTimingLabel(
  taskTiming?: ChatMsg['taskTiming'] | null,
  nowTs?: number,
  fallbackStartedAt?: number,
): string | null {
  const startedAtRaw = Number(taskTiming?.startedAt ?? fallbackStartedAt)
  if (!Number.isFinite(startedAtRaw) || startedAtRaw <= 0) return null
  const startedAt = startedAtRaw
  const direct = Number(taskTiming?.durationMs)
  const endedAt = Number(taskTiming?.endedAt)
  let durationMs = Number.NaN
  if (Number.isFinite(direct)) durationMs = direct
  else if (Number.isFinite(endedAt) && endedAt >= startedAt) durationMs = endedAt - startedAt
  else durationMs = (Number.isFinite(nowTs) ? Number(nowTs) : Date.now()) - startedAt
  if (!Number.isFinite(durationMs)) return null
  return `本轮耗时 ${formatElapsedHms(Math.max(0, durationMs))}`
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
    text: s.title || s.content || '',
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
            <div className="plan-step-content">
              <span className="plan-step-title">{step.title || step.text}</span>
              {step.content && <span className="plan-step-desc">{step.content}</span>}
              {step.note && <span className="plan-step-note">{step.note}</span>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function stripInternalSummaryBlocks(text: string): string {
  let output = String(text ?? '')
  const headers = [
    '【历史助手回复（仅供上下文，不代表当前轮结论）】',
    '【执行过程摘要】',
    '【计划状态】',
    '【Git 提交】',
  ]
  for (const header of headers) {
    const pattern = new RegExp(`${escapeRegExp(header)}[\\s\\S]*?(?=\\n【|$)`, 'g')
    output = output.replace(pattern, '')
  }
  return output
}

function maskToolNamesForUser(text: string, toolNames: string[]): string {
  let output = String(text ?? '')
  const names = Array.from(new Set(toolNames.filter(Boolean)))
  for (const name of names) {
    const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`, 'gi')
    output = output.replace(pattern, '工具操作')
  }
  output = output
    .replace(/\[TOOL_CALL\][\s\S]*?\[\/TOOL_CALL\]/gi, '')
    .replace(/<invoke[\s\S]*?<\/invoke>/gi, '')
    .replace(/<\/?minimax:tool_call>/gi, '')
  return output
}

function sanitizeAssistantContentForDisplay(content: string, toolNames: string[]): string {
  const withoutInternalSummary = stripInternalSummaryBlocks(content)
  const withoutThink = withoutInternalSummary
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think\b[^>]*>/gi, '')
  const masked = maskToolNamesForUser(withoutThink, toolNames)
  return masked
    .replace(/\[DONE\]\s*$/g, '') // 过滤 [DONE] 标记（SSE 终止符误入内容）
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

type ChatPanelProps = {
  messages: ChatMsg[]
  showStreamBubble: boolean
  streamingContent: string
  /** 当前在途任务开始时间（用于实时耗时） */
  activeTaskStartedAt?: number
  draft: string
  onDraftChange: (value: string) => void
  sending: boolean
  onSend: (content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } } | { type: 'video_url'; video_url: { url: string } } | { type: 'audio_url'; audio_url: { url: string } }>) => void
  onStop: () => void
  /** 会话管理 */
  onSwitchSession: (sessionId: string) => void
  onDeleteSession: (sessionId: string) => void
  sessions: Session[]
  activeSessionId: string
  onResend: (msgId: string) => void
  onEditResend: (msgId: string, newContent: string) => void
  workspace: string
  onSelectWorkspace: () => void
  provider: string
  onProviderChange: (id: string) => void
  configuredProviders: readonly { id: string; label: string; source?: 'custom' | 'system' }[]
  scrollRef: React.RefObject<HTMLDivElement>
  totalMessageCount?: number
  hasOlderStoredMessages?: boolean
  loadingOlderMessages?: boolean
  onLoadOlderMessages?: () => void | Promise<void>
  queue: QueuedMessage[]
  onRemoveFromQueue: (id: string) => void
  editor: EditorId
  /** 判断会话是否正在执行中 */
  isSessionSending?: (sessionId: string) => boolean
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
  /** 当前模型是否支持视觉理解 */
  supportsVision?: boolean
  /** 当前在编辑器中打开的文件路径（非变更文件） */
  viewingFile?: string | null
  /** 文件编辑器初始定位（行/列） */
  viewingSelection?: { line: number; column: number } | null
  /** 工作空间路径（FileEditor 需要） */
  viewingWorkspace?: string
  /** 关闭文件编辑器 */
  onCloseFileEditor?: () => void
  /** 文件保存后的回调（刷新目录树等） */
  onFileSaved?: () => void
  /** 文件编辑后的回调（用于同步变更列表） */
  onFileEdited?: (change: FileChangeInfo) => void
  /** 从编辑器切换到 Diff 视图 */
  onViewDiffFromEditor?: () => void
  /** 在中间区域打开文件查看/编辑 */
  onOpenFileView?: (filePath: string, forceDiff?: boolean, selection?: { line: number; column: number } | null) => void
}

export function ChatPanel({
  messages,
  showStreamBubble,
  streamingContent,
  activeTaskStartedAt,
  draft,
  onDraftChange,
  sending,
  onSend,
  onStop,
  onSwitchSession,
  onDeleteSession,
  sessions,
  activeSessionId,
  onResend,
  onEditResend,
  workspace,
  onSelectWorkspace,
  provider,
  onProviderChange,
  configuredProviders,
  scrollRef,
  totalMessageCount,
  hasOlderStoredMessages,
  loadingOlderMessages,
  onLoadOlderMessages,
  queue,
  onRemoveFromQueue,
  editor,
  isSessionSending,
  selectedFileChange,
  onCloseDiff,
  showTerminal,
  onToggleTerminal,
  terminalCwd,
  selectedFileStatus,
  onAcceptFile,
  onRejectFile,
  onRollbackBeforeMsg,
  supportsVision,
  viewingFile,
  viewingSelection,
  viewingWorkspace,
  onCloseFileEditor,
  onFileSaved,
  onFileEdited,
  onViewDiffFromEditor,
  onOpenFileView,
}: Readonly<ChatPanelProps>) {
  const hasProviders = configuredProviders.length > 0
  const isNearBottomRef = useRef<boolean>(true)
  const wasAtBottomBeforeRenderRef = useRef<boolean>(true)
  const lastScrollHeightRef = useRef<number>(0)
  const BOTTOM_THRESHOLD = 240
  const [visibleMessageCount, setVisibleMessageCount] = useState(() => Math.min(messages.length, INITIAL_VISIBLE_MESSAGE_COUNT))
  const prependAnchorRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null)
  const prevSessionIdRef = useRef<string | null>(activeSessionId ?? null)
  
  // ── 语言切换 ──
  const { language, toggleLanguage, t, isZhCN } = useLanguage()

  // ── 图片附件状态 ──
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([])
  /** 文件附件（代码、文档、视频、音频等） - 以卡片形式显示 */
  const [attachedAssets, setAttachedAssets] = useState<AttachedAsset[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const inputDivRef = useRef<HTMLDivElement>(null)

  /** 在 contentEditable div 中插入附件卡片 */
  function insertFileChip(path: string) {
    const div = inputDivRef.current
    if (!div) return

    // 创建附件卡片元素
    const chip = document.createElement('span')
    chip.className = 'file-attachment-chip'
    chip.setAttribute('data-file-path', path)
    chip.contentEditable = 'false'
    chip.innerHTML = `📄 ${toAssetName(path)} <span class="file-chip-remove">×</span>`
    
    // 点击删除
    chip.addEventListener('click', (e) => {
      const target = e.target as HTMLElement
      if (target.classList.contains('file-chip-remove')) {
        chip.remove()
        // 从 attachedAssets 中移除
        setAttachedAssets(prev => prev.filter(a => a.path !== path))
        // 更新 draft
        updateDraftFromDiv()
      }
    })

    // 插入到光标位置
    const selection = window.getSelection()
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0)
      range.deleteContents()
      range.insertNode(chip)
      // 光标移动到卡片后面
      range.setStartAfter(chip)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    } else {
      div.appendChild(chip)
    }

    div.focus()
    updateDraftFromDiv()
  }

  /** 从 contentEditable div 提取 draft */
  function updateDraftFromDiv() {
    const div = inputDivRef.current
    if (!div) return
    
    let text = ''
    for (const node of div.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent || ''
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as Element
        if (el.classList.contains('file-attachment-chip')) {
          const path = el.getAttribute('data-file-path')
          if (path) {
            text += `[FILE]${path}[/FILE]`
          }
        } else {
          text += el.textContent || ''
        }
      }
    }
    onDraftChange(text)
  }

  /** 读取文件为 base64 data URL */
  function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }

  /** 添加图片（去重，限制 5 张）- 选择/粘贴时立即上传 */
  async function addImages(files: File[]) {
    const MAX_IMAGES = 5
    const MAX_SIZE = 10 * 1024 * 1024 // 10MB
    const validFiles = files.filter((f) => f.type.startsWith('image/') && f.size <= MAX_SIZE)
    if (validFiles.length === 0) return

    for (const file of validFiles) {
      if (attachedImages.length >= MAX_IMAGES) break
      
      const id = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      
      // 先添加到列表,状态为pending
      const placeholder: AttachedImage = {
        id,
        dataUrl: '',
        cloudUrl: '',
        name: file.name,
        uploadStatus: 'pending',
        uploadProgress: 0,
      }
      setAttachedImages((prev) => [...prev, placeholder].slice(0, MAX_IMAGES))
      
      // 异步上传
      uploadImage(file, id)
    }
  }

  /** 上传图片到云存储 */
  async function uploadImage(file: File, id: string) {
    try {
      // 更新状态为uploading
      setAttachedImages((prev) => prev.map(img => 
        img.id === id ? { ...img, uploadStatus: 'uploading', uploadProgress: 10 } : img
      ))
      
      // 读取为data URL
      const dataUrl = await readFileAsDataUrl(file)
      
      setAttachedImages((prev) => prev.map(img => 
        img.id === id ? { ...img, dataUrl, uploadProgress: 30 } : img
      ))
      
      // 调用IPC上传 (主进程会直接读取配置)
      const result = await window.taco.image.upload(dataUrl, file.name)
      
      // 上传成功
      if (!result?.publicUrl) {
        throw new Error('上传返回的 URL 为空')
      }
      
      setAttachedImages((prev) => prev.map(img => 
        img.id === id ? { 
          ...img, 
          cloudUrl: result.publicUrl, 
          uploadStatus: 'done', 
          uploadProgress: 100 
        } : img
      ))
    } catch (err) {
      console.error('图片上传失败:', err)
      setAttachedImages((prev) => prev.map(img => 
        img.id === id ? { 
          ...img, 
          uploadStatus: 'error', 
          uploadProgress: 0 
        } : img
      ))
      // 3秒后自动移除失败的图片
      setTimeout(() => removeImage(id), 3000)
    }
  }

  function removeImage(id: string) {
    setAttachedImages((prev) => prev.filter((img) => img.id !== id))
  }

  function removeAsset(id: string) {
    setAttachedAssets((prev) => prev.filter((item) => item.id !== id))
  }

  function toAssetName(filePath: string): string {    const normalized = String(filePath ?? '').replace(/\\/g, '/')
    const parts = normalized.split('/').filter(Boolean)
    return parts[parts.length - 1] || normalized
  }

  /** 粘贴事件处理：提取图片 */
  function handlePaste(e: React.ClipboardEvent) {
    // 1. 处理图片粘贴
    if (supportsVision) {
      const items = e.clipboardData?.items
      if (items) {
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
          return
        }
      }
    }

    // 2. 处理文本粘贴：强制纯文本，去除样式
    const text = e.clipboardData?.getData('text/plain')
    if (text) {
      e.preventDefault()
      document.execCommand('insertText', false, text)
    }
  }

  /** 统一文件选择处理：根据类型自动路由 */
  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files
    if (!files || files.length === 0) {
      e.target.value = ''
      return
    }

    const imageFiles: File[] = []
    const otherFiles: File[] = []

    for (const file of Array.from(files)) {
      // 判断是否为图片
      if (file.type.startsWith('image/') && supportsVision) {
        imageFiles.push(file)
      } else {
        otherFiles.push(file)
      }
    }

    // 处理图片：直接调用现有的addImages
    if (imageFiles.length > 0) {
      addImages(imageFiles)
    }

    // 处理其他文件：由于<input type="file">无法获取完整路径，只能提示用户使用系统对话框
    // 这里暂时不处理，保持原有逻辑
    if (otherFiles.length > 0) {
      console.log('[handleFileSelect] 检测到非图片文件，这些文件无法作为附件添加(缺少完整路径)')
    }

    e.target.value = ''
  }

  /** 智能添加文件：统一入口，分别调用图片和附件选择 */
  async function handleAddFiles() {
    const paths = await globalThis.window.taco.dialog.selectAttachments()
    if (!Array.isArray(paths) || paths.length === 0) return

    const imagePaths: string[] = []
    const assetPaths: string[] = []

    // 分类文件路径
    for (const rawPath of paths) {
      const filePath = String(rawPath ?? '').trim()
      if (!filePath) continue

      const ext = filePath.toLowerCase().split('.').pop() || ''
      const imageExts = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico'])
      
      if (imageExts.has(ext) && supportsVision) {
        imagePaths.push(filePath)
      } else {
        assetPaths.push(filePath)
      }
    }

    // 处理图片：读取为data URL后上传
    if (imagePaths.length > 0) {
      const imageFiles: File[] = []
      for (const imgPath of imagePaths) {
        try {
          const result = await window.taco.file.read(imgPath)
          if (result.dataUrl) {
            const fileName = imgPath.split('/').pop() || 'image'
            const response = await fetch(result.dataUrl)
            const blob = await response.blob()
            imageFiles.push(new File([blob], fileName, { type: blob.type }))
          }
        } catch (err) {
          console.error('[handleAddFiles] 读取图片失败:', err)
        }
      }
      
      if (imageFiles.length > 0) {
        addImages(imageFiles)
      }
    }

    // 处理其他文件：插入附件卡片到输入框
    if (assetPaths.length > 0) {
      for (const filePath of assetPaths) {
        insertFileChip(filePath)
        // 添加到 attachedAssets 状态
        setAttachedAssets((prev) => {
          const exists = prev.some(a => a.path === filePath)
          if (exists) return prev
          return [...prev, {
            id: `asset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: toAssetName(filePath),
            path: filePath,
          }]
        })
      }
    }
  }

  /** 发送消息（构建统一 content 数组） */
  async function handleSend() {
    // 等待所有上传中的图片完成
    const hasPending = attachedImages.some(img => 
      img.uploadStatus === 'pending' || img.uploadStatus === 'uploading'
    )
    
    if (hasPending) {
      // 等待最多 30 秒
      const maxWait = 30000
      const startTime = Date.now()
      
      while (Date.now() - startTime < maxWait) {
        // 使用函数式更新获取最新状态
        let allDone = false
        setAttachedImages(prev => {
          const stillPending = prev.filter(img => 
            img.uploadStatus === 'pending' || img.uploadStatus === 'uploading'
          )
          allDone = stillPending.length === 0
          return prev // 不修改状态
        })
        
        if (allDone) {
          break
        }
        
        // 等待 100ms 后重试
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
    
    // 构建统一的 content 数组
    const parts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } } | { type: 'video_url'; video_url: { url: string } } | { type: 'audio_url'; audio_url: { url: string } }> = []
    
    // 1. 添加文本内容
    const textContent = draft.trim() || false
    if (textContent) {
      parts.push({ type: 'text', text: textContent })
    }
    
    // 2. 添加已上传的图片（使用 cloudUrl）
    const doneImages = attachedImages.filter(img => img.uploadStatus === 'done' && img.cloudUrl)
    for (const img of doneImages) {
      parts.push({ type: 'image_url', image_url: { url: img.cloudUrl } })
    }
    
    // 3. 添加文件附件（代码、文档、视频、音频等）
    // 后端会根据 attachedAssets 自动处理为对应格式
    for (const asset of attachedAssets) {
      const ext = asset.path.split('.').pop()?.toLowerCase() || ''
      const imageExts = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico'])
      const videoExts = new Set(['mp4', 'webm', 'ogg', 'mov', 'avi', 'mkv'])
      const audioExts = new Set(['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a'])
      
      if (imageExts.has(ext)) {
        parts.push({ type: 'image_url', image_url: { url: asset.path } })
      } else if (videoExts.has(ext)) {
        parts.push({ type: 'video_url', video_url: { url: asset.path } })
      } else if (audioExts.has(ext)) {
        parts.push({ type: 'audio_url', audio_url: { url: asset.path } })
      }
      // 非媒体文件（代码、文档等）由后端 mapMessageForApi 处理为 [FILE] 标签
    }
    
    
    // 清空附件状态
    setAttachedImages([])
    setAttachedAssets([])
    
    // 清空输入框
    onDraftChange('')
    if (inputDivRef.current) {
      inputDivRef.current.innerHTML = ''
    }
    
    // 发送统一的 content 数组
    onSend(parts)
  }

  // 编辑中的用户消息
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState('')
  const [editingAttachments, setEditingAttachments] = useState<AttachedAsset[]>([])
  const editingInputDivRef = useRef<HTMLDivElement>(null)

  /** 在编辑框中插入附件卡片 */
  function insertEditingFileChip(path: string) {
    const div = editingInputDivRef.current
    if (!div) return

    const chip = document.createElement('span')
    chip.className = 'file-attachment-chip'
    chip.setAttribute('data-file-path', path)
    chip.contentEditable = 'false'
    chip.innerHTML = `📄 ${toAssetName(path)} <span class="file-chip-remove">×</span>`
    
    chip.addEventListener('click', (e) => {
      const target = e.target as HTMLElement
      if (target.classList.contains('file-chip-remove')) {
        chip.remove()
        setEditingAttachments(prev => prev.filter(a => a.path !== path))
        updateEditingTextFromDiv()
      }
    })

    const selection = window.getSelection()
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0)
      range.deleteContents()
      range.insertNode(chip)
      range.setStartAfter(chip)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    } else {
      div.appendChild(chip)
    }

    div.focus()
    updateEditingTextFromDiv()
  }

  /** 从编辑框提取文本 */
  function updateEditingTextFromDiv() {
    const div = editingInputDivRef.current
    if (!div) return
    
    let text = ''
    for (const node of div.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent || ''
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as Element
        if (el.classList.contains('file-attachment-chip')) {
          const path = el.getAttribute('data-file-path')
          if (path) {
            text += `[FILE]${path}[/FILE]`
          }
        } else {
          text += el.textContent || ''
        }
      }
    }
    setEditingText(text)
  }

  // 已响应的确认请求（防止重复点击）
  const [respondedConfirms, setRespondedConfirms] = useState<Map<string, boolean>>(new Map())

  // 已响应的重试请求（防止重复点击）
  const [respondedRetries, setRespondedRetries] = useState<Map<string, boolean>>(new Map())

  // 监听移动端用户的确认响应，同步到桌面端 UI
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { confirmId: string; approved: boolean }
      if (detail?.confirmId) {
        setRespondedConfirms((prev) => {
          if (prev.has(detail.confirmId)) return prev
          return new Map(prev).set(detail.confirmId, detail.approved)
        })
      }
    }
    window.addEventListener('taco:confirm-response', handler as EventListener)
    return () => window.removeEventListener('taco:confirm-response', handler as EventListener)
  }, [])

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
  const [nowTs, setNowTs] = useState(() => Date.now())

  useEffect(() => {
    if (!sending) return
    const timer = window.setInterval(() => setNowTs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [sending])

  useEffect(() => {
    setVisibleMessageCount(Math.min(messages.length, INITIAL_VISIBLE_MESSAGE_COUNT))
    prependAnchorRef.current = null
  }, [activeSessionId])

  useEffect(() => {
    setVisibleMessageCount((prev) => {
      if (messages.length <= 0) return 0
      if (prev <= 0) return Math.min(messages.length, INITIAL_VISIBLE_MESSAGE_COUNT)
      if (prev > messages.length) return messages.length
      return prev
    })
  }, [messages.length])

  const totalHistoryCount = Math.max(messages.length, totalMessageCount ?? 0)
  const locallyHiddenMessageCount = Math.max(0, messages.length - visibleMessageCount)
  const hiddenMessageCount = Math.max(0, totalHistoryCount - visibleMessageCount)
  const hasHiddenHistory = locallyHiddenMessageCount > 0 || Boolean(hasOlderStoredMessages)
  const visibleMessages = locallyHiddenMessageCount > 0
    ? messages.slice(-visibleMessageCount)
    : messages

  const loadOlderMessages = useCallback(() => {
    if (!hasHiddenHistory) return
    const el = scrollRef.current
    if (el) {
      prependAnchorRef.current = {
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
      }
    }
    if (locallyHiddenMessageCount > 0) {
      setVisibleMessageCount((prev) => Math.min(messages.length, prev + LOAD_MORE_MESSAGE_BATCH))
      return
    }
    void onLoadOlderMessages?.()
  }, [hasHiddenHistory, locallyHiddenMessageCount, messages.length, onLoadOlderMessages, scrollRef])

  useEffect(() => {
    const anchor = prependAnchorRef.current
    const el = scrollRef.current
    if (!anchor || !el) return
    const heightDelta = el.scrollHeight - anchor.scrollHeight
    el.scrollTop = anchor.scrollTop + heightDelta
    prependAnchorRef.current = null
  }, [messages.length, visibleMessageCount, scrollRef])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    let frameId = 0
    const handleHistoryScroll = () => {
      if (frameId) return
      frameId = window.requestAnimationFrame(() => {
        frameId = 0
        if (el.scrollTop <= LOAD_MORE_SCROLL_THRESHOLD_PX && hasHiddenHistory) {
          loadOlderMessages()
        }
      })
    }

    el.addEventListener('scroll', handleHistoryScroll, { passive: true })
    return () => {
      if (frameId) window.cancelAnimationFrame(frameId)
      el.removeEventListener('scroll', handleHistoryScroll)
    }
  }, [hasHiddenHistory, loadOlderMessages, scrollRef])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    const check = () => {
      const distanceToBottom = Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight)
      isNearBottomRef.current = distanceToBottom < BOTTOM_THRESHOLD
    }

    check()
    el.addEventListener('scroll', check, { passive: true })
    return () => el.removeEventListener('scroll', check)
  }, [scrollRef])

  // 跟踪最后一条 AI 消息的内容长度（用于触发滚动）
  // 包含 content 长度和 toolCalls 数量，确保 tool calls 增加时也能触发滚动
  const lastAssistantContentLen = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === 'assistant') {
        const contentLen = (messages[i].content ?? '').length
        const toolCallsLen = messages[i].toolCalls?.length ?? 0
        return contentLen + toolCallsLen * 1000 // toolCalls 变化时触发重新计算
      }
    }
    return 0
  }, [messages])

  // 检测会话切换，强制标记需要滚动到底部
  // 必须用 useLayoutEffect 而非 useEffect，确保在 DOM 更新前同步执行，让下方的 useLayoutEffect 快照能读到正确值
  useLayoutEffect(() => {
    const prevSessionId = prevSessionIdRef.current
    if (prevSessionId !== activeSessionId) {
      prevSessionIdRef.current = activeSessionId ?? null
      // 会话切换，强制标记滚动到底部
      isNearBottomRef.current = true
      wasAtBottomBeforeRenderRef.current = true
    }
  }, [activeSessionId])

  // 记录本次渲染前用户是否在底部 + scrollHeight（DOM 更新前快照）
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const distanceToBottom = Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight)
    wasAtBottomBeforeRenderRef.current = distanceToBottom < BOTTOM_THRESHOLD
    lastScrollHeightRef.current = el.scrollHeight
  })

  // 滚动到底部：在 DOM 更新后同步执行
  // - 用户在底部时，内容增长自动跟随滚动（使用 scrollHeight 差值补偿）
  // - 用户向上查看历史时，不自动滚动
  // - 会话切换时，强制滚动到底部
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (!wasAtBottomBeforeRenderRef.current) return
    // 使用 scrollHeight 差值补偿法：内容增长多少，scrollTop 就增加多少
    const scrollHeightDelta = el.scrollHeight - lastScrollHeightRef.current
    if (scrollHeightDelta > 0) {
      el.scrollTop += scrollHeightDelta
    } else {
      // 首次渲染或内容未变化时，直接滚到底部
      el.scrollTop = el.scrollHeight
    }
  }, [messages.length, lastAssistantContentLen, scrollRef])

  // 挂载时（切换项目/会话）强制滚动到底部
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    // 使用两次 requestAnimationFrame 确保 DOM 完全渲染（包括图片、代码块等）
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight
        isNearBottomRef.current = true
        wasAtBottomBeforeRenderRef.current = true
        lastScrollHeightRef.current = el.scrollHeight
      })
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function isWindowsAbsolutePath(text: string): boolean {
    return /^[a-zA-Z]:[\\/]/.test(text) || text.startsWith('\\\\')
  }

  function normalizeScreenshotPath(raw: unknown): string | null {
    const text = String(raw ?? '').trim()
    if (!text) return null
    if (text.startsWith('/') || isWindowsAbsolutePath(text)) return text
    return null
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
    if (raw.startsWith('\\\\')) {
      const uncPath = raw.replace(/^\\\\+/, '').replace(/\\/g, '/')
      return `file://${encodeURI(uncPath)}`
    }
    if (/^[a-zA-Z]:[\\/]/.test(raw)) {
      const winPath = raw.replace(/\\/g, '/')
      return `file:///${encodeURI(winPath)}`
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

  let lastAssistantMessageId: string | null = null
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') {
      lastAssistantMessageId = messages[i].id
      break
    }
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
    if (step.status === 'retry_confirm') return '⚠'
    const allSuccess = step.toolResults.every((r) => r.success)
    return allSuccess ? '✓' : '⚠'
  }

  /** 用户授权或拒绝风险操作（防重复点击） */
  function handleConfirmResponse(confirmId: string, approved: boolean) {
    if (respondedConfirms.has(confirmId)) return // 已响应，忽略
    setRespondedConfirms((prev) => new Map(prev).set(confirmId, approved))
    globalThis.window.taco.agent.confirmResponse(confirmId, approved)
  }

  /** 用户对可恢复错误的重试响应（防重复点击） */
  function handleRetryResponse(retryId: string, shouldRetry: boolean) {
    if (respondedRetries.has(retryId)) return // 已响应，忽略
    setRespondedRetries((prev) => new Map(prev).set(retryId, shouldRetry))
    globalThis.window.taco.agent.retryResponse(retryId, shouldRetry)
  }

  /** 解析工具参数 JSON */
  function parseArgs(argsStr: string): Record<string, unknown> {
    try { return JSON.parse(argsStr) } catch { return {} }
  }

  function maskSensitiveText(text: string): string {
    let masked = text
    const keyValuePattern = /((?:token|access_token|api[_-]?key|authorization|bearer|password|passwd|pwd|secret)\s*[:=]\s*)([^\s'"]+)/ig
    masked = masked.replace(keyValuePattern, (_m, prefix: string) => `${prefix}***`)
    const bearerPattern = /(bearer\s+)([a-z0-9._\-]+)/ig
    masked = masked.replace(bearerPattern, (_m, prefix: string) => `${prefix}***`)
    return masked
  }

  function summarizeRunCommand(command: string): string {
    const masked = maskSensitiveText(command.trim())
    if (!masked) return ''

    const curlMatch = masked.match(/\bcurl\b[\s\S]*?(?:-X\s+([A-Z]+))?[\s\S]*?(https?:\/\/[^\s'"]+)/i)
    if (curlMatch) {
      const method = (curlMatch[1] || 'GET').toUpperCase()
      const urlText = curlMatch[2]
      try {
        const u = new URL(urlText)
        return `请求接口 ${method} ${u.pathname}`
      } catch {
        return `请求接口 ${method} ${urlText}`
      }
    }

    if (/npm\s+run\s+dev/i.test(masked)) return '启动前端开发服务'
    if (/npm\s+(run\s+)?build/i.test(masked)) return '构建项目'
    if (/go\s+test|npm\s+test|pnpm\s+test|yarn\s+test/i.test(masked)) return '执行测试'

    return masked.length > 60 ? `${masked.slice(0, 57)}...` : masked
  }

  /** 生成每个工具调用的富摘要 + 可悬停路径 */
  function toolCallSummary(tc: { name: string; arguments: string }): { label: string; detail: string; filePath?: string } {
    const args = parseArgs(tc.arguments)
    switch (tc.name) {
      case 'read_file': {
        const p = String(args.path ?? '')
        return { label: '查看文件', detail: p, filePath: p }
      }
      case 'write_file': {
        const p = String(args.path ?? '')
        return { label: '写入文件', detail: p, filePath: p }
      }
      case 'edit_file': {
        const p = String(args.path ?? '')
        return { label: '编辑文件', detail: p, filePath: p }
      }
      case 'delete_file': {
        const p = String(args.path ?? '')
        return { label: '删除文件', detail: p, filePath: p }
      }
      case 'list_dir':
      case 'list_directory': {
        const p = String(args.path ?? '.')
        return { label: '查看目录', detail: p, filePath: p }
      }
      case 'run_command': {
        const cmd = String(args.command ?? '')
        return { label: '执行命令', detail: summarizeRunCommand(cmd) }
      }
      case 'codebase_search': {
        const query = String(args.query ?? args.pattern ?? '')
        const dir = String(args.path ?? args.directory ?? '.')
        const glob = String(args.glob ?? args.filePattern ?? '').trim()
        const isRegex = Boolean(args.regex) || /[|()[\]{}.*+?\\]/.test(query)
        const compactQuery = query.length > 80 ? `${query.slice(0, 77)}...` : query
        const scope = glob ? `${dir} (${glob})` : dir
        return {
          label: isRegex ? '正则搜索' : '搜索代码',
          detail: `${compactQuery || '(空查询)'} @ ${scope}`,
        }
      }
      case 'browser_navigate': {
        const url = String(args.url ?? '')
        return { label: '浏览器操作', detail: url }
      }
      case 'browser_screenshot': {
        const goal = String(args.goal ?? '').trim()
        return { label: '浏览器操作', detail: goal ? `目标：${goal}` : '状态确认' }
      }
      case 'browser_wait': {
        const selector = String(args.selector ?? '')
        return { label: '浏览器操作', detail: selector || '等待页面加载完成' }
      }
      case 'browser_get_content': {
        const selector = String(args.selector ?? '')
        return { label: '浏览器操作', detail: selector || '读取页面主体内容' }
      }
      case 'browser_get_console_logs': {
        return { label: '浏览器操作', detail: '检查控制台日志' }
      }
      case 'browser_click': {
        const selector = String(args.selector ?? '').trim()
        const x = Number(args.x)
        const y = Number(args.y)
        const clickCount = Number(args.clickCount ?? 1)
        if (selector) {
          return { label: '浏览器操作', detail: clickCount >= 2 ? `双击 ${selector}` : `点击 ${selector}` }
        }
        if (Number.isFinite(x) && Number.isFinite(y)) {
          return { label: '浏览器操作', detail: `${clickCount >= 2 ? '双击' : '点击'} (${Math.round(x)}, ${Math.round(y)})` }
        }
        return { label: '浏览器操作', detail: clickCount >= 2 ? '双击页面' : '点击页面' }
      }
      case 'browser_type': {
        const selector = String(args.selector ?? '')
        const text = String(args.text ?? '')
        const displayText = text.length > 18 ? `${text.slice(0, 18)}...` : text
        return { label: '浏览器操作', detail: `${selector}${displayText ? ` ← ${displayText}` : ''}`.trim() }
      }
      case 'browser_scroll': {
        const direction = String(args.direction ?? 'down')
        return { label: '浏览器操作', detail: `滚动(${direction})` }
      }
      case 'browser_hover': {
        const selector = String(args.selector ?? '')
        return { label: '浏览器操作', detail: selector || '悬停指定位置' }
      }
      case 'browser_keypress': {
        const key = String(args.key ?? '')
        return { label: '浏览器操作', detail: `按键 ${key}` }
      }
      case 'browser_drag': {
        return { label: '浏览器操作', detail: '拖拽操作' }
      }
      case 'browser_select': {
        const selector = String(args.selector ?? '')
        const value = String(args.value ?? args.label ?? '')
        return { label: '浏览器操作', detail: `${selector}${value ? ` → ${value}` : ''}`.trim() }
      }
      default:
        return { label: '执行操作', detail: '' }
    }
  }

  /** 步骤折叠标题（多个工具时合并显示） */
  function stepHeaderSummary(step: AgentStep): { label: string; detail: string; filePath?: string } {
    if (step.systemTitle) {
      return { label: step.systemTitle, detail: step.systemDetail || '' }
    }
    if (step.status === 'retry_confirm') {
      const errorTypeLabels: Record<string, string> = {
        network: '网络连接异常',
        timeout: '请求超时',
        empty_response: '模型未返回有效数据',
        interrupted: '请求中断',
      }
      return {
        label: errorTypeLabels[step.retryErrorType ?? 'network'] || '可恢复错误',
        detail: '等待用户确认是否重试',
      }
    }
    if (step.toolCalls.length === 0) return { label: '思考中', detail: '...' }
    if (step.toolCalls.length === 1) {
      const tc = step.toolCalls[0]
      const base = toolCallSummary(tc)
      const result = step.toolResults.find((r) => r.tool_call_id === tc.id)
      const fc = result?.fileChange
      if (!fc) return base
      if (fc.oldContent === null && fc.newContent !== null) {
        return { ...base, label: '新建文件' }
      }
      if (fc.oldContent !== null && fc.newContent === null) {
        return { ...base, label: '删除文件' }
      }
      if (tc.name === 'edit_file') {
        return { ...base, label: '编辑文件' }
      }
      if (tc.name === 'write_file') {
        return { ...base, label: '覆盖文件' }
      }
      return base
    }
    // 多工具：显示数量
    const names = [...new Set(step.toolCalls.map((tc) => toolCallSummary(tc).label))]
    return { label: names.join(' + '), detail: `(${step.toolCalls.length} 个操作)` }
  }

  /** 步骤总卡片标题：显示当前（或最近）正在执行的操作 */
  function stepGroupOperationSummary(steps: AgentStep[]): string {
    if (steps.length === 0) return '暂无操作'
    const active = [...steps].reverse().find((s) =>
      s.status === 'running' || s.status === 'calling' || s.status === 'confirm' || s.status === 'retry_confirm'
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
    const normalizedPath = filePath.replace(/[\\/]+/g, '/').replace(/^\.\//, '')
    const normalizedWorkspace = workspace.replace(/[\\/]+/g, '/').replace(/\/+$/, '')
    let relativePath: string | null = null

    if (/^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith('\\\\') || filePath.startsWith('/')) {
      const lowerPath = normalizedPath.toLowerCase()
      const lowerWorkspace = normalizedWorkspace.toLowerCase()
      if (lowerPath === lowerWorkspace) {
        relativePath = ''
      } else if (lowerPath.startsWith(`${lowerWorkspace}/`)) {
        relativePath = normalizedPath.slice(normalizedWorkspace.length + 1)
      }
    } else if (normalizedPath && !normalizedPath.startsWith('../') && normalizedPath !== '..') {
      relativePath = normalizedPath
    }

    if (relativePath && onOpenFileView) {
      onOpenFileView(relativePath, false)
      return
    }

    // 非项目内路径兜底：仍允许外部编辑器打开
    const fullPath = filePath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith('\\\\')
      ? filePath
      : (workspace ? `${workspace}/${filePath}` : filePath)
    globalThis.window.taco.shell.openInEditor(fullPath, editor).catch(() => {
      // 静默失败，不影响 UI
    })
  }

  function startEdit(msg: ChatMsg) {
    if (sending) return
    setEditingMsgId(msg.id)
    
    // 初始化编辑时的附件：从 msg.attachments 或从 content 中解析 [FILE] 标签
    if (msg.attachments && msg.attachments.length > 0) {
      setEditingAttachments([...msg.attachments])
    } else {
      // 尝试从 content 中解析 [FILE] 标签
      const fileRegex = /\[FILE\]([^\[]+)\[\/FILE\]/g
      const attachments: AttachedAsset[] = []
      let match
      let idx = 0
      while ((match = fileRegex.exec(msg.content)) !== null) {
        const filePath = match[1]
        const fileName = filePath.split('/').pop() || filePath
        attachments.push({
          id: `edit-file-${idx++}`,
          path: filePath,
          name: fileName,
        })
      }
      setEditingAttachments(attachments)
    }
    
    setEditingText(msg.content)
    
    // 延迟填充 contentEditable 内容（确保 DOM 已渲染）
    setTimeout(() => {
      const div = editingInputDivRef.current
      if (!div) return
      
      // 清空并填充内容
      div.innerHTML = ''
      
      // 解析 content，将 [FILE] 标签转换为卡片，普通文本直接插入
      const content = msg.content
      const fileRegex2 = /\[FILE\]([^\[]+)\[\/FILE\]/g
      let lastIndex = 0
      let match2
      
      while ((match2 = fileRegex2.exec(content)) !== null) {
        // 添加文件标签前的文本
        if (match2.index > lastIndex) {
          const textNode = document.createTextNode(content.slice(lastIndex, match2.index))
          div.appendChild(textNode)
        }
        
        // 插入文件卡片
        const filePath = match2[1]
        const chip = document.createElement('span')
        chip.className = 'file-attachment-chip'
        chip.setAttribute('data-file-path', filePath)
        chip.contentEditable = 'false'
        chip.innerHTML = `📄 ${toAssetName(filePath)} <span class="file-chip-remove">×</span>`
        
        chip.addEventListener('click', (e) => {
          const target = e.target as HTMLElement
          if (target.classList.contains('file-chip-remove')) {
            chip.remove()
            setEditingAttachments(prev => prev.filter(a => a.path !== filePath))
            updateEditingTextFromDiv()
          }
        })
        
        div.appendChild(chip)
        lastIndex = match2.index + match2[0].length
      }
      
      // 添加剩余文本
      if (lastIndex < content.length) {
        const textNode = document.createTextNode(content.slice(lastIndex))
        div.appendChild(textNode)
      }
      
      // 如果没有文件标签，直接设置文本
      if (!div.innerHTML) {
        div.textContent = msg.content
      }
      
      // 聚焦并移动光标到末尾
      div.focus()
      const range = document.createRange()
      const sel = window.getSelection()
      range.selectNodeContents(div)
      range.collapse(false)
      sel?.removeAllRanges()
      sel?.addRange(range)
    }, 50)
  }

  function confirmEdit(msgId: string) {
    const text = editingText.trim()
    const attachments = editingAttachments
    
    setEditingMsgId(null)
    setEditingAttachments([])
    
    if (!text && attachments.length === 0) return
    
    // 将附件信息添加到文本中
    let finalText = text
    if (attachments.length > 0) {
      const fileTags = attachments.map(a => `[FILE]${a.path}[/FILE]`).join('\n')
      finalText = text ? `${text}\n\n${fileTags}` : fileTags
    }
    
    onEditResend(msgId, finalText)
  }

  function cancelEdit() {
    setEditingMsgId(null)
    setEditingAttachments([])
  }

  const showPendingThinkingHint = sending && !showStreamBubble && !selectedFileChange && !viewingFile
  /* ---- Agent 步骤内部渲染辅助函数 ---- */

  function renderStepThinking(msg: ChatMsg, step: AgentStep, isStepRunning: boolean) {
    if (!step.thinking) return null
    const toolNames = step.toolCalls.map((tc) => tc.name)
    const cleaned = maskToolNamesForUser(
      step.thinking.replace(/<think>/gi, '').replace(/<\/think>/gi, '').trim(),
      toolNames,
    )
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
          <div className="step-thinking-body">
            <MarkdownBubble content={cleaned} workspace={workspace} onOpenProjectFile={(path) => openFile(path)} />
          </div>
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
      let plan: { summary?: string; steps?: Array<{ index?: number; title?: string; content?: string; text?: string }>; reasoning?: string } = {}
      try { plan = JSON.parse(step.risks[0].detail) } catch { /* ignore */ }
      const normalizedPlanSteps = Array.isArray(plan.steps)
        ? plan.steps.map((s) => {
            if (typeof s === 'string') return s
            if (s && typeof s === 'object') {
              return s.title || s.content || (s as { text?: string }).text || String(s)
            }
            return String(s)
          })
        : []
      return (
        <div className="agent-confirm-card plan">
          <div className="agent-confirm-title">
            <span className="agent-confirm-icon">📋</span>
            执行计划{confirmStatus === 'pending' ? ' — 需要你的确认' : ''}
          </div>
          {plan.summary && <div className="agent-plan-summary">{plan.summary}</div>}
          {normalizedPlanSteps.length > 0 && (
            <ol className="agent-plan-steps">{normalizedPlanSteps.map((s, i) => <li key={i}>{s}</li>)}</ol>
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
              <span className="agent-confirm-risk-reason">
                {maskToolNamesForUser(risk.reason, step.risks?.map((r) => r.toolName) ?? [])}
              </span>
              <pre className="agent-confirm-risk-detail">
                {maskToolNamesForUser(risk.detail, step.risks?.map((r) => r.toolName) ?? [])}
              </pre>
            </div>
          ))}
        </div>
        {renderConfirmStatusUI()}
      </div>
    )
  }

  /** 渲染重试确认 UI（网络超时、空响应等可恢复错误） */
  function renderStepRetryConfirm(step: AgentStep, isStepRunning: boolean) {
    if (!step.retryId) return null

    const responded = respondedRetries.get(step.retryId)
    const isPending = responded === undefined

    const errorTypeLabels: Record<string, string> = {
      network: '网络连接异常',
      timeout: '请求超时',
      empty_response: '模型未返回有效数据',
      interrupted: '请求中断',
    }
    const errorLabel = errorTypeLabels[step.retryErrorType ?? 'network'] || '未知错误'

    const resolveRetryStatus = (): 'pending' | 'retried' | 'cancelled' => {
      if (responded === true) return 'retried'
      if (responded === false) return 'cancelled'
      return 'pending'
    }
    const retryStatus = resolveRetryStatus()

    const renderRetryStatusUI = () => {
      if (retryStatus === 'retried') {
        return (
          <div className="agent-confirm-responded">
            {isStepRunning
              ? <span className="agent-confirm-responded-icon spinning">⏳</span>
              : <span className="agent-confirm-responded-icon">✓</span>}
            {isStepRunning ? '正在重试中...' : '已重试'}
          </div>
        )
      }
      if (retryStatus === 'cancelled') {
        return (
          <div className="agent-confirm-responded denied">
            <span className="agent-confirm-responded-icon">✗</span>
            已取消重试
          </div>
        )
      }
      return (
        <div className="agent-confirm-actions">
          <button type="button" className="agent-confirm-btn approve" onClick={() => handleRetryResponse(step.retryId!, true)}>
            重试
          </button>
          <button type="button" className="agent-confirm-btn deny" onClick={() => handleRetryResponse(step.retryId!, false)}>
            取消
          </button>
        </div>
      )
    }

    // 错误消息截取摘要
    const errorSummary = (step.retryErrorMessage || '').length > 200
      ? `${(step.retryErrorMessage || '').slice(0, 200)}...`
      : (step.retryErrorMessage || '')

    return (
      <div className="agent-confirm-card retry">
        <div className="agent-confirm-title">
          <span className="agent-confirm-icon">⚠</span>
          {retryStatus === 'pending' ? `${errorLabel} — 需要你的确认` : errorLabel}
        </div>
        <div className="agent-confirm-risks">
          <div className="agent-confirm-risk warning">
            <span className="agent-confirm-risk-badge">错误</span>
            <span className="agent-confirm-risk-reason">{errorLabel}</span>
            {errorSummary && (
              <pre className="agent-confirm-risk-detail">{errorSummary}</pre>
            )}
          </div>
        </div>
        {retryStatus === 'pending' && (
          <div className="agent-retry-hint" style={{ fontSize: '12px', color: 'var(--text-secondary, #888)', marginTop: '8px', lineHeight: '1.5' }}>
            任务遇到可恢复的错误，是否重新发起请求？选择"重试"将继续当前任务，选择"取消"将终止任务。
          </div>
        )}
        {renderRetryStatusUI()}
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
          {step.toolCalls.map((tc, index) => {
            const sm = toolCallSummary(tc)
            const result = step.toolResults.find((r) => r.tool_call_id === tc.id)
            const tbKey = `${msg.id}-${step.round}-${tc.id}`
            const isToolRunning = !result && isStepRunning
            const isToolBlockOpen = isToolRunning || expandedToolBlocks.has(tbKey)
            const actionLabel = sm.label && sm.label.trim() ? sm.label : '执行操作'
            const actionDetail = sm.detail && sm.detail.trim() ? sm.detail : '无附加信息'
            return (
              <div key={tc.id} className={`agent-tool-block ${isToolRunning ? 'running' : ''}`}>
                <div className="agent-tool-block-header">
                  <button type="button" className="agent-tool-block-toggle" onClick={() => toggleToolBlock(tbKey)}>
                    <span className="agent-tool-block-label">{actionLabel}</span>
                    <span className="agent-tool-block-seq">{index + 1}/{step.toolCalls.length}</span>
                  </button>
                  <span className="agent-tool-block-path" onClick={() => toggleToolBlock(tbKey)}>
                    {sm.filePath ? (
                      <span className="agent-step-path-link" title="点击预览打开" onClick={(e) => { e.stopPropagation(); openFile(sm.filePath!) }}>{actionDetail}</span>
                    ) : actionDetail}
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
    <main className="main-panel" style={{ width: '100%', minWidth: 0, alignSelf: 'stretch' }}>
      {/* 会话标签页 */}
      {sessions.length > 1 && (
        <div className="session-tabs">
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`session-tab ${s.id === activeSessionId ? 'active' : ''} ${(isSessionSending?.(s.id) ?? false) ? 'sending' : ''}`}
              onClick={() => onSwitchSession(s.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter') onSwitchSession(s.id) }}
            >
              {(isSessionSending?.(s.id) ?? false) && (
                <span className="session-tab-status" title="执行中" />
              )}
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
            onSaved={(change) => {
              onFileSaved?.()
              if (change && onFileEdited) {
                onFileEdited({
                  filePath: change.filePath,
                  oldContent: change.oldContent,
                  newContent: change.newContent,
                })
              }
            }}
            onViewDiff={onViewDiffFromEditor}
            onNavigateToFile={(nextFilePath, line, column) => {
              onOpenFileView?.(nextFilePath, false, { line, column })
            }}
            initialSelection={viewingSelection ?? null}
          />
        </section>
      )}

      {/* Conversation */}
      <section
        className={`conversation ${showTerminal && !selectedFileChange && !viewingFile ? 'with-terminal' : ''}`}
        ref={scrollRef}
        style={selectedFileChange || viewingFile ? { display: 'none' } : undefined}
      >
        {totalHistoryCount === 0 && !showStreamBubble && (
          <div className="empty-state">
            <div className="empty-title">Taco AI</div>
            <div className="empty-sub">
              {!hasProviders
                ? '请先在 Settings 中配置至少一个模型的 API Key'
                : !workspace
                  ? '请先选择一个工作空间目录，作为 Agent 可操作的安全空间'
                  : '发送一条消息开始对话'}
            </div>
            {!workspace && hasProviders && (
              <button
                type="button"
                className="workspace-select-btn"
                onClick={onSelectWorkspace}
              >
                <svg className="workspace-select-btn-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M3.5 8.5A2.5 2.5 0 0 1 6 6h4l2 2h6A2.5 2.5 0 0 1 20.5 10.5v7A2.5 2.5 0 0 1 18 20H6a2.5 2.5 0 0 1-2.5-2.5z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
                </svg>
                <span>选择工作空间</span>
              </button>
            )}
          </div>
        )}

        <div className="chat-thread">
          {hasHiddenHistory && (
            <div className="chat-history-loader">
              <button
                type="button"
                className="chat-history-loader-btn"
                onClick={loadOlderMessages}
                disabled={Boolean(loadingOlderMessages)}
              >
                {loadingOlderMessages ? '加载中...' : '加载更早消息'}
              </button>
              <div className="chat-history-loader-note">
                当前显示最近 {visibleMessages.length} / {totalHistoryCount} 条
              </div>
            </div>
          )}
          {visibleMessages.map((msg) => {
            const isEditing = editingMsgId === msg.id
            const isExecutingAssistant = Boolean(
              sending &&
              msg.role === 'assistant' &&
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
              <div key={msg.id} className={`chat-row ${msg.role}`}>
                {msg.role === 'assistant' ? (
                  <div className="bubble">
                    {taskTimingLabel && <div className="assistant-task-meta">{taskTimingLabel}</div>}
                    {/* Agent 步骤 + PlanTracker 插入在计划确认和执行步骤之间 */}
                    {msg.agentSteps && msg.agentSteps.length > 0 && (() => {
                      const stepCount = msg.agentSteps.length
                      const activeCount = msg.agentSteps.filter((s) => s.status === 'running' || s.status === 'calling' || s.status === 'confirm' || s.status === 'retry_confirm').length
                      const doneCount = msg.agentSteps.filter((s) => s.status === 'done').length
                      const failedCount = msg.agentSteps.filter((s) => s.status === 'done' && s.toolResults.some((r) => !r.success)).length
                      const hasActiveSteps = activeCount > 0
                      const isMessageExecuting = Boolean(sending && lastAssistantMessageId && msg.id === lastAssistantMessageId)
                      const defaultExpanded = hasActiveSteps || stepCount <= 4
                      const hasExplicitExpanded = Object.prototype.hasOwnProperty.call(stepGroupExpandedMap, msg.id)
                      const isStepsExpanded = isMessageExecuting
                        ? true
                        : (hasExplicitExpanded ? stepGroupExpandedMap[msg.id] : defaultExpanded)
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
                              <div className="agent-step-body">
                                {renderStepThinking(msg, step, isStepRunning)}
                                {renderStepConfirm(msg, step, isStepRunning, isStepConfirm)}
                                {renderStepRetryConfirm(step, isStepRunning)}
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
                    {/* 最终回复文本（隐藏内部过程摘要与工具名） */}
                    {(() => {
                      const toolNames = msg.agentSteps?.flatMap((s) => s.toolCalls.map((tc) => tc.name)) ?? []
                      const visibleContent = sanitizeAssistantContentForDisplay(msg.content, toolNames)
                      return visibleContent ? (
                        <MarkdownBubble
                          content={visibleContent}
                          workspace={workspace}
                          onOpenProjectFile={(path) => openFile(path)}
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
                ) : isEditing ? (
                  <div className="bubble editing">
                    {/* 附件显示区 */}
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
                                // 从编辑框中移除对应的 chip
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
                    {/* contentEditable 编辑框 */}
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
                          confirmEdit(msg.id)
                        }
                        if (e.key === 'Escape') cancelEdit()
                      }}
                      style={{
                        width: '100%',
                        minWidth: '100%',
                        minHeight: '2.5em',
                        maxHeight: '12em',
                        overflowY: 'auto',
                      }}
                    />
                    {/* 添加附件按钮 */}
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
                              // 在编辑框中插入卡片
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
                ) : (
                  <>
                    <div className="bubble">
                      {msg.images && msg.images.length > 0 && (
                        <div className="msg-images">
                          {msg.images.map((img) => {
                            // 优先使用 dataUrl（本地预览），回退到 cloudUrl（云端URL）
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
                      {(() => {
                        // 解析 content，提取 [FILE]...[/FILE] 标签并渲染为附件卡片
                        const content = msg.content
                        const fileRegex = /\[FILE\]([^\[]+)\[\/FILE\]/g
                        const parts: Array<{ type: 'text' | 'file'; content: string; path?: string }> = []
                        let lastIndex = 0
                        let match
                        
                        while ((match = fileRegex.exec(content)) !== null) {
                          // 添加文件标签前的文本
                          if (match.index > lastIndex) {
                            parts.push({ type: 'text', content: content.slice(lastIndex, match.index) })
                          }
                          // 添加文件标签
                          parts.push({ type: 'file', content: match[1], path: match[1] })
                          lastIndex = match.index + match[0].length
                        }
                        
                        // 添加剩余文本
                        if (lastIndex < content.length) {
                          parts.push({ type: 'text', content: content.slice(lastIndex) })
                        }
                        
                        // 如果没有匹配到任何文件标签，直接渲染原文本
                        if (parts.length === 0) {
                          parts.push({ type: 'text', content })
                        }
                        
                        return (
                          <>
                            {/* 渲染提取出的文件附件卡片 */}
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
                            {/* 渲染文本内容（移除文件标签） */}
                            {parts.filter(p => p.type === 'text').map((part, i) => {
                              if (!part.content.trim()) return null
                              return part.content.split('\n').map((line, j) => (
                                <p key={`text-${i}-${j}`}>{line}</p>
                              ))
                            })}
                          </>
                        )
                      })()}
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
                {activeTaskStartedAt && (
                  <div className="assistant-task-meta">
                    {formatTaskTimingLabel({ startedAt: activeTaskStartedAt }, nowTs)}
                  </div>
                )}
                {streamingContent ? (
                  <MarkdownBubble
                    content={streamingContent}
                    streaming
                    workspace={workspace}
                    onOpenProjectFile={(path) => openFile(path)}
                  />
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
                  {/* 上传进度覆盖层 */}
                  {img.uploadStatus === 'uploading' && (
                    <div className="composer-image-upload-overlay">
                      <div className="composer-image-progress-bar" style={{ width: `${img.uploadProgress || 0}%` }} />
                      <span className="composer-image-progress-text">{img.uploadProgress || 0}%</span>
                    </div>
                  )}
                  {/* 上传失败覆盖层 */}
                  {img.uploadStatus === 'error' && (
                    <div className="composer-image-error-overlay">
                      <span>上传失败</span>
                    </div>
                  )}
                  {/* 图片缩略图 */}
                  {img.dataUrl && (
                    <img
                      src={img.dataUrl}
                      alt={img.name}
                      className="composer-image-thumb"
                      title="点击预览"
                      onClick={() => img.uploadStatus === 'done' && setPreviewImageUrl(img.dataUrl)}
                      style={{ opacity: img.uploadStatus === 'uploading' ? 0.5 : 1 }}
                    />
                  )}
                  <button
                    type="button"
                    className="composer-image-remove"
                    onClick={(e) => {
                      e.stopPropagation()
                      removeImage(img.id)
                    }}
                    title="移除图片"
                  >×</button>
                </div>
              ))}
            </div>
          )}
          <div
            ref={inputDivRef}
            className="composer-input"
            contentEditable
            suppressContentEditableWarning
            data-placeholder={
              !hasProviders
                ? t('input.no_provider')
                : !workspace
                  ? t('input.placeholder.no_workspace')
                  : sending
                    ? t('input.placeholder.sending')
                    : t('input.placeholder.default')
            }
            onInput={(e) => {
              const target = e.currentTarget
              // 提取纯文本，过滤掉附件卡片
              let text = ''
              for (const node of target.childNodes) {
                if (node.nodeType === Node.TEXT_NODE) {
                  text += node.textContent
                } else if (node.nodeType === Node.ELEMENT_NODE) {
                  const el = node as Element
                  if (el.classList.contains('file-attachment-chip')) {
                    // 保留 FILE 标签
                    const path = el.getAttribute('data-file-path')
                    if (path) {
                      text += `[FILE]${path}[/FILE]`
                    }
                  } else {
                    text += el.textContent
                  }
                }
              }
              onDraftChange(text)
            }}
            onPaste={handlePaste}
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
            placeholder="选择图片"
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: 'none' }}
            onChange={handleFileSelect}
          />
          <div className="composer-row">
            <div className="composer-left">
              {/* 统一添加文件按钮：智能识别图片/附件 */}
              <button
                type="button"
                className="composer-attach-btn"
                onClick={() => handleAddFiles()}
                title={supportsVision ? t('input.attach_file') : '添加附件'}
                disabled={!hasProviders || !workspace}
              >
                <svg className="composer-btn-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M8.8 12.7l5.7-5.8a3.2 3.2 0 014.6 4.6l-7.2 7.2a5.1 5.1 0 01-7.2-7.2L12 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
                <ProviderSelect
                  value={provider}
                  options={configuredProviders}
                  onChange={onProviderChange}
                  disabled={!hasProviders}
                  placeholder={t('input.no_provider')}
                />
            </div>
            <div className="composer-right">
              {sending ? (
                <button
                  className="send-btn stop"
                  type="button"
                  onClick={onStop}
                  title={t('input.stop')}
                >
                  <span className="stop-icon" />
                </button>
              ) : (
                <button
                  title={t('input.send')}
                  className="send-btn"
                  type="button"
                  onClick={handleSend}
                  disabled={!hasProviders || !workspace}
                >
                  <svg className="send-btn-icon" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 19V5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    <path d="M6.8 10.2L12 5l5.2 5.2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </div>
      </footer>
      
      {/* 底部控制栏：语言切换 + 项目目录 + 版本号 */}
      <div className="composer-bottom-bar">
        <div className="composer-bottom-left">
          {/* 语言切换下拉框 */}
          <select
            className="bottom-bar-select"
            value={language}
            onChange={(e) => {
              const newLang = e.target.value as 'zh-CN' | 'en-US'
              if (newLang !== language) {
                toggleLanguage()
              }
            }}
            aria-label="切换语言"
          >
            <option value="zh-CN">中文</option>
            <option value="en-US">English</option>
          </select>
          
          {/* 项目目录 - 可点击 */}
          <div className="bottom-bar-item workspace-item" onClick={onSelectWorkspace} title={workspace ? `工作空间: ${workspace}` : '选择工作空间'}>
            <svg className="workspace-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M3.5 8.5A2.5 2.5 0 0 1 6 6h4l2 2h6A2.5 2.5 0 0 1 20.5 10.5v7A2.5 2.5 0 0 1 18 20H6a2.5 2.5 0 0 1-2.5-2.5z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
            </svg>
            <span>{workspace ? workspace.split('/').pop() || workspace : '选择工作空间'}</span>
          </div>
        </div>
              
        {/* 版本号 - 右侧 */}
        <div className="composer-bottom-right">
          <span className="composer-footer-version">v{window.taco.version}</span>
        </div>
      </div>
    </main>
  )
}
