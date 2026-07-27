import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentStep, AttachedAsset, AttachedImage, ChatMsg, FileChangeInfo, FileChangeStatus, QueuedMessage, Session } from '../../types'
import type { ProjectTokenStats, RunTokenStats } from '../../hooks/useChat'
import type { EditorId } from '../../../shared/ipc'
import { DiffView } from '../DiffView'
import { MarkdownBubble } from './MarkdownBubble'
import { useLanguage } from '../../hooks/useLanguage'
import { useVoiceInput } from '../../hooks/useVoiceInput'
import { stripMarkdown } from '../../hooks/useTts'
import { INITIAL_VISIBLE_MESSAGE_COUNT, LOAD_MORE_MESSAGE_BATCH, LOAD_MORE_SCROLL_THRESHOLD_PX, formatTaskTimingLabel } from './PlanTracker'
import { MessageBubble } from './MessageBubble'
import { InputArea } from './InputArea'
import { BottomBar } from './BottomBar'

/* ------------------------------------------------------------------ */
/*  ChatPanel — 聊天主面板（编排所有子组件）                             */
/* ------------------------------------------------------------------ */

type ChatPanelProps = {
  messages: ChatMsg[]
  showStreamBubble: boolean
  streamingContent: string
  activeTaskStartedAt?: number
  draft: string
  onDraftChange: (value: string) => void
  attachedImages: AttachedImage[]
  onAttachedImagesChange: (value: AttachedImage[] | ((prev: AttachedImage[]) => AttachedImage[])) => void
  attachedAssets: AttachedAsset[]
  onAttachedAssetsChange: (value: AttachedAsset[] | ((prev: AttachedAsset[]) => AttachedAsset[])) => void
  sending: boolean
  onSend: (content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } } | { type: 'video_url'; video_url: { url: string } } | { type: 'audio_url'; audio_url: { url: string } }>) => void
  onStop: () => void
  onSwitchSession: (sessionId: string) => void
  onDeleteSession: (sessionId: string) => void
  sessions: Session[]
  activeSessionId: string
  onResend: (msgId: string) => void
  onEditResend: (msgId: string, newContent: string) => void
  workspace: string
  onSelectWorkspace: (defaultPath?: string) => void
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
  isSessionSending?: (sessionId: string) => boolean
  selectedFileChange: FileChangeInfo | null
  onCloseDiff: () => void
  showTerminal: boolean
  onToggleTerminal: () => void
  selectedFileStatus?: FileChangeStatus
  onAcceptFile?: (filePath: string) => void
  onRejectFile?: (filePath: string) => void
  onRollbackBeforeMsg?: (commitHash: string) => Promise<void>
  contextPercent: number
  projectTokenStats?: ProjectTokenStats
  runTokenStats?: RunTokenStats
  supportsVision?: boolean
  projectId?: string
  onOpenFileView?: (filePath: string, forceDiff?: boolean, selection?: { line: number; column: number } | null) => void
  /** 在内置 webview 中打开链接 */
  onOpenWebview?: (url: string) => void
  onOpenModels?: () => void
  activeConfirmIds: Set<string>
  activeRetryIds: Set<string>
}

export function ChatPanel({
  messages,
  showStreamBubble,
  streamingContent,
  activeTaskStartedAt,
  draft,
  onDraftChange,
  attachedImages,
  onAttachedImagesChange,
  attachedAssets,
  onAttachedAssetsChange,
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
  selectedFileStatus,
  onAcceptFile,
  onRejectFile,
  onRollbackBeforeMsg,
  contextPercent,
  supportsVision,
  onOpenFileView,
  onOpenWebview,
  projectTokenStats,
  runTokenStats,
  projectId,
  onOpenModels,
  activeConfirmIds,
  activeRetryIds,
}: Readonly<ChatPanelProps>) {
  const hasProviders = (configuredProviders ?? []).length > 0
  const isNearBottomRef = useRef<boolean>(true)
  const lastScrollHeightRef = useRef<number>(0)
  const BOTTOM_THRESHOLD = 240
  const [visibleMessageCount, setVisibleMessageCount] = useState(() => Math.min((messages ?? []).length, INITIAL_VISIBLE_MESSAGE_COUNT))
  const prependAnchorRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null)
  const prevSessionIdRef = useRef<string | null>(activeSessionId ?? null)
  const attachedImagesRef = useRef<AttachedImage[]>(attachedImages)
  attachedImagesRef.current = attachedImages
  const onDraftChangeRef = useRef(onDraftChange)
  onDraftChangeRef.current = onDraftChange

  const { language, toggleLanguage, t, isZhCN } = useLanguage()

  // ── 语音输入 ──
  const handleVoiceTextReady = useCallback((text: string) => {
    const div = inputDivRef.current
    if (!div) return
    const selection = window.getSelection()
    if (selection && selection.rangeCount > 0 && div.contains(selection.anchorNode)) {
      const range = selection.getRangeAt(0)
      range.deleteContents()
      range.insertNode(document.createTextNode(text))
      range.collapse(false)
      selection.removeAllRanges()
      selection.addRange(range)
    } else {
      div.appendChild(document.createTextNode(text))
    }
    div.focus()
    const draftText = extractDivText(div)
    onDraftChangeRef.current(draftText)
  }, [])

  const { isRecording, elapsedSeconds, toggleRecording } = useVoiceInput({ onTextReady: handleVoiceTextReady })

  // ── 语音朗读（自动 TTS 队列）──
  // 朗读状态（控制 AI Voice Avatar 显隐）
  const [isSpeaking, setIsSpeaking] = useState(false)
  // TTS 改写进行中（改写完成前保持发送按钮禁用）
  const [isTtsRewriting, setIsTtsRewriting] = useState(false)

  // ── TTS 队列系统 ──
  const ttsQueueRef = useRef<string[]>([])
  const ttsPlayingRef = useRef(false)

  /** 构建 SpeechSynthesisUtterance（共用配置） */
  const buildUtterance = useCallback((text: string) => {
    const u = new SpeechSynthesisUtterance(text)
    u.rate = parseFloat(localStorage.getItem('taco-tts-rate') || '1.0')
    u.pitch = parseFloat(localStorage.getItem('taco-tts-pitch') || '1.0')
    u.volume = 1.0
    const voiceUri = localStorage.getItem('taco-tts-voice') || ''
    const voices = window.speechSynthesis.getVoices()
    if (voiceUri) {
      const v = voices.find(vo => vo.voiceURI === voiceUri)
      if (v) u.voice = v
    } else if (/[\u4e00-\u9fff]/.test(text)) {
      const zh = voices.find(vo => vo.lang.startsWith('zh') || vo.name.includes('Tingting'))
      if (zh) u.voice = zh
    }
    return u
  }, [])

  /** 播放队列中下一条 */
  const playNextInQueue = useCallback(() => {
    if (ttsPlayingRef.current || ttsQueueRef.current.length === 0 || !('speechSynthesis' in window)) {
      console.log('[TTS] playNextInQueue skipped', { playing: ttsPlayingRef.current, qLen: ttsQueueRef.current.length, hasApi: 'speechSynthesis' in window })
      return
    }
    const text = ttsQueueRef.current.shift()!
    if (!text.trim()) { playNextInQueue(); return }
    ttsPlayingRef.current = true
    setIsSpeaking(true)
    console.log('[TTS] setIsSpeaking(true), text length=', text.length)
    const u = buildUtterance(text)
    u.onstart = () => { console.log('[TTS] utterance.onstart fired') }
    u.onend = () => { console.log('[TTS] utterance.onend fired, qLen=', ttsQueueRef.current.length); ttsPlayingRef.current = false; ttsQueueRef.current.length > 0 ? playNextInQueue() : setTimeout(() => setIsSpeaking(false), 600) }
    u.onerror = (e) => { console.log('[TTS] utterance.onerror fired', e.error); ttsPlayingRef.current = false; ttsQueueRef.current.length > 0 ? playNextInQueue() : setTimeout(() => setIsSpeaking(false), 600) }
    window.speechSynthesis.speak(u)
  }, [buildUtterance])

  // ── 切换项目时停止 TTS ──
  useEffect(() => {
    window.speechSynthesis?.cancel()
    ttsQueueRef.current = []
    ttsPlayingRef.current = false
    setIsSpeaking(false)
  }, [projectId])

  // ── 发送状态变更 → 控制 TTS ──
  // 使用 useLayoutEffect（而非 useEffect）确保 isTtsRewriting 在浏览器绘制前更新，
  // 从而与 InputArea 的 sending || isTtsRewriting 配合，避免按钮在 TTS 改写完成前恢复。
  const prevSendingRef = useRef(false)
  useLayoutEffect(() => {
    const was = prevSendingRef.current
    prevSendingRef.current = sending

    if (sending && !was) {
      // 发送开始 → 停止旧朗读、清空队列
      window.speechSynthesis?.cancel()
      ttsQueueRef.current = []
      ttsPlayingRef.current = false
      setIsSpeaking(false)
      return
    }

    // 仅当 sending 从 true 变为 false（刚完成回复）才朗读，不会在组件挂载时误触发
    if (!sending && was) {
      if (localStorage.getItem('taco-tts-auto') !== '1') return
      window.speechSynthesis?.cancel()
      ttsQueueRef.current = []
      ttsPlayingRef.current = false
      const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant')
      if (lastAssistant?.content?.trim()) {
        let clean = stripMarkdown(lastAssistant.content)
        if (clean) {
          const rewriteEnabled = localStorage.getItem('taco-tts-rewrite-enabled') === '1'
          const rewriteModelId = localStorage.getItem('taco-tts-rewrite-model') || ''
          if (rewriteEnabled && rewriteModelId && clean.length > 10) {
            // AI 智能润色：改写完成前保持发送按钮禁用
            setIsTtsRewriting(true)
            window.taco.tts.rewriteText(clean, rewriteModelId).then(rewritten => {
              if (rewritten?.trim()) {
                ttsQueueRef.current.push(rewritten.trim())
              } else {
                ttsQueueRef.current.push(clean)
              }
              setIsTtsRewriting(false)
              setTimeout(() => playNextInQueue(), 100)
            }).catch(err => {
              console.warn('[TTS] AI rewrite failed, using original text:', err)
              ttsQueueRef.current.push(clean)
              setIsTtsRewriting(false)
              setTimeout(() => playNextInQueue(), 100)
            })
          } else {
            ttsQueueRef.current.push(clean)
            setTimeout(() => playNextInQueue(), 100)
          }
        }
      }
    }
  }, [sending])

  // ── 授权级别 ──
  const [authLevel, setAuthLevel] = useState<'auto' | 'standard'>(() => {
    if (projectId) {
      const stored = localStorage.getItem(`taco-auth-level:${projectId}`)
      if (stored === 'auto') return stored
    }
    return 'standard'
  })

  const handleAuthLevelChange = useCallback((level: 'auto' | 'standard') => {
    setAuthLevel(level)
    if (projectId) {
      localStorage.setItem(`taco-auth-level:${projectId}`, level)
      window.taco.agent.setAuthLevel(level, projectId)
    }
  }, [projectId])

  useEffect(() => {
    if (!projectId) return
    const unsubscribe = window.taco.bridge.onAuthLevelChanged(({ level, projectId: changedProjectId }) => {
      if (level !== 'auto' && level !== 'standard') return
      if (changedProjectId !== projectId) return
      setAuthLevel(level)
      localStorage.setItem(`taco-auth-level:${projectId}`, level)
    })
    return unsubscribe
  }, [projectId])

  useEffect(() => {
    if (!projectId) return
    const unsubscribe = window.taco.bridge.onAutoCommitChanged(({ enabled, projectId: changedProjectId }) => {
      if (changedProjectId !== projectId) return
      setAutoCommit(enabled)
    })
    return unsubscribe
  }, [projectId])

  useEffect(() => {
    if (!projectId) { setAuthLevel('standard'); return }
    const stored = localStorage.getItem(`taco-auth-level:${projectId}`)
    if (stored === 'auto') setAuthLevel('auto')
    else setAuthLevel('standard')
  }, [projectId])

  const [authDropdownOpen, setAuthDropdownOpen] = useState(false)
  const authDropdownRef = useRef<HTMLDivElement>(null!)
  const [autoCommit, setAutoCommit] = useState(false)

  useEffect(() => {
    if (!projectId) { setAutoCommit(false); return }
    window.taco.agent.getAutoCommit(projectId).then((enabled) => {
      setAutoCommit(enabled)
    }).catch(() => setAutoCommit(false))
  }, [projectId])

  const handleAutoCommitToggle = useCallback(() => {
    const next = !autoCommit
    setAutoCommit(next)
    if (projectId) { window.taco.agent.setAutoCommit(next, projectId) }
  }, [autoCommit, projectId])

  const fileInputRef = useRef<HTMLInputElement>(null!)
  const inputDivRef = useRef<HTMLDivElement>(null!)

  /* ------------------------------------------------------------------ */
  /*  文件 / 图片处理辅助函数                                             */
  /* ------------------------------------------------------------------ */

  function toAssetName(filePath: string): string {
    const normalized = String(filePath ?? '').replace(/\\/g, '/')
    const parts = normalized.split('/').filter(Boolean)
    return parts[parts.length - 1] || normalized
  }

  function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }

  async function addImages(files: File[]) {
    const MAX_IMAGES = 5
    const MAX_SIZE = 10 * 1024 * 1024
    const validFiles = files.filter((f) => f.type.startsWith('image/') && f.size <= MAX_SIZE)
    if (validFiles.length === 0) return
    for (const file of validFiles) {
      if (attachedImages.length >= MAX_IMAGES) break
      const id = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const placeholder: AttachedImage = { id, dataUrl: '', cloudUrl: '', name: file.name, uploadStatus: 'pending', uploadProgress: 0 }
      onAttachedImagesChange((prev) => [...prev, placeholder].slice(0, MAX_IMAGES))
      uploadImage(file, id)
    }
  }

  async function uploadImage(file: File, id: string) {
    try {
      onAttachedImagesChange((prev) => prev.map(img => img.id === id ? { ...img, uploadStatus: 'uploading', uploadProgress: 10 } : img))
      const dataUrl = await readFileAsDataUrl(file)
      onAttachedImagesChange((prev) => prev.map(img => img.id === id ? { ...img, dataUrl, uploadProgress: 30 } : img))
      const result = await window.taco.image.upload(dataUrl, file.name)
      if (!result?.publicUrl) throw new Error('上传返回的 URL 为空')
      onAttachedImagesChange((prev) => prev.map(img => img.id === id ? { ...img, cloudUrl: result.publicUrl, uploadStatus: 'done', uploadProgress: 100 } : img))
    } catch (err) {
      console.error('图片上传失败:', err)
      onAttachedImagesChange((prev) => prev.map(img => img.id === id ? { ...img, uploadStatus: 'error', uploadProgress: 0 } : img))
    }
  }

  function removeImage(id: string) {
    onAttachedImagesChange((prev) => prev.filter((img) => img.id !== id))
  }

  /* ------------------------------------------------------------------ */
  /*  contentEditable 附件 / 文本提取                                     */
  /* ------------------------------------------------------------------ */

  function extractDivText(div: HTMLDivElement): string {
    let text = ''
    for (const node of div.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) text += node.textContent || ''
      else if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as Element
        if (el.classList.contains('file-attachment-chip')) {
          const path = el.getAttribute('data-file-path')
          if (path) text += `[FILE]${path}[/FILE]`
        } else text += el.textContent || ''
      }
    }
    return text
  }

  function updateDraftFromDiv() {
    const div = inputDivRef.current
    if (!div) return
    onDraftChange(extractDivText(div))
  }

  function insertFileChip(path: string) {
    const div = inputDivRef.current
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
        onAttachedAssetsChange(prev => prev.filter(a => a.path !== path))
        updateDraftFromDiv()
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
    } else div.appendChild(chip)
    div.focus()
    updateDraftFromDiv()
  }

  function renderDraftToDiv(div: HTMLDivElement, draftText: string) {
    div.innerHTML = ''
    const fileRegex = /\[FILE\]([^\[]+)\[\/FILE\]/g
    let lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = fileRegex.exec(draftText)) !== null) {
      if (match.index > lastIndex) div.appendChild(document.createTextNode(draftText.slice(lastIndex, match.index)))
      const filePath = match[1]
      const chip = document.createElement('span')
      chip.className = 'file-attachment-chip'
      chip.setAttribute('data-file-path', filePath)
      chip.contentEditable = 'false'
      chip.innerHTML = `📄 ${toAssetName(filePath)} <span class="file-chip-remove">×</span>`
      chip.addEventListener('click', (e) => {
        const target = e.target as HTMLElement
        if (target.classList.contains('file-chip-remove')) {
          chip.remove()
          onAttachedAssetsChange((prev) => prev.filter((a) => a.path !== filePath))
          updateDraftFromDiv()
        }
      })
      div.appendChild(chip)
      lastIndex = match.index + match[0].length
    }
    if (lastIndex < draftText.length) div.appendChild(document.createTextNode(draftText.slice(lastIndex)))
  }

  function handlePaste(e: React.ClipboardEvent) {
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
      if (imageFiles.length > 0) { e.preventDefault(); addImages(imageFiles); return }
    }
    const text = e.clipboardData?.getData('text/plain')
    if (text) { e.preventDefault(); document.execCommand('insertText', false, text) }
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files
    if (!files || files.length === 0) { e.target.value = ''; return }
    const imageFiles: File[] = []
    for (const file of Array.from(files)) {
      if (file.type.startsWith('image/')) imageFiles.push(file)
    }
    if (imageFiles.length > 0) addImages(imageFiles)
    e.target.value = ''
  }

  async function handleAddFiles() {
    const paths = await globalThis.window.taco.dialog.selectAttachments()
    if (!Array.isArray(paths) || paths.length === 0) return
    const imagePaths: string[] = []
    const assetPaths: string[] = []
    for (const rawPath of paths) {
      const filePath = String(rawPath ?? '').trim()
      if (!filePath) continue
      const ext = filePath.toLowerCase().split('.').pop() || ''
      const imageExts = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico'])
      if (imageExts.has(ext)) imagePaths.push(filePath)
      else assetPaths.push(filePath)
    }
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
        } catch (err) { console.error('[handleAddFiles] 读取图片失败:', err) }
      }
      if (imageFiles.length > 0) addImages(imageFiles)
    }
    if (assetPaths.length > 0) {
      for (const filePath of assetPaths) {
        insertFileChip(filePath)
        onAttachedAssetsChange((prev) => {
          const exists = prev.some(a => a.path === filePath)
          if (exists) return prev
          return [...prev, { id: `asset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name: toAssetName(filePath), path: filePath }]
        })
      }
    }
  }

  async function handleSend() {
    const hasPending = attachedImagesRef.current.some(img => img.uploadStatus === 'pending' || img.uploadStatus === 'uploading')
    if (hasPending) {
      const maxWait = 30000
      const startTime = Date.now()
      while (Date.now() - startTime < maxWait) {
        const stillPending = attachedImagesRef.current.filter(img => img.uploadStatus === 'pending' || img.uploadStatus === 'uploading')
        if (stillPending.length === 0) break
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
    const parts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } } | { type: 'video_url'; video_url: { url: string } } | { type: 'audio_url'; audio_url: { url: string } }> = []
    const textContent = draft.trim() || false
    if (textContent) parts.push({ type: 'text', text: textContent })
    const doneImages = attachedImagesRef.current.filter(img => img.uploadStatus === 'done' && img.cloudUrl)
    for (const img of doneImages) parts.push({ type: 'image_url', image_url: { url: img.cloudUrl } })
    for (const asset of attachedAssets) {
      const ext = asset.path.split('.').pop()?.toLowerCase() || ''
      const imageExts = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico'])
      const videoExts = new Set(['mp4', 'webm', 'ogg', 'mov', 'avi', 'mkv'])
      const audioExts = new Set(['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a'])
      if (imageExts.has(ext)) parts.push({ type: 'image_url', image_url: { url: asset.path } })
      else if (videoExts.has(ext)) parts.push({ type: 'video_url', video_url: { url: asset.path } })
      else if (audioExts.has(ext)) parts.push({ type: 'audio_url', audio_url: { url: asset.path } })
    }
    onAttachedImagesChange([])
    onAttachedAssetsChange([])
    onDraftChange('')
    if (inputDivRef.current) inputDivRef.current.innerHTML = ''
    onSend(parts)
  }

  /* ------------------------------------------------------------------ */
  /*  编辑模式                                                            */
  /* ------------------------------------------------------------------ */

  const [editingMsgId, setEditingMsgId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState('')
  const [editingAttachments, setEditingAttachments] = useState<AttachedAsset[]>([])
  const editingInputDivRef = useRef<HTMLDivElement>(null!)

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
    } else div.appendChild(chip)
    div.focus()
    updateEditingTextFromDiv()
  }

  function updateEditingTextFromDiv() {
    const div = editingInputDivRef.current
    if (!div) return
    let text = ''
    for (const node of div.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) text += node.textContent || ''
      else if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as Element
        if (el.classList.contains('file-attachment-chip')) {
          const path = el.getAttribute('data-file-path')
          if (path) text += `[FILE]${path}[/FILE]`
        } else text += el.textContent || ''
      }
    }
    setEditingText(text)
  }

  function startEdit(msg: ChatMsg) {
    if (sending) return
    setEditingMsgId(msg.id)
    if (msg.attachments && msg.attachments.length > 0) {
      setEditingAttachments([...msg.attachments])
    } else {
      const fileRegex = /\[FILE\]([^\[]+)\[\/FILE\]/g
      const attachments: AttachedAsset[] = []
      let match, idx = 0
      while ((match = fileRegex.exec(msg.content)) !== null) {
        const filePath = match[1]
        const fileName = filePath.split('/').pop() || filePath
        attachments.push({ id: `edit-file-${idx++}`, path: filePath, name: fileName })
      }
      setEditingAttachments(attachments)
    }
    setEditingText(msg.content)
    setTimeout(() => {
      const div = editingInputDivRef.current
      if (!div) return
      div.innerHTML = ''
      const content = msg.content
      const fileRegex2 = /\[FILE\]([^\[]+)\[\/FILE\]/g
      let lastIndex = 0, match2
      while ((match2 = fileRegex2.exec(content)) !== null) {
        if (match2.index > lastIndex) div.appendChild(document.createTextNode(content.slice(lastIndex, match2.index)))
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
      if (lastIndex < content.length) div.appendChild(document.createTextNode(content.slice(lastIndex)))
      if (!div.innerHTML) div.textContent = msg.content
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

  /* ------------------------------------------------------------------ */
  /*  确认 / 重试状态                                                     */
  /* ------------------------------------------------------------------ */

  const [respondedConfirms, setRespondedConfirms] = useState<Map<string, boolean>>(new Map())
  const [collapsedConfirms, setCollapsedConfirms] = useState<Set<string>>(new Set())
  const [respondedRetries, setRespondedRetries] = useState<Map<string, boolean>>(new Map())

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

  const [rollingBackHash, setRollingBackHash] = useState<string | null>(null)
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set())
  const [expandedToolBlocks, setExpandedToolBlocks] = useState<Set<string>>(new Set())
  const [expandedThinkBlocks, setExpandedThinkBlocks] = useState<Set<string>>(new Set())
  const [stepGroupExpandedMap, setStepGroupExpandedMap] = useState<Record<string, boolean>>({})
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

  useEffect(() => {
    if (!authDropdownOpen) return
    const handleClick = (e: MouseEvent) => {
      if (authDropdownRef.current && !authDropdownRef.current.contains(e.target as Node)) setAuthDropdownOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [authDropdownOpen])

  const totalHistoryCount = Math.max(messages.length, totalMessageCount ?? 0)
  const locallyHiddenMessageCount = Math.max(0, messages.length - visibleMessageCount)
  const hiddenMessageCount = Math.max(0, totalHistoryCount - visibleMessageCount)
  const hasHiddenHistory = locallyHiddenMessageCount > 0 || Boolean(hasOlderStoredMessages)
  const visibleMessages = locallyHiddenMessageCount > 0 ? messages.slice(-visibleMessageCount) : messages

  const pendingConfirms = useMemo(() => {
    if (!sending) return []
    const results: Array<{
      confirmId?: string; retryId?: string; isPlan: boolean; isRetry: boolean
      retryErrorType?: string; retryErrorMessage?: string
      planData?: { summary?: string; steps?: Array<{ index?: number; title?: string; content?: string; text?: string }>; reasoning?: string }
      risks?: AgentStep['risks']
    }> = []
    for (const msg of visibleMessages) {
      if (!msg.agentSteps) continue
      for (const step of msg.agentSteps) {
        if (step.status !== 'confirm' && step.status !== 'retry_confirm') continue
        if (step.status === 'retry_confirm') {
          if (!step.retryId || !activeRetryIds.has(step.retryId) || respondedRetries.has(step.retryId)) continue
          results.push({ retryId: step.retryId, isPlan: false, isRetry: true, retryErrorType: step.retryErrorType, retryErrorMessage: step.retryErrorMessage })
          continue
        }
        if (!step.confirmId || !activeConfirmIds.has(step.confirmId) || respondedConfirms.has(step.confirmId)) continue
        const isPlan = step.risks?.some((r) => r.toolName === 'propose_plan') ?? false
        let planData: { summary?: string; steps?: Array<{ index?: number; title?: string; content?: string; text?: string }>; reasoning?: string } | undefined
        if (isPlan) { try { planData = JSON.parse(step.risks![0].detail) } catch { /* ignore */ } }
        results.push({ confirmId: step.confirmId, isPlan, isRetry: false, planData, risks: step.risks })
      }
    }
    return results
  }, [visibleMessages, respondedConfirms, respondedRetries, sending, activeConfirmIds, activeRetryIds])

  const loadOlderMessages = useCallback(() => {
    if (!hasHiddenHistory) return
    const el = scrollRef.current
    if (el) { prependAnchorRef.current = { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight } }
    if (locallyHiddenMessageCount > 0) { setVisibleMessageCount((prev) => Math.min(messages.length, prev + LOAD_MORE_MESSAGE_BATCH)); return }
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
        if (el.scrollTop <= LOAD_MORE_SCROLL_THRESHOLD_PX && hasHiddenHistory) loadOlderMessages()
      })
    }
    el.addEventListener('scroll', handleHistoryScroll, { passive: true })
    return () => { if (frameId) window.cancelAnimationFrame(frameId); el.removeEventListener('scroll', handleHistoryScroll) }
  }, [hasHiddenHistory, loadOlderMessages, scrollRef])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const check = () => { const distanceToBottom = Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight); isNearBottomRef.current = distanceToBottom < BOTTOM_THRESHOLD }
    check()
    el.addEventListener('scroll', check, { passive: true })
    return () => el.removeEventListener('scroll', check)
  }, [scrollRef])

  const scrollPendingRef = useRef(false)
  useLayoutEffect(() => {
    const prevSessionId = prevSessionIdRef.current
    if (prevSessionId !== activeSessionId) { prevSessionIdRef.current = activeSessionId ?? null; scrollPendingRef.current = true; isNearBottomRef.current = true }
  }, [activeSessionId])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (scrollPendingRef.current) {
      lastScrollHeightRef.current = el.scrollHeight
      if (messages.length > 0) { el.scrollTop = el.scrollHeight; scrollPendingRef.current = false; isNearBottomRef.current = true }
      return
    }
    const prevScrollHeight = lastScrollHeightRef.current
    const prevDistanceToBottom = Math.max(0, prevScrollHeight - el.scrollTop - el.clientHeight)
    const wasAtBottom = prevDistanceToBottom < BOTTOM_THRESHOLD
    lastScrollHeightRef.current = el.scrollHeight
    if (!wasAtBottom) return
    el.scrollTop = el.scrollHeight
    isNearBottomRef.current = true
  })

  /* ------------------------------------------------------------------ */
  /*  文件打开 / 步骤切换                                                  */
  /* ------------------------------------------------------------------ */

  let lastAssistantMessageId: string | null = null
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') { lastAssistantMessageId = messages[i].id; break }
  }

  function openFile(filePath: string) {
    if (!filePath) return
    const normalizedPath = filePath.replace(/[\\/]+/g, '/').replace(/^\.\//, '')
    const normalizedWorkspace = workspace.replace(/[\\/]+/g, '/').replace(/\/+$/, '')
    let relativePath: string | null = null
    if (/^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith('\\\\') || filePath.startsWith('/')) {
      const lowerPath = normalizedPath.toLowerCase()
      const lowerWorkspace = normalizedWorkspace.toLowerCase()
      if (lowerPath === lowerWorkspace) relativePath = ''
      else if (lowerPath.startsWith(`${lowerWorkspace}/`)) relativePath = normalizedPath.slice(normalizedWorkspace.length + 1)
    } else if (normalizedPath && !normalizedPath.startsWith('../') && normalizedPath !== '..') {
      relativePath = normalizedPath
    }
    if (relativePath && onOpenFileView) { onOpenFileView(relativePath, false); return }
    const fullPath = filePath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith('\\\\') ? filePath : (workspace ? `${workspace}/${filePath}` : filePath)
    globalThis.window.taco.shell.openInEditor(fullPath, editor).catch(() => {})
  }

  function toggleStep(key: string) { setExpandedSteps((prev) => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next }) }
  function toggleToolBlock(key: string) { setExpandedToolBlocks((prev) => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next }) }
  function toggleThinkBlock(key: string) { setExpandedThinkBlocks((prev) => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next }) }
  function toggleStepGroup(messageId: string, fallbackExpanded: boolean) {
    setStepGroupExpandedMap((prev) => {
      const hasExplicit = Object.prototype.hasOwnProperty.call(prev, messageId)
      const current = hasExplicit ? prev[messageId] : fallbackExpanded
      return { ...prev, [messageId]: !current }
    })
  }

  function handleConfirmResponse(confirmId: string, approved: boolean) {
    let alreadyResponded = false
    setRespondedConfirms((prev) => { if (prev.has(confirmId)) { alreadyResponded = true; return prev } return new Map(prev).set(confirmId, approved) })
    if (alreadyResponded) return
    globalThis.window.taco.agent.confirmResponse(confirmId, approved)
  }

  function handleRetryResponse(retryId: string, shouldRetry: boolean) {
    if (respondedRetries.has(retryId)) return
    setRespondedRetries((prev) => new Map(prev).set(retryId, shouldRetry))
    globalThis.window.taco.agent.retryResponse(retryId, shouldRetry)
  }

  /* ------------------------------------------------------------------ */
  /*  JSX                                                                */
  /* ------------------------------------------------------------------ */

  const showPendingThinkingHint = sending && !showStreamBubble && !selectedFileChange

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
              {(isSessionSending?.(s.id) ?? false) && <span className="session-tab-status" title="执行中" />}
              <span className="session-tab-title">{s.title}</span>
              {sessions.length > 1 && (
                <button type="button" className="session-tab-close" onClick={(e) => { e.stopPropagation(); onDeleteSession(s.id) }} title="关闭会话">✕</button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Diff 视图 */}
      {selectedFileChange && (
        <section className="diff-overlay">
          <DiffView change={selectedFileChange} onClose={onCloseDiff} status={selectedFileStatus}
            onAccept={onAcceptFile ? () => onAcceptFile(selectedFileChange.filePath) : undefined}
            onReject={onRejectFile ? () => onRejectFile(selectedFileChange.filePath) : undefined}
            workspace={workspace} onSaved={() => {}} />
        </section>
      )}

      {/* 对话区域 */}
      <section
        className={`conversation ${showTerminal && !selectedFileChange ? 'with-terminal' : ''}`}
        ref={scrollRef}
        style={selectedFileChange ? { display: 'none' } : undefined}
      >
        {totalHistoryCount === 0 && !showStreamBubble && (
          <div className="empty-state">
            <div className="empty-title">Taco AI</div>
            <div className="empty-sub">
              {!hasProviders ? '请先在 Settings 中配置至少一个模型的 API Key'
                : !workspace ? '请先选择一个工作空间目录，作为 Agent 可操作的安全空间'
                : '发送一条消息开始对话'}
            </div>
            {!workspace && hasProviders && (
              <button type="button" className="workspace-select-btn" onClick={() => onSelectWorkspace()}>
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
              <button type="button" className="chat-history-loader-btn" onClick={loadOlderMessages} disabled={Boolean(loadingOlderMessages)}>
                {loadingOlderMessages ? '加载中...' : '加载更早消息'}
              </button>
              <div className="chat-history-loader-note">当前显示最近 {visibleMessages.length} / {totalHistoryCount} 条</div>
            </div>
          )}
          {visibleMessages.map((msg) => {
            const isEditing = editingMsgId === msg.id
            return (
              <div key={msg.id} className={`chat-row ${msg.role}`}>
                <MessageBubble
                  msg={msg}
                  isEditing={isEditing}
                  sending={sending || isTtsRewriting}
                  activeTaskStartedAt={activeTaskStartedAt}
                  lastAssistantMessageId={lastAssistantMessageId}
                  nowTs={nowTs}
                  messages={messages}
                  expandedSteps={expandedSteps}
                  expandedToolBlocks={expandedToolBlocks}
                  expandedThinkBlocks={expandedThinkBlocks}
                  stepGroupExpandedMap={stepGroupExpandedMap}
                  respondedConfirms={respondedConfirms}
                  respondedRetries={respondedRetries}
                  toggleStep={toggleStep}
                  toggleToolBlock={toggleToolBlock}
                  toggleThinkBlock={toggleThinkBlock}
                  toggleStepGroup={toggleStepGroup}
                  handleConfirmResponse={handleConfirmResponse}
                  handleRetryResponse={handleRetryResponse}
                  workspace={workspace}
                  onOpenFileView={onOpenFileView}
                  openFile={openFile}
                  onOpenWebview={onOpenWebview}
                  editor={editor}
                  setPreviewImageUrl={setPreviewImageUrl}
                  editingText={editingText}
                  editingAttachments={editingAttachments}
                  setEditingAttachments={setEditingAttachments}
                  editingInputDivRef={editingInputDivRef}
                  startEdit={startEdit}
                  confirmEdit={confirmEdit}
                  cancelEdit={cancelEdit}
                  updateEditingTextFromDiv={updateEditingTextFromDiv}
                  insertEditingFileChip={insertEditingFileChip}
                  toAssetName={toAssetName}
                  onResend={onResend}
                  onRollbackBeforeMsg={onRollbackBeforeMsg}
                  rollingBackHash={rollingBackHash}
                  setRollingBackHash={setRollingBackHash}
                  onEditResend={onEditResend}
                />
              </div>
            )
          })}

          {showStreamBubble && (
            <div className="chat-row assistant">
              <div className="bubble">
                {activeTaskStartedAt && <div className="assistant-task-meta">{formatTaskTimingLabel({ startedAt: activeTaskStartedAt }, nowTs)}</div>}
                {streamingContent ? (
                  <MarkdownBubble content={streamingContent} streaming workspace={workspace}
                    onOpenProjectFile={(path) => openFile(path)} onOpenWebview={onOpenWebview} onImagePreview={setPreviewImageUrl} />
                ) : (
                  <div className="typing-indicator"><span /><span /><span /></div>
                )}
              </div>
            </div>
          )}

          {showPendingThinkingHint && (
            <div className="chat-row assistant">
              <div className="assistant-thinking-inline" aria-live="polite">
                <span>思考中</span><span className="dot-pulse inline" />
              </div>
            </div>
          )}
        </div>
      </section>

      {/* 底部浮动确认通知条 */}
      {pendingConfirms.length > 0 && (
        <div className="confirm-bar">
          {pendingConfirms.map((pc, i) => {
            const itemKey = (pc.confirmId || pc.retryId)!
            const isExpanded = !collapsedConfirms.has(itemKey)
            const toggleExpand = () => { setCollapsedConfirms((prev) => { const next = new Set(prev); if (next.has(itemKey)) next.delete(itemKey); else next.add(itemKey); return next }) }
            return (
              <div key={itemKey} className="confirm-bar-item">
                <button type="button" className="confirm-bar-header-btn" onClick={toggleExpand}>
                  <span className="confirm-bar-chevron">{isExpanded ? '⌄' : '›'}</span>
                  <span className="confirm-bar-icon">{pc.isRetry ? '\u26A0\uFE0F' : pc.isPlan ? '\u{1F4CB}' : '\u26A0\uFE0F'}</span>
                  <span className="confirm-bar-label">{pc.isRetry ? '操作异常 — 需要你的确认' : pc.isPlan ? '执行计划 — 需要你的确认' : '操作授权 — 需要你的确认'}</span>
                  {pendingConfirms.length > 1 && <span className="confirm-bar-count">({i + 1}/{pendingConfirms.length})</span>}
                </button>
                {isExpanded && (
                  <div className="confirm-bar-expanded">
                    {pc.isRetry && <div className="confirm-bar-summary">{pc.retryErrorType || '未知错误'}{pc.retryErrorMessage ? `：${pc.retryErrorMessage.slice(0, 200)}` : ''}</div>}
                    {pc.isPlan && pc.planData?.summary && <div className="confirm-bar-summary">{pc.planData.summary}</div>}
                    {!pc.isPlan && !pc.isRetry && pc.risks && pc.risks.length > 0 && <div className="confirm-bar-summary">{pc.risks.map((r) => r.reason).join('；')}</div>}
                    {pc.isPlan && pc.planData?.steps && pc.planData.steps.length > 0 && (
                      <div className="agent-steps">
                        {pc.planData.steps.map((s, si) => {
                          const idx = (s && typeof s === 'object' ? s.index : undefined) ?? si + 1
                          const title = s && typeof s === 'object' ? (s.title || s.content || s.text) : String(s ?? '')
                          const desc = s && typeof s === 'object' ? (s.title ? s.content : undefined) : undefined
                          return <div key={si} className="agent-step"><div className="agent-step-header"><span className="agent-step-toggle"><span className="agent-step-label-text">{idx}</span></span><span className="agent-step-detail">{title}</span></div>{desc && <div className="agent-step-body">{desc}</div>}</div>
                        })}
                      </div>
                    )}
                    {pc.isPlan && pc.planData?.reasoning && <div className="confirm-bar-reasoning"><div className="confirm-bar-reasoning-title">选择理由</div><div className="confirm-bar-reasoning-text">{pc.planData.reasoning}</div></div>}
                  </div>
                )}
                <div className="confirm-bar-actions">
                  {pc.isRetry ? (
                    <>
                      <button type="button" className="agent-confirm-btn approve" onClick={() => handleRetryResponse(pc.retryId!, true)}>重试</button>
                      <button type="button" className="agent-confirm-btn deny" onClick={() => handleRetryResponse(pc.retryId!, false)}>取消</button>
                    </>
                  ) : (
                    <>
                      <button type="button" className="agent-confirm-btn approve" onClick={() => handleConfirmResponse(pc.confirmId!, true)}>{pc.isPlan ? '确认执行' : '允许执行'}</button>
                      <button type="button" className="agent-confirm-btn deny" onClick={() => handleConfirmResponse(pc.confirmId!, false)}>{pc.isPlan ? '需要调整' : '拒绝'}</button>
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* AI 语音头像 — 科幻能量核心特效（fixed 居中，无遮罩） */}
      {isSpeaking && (
        <div className="ai-voice-avatar">
          <div className="ava-energy-core" />
          <div className="ava-shockwave ava-shockwave-1" />
          <div className="ava-shockwave ava-shockwave-2" />
          <div className="ava-shockwave ava-shockwave-3" />
        </div>
      )}

      {previewImageUrl && (
        <div className="image-lightbox" onClick={() => setPreviewImageUrl(null)}>
          <button type="button" className="image-lightbox-close" onClick={(e) => { e.stopPropagation(); setPreviewImageUrl(null) }} aria-label="Close image preview">×</button>
          <img src={previewImageUrl} alt="automation-screenshot-preview" className="image-lightbox-content" onClick={(e) => e.stopPropagation()} />
        </div>
      )}

      {/* 输入区域 */}
      <InputArea
        attachedImages={attachedImages}
        onAttachedImagesChange={onAttachedImagesChange}
        attachedAssets={attachedAssets}
        draft={draft}
        onDraftChange={onDraftChange}
        sending={sending || isTtsRewriting}
        hasProviders={hasProviders}
        workspace={workspace}
        onSendClick={handleSend}
        onStop={onStop}
        queue={queue}
        onRemoveFromQueue={onRemoveFromQueue}
        provider={provider}
        onProviderChange={onProviderChange}
        configuredProviders={configuredProviders}
        onOpenModels={onOpenModels}
        fileInputRef={fileInputRef}
        inputDivRef={inputDivRef}
        onDraftChangeRef={onDraftChangeRef}
        handleFileSelect={handleFileSelect}
        handlePaste={handlePaste}
        handleAddFiles={handleAddFiles}
        removeImage={removeImage}
        removeAsset={(id) => onAttachedAssetsChange((prev) => prev.filter(a => a.id !== id))}
        toAssetName={toAssetName}
        renderDraftToDiv={renderDraftToDiv}
        extractDivText={extractDivText}
        isRecording={isRecording}
        toggleRecording={toggleRecording}
        elapsedSeconds={elapsedSeconds}
        authLevel={authLevel}
        handleAuthLevelChange={handleAuthLevelChange}
        authDropdownOpen={authDropdownOpen}
        setAuthDropdownOpen={setAuthDropdownOpen}
        authDropdownRef={authDropdownRef}
        autoCommit={autoCommit}
        handleAutoCommitToggle={handleAutoCommitToggle}
        contextPercent={contextPercent}
        projectId={projectId}
        supportsVision={supportsVision}
        t={t}
        setPreviewImageUrl={setPreviewImageUrl}
      />

      {/* 底部状态栏 */}
      <BottomBar
        language={language}
        toggleLanguage={toggleLanguage}
        t={t}
        workspace={workspace}
        onSelectWorkspace={onSelectWorkspace}
        runTokenStats={runTokenStats}
        projectTokenStats={projectTokenStats}
      />
    </main>
  )
}
