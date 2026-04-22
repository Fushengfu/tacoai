import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useTransition, type ErrorInfo } from 'react'
import type { AttachedAsset, AttachedImage, ChatMsg, FileChangeInfo, FileChangeStatus, GitVersionCommit, ProviderId, ThemeMode, ThreadMode } from './types'
import type { AppUpdateCheckResult, EditorId, FileTreeEntry, BrowserConsoleLevel, MobileBridgeContextSnapshot, GitWorkingTreeStatus } from '../shared/ipc'
import { estimateTokens, buildSystemPrompt, resolveModelConfigDisplayLabel, resolveModelConfigMaxTokens } from './constants'
import { loadJson, saveJson } from './lib/storage'
import { useThreads } from './hooks/useThreads'
import { useChat } from './hooks/useChat'
import { useProviderSettings } from './hooks/useProviderSettings'
import { useGuiPlusSettings } from './hooks/useGuiPlusSettings'
import { Sidebar } from './components/Sidebar'
import { ChatPanel } from './components/ChatPanel'
import { DetailPanel } from './components/DetailPanel'
import { SettingsPage } from './components/SettingsModal'
import { PaneErrorBoundary } from './components/PaneErrorBoundary'
import { useResize } from './hooks/useResize'
import { useDrag } from './hooks/useDrag'

const DEV_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1'])
const SIDEBAR_MIN_WIDTH = 220
const SIDEBAR_DEFAULT_RATIO = 0.2
const CHAT_MIN_WIDTH = 640
const DETAIL_DEFAULT_WIDTH = 340
const DETAIL_MIN_WIDTH = 260
const DETAIL_MAX_WIDTH = 700

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function readStoredBoolean(key: string, fallback: boolean): boolean {
  try {
    const value = localStorage.getItem(key)
    return value === null ? fallback : value === 'true'
  } catch {
    return fallback
  }
}

function isPrivateIpv4(hostname: string): boolean {
  const m = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  if (a === 10) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return false
}

function isDevBrowserUrl(rawUrl?: string): boolean {
  if (!rawUrl) return false
  if (rawUrl.startsWith('webpack://') || rawUrl.startsWith('vite://')) return true
  try {
    const u = new URL(rawUrl)
    const host = u.hostname.toLowerCase()
    if (DEV_HOSTS.has(host)) return true
    if (host.endsWith('.localhost') || host.endsWith('.local')) return true
    if (isPrivateIpv4(host)) return true
    return false
  } catch {
    return false
  }
}

function normalizeScreenshotPath(raw: unknown): string | null {
  const text = String(raw ?? '').trim()
  if (!text) return null
  if (text.startsWith('/')) return text
  if (/^[a-zA-Z]:[\\/]/.test(text)) return text
  if (text.startsWith('\\\\')) return text
  return null
}

function extractScreenshotPathsFromContent(content: string): string[] {
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
    // ignore non-json tool results
  }

  const regex = /"screenshotPath"\s*:\s*"([^"]+)"/g
  let match: RegExpExecArray | null = null
  while ((match = regex.exec(text)) !== null) {
    const normalized = normalizeScreenshotPath(match[1])
    if (normalized) paths.add(normalized)
  }
  return Array.from(paths)
}

function collectMessageScreenshotPaths(msg: ChatMsg): string[] {
  const paths = new Set<string>()
  if (msg.agentSteps) {
    for (const step of msg.agentSteps) {
      for (const result of step.toolResults) {
        for (const p of extractScreenshotPathsFromContent(result.content)) {
          paths.add(p)
        }
      }
    }
  }
  return Array.from(paths)
}

function buildMobileBridgeSnapshotDigest(snapshot: MobileBridgeContextSnapshot): string {
  // 与主进程保持一致：去重时忽略顶层 updatedAt，避免时间戳导致的伪变化。
  return JSON.stringify({
    ...snapshot,
    updatedAt: 0,
  })
}

function normalizeSlashPath(input: string): string {
  return String(input ?? '').trim().replace(/[\\/]+/g, '/').replace(/\/+/g, '/')
}

function normalizeWorkspaceRelativePath(filePath: string, workspace?: string | null): string {
  const normalizedFilePath = normalizeSlashPath(filePath).replace(/^\.\//, '')
  if (!normalizedFilePath) return normalizedFilePath
  if (!workspace) return normalizedFilePath

  const normalizedWorkspace = normalizeSlashPath(workspace).replace(/\/+$/, '')
  if (!normalizedWorkspace) return normalizedFilePath

  const lowerFilePath = normalizedFilePath.toLowerCase()
  const lowerWorkspace = normalizedWorkspace.toLowerCase()
  if (lowerFilePath === lowerWorkspace) return ''
  if (lowerFilePath.startsWith(`${lowerWorkspace}/`)) {
    return normalizedFilePath.slice(normalizedWorkspace.length + 1)
  }
  return normalizedFilePath
}

function normalizeFileStatusMap(
  raw: Record<string, FileChangeStatus>,
  workspace?: string | null,
): Record<string, FileChangeStatus> {
  const normalized: Record<string, FileChangeStatus> = {}
  for (const [filePath, status] of Object.entries(raw ?? {})) {
    const key = normalizeWorkspaceRelativePath(filePath, workspace)
    if (!key) continue
    normalized[key] = status
  }
  return normalized
}

export default function App() {
  /* ---- hooks ---- */
  const threadStore = useThreads()
  const chat = useChat()
  const providerSettings = useProviderSettings()
  const guiPlusSettings = useGuiPlusSettings()
  const [, startPanelStateTransition] = useTransition()
  const { width: detailWidth, setWidth: setDetailWidth, handleMouseDown: handleResizeMouseDown } = useResize(
    DETAIL_DEFAULT_WIDTH, DETAIL_MIN_WIDTH, DETAIL_MAX_WIDTH, 'taco.detailPanelWidth', 'right'
  )

  /* ---- local UI state ---- */
  const [draft, setDraft] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [sidebarVisible, setSidebarVisible] = useState<boolean>(true)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  /** 当前在中间区域查看/编辑的文件（非变更文件） */
  const [viewingFile, setViewingFile] = useState<string | null>(null)
  /** 打开文件后需要定位到的行列（供编辑器跳转定义使用） */
  const [viewingSelection, setViewingSelection] = useState<{ line: number; column: number } | null>(null)
  const [detailTreeExpanded, setDetailTreeExpanded] = useState<boolean>(() => readStoredBoolean('taco.panel.treeExpanded', false))
  const [detailChangesExpanded, setDetailChangesExpanded] = useState<boolean>(() => readStoredBoolean('taco.panel.changesExpanded', true))
  const [detailGitExpanded, setDetailGitExpanded] = useState<boolean>(() => readStoredBoolean('taco.panel.gitExpanded', true))
  const [showTerminal, setShowTerminal] = useState(false)
  /** 外部浏览器窗口状态 Map<appId, url> */
  const [browserWindows, setBrowserWindows] = useState<Map<string, string>>(new Map())
  /** 外部浏览器控制台日志 */
  type BrowserConsoleEntry = {
    id: number
    appId: string
    level: BrowserConsoleLevel
    message: string
    source?: string
    line?: number
    timestamp: number
  }
  const [browserConsoleLogs, setBrowserConsoleLogs] = useState<BrowserConsoleEntry[]>([])
  const consoleIdRef = useRef(0)
  const browserWindowsRef = useRef<Map<string, string>>(new Map())
  /** 外部浏览器异常缓存（仅保留权重最高且最新的 3 条，按需再发送给 AI） */
  type BrowserErrorCandidate = BrowserConsoleEntry & { weight: number; fingerprint: string }
  const browserErrorCandidatesRef = useRef<BrowserErrorCandidate[]>([])
  /** doSend 的 ref，避免 useEffect 闭包捕获旧引用 */
  type MobileTarget = { threadId?: string; sessionId?: string; modelConfigId?: string }
  const doSendRef = useRef<(content: string, images?: AttachedImage[], attachments?: AttachedAsset[], target?: MobileTarget) => void>(() => {})
  const mobileSyncTimerRef = useRef<number | null>(null)
  const lastMobileSnapshotDigestRef = useRef('')
  /** 中间区域当前视图：chat / settings */
  type MiddleView = 'chat' | 'settings'
  const [middleView, setMiddleView] = useState<MiddleView>('chat')
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    const saved = String(localStorage.getItem('taco.themeMode') || '').trim()
    if (saved === 'ocean' || saved === 'graphite' || saved === 'dark') return saved
    return 'dark'
  })
  const [updateStatus, setUpdateStatus] = useState<AppUpdateCheckResult | null>(null)
  const [updateChecking, setUpdateChecking] = useState(false)
  const [editor, setEditor] = useState<EditorId>(() =>
    (localStorage.getItem('taco.editor') as EditorId) || 'cursor'
  )
  const [sidebarWidthRatio, setSidebarWidthRatio] = useState<number>(() => {
    const savedRatio = Number(localStorage.getItem('taco.sidebarRatio') ?? '')
    if (Number.isFinite(savedRatio) && savedRatio > 0) {
      return savedRatio
    }
    // 兼容历史像素配置
    const savedWidth = Number(localStorage.getItem('taco.sidebarWidth') ?? '')
    if (Number.isFinite(savedWidth) && savedWidth > 0) {
      const viewport = typeof window === 'undefined' ? 1440 : window.innerWidth
      const fallbackAreaWidth = Math.max(1, viewport - 340)
      return savedWidth / fallbackAreaWidth
    }
    return SIDEBAR_DEFAULT_RATIO
  })
  const [appShellWidth, setAppShellWidth] = useState<number>(() =>
    typeof window === 'undefined' ? 1440 : window.innerWidth
  )
  const appShellRef = useRef<HTMLDivElement | null>(null)
  const detailWidthRef = useRef(detailWidth)
  const scrollRef = useRef<HTMLDivElement>(null)
  /** 手动编辑产生的文件变更（按 session 隔离），用于右侧变更面板实时同步 */
  const [manualFileChangesBySession, setManualFileChangesBySession] = useState<Record<string, FileChangeInfo[]>>({})
  /**
   * 每个会话在最近一次切换 workspace 时的消息基线下标。
   * 仅展示基线之后产生的 agent 文件变更，避免跨目录历史变更污染当前面板。
   */
  const [changeStartIndexBySession, setChangeStartIndexBySession] = useState<Record<string, number>>({})
  const lastWorkspaceBySessionRef = useRef<Record<string, string>>({})
  // 移动端桥接监听采用“单次订阅 + ref 读取最新状态”，避免高频重渲染导致事件丢失。
  const threadStoreRef = useRef(threadStore)
  const providerSettingsRef = useRef(providerSettings)
  const chatRef = useRef(chat)
  const activeThreadIdRef = useRef('')
  const activeSessionIdRef = useRef('')

  const scoreBrowserError = useCallback((entry: BrowserConsoleEntry): number => {
    let score = 0
    const msg = entry.message || ''
    if (entry.level === 'error') score += 50
    if (entry.level === 'network') score += 40
    if (msg.startsWith('[页面加载失败]')) score += 60
    if (/Uncaught|Unhandled/i.test(msg)) score += 45
    if (/TypeError|ReferenceError|SyntaxError|RangeError/i.test(msg)) score += 35
    if (/CORS|ERR_|Failed to fetch|NetworkError/i.test(msg)) score += 25
    return score
  }, [])

  const rememberBrowserErrorCandidate = useCallback((entry: BrowserConsoleEntry) => {
    const weight = scoreBrowserError(entry)
    const fingerprint = `${entry.appId}|${entry.level}|${entry.message}|${entry.source ?? ''}|${entry.line ?? ''}`
    const withScore: BrowserErrorCandidate = { ...entry, weight, fingerprint }

    const deduped = browserErrorCandidatesRef.current.filter((e) => e.fingerprint !== fingerprint)
    const ranked = [...deduped, withScore]
      .sort((a, b) => (b.weight - a.weight) || (b.timestamp - a.timestamp))
      .slice(0, 3)

    browserErrorCandidatesRef.current = ranked
  }, [scoreBrowserError])

  /* ---- derived ---- */
  const tid = threadStore.activeThreadId                           // 当前项目 ID
  const sessionId = threadStore.activeThread?.activeSessionId ?? '' // 当前会话 ID
  const sessions = threadStore.activeThread?.sessions ?? []

  // 消息、发送状态等全部以 sessionId 为 key
  const messages = chat.getMessages(sessionId)
  const totalSessionMessageCount = chat.getSessionMessageCount(sessionId)
  const sessionSending = chat.isSending(sessionId)
  const sessionStreamingContent = chat.getStreamingContent(sessionId)
  const sessionQueue = chat.getQueue(sessionId)
  const activeTaskStartedAt = chat.getActiveTaskStartedAt(sessionId)

  // 当前项目的模式和工作空间
  const currentMode: ThreadMode = 'agent'
  const currentProjectRules = threadStore.activeThread?.projectRules ?? ''

  // Agent 模式下文本已在消息内实时更新，不需要独立的流式气泡
  const showStreamBubble = sessionSending && currentMode !== 'agent'
  const currentWorkspace: string = threadStore.activeThread?.workspace ?? ''

  useEffect(() => {
    if (!sessionId) return
    void chat.ensureSessionLoaded(sessionId)
  }, [chat, sessionId])

  /** 将相对路径解析为绝对路径 */
  const resolveFilePath = useCallback((filePath: string) => {
    // 如果已经是绝对路径则直接返回
    if (filePath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith('\\\\')) {
      return filePath
    }
    // 否则拼接工作空间路径
    if (currentWorkspace) {
      const base = currentWorkspace.replace(/[\\/]+$/, '')
      const rel = normalizeSlashPath(filePath).replace(/^\.\//, '')
      const isWindowsWorkspace = /[a-zA-Z]:[\\/]/.test(base) || base.includes('\\')
      if (isWindowsWorkspace) return `${base}\\${rel.replace(/\//g, '\\')}`
      return `${base}/${rel}`
    }
    return filePath
  }, [currentWorkspace])

  // 当前项目使用的模型配置（项目级 > 全局默认）
  const currentModelConfigId =
    threadStore.activeThread?.modelConfigId ?? providerSettings.activeModelConfigId
  const currentModelConfig = providerSettings.getModelConfig(currentModelConfigId || '')
  const currentProvider: ProviderId | undefined = currentModelConfig?.provider
  const activeProviderLabel = currentModelConfig ? resolveModelConfigDisplayLabel(currentModelConfig) : ''

  useEffect(() => {
    try { localStorage.setItem('taco.panel.treeExpanded', String(detailTreeExpanded)) } catch { /* ignore */ }
  }, [detailTreeExpanded])

  useEffect(() => {
    try { localStorage.setItem('taco.panel.changesExpanded', String(detailChangesExpanded)) } catch { /* ignore */ }
  }, [detailChangesExpanded])

  useEffect(() => {
    try { localStorage.setItem('taco.panel.gitExpanded', String(detailGitExpanded)) } catch { /* ignore */ }
  }, [detailGitExpanded])

  useEffect(() => {
    threadStoreRef.current = threadStore
    providerSettingsRef.current = providerSettings
    chatRef.current = chat
    activeThreadIdRef.current = tid
    activeSessionIdRef.current = sessionId
  }, [threadStore, providerSettings, chat, tid, sessionId])

  // 上下文窗口使用量：优先使用模型真实 usage.total_tokens，缺失时回退本地估算
  const estimatedTokens = estimateTokens(
    buildSystemPrompt({
      mode: currentMode,
      workspace: currentWorkspace,
      provider: currentProvider ?? 'deepseek',
      model: currentModelConfig?.model,
      projectRules: currentProjectRules,
    })
  ) +
    messages.reduce((sum, m) => sum + estimateTokens(m.content), 0)
  const usageTotalTokens = chat.getUsageTotalTokens(sessionId)
  const usedTokens = typeof usageTotalTokens === 'number' ? usageTotalTokens : estimatedTokens
  const maxTokens = resolveModelConfigMaxTokens(currentModelConfig)
  const contextPercent = Math.min(Math.round((usedTokens / maxTokens) * 100), 100)
  const projectTokenStats = tid ? chat.getProjectTokenStats(tid) : undefined

  useEffect(() => {
    localStorage.setItem('taco.themeMode', themeMode)
    document.documentElement.setAttribute('data-theme', themeMode)
  }, [themeMode])

  const refreshUpdateStatus = useCallback(async () => {
    try {
      const status = await window.taco.updater.getStatus()
      setUpdateStatus(status)
    } catch {
      // ignore
    }
  }, [])

  const handleOpenUpdateDialog = useCallback(async () => {
    if (updateChecking) return
    setUpdateChecking(true)
    try {
      const result = await window.taco.updater.check(true)
      setUpdateStatus(result)
    } catch {
      // ignore
    } finally {
      setUpdateChecking(false)
    }
  }, [updateChecking])

  useEffect(() => {
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let retries = 0

    const pull = async () => {
      if (cancelled) return
      try {
        const status = await window.taco.updater.getStatus()
        if (cancelled) return
        setUpdateStatus(status)
        if (!status && retries < 20) {
          retries += 1
          retryTimer = setTimeout(() => { void pull() }, 800)
        }
      } catch {
        // ignore
      }
    }

    void pull()
    const interval = window.setInterval(() => {
      void refreshUpdateStatus()
    }, 30_000)

    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
      window.clearInterval(interval)
    }
  }, [refreshUpdateStatus])

  useEffect(() => {
    const normalized = Number.isFinite(sidebarWidthRatio) ? sidebarWidthRatio : SIDEBAR_DEFAULT_RATIO
    localStorage.setItem('taco.sidebarRatio', String(normalized))
  }, [sidebarWidthRatio])

  useEffect(() => {
    const element = appShellRef.current
    if (!element) return

    const updateWidth = () => {
      const measured = element.clientWidth
      if (Number.isFinite(measured) && measured > 0) {
        setAppShellWidth(measured)
      } else {
        setAppShellWidth(window.innerWidth)
      }
    }

    updateWidth()
    const observer = new ResizeObserver(() => updateWidth())
    observer.observe(element)

    window.addEventListener('resize', updateWidth)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateWidth)
    }
  }, [])

  const detailAutoMaxWidth = clampNumber(
    appShellWidth - SIDEBAR_MIN_WIDTH - CHAT_MIN_WIDTH,
    DETAIL_MIN_WIDTH,
    DETAIL_MAX_WIDTH,
  )
  const effectiveDetailWidth = clampNumber(detailWidth, DETAIL_MIN_WIDTH, detailAutoMaxWidth)

  useEffect(() => {
    setDetailWidth((prev) => {
      const next = clampNumber(prev, DETAIL_MIN_WIDTH, detailAutoMaxWidth)
      return Math.abs(next - prev) < 0.5 ? prev : next
    })
  }, [detailAutoMaxWidth, setDetailWidth])

  useEffect(() => {
    detailWidthRef.current = effectiveDetailWidth
  }, [effectiveDetailWidth])

  const sidebarAreaWidth = Math.max(0, appShellWidth - effectiveDetailWidth)
  const sidebarAutoMinWidth = Math.min(SIDEBAR_MIN_WIDTH, sidebarAreaWidth)
  const sidebarAutoMaxWidth = Math.max(sidebarAutoMinWidth, sidebarAreaWidth - CHAT_MIN_WIDTH)
  const sidebarMinRatio = sidebarAreaWidth > 0 ? (sidebarAutoMinWidth / sidebarAreaWidth) : 0
  const sidebarMaxRatio = sidebarAreaWidth > 0
    ? clampNumber(sidebarAutoMaxWidth / sidebarAreaWidth, sidebarMinRatio, 1)
    : 0

  useEffect(() => {
    setSidebarWidthRatio((prev) => {
      const safePrev = Number.isFinite(prev) ? prev : SIDEBAR_DEFAULT_RATIO
      const next = clampNumber(safePrev, sidebarMinRatio, sidebarMaxRatio)
      return Math.abs(next - safePrev) < 0.0001 ? safePrev : next
    })
  }, [sidebarMinRatio, sidebarMaxRatio])

  const handleSidebarResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const getAreaWidth = () => {
      const shellWidth = appShellRef.current?.clientWidth ?? appShellWidth
      return Math.max(1, shellWidth - detailWidthRef.current)
    }
    const startAreaWidth = getAreaWidth()
    const startMinWidth = Math.min(SIDEBAR_MIN_WIDTH, startAreaWidth)
    const startMaxWidth = Math.max(startMinWidth, startAreaWidth - CHAT_MIN_WIDTH)
    const startMinRatio = startAreaWidth > 0 ? (startMinWidth / startAreaWidth) : 0
    const startMaxRatio = startAreaWidth > 0
      ? clampNumber(startMaxWidth / startAreaWidth, startMinRatio, 1)
      : startMinRatio
    const startRatio = clampNumber(sidebarWidthRatio, startMinRatio, startMaxRatio)
    const startWidth = startRatio * startAreaWidth

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.body.classList.add('is-resizing')

    const handleMouseMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX
      const areaWidth = getAreaWidth()
      const dragMinWidth = Math.min(SIDEBAR_MIN_WIDTH, areaWidth)
      const dragMaxWidth = Math.max(dragMinWidth, areaWidth - CHAT_MIN_WIDTH)
      const dragMinRatio = areaWidth > 0 ? (dragMinWidth / areaWidth) : 0
      const dragMaxRatio = areaWidth > 0
        ? clampNumber(dragMaxWidth / areaWidth, dragMinRatio, 1)
        : dragMinRatio
      const nextWidth = clampNumber(startWidth + dx, dragMinWidth, dragMaxWidth)
      const nextRatio = areaWidth > 0 ? (nextWidth / areaWidth) : dragMinRatio
      setSidebarWidthRatio(clampNumber(nextRatio, dragMinRatio, dragMaxRatio))
    }

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      document.body.classList.remove('is-resizing')
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp, { once: true })
  }, [appShellWidth, sidebarWidthRatio])

  /** 判断某项目（线程）是否有任何会话正在发送 */
  function isThreadSending(threadId: string): boolean {
    const thread = threadStore.threads.find((t) => t.id === threadId)
    if (!thread) return false
    return thread.sessions.some((s) => chat.isSending(s.id))
  }

  /** 判断某项目是否有会话刚完成 */
  function isThreadCompleted(threadId: string): boolean {
    const thread = threadStore.threads.find((t) => t.id === threadId)
    if (!thread) return false
    return thread.sessions.some((s) => chat.isCompleted(s.id))
  }

  // Agent 模式：收集所有文件变更（从 agentSteps 的 toolResults 中提取）
  const changeStartIndex = useMemo(() => {
    const raw = changeStartIndexBySession[sessionId] ?? 0
    if (!Number.isFinite(raw) || raw < 0) return 0
    return raw > messages.length ? messages.length : raw
  }, [changeStartIndexBySession, sessionId, messages.length])

  const agentFileChanges: FileChangeInfo[] = useMemo(() => {
    if (currentMode !== 'agent') return []
    const changes: FileChangeInfo[] = []
    for (let i = changeStartIndex; i < messages.length; i++) {
      const msg = messages[i]
      if (!msg.agentSteps) continue
      for (const step of msg.agentSteps) {
        for (const tr of step.toolResults) {
          if (tr.fileChange) {
            const normalizedPath = normalizeWorkspaceRelativePath(tr.fileChange.filePath, currentWorkspace)
            if (!normalizedPath) continue
            changes.push({
              ...tr.fileChange,
              filePath: normalizedPath,
            })
          }
        }
      }
    }
    return changes
  }, [messages, currentMode, currentWorkspace, changeStartIndex])

  // 当前会话手动编辑变更
  const manualFileChanges = useMemo(
    () => manualFileChangesBySession[sessionId] ?? [],
    [manualFileChangesBySession, sessionId],
  )

  // 合并 agent 变更与手动编辑变更
  const fileChanges: FileChangeInfo[] = useMemo(
    () => [...agentFileChanges, ...manualFileChanges],
    [agentFileChanges, manualFileChanges],
  )

  // 去重合并：同一文件多次变更 → 保留首次 oldContent + 最终 newContent
  const dedupedFileChanges = useMemo(() => {
    if (fileChanges.length === 0) return []
    const map = new Map<string, import('./types').FileChangeInfo>()
    for (const fc of fileChanges) {
      const existing = map.get(fc.filePath)
      if (existing) {
        // 合并：保留最初的 oldContent，更新为最新的 newContent
        map.set(fc.filePath, {
          filePath: fc.filePath,
          oldContent: existing.oldContent,
          newContent: fc.newContent,
        })
      } else {
        map.set(fc.filePath, { ...fc })
      }
    }
    // 过滤掉最终内容与原始内容相同的文件（改了又改回来的情况）
    return Array.from(map.values()).filter(
      (fc) => fc.oldContent !== fc.newContent
    )
  }, [fileChanges])

  const [gitWorkingStatus, setGitWorkingStatus] = useState<GitWorkingTreeStatus>({ staged: [], unstaged: [] })
  const [gitStatusLoaded, setGitStatusLoaded] = useState(false)

  const gitStagedFiles = useMemo(() => {
    const seen = new Set<string>()
    for (const filePath of gitWorkingStatus.staged ?? []) {
      const normalized = normalizeWorkspaceRelativePath(filePath, currentWorkspace)
      if (normalized) seen.add(normalized)
    }
    return Array.from(seen).sort((a, b) => a.localeCompare(b))
  }, [gitWorkingStatus.staged, currentWorkspace])

  const gitUnstagedFiles = useMemo(() => {
    const seen = new Set<string>()
    for (const filePath of gitWorkingStatus.unstaged ?? []) {
      const normalized = normalizeWorkspaceRelativePath(filePath, currentWorkspace)
      if (normalized) seen.add(normalized)
    }
    return Array.from(seen).sort((a, b) => a.localeCompare(b))
  }, [gitWorkingStatus.unstaged, currentWorkspace])

  const stagedFileSet = useMemo(() => new Set(gitStagedFiles), [gitStagedFiles])
  const unstagedFileSet = useMemo(() => new Set(gitUnstagedFiles), [gitUnstagedFiles])

  /**
   * 实时文件差异覆盖层：
   * - 已有 deduped 变更：以分片方式从磁盘刷新 newContent
   * - 仅同步最近一批变更文件，避免全量扫描导致 UI 卡顿
   * 值为 null 表示该路径当前已无有效差异（用于清理旧快照）。
   */
  const [liveFileChangeOverrides, setLiveFileChangeOverrides] = useState<Record<string, FileChangeInfo | null>>({})
  const liveFileChangeSyncSeqRef = useRef(0)
  const liveDiffLastRunAtRef = useRef(0)
  const liveDiffLastTargetKeyRef = useRef('')
  const liveDiffPriorityPaths = useMemo(() => {
    if (currentMode !== 'agent') return []
    const ordered: string[] = []
    const seen = new Set<string>()
    const pushPath = (filePath: string | null) => {
      if (!filePath || seen.has(filePath)) return
      seen.add(filePath)
      ordered.push(filePath)
    }

    pushPath(selectedFile)
    pushPath(viewingFile)

    if (detailChangesExpanded) {
      for (let i = dedupedFileChanges.length - 1; i >= 0 && ordered.length < 18; i--) {
        pushPath(dedupedFileChanges[i]?.filePath ?? null)
      }
    }

    return ordered
  }, [currentMode, selectedFile, viewingFile, detailChangesExpanded, dedupedFileChanges])
  const liveDiffTargetKey = liveDiffPriorityPaths.join('|')
  const syncLiveNewContentByPath = useCallback(async () => {
    const now = Date.now()
    const minInterval = sessionSending ? 700 : 1500
    const targetChanged = liveDiffTargetKey !== liveDiffLastTargetKeyRef.current
    if (targetChanged) {
      liveDiffLastTargetKeyRef.current = liveDiffTargetKey
    }
    if (!targetChanged && (now - liveDiffLastRunAtRef.current) < minInterval) return
    liveDiffLastRunAtRef.current = now

    const seq = ++liveFileChangeSyncSeqRef.current
    if (!currentWorkspace || currentMode !== 'agent' || liveDiffPriorityPaths.length === 0) {
      liveDiffLastTargetKeyRef.current = liveDiffTargetKey
      startPanelStateTransition(() => setLiveFileChangeOverrides({}))
      return
    }

    const maxTargets = detailChangesExpanded
      ? (sessionSending ? 10 : 24)
      : 2
    const changeMap = new Map(
      dedupedFileChanges
        .filter((fc) => String(fc.filePath ?? '').trim().length > 0)
        .map((fc) => [fc.filePath, fc] as const),
    )
    const targetChanges: FileChangeInfo[] = []
    for (const filePath of liveDiffPriorityPaths) {
      const change = changeMap.get(filePath)
      if (!change) continue
      targetChanges.push(change)
      if (targetChanges.length >= maxTargets) break
    }

    if (targetChanges.length === 0) {
      startPanelStateTransition(() => setLiveFileChangeOverrides({}))
      return
    }

    const next: Record<string, FileChangeInfo | null> = {}
    const chunkSize = 4
    for (let i = 0; i < targetChanges.length; i += chunkSize) {
      if (seq !== liveFileChangeSyncSeqRef.current) return
      const chunk = targetChanges.slice(i, i + chunkSize)
      const entries = await Promise.all(chunk.map(async (base) => {
        const filePath = base.filePath
        try {
          const fileResult = await window.taco.file.read(resolveFilePath(filePath))
          const newContent = fileResult.isBinary
            ? null
            : (fileResult.truncated ? base.newContent : fileResult.content)
          const merged = { ...base, newContent }
          return [filePath, merged.oldContent === merged.newContent ? null : merged] as const
        } catch {
          const merged = { ...base, newContent: null }
          return [filePath, merged.oldContent === merged.newContent ? null : merged] as const
        }
      }))
      if (seq !== liveFileChangeSyncSeqRef.current) return
      for (const [filePath, change] of entries) next[filePath] = change
      // 分片让出主线程，避免目录/变更面板刷新时卡顿
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    }

    if (seq !== liveFileChangeSyncSeqRef.current) return
    startPanelStateTransition(() => setLiveFileChangeOverrides(next))
  }, [
    currentWorkspace,
    currentMode,
    dedupedFileChanges,
    detailChangesExpanded,
    liveDiffPriorityPaths,
    liveDiffTargetKey,
    sessionSending,
    resolveFilePath,
    startPanelStateTransition,
  ])

  const effectiveFileChanges = useMemo(() => {
    const result = new Map<string, FileChangeInfo>()
    for (const change of dedupedFileChanges) {
      result.set(change.filePath, change)
    }
    for (const [filePath, override] of Object.entries(liveFileChangeOverrides)) {
      if (override === null) {
        result.delete(filePath)
      } else {
        result.set(filePath, override)
      }
    }
    return Array.from(result.values()).filter((fc) => fc.oldContent !== fc.newContent)
  }, [dedupedFileChanges, liveFileChangeOverrides])

  const changeSyncSignal = useMemo(() => {
    if (currentMode !== 'agent') return ''
    const segments: string[] = []
    for (const msg of messages) {
      if (!msg.agentSteps) continue
      for (const step of msg.agentSteps) {
        for (const result of step.toolResults) {
          if (!result.fileChange) continue
          const path = normalizeWorkspaceRelativePath(result.fileChange.filePath, currentWorkspace)
          if (!path) continue
          segments.push(`${path}:${result.success ? '1' : '0'}:${result.fileChange.oldContent?.length ?? -1}:${result.fileChange.newContent?.length ?? -1}`)
        }
      }
    }
    return segments.join('|')
  }, [messages, currentMode, currentWorkspace])

  // 工作区目录树
  const [workspaceTree, setWorkspaceTree] = useState<FileTreeEntry[]>([])
  const workspaceTreeRefreshSeqRef = useRef(0)
  const gitLogRefreshSeqRef = useRef(0)
  const gitStatusRefreshSeqRef = useRef(0)

  /** 刷新工作区目录树 */
  const refreshWorkspaceTree = useCallback(async () => {
    const seq = ++workspaceTreeRefreshSeqRef.current
    if (!currentWorkspace) {
      startPanelStateTransition(() => setWorkspaceTree([]))
      return
    }
    try {
      const tree = await window.taco.workspace.tree(currentWorkspace)
      if (seq !== workspaceTreeRefreshSeqRef.current) return
      startPanelStateTransition(() => setWorkspaceTree(tree))
    } catch (err) {
      if (seq !== workspaceTreeRefreshSeqRef.current) return
      console.error('读取工作区目录失败:', err)
      startPanelStateTransition(() => setWorkspaceTree([]))
    }
  }, [currentWorkspace, startPanelStateTransition])

  // Git 版本历史
  const [gitVersions, setGitVersions] = useState<GitVersionCommit[]>([])

  /** 刷新 Git 版本历史 */
  const refreshGitLog = useCallback(async () => {
    const seq = ++gitLogRefreshSeqRef.current
    if (!currentWorkspace || currentMode !== 'agent') {
      startPanelStateTransition(() => setGitVersions([]))
      return
    }
    try {
      const commits = await window.taco.git.log(currentWorkspace)
      if (seq !== gitLogRefreshSeqRef.current) return
      startPanelStateTransition(() => setGitVersions(commits))
    } catch (err) {
      if (seq !== gitLogRefreshSeqRef.current) return
      console.error('获取 Git 版本历史失败:', err)
      startPanelStateTransition(() => setGitVersions([]))
    }
  }, [currentWorkspace, currentMode, startPanelStateTransition])

  /** 刷新 Git 工作区状态（已暂存/未暂存） */
  const refreshGitStatus = useCallback(async () => {
    const seq = ++gitStatusRefreshSeqRef.current
    if (!currentWorkspace) {
      startPanelStateTransition(() => setGitWorkingStatus({ staged: [], unstaged: [] }))
      setGitStatusLoaded(false)
      return
    }
    try {
      const status = await window.taco.git.status(currentWorkspace)
      if (seq !== gitStatusRefreshSeqRef.current) return
      startPanelStateTransition(() => {
        setGitWorkingStatus({
          staged: Array.isArray(status?.staged) ? status.staged : [],
          unstaged: Array.isArray(status?.unstaged) ? status.unstaged : [],
        })
      })
      setGitStatusLoaded(true)
    } catch (err) {
      if (seq !== gitStatusRefreshSeqRef.current) return
      console.error('获取 Git 工作区状态失败:', err)
      startPanelStateTransition(() => setGitWorkingStatus({ staged: [], unstaged: [] }))
      setGitStatusLoaded(true)
    }
  }, [currentWorkspace, startPanelStateTransition])

  type ProjectRefreshFlags = {
    tree: boolean
    gitStatus: boolean
    gitLog: boolean
    liveDiff: boolean
  }

  const autoRefreshFlags = useMemo<ProjectRefreshFlags>(() => ({
    tree: detailTreeExpanded,
    gitStatus: currentMode === 'agent' && detailChangesExpanded,
    gitLog: currentMode === 'agent' && detailGitExpanded,
    liveDiff: currentMode === 'agent' && liveDiffPriorityPaths.length > 0,
  }), [
    currentMode,
    detailTreeExpanded,
    detailChangesExpanded,
    detailGitExpanded,
    liveDiffPriorityPaths.length,
  ])
  const shouldWatchWorkspace = autoRefreshFlags.tree || autoRefreshFlags.gitStatus || autoRefreshFlags.liveDiff

  const refreshQueueRef = useRef<{
    pending: ProjectRefreshFlags
    timer: ReturnType<typeof window.setTimeout> | null
    running: boolean
    lastTreeAt: number
    lastGitStatusAt: number
    lastGitLogAt: number
  }>({
    pending: { tree: false, gitStatus: false, gitLog: false, liveDiff: false },
    timer: null,
    running: false,
    lastTreeAt: 0,
    lastGitStatusAt: 0,
    lastGitLogAt: 0,
  })
  const refreshFnsRef = useRef({
    refreshWorkspaceTree,
    refreshGitStatus,
    refreshGitLog,
    syncLiveNewContentByPath,
    sessionSending,
  })
  useEffect(() => {
    refreshFnsRef.current = {
      refreshWorkspaceTree,
      refreshGitStatus,
      refreshGitLog,
      syncLiveNewContentByPath,
      sessionSending,
    }
  }, [refreshWorkspaceTree, refreshGitStatus, refreshGitLog, syncLiveNewContentByPath, sessionSending])

  const runQueuedProjectRefresh = useCallback(async () => {
    const yieldToUI = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    const state = refreshQueueRef.current
    if (state.running) return
    state.running = true
    if (state.timer) {
      window.clearTimeout(state.timer)
      state.timer = null
    }
    try {
      while (true) {
        const pending = state.pending
        const shouldTree = pending.tree
        const shouldGitStatus = pending.gitStatus
        const shouldGitLog = pending.gitLog
        const shouldLiveDiff = pending.liveDiff

        state.pending = { tree: false, gitStatus: false, gitLog: false, liveDiff: false }

        if (!shouldTree && !shouldGitStatus && !shouldGitLog && !shouldLiveDiff) break

        const refreshFns = refreshFnsRef.current
        let didWork = false
        if (shouldTree) {
          const now = Date.now()
          const minTreeInterval = refreshFns.sessionSending ? 2800 : 1200
          if ((now - state.lastTreeAt) >= minTreeInterval) {
            didWork = true
            state.lastTreeAt = now
            await refreshFns.refreshWorkspaceTree()
            await yieldToUI()
          } else {
            state.pending.tree = true
          }
        }
        if (shouldGitStatus) {
          const now = Date.now()
          const minGitStatusInterval = refreshFns.sessionSending ? 1400 : 600
          if ((now - state.lastGitStatusAt) >= minGitStatusInterval) {
            didWork = true
            state.lastGitStatusAt = now
            await refreshFns.refreshGitStatus()
            await yieldToUI()
          } else {
            state.pending.gitStatus = true
          }
        }
        if (shouldLiveDiff) {
          didWork = true
          await refreshFns.syncLiveNewContentByPath()
          await yieldToUI()
        }

        if (shouldGitLog) {
          const now = Date.now()
          const canRefreshGitLog = !refreshFns.sessionSending || (now - state.lastGitLogAt >= 1200)
          if (canRefreshGitLog) {
            didWork = true
            state.lastGitLogAt = now
            await refreshFns.refreshGitLog()
            await yieldToUI()
          } else {
            // 限频期间保留请求，避免高频消息时反复打满 git log
            state.pending.gitLog = true
          }
        }

        if (!didWork && (state.pending.tree || state.pending.gitStatus || state.pending.gitLog)) {
          // 限频导致本轮未执行真实刷新时，短暂等待避免 busy loop 占满 CPU。
          await new Promise<void>((resolve) => {
            window.setTimeout(resolve, 220)
          })
        }
      }
    } finally {
      state.running = false
      const hasPending = state.pending.tree || state.pending.gitStatus || state.pending.gitLog || state.pending.liveDiff
      if (hasPending && !state.timer) {
        state.timer = window.setTimeout(() => {
          state.timer = null
          void runQueuedProjectRefresh()
        }, 80)
      }
    }
  }, [])

  const queueProjectRefresh = useCallback((flags: Partial<ProjectRefreshFlags>, debounceMs = 120) => {
    const state = refreshQueueRef.current
    state.pending.tree = state.pending.tree || !!flags.tree
    state.pending.gitStatus = state.pending.gitStatus || !!flags.gitStatus
    state.pending.gitLog = state.pending.gitLog || !!flags.gitLog
    state.pending.liveDiff = state.pending.liveDiff || !!flags.liveDiff

    if (debounceMs <= 0) {
      if (state.timer) {
        window.clearTimeout(state.timer)
        state.timer = null
      }
      void runQueuedProjectRefresh()
      return
    }

    if (state.timer) return
    state.timer = window.setTimeout(() => {
      state.timer = null
      void runQueuedProjectRefresh()
    }, debounceMs)
  }, [runQueuedProjectRefresh])

  // 切换工作区时：立即刷新目录树 + 启动文件监听
  useEffect(() => {
    setGitStatusLoaded(false)
    const initialFlags: Partial<ProjectRefreshFlags> = {
      tree: true, // 始终加载目录树，不管面板是否展开
      gitStatus: currentMode === 'agent' && detailChangesExpanded,
      gitLog: currentMode === 'agent' && detailGitExpanded,
    }
    if (initialFlags.tree || initialFlags.gitStatus || initialFlags.gitLog) {
      queueProjectRefresh(initialFlags, 0)
    }
  }, [currentWorkspace, currentMode, queueProjectRefresh])

  useEffect(() => {
    if (!currentWorkspace || !shouldWatchWorkspace) return
    window.taco.workspace.watch(currentWorkspace)
    return () => {
      window.taco.workspace.unwatch()
    }
  }, [currentWorkspace, shouldWatchWorkspace])

  // 切换会话/项目时刷新一次状态（去掉消息长度驱动，避免频繁重刷）
  useEffect(() => {
    if (!currentWorkspace) return
    const sessionRefreshFlags: Partial<ProjectRefreshFlags> = {
      gitStatus: currentMode === 'agent' && detailChangesExpanded,
      gitLog: currentMode === 'agent' && detailGitExpanded,
      liveDiff: currentMode === 'agent' && liveDiffPriorityPaths.length > 0,
    }
    if (sessionRefreshFlags.gitStatus || sessionRefreshFlags.gitLog || sessionRefreshFlags.liveDiff) {
      queueProjectRefresh({
        gitStatus: sessionRefreshFlags.gitStatus,
        gitLog: sessionRefreshFlags.gitLog,
        liveDiff: sessionRefreshFlags.liveDiff,
      }, 120)
    }
  }, [sessionId, currentWorkspace, currentMode, queueProjectRefresh])

  // 监听文件系统变化通知，自动刷新（合并到调度队列）
  useEffect(() => {
    const unsubscribe = window.taco.workspace.onChanged(() => {
      if (!autoRefreshFlags.tree && !autoRefreshFlags.gitStatus && !autoRefreshFlags.gitLog && !autoRefreshFlags.liveDiff) {
        return
      }
      queueProjectRefresh(autoRefreshFlags, 260)
    })
    return unsubscribe
  }, [autoRefreshFlags, queueProjectRefresh])

  useEffect(() => {
    if (!currentWorkspace || currentMode !== 'agent' || !changeSyncSignal) return
    if (!autoRefreshFlags.tree && !autoRefreshFlags.gitStatus && !autoRefreshFlags.liveDiff) return
    queueProjectRefresh({
      tree: autoRefreshFlags.tree,
      gitStatus: autoRefreshFlags.gitStatus,
      liveDiff: autoRefreshFlags.liveDiff,
    }, 80)
  }, [currentWorkspace, currentMode, changeSyncSignal, autoRefreshFlags, queueProjectRefresh])

  // 低频兜底轮询（监听漏事件时保持状态最终一致）
  useEffect(() => {
    if (!currentWorkspace || sessionSending) return
    if (!autoRefreshFlags.tree && !autoRefreshFlags.gitStatus && !autoRefreshFlags.gitLog && !autoRefreshFlags.liveDiff) return
    const intervalMs = 15000
    const timer = window.setInterval(() => {
      queueProjectRefresh(autoRefreshFlags, 120)
    }, intervalMs)
    return () => window.clearInterval(timer)
  }, [currentWorkspace, sessionSending, autoRefreshFlags, queueProjectRefresh])

  // Agent 一轮任务结束后立即做一次全量刷新，避免目录/变更面板停留旧状态
  const prevSessionSendingRef = useRef(false)
  useEffect(() => {
    const prev = prevSessionSendingRef.current
    prevSessionSendingRef.current = sessionSending
    if (!currentWorkspace || currentMode !== 'agent') return
    if (prev && !sessionSending) {
      if (autoRefreshFlags.tree || autoRefreshFlags.gitStatus || autoRefreshFlags.gitLog || autoRefreshFlags.liveDiff) {
        queueProjectRefresh(autoRefreshFlags, 0)
      }
    }
  }, [currentWorkspace, currentMode, sessionSending, autoRefreshFlags, queueProjectRefresh])

  useEffect(() => {
    if (!currentWorkspace) return
    if (!autoRefreshFlags.tree && !autoRefreshFlags.gitStatus && !autoRefreshFlags.gitLog && !autoRefreshFlags.liveDiff) return
    const handleFocusRefresh = () => {
      queueProjectRefresh(autoRefreshFlags, 0)
    }
    const handleVisibilityChange = () => {
      if (!document.hidden) handleFocusRefresh()
    }
    window.addEventListener('focus', handleFocusRefresh)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.removeEventListener('focus', handleFocusRefresh)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [currentWorkspace, autoRefreshFlags, queueProjectRefresh])

  const panelVisibilityRef = useRef({
    treeExpanded: detailTreeExpanded,
    changesExpanded: detailChangesExpanded,
    gitExpanded: detailGitExpanded,
    liveDiffTargetKey,
  })
  useEffect(() => {
    const prev = panelVisibilityRef.current
    panelVisibilityRef.current = {
      treeExpanded: detailTreeExpanded,
      changesExpanded: detailChangesExpanded,
      gitExpanded: detailGitExpanded,
      liveDiffTargetKey,
    }

    if (!currentWorkspace) return

    const nextFlags: Partial<ProjectRefreshFlags> = {}
    if (detailTreeExpanded && !prev.treeExpanded) {
      nextFlags.tree = true
    }
    if (currentMode === 'agent' && detailChangesExpanded && !prev.changesExpanded) {
      nextFlags.gitStatus = true
      if (liveDiffTargetKey) nextFlags.liveDiff = true
    }
    if (currentMode === 'agent' && detailGitExpanded && !prev.gitExpanded) {
      nextFlags.gitLog = true
    }
    if (currentMode === 'agent' && liveDiffTargetKey && liveDiffTargetKey !== prev.liveDiffTargetKey) {
      nextFlags.liveDiff = true
    }

    if (nextFlags.tree || nextFlags.gitStatus || nextFlags.gitLog || nextFlags.liveDiff) {
      queueProjectRefresh(nextFlags, 0)
    }
  }, [
    currentWorkspace,
    currentMode,
    detailTreeExpanded,
    detailChangesExpanded,
    detailGitExpanded,
    liveDiffTargetKey,
    queueProjectRefresh,
  ])

  useEffect(() => {
    return () => {
      const state = refreshQueueRef.current
      if (state.timer) {
        window.clearTimeout(state.timer)
        state.timer = null
      }
    }
  }, [])

  // （浏览器模式已统一为外部 BrowserWindow，不再需要模式切换）

  const currentBrowserAppId = tid
    ? `project-${tid.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 64)}`
    : 'default'

  /** 打开外部浏览器 */
  const openBrowser = useCallback((url: string) => {
    window.taco.browser.openExternal(url, currentBrowserAppId)
  }, [currentBrowserAppId])

  /** 关闭指定 appId 的外部浏览器 */
  const closeBrowser = useCallback((appId?: string) => {
    const id = appId || 'default'
    window.taco.browser.closeExternal(id)
    setBrowserWindows(prev => {
      const next = new Map(prev)
      next.delete(id)
      return next
    })
  }, [])

  // 监听主进程发来的打开 URL 事件（模式感知）
  useEffect(() => {
    const unsubscribe = window.taco.browser.onOpenUrl((url) => {
      openBrowser(url)
    })
    return unsubscribe
  }, [openBrowser])

  // 监听外部浏览器窗口状态（支持多 appId）
  useEffect(() => {
    const unsubscribe = window.taco.browser.onExternalStatus((status) => {
      const appId = status.appId || 'default'

      if (status.type === 'console') {
        const level = status.consoleLevel || 'log'
        const message = status.consoleMessage || ''
        const pageUrl = browserWindowsRef.current.get(appId) || ''
        const fromDevEnv = isDevBrowserUrl(pageUrl) || isDevBrowserUrl(status.consoleSource)

        const entry: BrowserConsoleEntry = {
          id: ++consoleIdRef.current,
          appId,
          level,
          message,
          source: status.consoleSource,
          line: status.consoleLine,
          timestamp: Date.now(),
        }

        // 存储日志
        setBrowserConsoleLogs(prev => {
          const next = [...prev, entry]
          return next.length > 500 ? next.slice(-500) : next
        })

        // 致命错误（页面加载失败、JS 运行时异常）仅记录候选；不再自动发送给 AI
        const isFatal = level === 'error' && (
          message.startsWith('[页面加载失败]') ||
          message.includes('Uncaught') ||
          message.includes('TypeError') ||
          message.includes('ReferenceError') ||
          message.includes('SyntaxError') ||
          message.includes('CORS') ||
          message.includes('ERR_')
        )
        if (isFatal && fromDevEnv) {
          rememberBrowserErrorCandidate(entry)
        }
        return
      }

      setBrowserWindows(prev => {
        const next = new Map(prev)
        if (status.type === 'opened' && status.url) {
          next.set(appId, status.url)
        } else if (status.type === 'closed') {
          next.delete(appId)
        } else if (status.type === 'navigated' && status.url) {
          next.set(appId, status.url)
        }
        return next
      })
    })
    return unsubscribe
  }, [rememberBrowserErrorCandidate])

  useEffect(() => {
    browserWindowsRef.current = browserWindows
  }, [browserWindows])

  // （浏览器自动化操作统一在主进程通过 CDP 执行，不再需要渲染进程中转）

  // 启动时同步浏览器设置到主进程
  useEffect(() => {
    const saved = localStorage.getItem('taco.browserAutoTakeover') === 'true'
    if (saved) window.taco.browser.setAutoTakeover(true)
    const debugSaved = localStorage.getItem('taco.browserDebugMode') === 'true'
    if (debugSaved) window.taco.browser.setDebugMode(true)
    const hiddenSavedRaw = localStorage.getItem('taco.browserHiddenMode')
    const hiddenSaved = hiddenSavedRaw === null ? true : hiddenSavedRaw === 'true'
    window.taco.browser.setHiddenMode(hiddenSaved)
    if (hiddenSavedRaw === null) {
      localStorage.setItem('taco.browserHiddenMode', 'true')
    }
    // 同步自动授权分类到主进程
    try {
      const autoApprove = localStorage.getItem('taco.autoApproveCategories')
      if (autoApprove) {
        const categories = JSON.parse(autoApprove) as string[]
        if (categories.length > 0) window.taco.agent.setAutoApprove(categories)
      }
    } catch { /* ignore */ }
  }, [])

  // 选中的文件变更信息
  const selectedFileChange = useMemo(
    () => effectiveFileChanges.find((fc) => fc.filePath === selectedFile) ?? null,
    [effectiveFileChanges, selectedFile]
  )

  // 右侧面板采用延后值，避免高频刷新时阻塞主线程
  const deferredWorkspaceTree = useDeferredValue(workspaceTree)
  const deferredFileChanges = useDeferredValue(effectiveFileChanges)
  const deferredGitStagedFiles = useDeferredValue(gitStagedFiles)
  const deferredGitUnstagedFiles = useDeferredValue(gitUnstagedFiles)

  // 文件变更审核状态：key = filePath, value = 'pending' | 'accepted' | 'rejected'
  // 按 sessionId 持久化到 localStorage
  const fileStatusKey = `taco.fileStatuses.${sessionId}`
  const [fileStatuses, setFileStatuses] = useState<Record<string, FileChangeStatus>>(() =>
    normalizeFileStatusMap(loadJson(fileStatusKey, {}), currentWorkspace)
  )

  const readFileStatus = useCallback((filePath: string): FileChangeStatus => {
    return (
      fileStatuses[filePath]
      ?? fileStatuses[filePath.replace(/\//g, '\\')]
      ?? 'pending'
    )
  }, [fileStatuses])

  /** 从当前会话手动变更列表中移除指定文件 */
  const removeManualChanges = useCallback((paths: string[]) => {
    if (!sessionId || paths.length === 0) return
    const normalizedTargets = new Set(
      paths.map((p) => normalizeWorkspaceRelativePath(p, currentWorkspace)).filter(Boolean)
    )
    if (normalizedTargets.size === 0) return
    setManualFileChangesBySession((prev) => {
      const current = prev[sessionId] ?? []
      const next = current.filter((fc) => !normalizedTargets.has(normalizeWorkspaceRelativePath(fc.filePath, currentWorkspace)))
      if (next.length === current.length) return prev
      return { ...prev, [sessionId]: next }
    })
  }, [sessionId, currentWorkspace])

  /** 生成 git add 的候选路径（兼容不同工作区层级与路径格式） */
  const buildGitStageCandidates = useCallback((filePath: string): string[] => {
    const set = new Set<string>()
    const push = (value: string) => {
      const v = String(value ?? '').trim()
      if (!v) return
      set.add(v)
      set.add(v.replace(/\\/g, '/'))
      set.add(v.replace(/\//g, '\\'))
    }

    const raw = String(filePath ?? '').trim()
    const normalized = normalizeWorkspaceRelativePath(raw, currentWorkspace) || normalizeSlashPath(raw)
    push(raw)
    push(normalized)

    if (currentWorkspace) {
      const workspaceNorm = normalizeSlashPath(currentWorkspace).replace(/\/+$/, '')
      const workspaceBase = workspaceNorm.split('/').pop() ?? ''
      if (workspaceBase) {
        const lowNorm = normalized.toLowerCase()
        const lowBase = workspaceBase.toLowerCase()
        if (lowNorm.startsWith(`${lowBase}/`)) {
          push(normalized.slice(workspaceBase.length + 1))
        }
      }
    }

    const abs = resolveFilePath(normalized || raw)
    push(abs)
    return Array.from(set).filter(Boolean)
  }, [currentWorkspace, resolveFilePath])

  const stageSingleFileWithFallback = useCallback(async (filePath: string) => {
    if (!currentWorkspace) throw new Error('未选择工作区')
    const candidates = buildGitStageCandidates(filePath)
    let lastErr: unknown = null
    for (const candidate of candidates) {
      try {
        await window.taco.git.stageFiles(currentWorkspace, [candidate])
        return
      } catch (err) {
        lastErr = err
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('暂存失败')
  }, [currentWorkspace, buildGitStageCandidates])

  /** 保存（接受）单个文件变更 */
  const handleAcceptFile = useCallback(async (filePath: string) => {
    if (!currentWorkspace) return
    const normalizedPath = normalizeWorkspaceRelativePath(filePath, currentWorkspace)
    const candidatePath = normalizedPath || filePath
    // 先本地乐观更新，确保右侧列表即时变化
    setGitWorkingStatus((prev) => {
      const staged = new Set(prev.staged ?? [])
      const unstaged = new Set(prev.unstaged ?? [])
      staged.add(candidatePath)
      unstaged.delete(candidatePath)
      unstaged.delete(candidatePath.replace(/\//g, '\\'))
      unstaged.delete(candidatePath.replace(/\\/g, '/'))
      return { staged: Array.from(staged), unstaged: Array.from(unstaged) }
    })
    setFileStatuses((prev) => ({ ...prev, [filePath]: 'accepted' }))
    try {
      await stageSingleFileWithFallback(filePath)
      queueProjectRefresh({
        tree: true,
        gitStatus: true,
        gitLog: currentMode === 'agent',
        liveDiff: currentMode === 'agent',
      }, 0)
    } catch (err) {
      setFileStatuses((prev) => ({ ...prev, [filePath]: 'pending', [candidatePath]: 'pending' }))
      queueProjectRefresh({
        tree: true,
        gitStatus: true,
        gitLog: currentMode === 'agent',
        liveDiff: currentMode === 'agent',
      }, 0)
      console.error('暂存文件候选路径:', buildGitStageCandidates(filePath))
      console.error('暂存文件失败:', filePath, err)
    }
  }, [currentWorkspace, currentMode, queueProjectRefresh, stageSingleFileWithFallback, buildGitStageCandidates])

  /** 记录文件编辑器产生的变更（用于实时更新右侧“变更文件”面板） */
  const handleFileEdited = useCallback((change: FileChangeInfo) => {
    if (!sessionId) return
    const normalizedPath = normalizeWorkspaceRelativePath(change.filePath, currentWorkspace)
    if (!normalizedPath) return
    const normalizedChange: FileChangeInfo = {
      filePath: normalizedPath,
      oldContent: change.oldContent,
      newContent: change.newContent,
    }
    setManualFileChangesBySession((prev) => {
      const current = prev[sessionId] ?? []
      const map = new Map<string, FileChangeInfo>()
      for (const item of current) map.set(item.filePath, item)
      const existing = map.get(normalizedPath)
      if (existing) {
        map.set(normalizedPath, {
          filePath: normalizedPath,
          oldContent: existing.oldContent,
          newContent: normalizedChange.newContent,
        })
      } else {
        map.set(normalizedPath, normalizedChange)
      }
      const merged = Array.from(map.values()).filter((fc) => fc.oldContent !== fc.newContent)
      return { ...prev, [sessionId]: merged }
    })
  }, [sessionId, currentWorkspace])

  /** 撤销（拒绝）单个文件变更 */
  const handleRejectFile = useCallback(async (filePath: string) => {
    const change = effectiveFileChanges.find((fc) => fc.filePath === filePath)
    if (!change) return
    const absPath = resolveFilePath(filePath)
    try {
      if (change.oldContent === null && change.newContent !== null) {
        // 撤销创建：Agent 新建了文件 → 删除它
        await window.taco.file.delete(absPath)
      } else if (change.oldContent !== null && change.newContent === null) {
        // 恢复删除：Agent 删除了文件 → 用旧内容重建它
        await window.taco.file.revert(absPath, change.oldContent)
      } else if (change.oldContent !== null && change.newContent !== null) {
        // 恢复修改：Agent 修改了文件 → 写回旧内容
        await window.taco.file.revert(absPath, change.oldContent)
      }
      setFileStatuses((prev) => ({ ...prev, [filePath]: 'rejected' }))
      removeManualChanges([filePath])
      queueProjectRefresh({
        tree: true,
        gitStatus: true,
        gitLog: currentMode === 'agent',
        liveDiff: currentMode === 'agent',
      }, 0)
    } catch (err) {
      console.error('撤销文件变更失败:', filePath, err)
    }
  }, [currentMode, effectiveFileChanges, resolveFilePath, removeManualChanges, queueProjectRefresh])

  /** 从文件树中删除文件 */
  const handleDeleteFile = useCallback(async (filePath: string) => {
    if (!currentWorkspace) return
    try {
      const absPath = resolveFilePath(filePath)
      await window.taco.file.delete(absPath)
      queueProjectRefresh({
        tree: true,
        gitStatus: true,
        gitLog: currentMode === 'agent',
        liveDiff: currentMode === 'agent',
      }, 0)
    } catch (err) {
      console.error('删除文件失败:', filePath, err)
    }
  }, [currentWorkspace, currentMode, resolveFilePath, queueProjectRefresh])

  /** 从文件树中删除目录 */
  const handleDeleteDirectory = useCallback(async (dirPath: string) => {
    if (!currentWorkspace) return
    try {
      const absPath = resolveFilePath(dirPath)
      await window.taco.file.deleteDirectory(absPath)
      queueProjectRefresh({
        tree: true,
        gitStatus: true,
        gitLog: currentMode === 'agent',
        liveDiff: currentMode === 'agent',
      }, 0)
    } catch (err) {
      console.error('删除目录失败:', dirPath, err)
    }
  }, [currentWorkspace, currentMode, resolveFilePath, queueProjectRefresh])

  /** 保存所有 pending 变更 */
  const handleAcceptAll = useCallback(async () => {
    if (!currentWorkspace) return
    // 先乐观更新，提供即时反馈
    setGitWorkingStatus((prev) => {
      const staged = new Set(prev.staged ?? [])
      for (const p of prev.unstaged ?? []) staged.add(p)
      for (const fc of effectiveFileChanges) {
        const normalized = normalizeWorkspaceRelativePath(fc.filePath, currentWorkspace)
        if (normalized) staged.add(normalized)
      }
      return { staged: Array.from(staged), unstaged: [] }
    })
    setFileStatuses((prev) => {
      const next = { ...prev }
      for (const fc of effectiveFileChanges) next[fc.filePath] = 'accepted'
      return next
    })
    try {
      try {
        await window.taco.git.stageAll(currentWorkspace)
      } catch (errAll) {
        const fallbackTargets = Array.from(new Set([
          ...gitUnstagedFiles,
          ...effectiveFileChanges.map((fc) => fc.filePath),
        ])).filter(Boolean)
        let successAny = false
        for (const p of fallbackTargets) {
          try {
            await stageSingleFileWithFallback(p)
            successAny = true
          } catch {
            // continue trying other paths
          }
        }
        if (!successAny) throw errAll
      }
      queueProjectRefresh({
        tree: true,
        gitStatus: true,
        gitLog: currentMode === 'agent',
        liveDiff: currentMode === 'agent',
      }, 0)
    } catch (err) {
      setFileStatuses((prev) => {
        const next = { ...prev }
        for (const fc of effectiveFileChanges) next[fc.filePath] = 'pending'
        return next
      })
      queueProjectRefresh({
        tree: true,
        gitStatus: true,
        gitLog: currentMode === 'agent',
        liveDiff: currentMode === 'agent',
      }, 0)
      console.error('暂存全部失败:', err)
    }
  }, [currentWorkspace, currentMode, effectiveFileChanges, gitUnstagedFiles, queueProjectRefresh, stageSingleFileWithFallback])

  /** 撤销所有 pending 变更 */
  const handleRejectAll = useCallback(async () => {
    const pending = effectiveFileChanges.filter(
      (fc) => readFileStatus(fc.filePath) === 'pending'
    )
    for (const change of pending) {
      const absPath = resolveFilePath(change.filePath)
      try {
        if (change.oldContent === null && change.newContent !== null) {
          // 撤销创建 → 删除
          await window.taco.file.delete(absPath)
        } else if (change.oldContent !== null && change.newContent === null) {
          // 恢复删除 → 重建
          await window.taco.file.revert(absPath, change.oldContent)
        } else if (change.oldContent !== null && change.newContent !== null) {
          // 恢复修改 → 写回旧内容
          await window.taco.file.revert(absPath, change.oldContent)
        }
        setFileStatuses((prev) => ({ ...prev, [change.filePath]: 'rejected' }))
      } catch (err) {
        console.error('撤销文件变更失败:', change.filePath, err)
      }
    }
    removeManualChanges(pending.map((fc) => fc.filePath))
    queueProjectRefresh({
      tree: true,
      gitStatus: true,
      gitLog: currentMode === 'agent',
      liveDiff: currentMode === 'agent',
    }, 0)
  }, [currentMode, effectiveFileChanges, readFileStatus, resolveFilePath, removeManualChanges, queueProjectRefresh])

  /** 回退到指定 Git 版本 */
  const handleGitRollback = useCallback(async (hash: string) => {
    if (!currentWorkspace) return
    try {
      await window.taco.git.rollback(currentWorkspace, hash)
      // 刷新版本历史
      await refreshGitLog()
      await refreshGitStatus()
      // 回退后清除文件审核状态（文件内容已变更）
      setFileStatuses({})
      if (sessionId) {
        setManualFileChangesBySession((prev) => ({ ...prev, [sessionId]: [] }))
      }
      await refreshWorkspaceTree()
    } catch (err) {
      console.error('Git 回退失败:', err)
    }
  }, [currentWorkspace, sessionId, refreshWorkspaceTree, refreshGitLog, refreshGitStatus])

  /** 回滚到某条消息之前的 Git 版本：reset 到该 commit 的父提交 */
  const handleRollbackBeforeMsg = useCallback(async (commitHash: string) => {
    if (!currentWorkspace) return
    try {
      // 回退到该提交的父版本（即 agent 操作之前的状态）
      await window.taco.git.rollback(currentWorkspace, `${commitHash}~1`)
      await refreshGitLog()
      await refreshGitStatus()
      setFileStatuses({})
      if (sessionId) {
        setManualFileChangesBySession((prev) => ({ ...prev, [sessionId]: [] }))
      }
      await refreshWorkspaceTree()
    } catch (err) {
      console.error('Git 回退失败:', err)
    }
  }, [currentWorkspace, sessionId, refreshWorkspaceTree, refreshGitLog, refreshGitStatus])

  /** 加载某个 Git 提交的变更文件列表 */
  const handleLoadCommitFiles = useCallback(async (hash: string): Promise<string[]> => {
    if (!currentWorkspace) return []
    try {
      return await window.taco.git.commitFiles(currentWorkspace, hash)
    } catch {
      return []
    }
  }, [currentWorkspace])

  // 用 ref 追踪当前 sessionId，避免切换会话时把旧数据保存到新 key
  const sessionIdRef = useRef(sessionId)
  sessionIdRef.current = sessionId

  // 持久化文件审核状态（仅在 fileStatuses 变化时保存，不跟踪 sessionId）
  useEffect(() => {
    if (sessionIdRef.current) {
      saveJson(`taco.fileStatuses.${sessionIdRef.current}`, fileStatuses)
    }
  }, [fileStatuses])

  // 切换会话时从 localStorage 加载该会话的审核状态
  useEffect(() => {
    if (sessionId) {
      setFileStatuses(normalizeFileStatusMap(loadJson(`taco.fileStatuses.${sessionId}`, {}), currentWorkspace))
    }
  }, [sessionId, currentWorkspace])

  // 同一会话切换 workspace 时，重置当前变更面板的上下文基线与临时状态
  useEffect(() => {
    if (!sessionId) return
    const prevWorkspace = lastWorkspaceBySessionRef.current[sessionId]
    if (prevWorkspace === undefined) {
      lastWorkspaceBySessionRef.current[sessionId] = currentWorkspace
      return
    }
    if (prevWorkspace !== currentWorkspace) {
      const baseline = messages.length
      setChangeStartIndexBySession((prev) => ({ ...prev, [sessionId]: baseline }))
      setManualFileChangesBySession((prev) => ({ ...prev, [sessionId]: [] }))
      setLiveFileChangeOverrides({})
      setFileStatuses({})
      setSelectedFile(null)
      setViewingFile(null)
      setViewingSelection(null)
    }
    lastWorkspaceBySessionRef.current[sessionId] = currentWorkspace
  }, [sessionId, currentWorkspace, messages.length])

  // 会话消息被清空/截断后，修正基线下标，避免新消息被错误过滤
  const currentSessionChangeStart = changeStartIndexBySession[sessionId] ?? 0
  useEffect(() => {
    if (!sessionId) return
    if (currentSessionChangeStart > messages.length) {
      setChangeStartIndexBySession((prev) => ({ ...prev, [sessionId]: messages.length }))
    }
  }, [sessionId, currentSessionChangeStart, messages.length])

  /* ---- smart auto-scroll ---- */
  // 用户是否在底部附近（50px 阈值），只有在底部时才自动滚动
  const isNearBottomRef = useRef(true)

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const threshold = 50
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold
  }, [])

  // 监听滚动事件
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [handleScroll])

  // 仅在用户处于底部时自动滚动
  useEffect(() => {
    if (!scrollRef.current || !isNearBottomRef.current) return
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages, sessionStreamingContent])

  // 切换项目或会话时重置到底部
  useEffect(() => {
    isNearBottomRef.current = true
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [sessionId])

  /* ---- handlers (cross-module coordination) ---- */

  /** 新建项目 */
  function handleNewThread() {
    threadStore.createThread('新项目', providerSettings.activeModelConfigId || undefined)
    setDraft('')
    setSelectedFile(null)
    setViewingFile(null)
    setViewingSelection(null)
    setShowTerminal(false)
  }

  function handleSwitchThread(id: string) {
    threadStore.switchThread(id)
    setDraft('')
    setSelectedFile(null)
    setViewingFile(null)
    setViewingSelection(null)
  }

  function handleDeleteThread(threadId: string) {
    // 删除项目时清除其所有会话的消息
    const thread = threadStore.threads.find((t) => t.id === threadId)
    if (thread) {
      for (const s of thread.sessions) {
        chat.deleteThreadMessages(s.id)
      }
      setManualFileChangesBySession((prev) => {
        const next = { ...prev }
        for (const s of thread.sessions) delete next[s.id]
        return next
      })
      setChangeStartIndexBySession((prev) => {
        const next = { ...prev }
        for (const s of thread.sessions) delete next[s.id]
        return next
      })
      for (const s of thread.sessions) {
        delete lastWorkspaceBySessionRef.current[s.id]
      }
    }
    chat.clearProjectTokenStats(threadId)
    threadStore.deleteThread(threadId)
  }

  /** 在当前项目内新建会话 */
  function handleNewSession() {
    if (!tid) return
    threadStore.createSession(tid)
    setDraft('')
    setSelectedFile(null)
    setViewingFile(null)
    setViewingSelection(null)
  }

  /** 切换当前项目内的会话 */
  function handleSwitchSession(sid: string) {
    if (!tid) return
    threadStore.switchSession(tid, sid)
    setDraft('')
    setSelectedFile(null)
    setViewingFile(null)
    setViewingSelection(null)
  }

  /** 删除当前项目内的某个会话 */
  function handleDeleteSession(sid: string) {
    if (!tid) return
    chat.deleteThreadMessages(sid)
    setManualFileChangesBySession((prev) => {
      const next = { ...prev }
      delete next[sid]
      return next
    })
    setChangeStartIndexBySession((prev) => {
      const next = { ...prev }
      delete next[sid]
      return next
    })
    delete lastWorkspaceBySessionRef.current[sid]
    threadStore.deleteSession(tid, sid)
  }

  function handleClearChat() {
    chat.clearMessages(sessionId)
    if (sessionId) {
      setManualFileChangesBySession((prev) => ({ ...prev, [sessionId]: [] }))
      setChangeStartIndexBySession((prev) => ({ ...prev, [sessionId]: 0 }))
    }
  }

  /** 选择工作空间目录 */
  async function handleSelectWorkspace() {
    const dir = await globalThis.window.taco.dialog.selectDirectory()
    if (dir && tid) {
      const nextWorkspace = normalizeSlashPath(dir).replace(/\/+$/, '')
      const prevWorkspace = normalizeSlashPath(currentWorkspace).replace(/\/+$/, '')
      if (sessionId && nextWorkspace !== prevWorkspace) {
        // 先记录当前消息下标，后续只展示新目录中的新增变更
        setChangeStartIndexBySession((prev) => ({ ...prev, [sessionId]: messages.length }))
        setManualFileChangesBySession((prev) => ({ ...prev, [sessionId]: [] }))
      }
      threadStore.updateThread(tid, { workspace: dir })
    }
  }

  /** 切换当前项目的模型配置 */
  function handleProviderChange(id: string) {
    if (tid) {
      threadStore.updateThread(tid, { modelConfigId: id })
    }
    providerSettings.setActiveModelConfigId(id)
  }

  const notifyTaskCompleted = useCallback((threadTitle?: string) => {
    if (currentMode !== 'agent') return
    const title = 'Taco AI 任务完成'
    const body = threadTitle?.trim()
      ? `项目「${threadTitle.trim()}」已执行完成`
      : '当前任务已执行完成'
    void window.taco.shell.notify({ title, body, silent: false })
  }, [currentMode])

  const applyMobileSelection = useCallback((target?: MobileTarget): MobileTarget => {
    if (!target) return {}
    const store = threadStoreRef.current
    const providerState = providerSettingsRef.current
    const currentThreadId = activeThreadIdRef.current
    const next: MobileTarget = {}
    let targetThreadId = target.threadId
    if (!targetThreadId && target.sessionId) {
      const owner = store.threads.find((t) => t.sessions.some((s) => s.id === target.sessionId))
      targetThreadId = owner?.id
    }
    if (targetThreadId && store.threads.some((t) => t.id === targetThreadId)) {
      store.switchThread(targetThreadId)
      next.threadId = targetThreadId
    }
    if (target.sessionId) {
      const owner = next.threadId
        ? store.threads.find((t) => t.id === next.threadId)
        : store.threads.find((t) => t.sessions.some((s) => s.id === target.sessionId))
      if (owner && owner.sessions.some((s) => s.id === target.sessionId)) {
        store.switchSession(owner.id, target.sessionId)
        next.threadId = owner.id
        next.sessionId = target.sessionId
      }
    }
    if (target.modelConfigId) {
      const modelId = String(target.modelConfigId || '').trim()
      if (modelId && providerState.getModelConfig(modelId)) {
        const threadId = next.threadId ?? currentThreadId
        if (threadId) store.updateThread(threadId, { modelConfigId: modelId })
        providerState.setActiveModelConfigId(modelId)
        next.modelConfigId = modelId
      }
    }
    return next
  }, [])

  /** 实际执行发送（使用 sessionId 作为消息存储 key） */
  function doSend(content: string, images?: AttachedImage[], attachments?: AttachedAsset[], target?: MobileTarget) {
    const threadId = target?.threadId ?? threadStore.ensureActiveThread()
    const thread = threadStore.threads.find((t) => t.id === threadId)
    const sid = target?.sessionId ?? thread?.activeSessionId ?? ''
    if (!sid) return
    const modelConfigId = String(
      target?.modelConfigId
      || thread?.modelConfigId
      || providerSettings.activeModelConfigId
      || '',
    ).trim()
    const modelConfig = providerSettings.getModelConfig(modelConfigId)
    if (!modelConfig || !modelConfig.provider) return
    if (threadId && thread?.modelConfigId !== modelConfigId) {
      threadStore.updateThread(threadId, { modelConfigId })
    }
    const mode: ThreadMode = 'agent'
    const workspace = thread?.workspace ?? ''
    const targetMaxTokens = resolveModelConfigMaxTokens(modelConfig)

    chat.sendMessage({
      threadId: sid,
      projectId: threadId,
      projectRules: thread?.projectRules ?? '',
      content,
      images,
      attachments,
      provider: modelConfig.provider,
      modelConfig,
      mode,
      workspace,
      maxTokens: targetMaxTokens,
      onFirstMessage: (title) => {
        const latestThread = threadStore.threads.find((t) => t.id === threadId)
        if (latestThread?.titleLocked) {
          threadStore.updateThread(threadId, { updatedAt: Date.now() })
          return
        }
        threadStore.updateThread(threadId, { title, updatedAt: Date.now(), titleLocked: false })
      },
      onComplete: () => {
        threadStore.updateThread(threadId, { updatedAt: Date.now() })
        notifyTaskCompleted(thread?.title)
      },
    })
  }
  // 保持 ref 指向最新的 doSend
  doSendRef.current = doSend

  // 移动端桥接：手机输入的指令直接作为当前会话用户消息发送
  useEffect(() => {
    const unsubscribe = window.taco.mobileBridge.onCommand((cmd) => {
      const text = cmd.text.trim()
      if (!text) return
      const selected = applyMobileSelection({
        threadId: cmd.threadId,
        sessionId: cmd.sessionId,
        modelConfigId: cmd.provider as string | undefined,
      })
      doSendRef.current(text, undefined, undefined, selected)
    })
    return unsubscribe
  }, [applyMobileSelection])

  // 移动端桥接：仅同步选择，不发送消息
  useEffect(() => {
    const unsubscribe = window.taco.mobileBridge.onSelect((sel) => {
      applyMobileSelection({
        threadId: sel.threadId,
        sessionId: sel.sessionId,
        modelConfigId: sel.provider as string | undefined,
      })
    })
    return unsubscribe
  }, [applyMobileSelection])

  // 移动端桥接：停止当前任务（与桌面 stop 语义一致，仅终止在执行任务，队列保留）
  useEffect(() => {
    const unsubscribe = window.taco.mobileBridge.onAbort((evt) => {
      const store = threadStoreRef.current
      const selected = applyMobileSelection({
        threadId: evt.threadId,
        sessionId: evt.sessionId,
      })
      const targetThreadId = selected.threadId ?? evt.threadId
      const targetSessionId =
        selected.sessionId ??
        evt.sessionId ??
        (targetThreadId ? store.threads.find((t) => t.id === targetThreadId)?.activeSessionId : undefined) ??
        activeSessionIdRef.current
      if (targetSessionId) {
        chatRef.current.stopSending(targetSessionId)
      }
    })
    return unsubscribe
  }, [applyMobileSelection])

  // 移动端桥接：确认/拒绝当前风险步骤（恢复 agent 执行）
  useEffect(() => {
    const unsubscribe = window.taco.mobileBridge.onConfirm((evt) => {
      applyMobileSelection({
        threadId: evt.threadId,
        sessionId: evt.sessionId,
      })
      if (!evt.confirmId) return
      window.taco.agent.confirmResponse(evt.confirmId, evt.approved === true)
    })
    return unsubscribe
  }, [applyMobileSelection])

  // 移动端桥接：在同一项目内新建会话
  useEffect(() => {
    const unsubscribe = window.taco.mobileBridge.onNewSession((evt) => {
      const store = threadStoreRef.current
      const selected = applyMobileSelection({ threadId: evt.threadId })
      const targetThreadId = selected.threadId ?? evt.threadId ?? activeThreadIdRef.current
      if (!targetThreadId) return
      const exists = store.threads.some((thread) => thread.id === targetThreadId)
      if (!exists) return
      store.switchThread(targetThreadId)
      store.createSession(targetThreadId)
    })
    return unsubscribe
  }, [applyMobileSelection])

  // 移动端桥接：清空会话记录（不删除会话本身）
  useEffect(() => {
    const unsubscribe = window.taco.mobileBridge.onClearSession((evt) => {
      const store = threadStoreRef.current
      const selected = applyMobileSelection({
        threadId: evt.threadId,
        sessionId: evt.sessionId,
      })
      const targetThreadId = selected.threadId ?? evt.threadId
      const targetSessionId =
        selected.sessionId ??
        evt.sessionId ??
        (targetThreadId ? store.threads.find((t) => t.id === targetThreadId)?.activeSessionId : undefined) ??
        activeSessionIdRef.current
      if (!targetSessionId) return
      chatRef.current.clearMessages(targetSessionId)
    })
    return unsubscribe
  }, [applyMobileSelection])

  const mobileBridgeSnapshot = useMemo<MobileBridgeContextSnapshot>(() => {
    const activeThreadId = tid || undefined
    const activeSessionId = sessionId || undefined
    const toMobileMessage = (msg: ChatMsg) => ({
      id: msg.id,
      role: msg.role,
      content: msg.content.slice(0, 4000),
      screenshotPaths: collectMessageScreenshotPaths(msg).map((p) => p.slice(0, 1024)),
      agentSteps: Array.isArray(msg.agentSteps)
        ? msg.agentSteps.map((step) => ({
          round: step.round,
          thinking: step.thinking.slice(0, 4000),
          status: step.status,
          confirmId: step.confirmId?.slice(0, 128),
          risks: step.risks?.map((r) => ({
            toolName: r.toolName.slice(0, 128),
            reason: r.reason.slice(0, 1000),
            detail: r.detail.slice(0, 2000),
            level: r.level,
          })),
          toolCalls: step.toolCalls.map((tc) => ({
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments.slice(0, 2000),
          })),
          toolResults: step.toolResults.map((tr) => ({
            tool_call_id: tr.tool_call_id,
            name: tr.name,
            content: tr.content.slice(0, 3000),
            success: tr.success,
            fileChange: tr.fileChange ? {
              filePath: tr.fileChange.filePath.slice(0, 1024),
              oldContent: tr.fileChange.oldContent?.slice(0, 12000) ?? null,
              newContent: tr.fileChange.newContent?.slice(0, 12000) ?? null,
            } : undefined,
          })),
        }))
        : undefined,
      activePlan: msg.activePlan
        ? {
          summary: msg.activePlan.summary.slice(0, 500),
          reasoning: msg.activePlan.reasoning?.slice(0, 1000),
          steps: msg.activePlan.steps.map((s) => ({
            text: s.text.slice(0, 500),
            status: s.status,
            note: s.note?.slice(0, 500),
          })),
        }
        : undefined,
    })

    return {
      updatedAt: Date.now(),
      activeThreadId,
      activeSessionId,
      activeProvider: currentModelConfigId || undefined,
      providers: providerSettings.configuredModels.map((p) => ({ id: p.id, label: p.label })),
      threads: threadStore.threads.map((thread) => {
        const isActiveThread = thread.id === activeThreadId
        const threadActiveSessionId = isActiveThread ? (activeSessionId ?? thread.activeSessionId) : ''
        const sessionContexts = thread.sessions.map((session) => {
          const sid = session.id
          const sessionMessages = chat.threadMessages[sid] ?? []
          const sessionMessageCount = chat.getSessionMessageCount(sid)
          const syncFull = isActiveThread && sid === threadActiveSessionId
          return {
            sessionId: sid,
            title: session.title,
            messageCount: sessionMessageCount,
            detailLevel: syncFull ? 'full' as const : 'meta' as const,
            messages: syncFull ? sessionMessages.map(toMobileMessage) : [],
            sending: Boolean(chat.sendingThreads[sid]),
            queue: syncFull ? (chat.queues[sid] ?? []).map((q) => q.content.slice(0, 500)) : [],
            streamingContent: syncFull ? String(chat.streamingContents[sid] ?? '').slice(0, 4000) : '',
          }
        })
        return {
          threadId: thread.id,
          title: thread.title,
          updatedAt: thread.updatedAt,
          provider: thread.modelConfigId,
          mode: thread.mode ?? 'agent',
          workspace: thread.workspace,
          activeSessionId: thread.activeSessionId,
          sessions: sessionContexts,
        }
      }),
    }
  }, [
    tid,
    sessionId,
    currentModelConfigId,
    providerSettings.configuredModels,
    threadStore.threads,
    chat.threadMessages,
    chat.sessionLoadMetaById,
    chat.sendingThreads,
    chat.queues,
    chat.streamingContents,
  ])

  const mobileBridgeSnapshotDigest = useMemo(
    () => buildMobileBridgeSnapshotDigest(mobileBridgeSnapshot),
    [mobileBridgeSnapshot],
  )

  // 移动端桥接：将桌面端当前会话历史/上下文同步到主进程缓存（去重 + 节流），供手机端查询
  useEffect(() => {
    if (mobileBridgeSnapshotDigest === lastMobileSnapshotDigestRef.current) return
    if (mobileSyncTimerRef.current != null) {
      window.clearTimeout(mobileSyncTimerRef.current)
      mobileSyncTimerRef.current = null
    }
    mobileSyncTimerRef.current = window.setTimeout(() => {
      window.taco.mobileBridge.syncContext(mobileBridgeSnapshot)
      lastMobileSnapshotDigestRef.current = mobileBridgeSnapshotDigest
      mobileSyncTimerRef.current = null
    }, 120)
  }, [mobileBridgeSnapshot, mobileBridgeSnapshotDigest])

  useEffect(() => () => {
    if (mobileSyncTimerRef.current != null) {
      window.clearTimeout(mobileSyncTimerRef.current)
      mobileSyncTimerRef.current = null
    }
  }, [])

  /** 重新发送：保留该消息，删掉之后的回复，重新请求 */
  async function handleResend(msgId: string) {
    if (sessionSending || !sessionId || !currentModelConfig || !currentProvider) return
    await chat.ensureSessionFullyLoaded(sessionId)
    const latestMessages = chat.getMessages(sessionId)
    const idx = latestMessages.findIndex((m) => m.id === msgId)
    if (idx === -1) return
    chat.setMessages(sessionId, latestMessages.slice(0, idx + 1))
    chat.resendFromExisting({
      threadId: sessionId,
      projectId: tid,
      projectRules: currentProjectRules,
      provider: currentProvider,
      modelConfig: currentModelConfig,
      mode: currentMode,
      workspace: currentWorkspace,
      onComplete: () => {
        threadStore.updateThread(tid, { updatedAt: Date.now() })
        notifyTaskCompleted(threadStore.activeThread?.title)
      },
    })
  }

  /** 编辑后重新发送：更新原消息内容，删掉之后的回复，重新请求 */
  async function handleEditResend(msgId: string, newContent: string) {
    if (sessionSending || !sessionId || !currentModelConfig || !currentProvider) return
    await chat.ensureSessionFullyLoaded(sessionId)
    const latestMessages = chat.getMessages(sessionId)
    const idx = latestMessages.findIndex((m) => m.id === msgId)
    if (idx === -1) return
    const updated = latestMessages.slice(0, idx + 1)
    updated[idx] = { ...updated[idx], content: newContent }
    chat.setMessages(sessionId, updated)
    chat.resendFromExisting({
      threadId: sessionId,
      projectId: tid,
      projectRules: currentProjectRules,
      provider: currentProvider,
      modelConfig: currentModelConfig,
      mode: currentMode,
      workspace: currentWorkspace,
      onComplete: () => {
        threadStore.updateThread(tid, { updatedAt: Date.now() })
        notifyTaskCompleted(threadStore.activeThread?.title)
      },
    })
  }

  function handleSend(images?: AttachedImage[], attachments?: AttachedAsset[]) {
    const content = draft.trim()
    if (
      (!content && (!images || images.length === 0) && (!attachments || attachments.length === 0))
      || providerSettings.configuredModels.length === 0
    ) return
    setDraft('')

    if (sessionSending) {
      // 当前会话正在请求 → 加入该会话的队列（队列不支持图片，仅文本）
      chat.addToQueue(sessionId, content || (images && images.length > 0 ? '(图片消息)' : '(附件消息)'))
    } else {
      // 空闲 → 直接发送
      const fallback = images && images.length > 0 ? '请分析这张图片' : '请查看这些附件'
      doSend(content || fallback, images, attachments)
    }
  }

  /** 在中间区域打开文件（右侧目录树点击普通文件时调用） */
  const handleOpenFileView = useCallback((filePath: string, forceDiff?: boolean, selection?: { line: number; column: number } | null) => {
    // 确保切换到聊天视图（FileEditor / DiffView 在 ChatPanel 内渲染）
    setMiddleView('chat')
    if (forceDiff) {
      // 变更文件面板点击 → 走 Diff 视图
      setSelectedFile(selectedFile === filePath ? null : filePath)
      setViewingFile(null)
      setViewingSelection(null)
    } else {
      // 目录树点击 → 永远走编辑模式
      if (selection) {
        setViewingFile(filePath)
        setViewingSelection({
          line: Math.max(1, Math.floor(selection.line)),
          column: Math.max(1, Math.floor(selection.column)),
        })
      } else {
        setViewingFile(viewingFile === filePath ? null : filePath)
        setViewingSelection(null)
      }
      setSelectedFile(null)
    }
  }, [selectedFile, viewingFile])

  /** 关闭文件编辑器 */
  const handleCloseFileEditor = useCallback(() => {
    setViewingFile(null)
    setViewingSelection(null)
  }, [])

  // （浏览器错误反馈统一在外部浏览器窗口处理）

  /** 从编辑器切换到 Diff 视图 */
  const handleViewDiffFromEditor = useCallback(() => {
    if (viewingFile) {
      const isChanged = effectiveFileChanges.some((fc) => fc.filePath === viewingFile)
      if (isChanged) {
        setSelectedFile(viewingFile)
        setViewingFile(null)
        setViewingSelection(null)
      }
    }
  }, [viewingFile, effectiveFileChanges])

  const reportPaneRenderError = useCallback((pane: string, error: Error, info: ErrorInfo) => {
    void window.taco.shell.reportRendererError({
      source: `pane:${pane}`,
      message: error.message || String(error),
      stack: error.stack,
      componentStack: info.componentStack,
      projectId: tid || undefined,
      workspace: currentWorkspace || undefined,
      metadata: {
        pane,
        threadId: tid || undefined,
        sessionId: sessionId || undefined,
        mode: currentMode,
        middleView,
        sidebarVisible,
        detailTreeExpanded,
        detailChangesExpanded,
        detailGitExpanded,
      },
    }).catch(() => {
      // ignore logging failures
    })
  }, [
    tid,
    currentWorkspace,
    sessionId,
    currentMode,
    middleView,
    sidebarVisible,
    detailTreeExpanded,
    detailChangesExpanded,
    detailGitExpanded,
  ])

  /* ---- render ---- */
  const drag = useDrag()
  const platform = globalThis.window.taco.system.platform
  const showWindowControls = platform === 'win32'
  const hasMacTrafficLights = platform === 'darwin'
  const activeThreadTitle = threadStore.activeThread?.title ?? '新项目'
  const clampedSidebarRatio = clampNumber(sidebarWidthRatio, sidebarMinRatio, sidebarMaxRatio)
  const clampedSidebarWidth = sidebarAreaWidth > 0 ? clampedSidebarRatio * sidebarAreaWidth : 0
  const effectiveSidebarWidth = sidebarVisible ? clampedSidebarWidth : 0
  const gridStyle = {
    gridTemplateRows: '48px minmax(0, 1fr)',
    gridTemplateColumns: `${effectiveSidebarWidth}px 0px minmax(0, 1fr) 0px minmax(${DETAIL_MIN_WIDTH}px, ${effectiveDetailWidth}px)`,
  }

  return (
    <div ref={appShellRef} className="app-shell" style={gridStyle}>
      <header
        className={`topbar app-topbar draggable ${hasMacTrafficLights ? 'has-native-traffic-lights' : ''}`}
        style={{ gridColumn: '1 / 6', gridRow: '1 / 2' }}
        {...drag}
        onDoubleClick={(e) => {
          const target = e.target as HTMLElement
          if (target.closest('.no-drag')) return
          globalThis.window.taco.window.toggleMaximize()
        }}
      >
        <div className="app-topbar-left">
          <button
            type="button"
            className="sidebar-fixed-toggle no-drag"
            onClick={() => setSidebarVisible((v) => !v)}
            title={sidebarVisible ? '隐藏左侧项目栏' : '显示左侧项目栏'}
            aria-label={sidebarVisible ? '隐藏左侧项目栏' : '显示左侧项目栏'}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <rect x="2.25" y="2.25" width="11.5" height="11.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <path d="M6 3.2v9.6" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              {sidebarVisible ? (
                <path d="M8 6.4 6.6 8 8 9.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              ) : (
                <path d="M7.2 6.4 8.6 8 7.2 9.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              )}
            </svg>
          </button>
        </div>

        <div className="app-topbar-center">
          <div className="topbar-title app-topbar-title" title={activeThreadTitle}>
            {activeThreadTitle}
          </div>
        </div>

        <div className={`topbar-actions app-topbar-right ${showWindowControls ? 'has-window-controls' : ''}`}>
          <div className="topbar-main-actions no-drag">
            {updateStatus?.success && updateStatus.hasUpdate && (
              <button
                className="pill update-pill"
                type="button"
                onClick={() => handleOpenUpdateDialog()}
                disabled={updateChecking}
                title="点击查看并升级新版本"
              >
                {updateChecking ? '检查更新中...' : `新版本 v${updateStatus.latestVersion || ''}`}
              </button>
            )}
            <button
              className={`pill terminal-toggle ${showTerminal ? 'active' : ''}`}
              type="button"
              onClick={() => setShowTerminal((v) => !v)}
              title={showTerminal ? '关闭终端' : '打开终端'}
            >
              {'>'}_
            </button>
            {messages.length > 0 && (
              <button className="pill" type="button" onClick={handleClearChat}>
                清空
              </button>
            )}
            <button className="pill new-session-btn" type="button" onClick={handleNewSession} title="在当前项目中新建会话">
              + 新建会话
            </button>
          </div>
          {showWindowControls && (
            <div className="window-controls no-drag">
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

      <div
        style={{
          gridColumn: '1 / 2',
          gridRow: '2 / 3',
          display: 'block',
          height: '100%',
          width: '100%',
          minWidth: 0,
          minHeight: 0,
          overflow: 'hidden',
          visibility: sidebarVisible ? 'visible' : 'hidden',
          pointerEvents: sidebarVisible ? 'auto' : 'none',
        }}
      >
        <PaneErrorBoundary
          pane="sidebar"
          title="项目侧栏"
          resetKey={`${tid}:${threadStore.sortedThreads.length}:${sidebarVisible ? '1' : '0'}`}
          onError={reportPaneRenderError}
        >
          <Sidebar
            sortedThreads={threadStore.sortedThreads}
            activeThreadId={tid}
            editingThreadId={threadStore.editingThreadId}
            editingTitle={threadStore.editingTitle}
            onEditingTitleChange={threadStore.setEditingTitle}
            onNewThread={handleNewThread}
            onSwitchThread={handleSwitchThread}
            onRenameStart={threadStore.startRename}
            onRenameCommit={threadStore.commitRename}
            onCancelRename={threadStore.cancelRename}
            onDeleteThread={handleDeleteThread}
            onReorderThread={threadStore.reorderThread}
            onOpenSettings={() => { setShowSettings(true); setMiddleView('settings') }}
            isSending={isThreadSending}
            isCompleted={isThreadCompleted}
            contextPercent={contextPercent}
          />
        </PaneErrorBoundary>
      </div>

      <div
        className="resize-handle resize-handle-left"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整项目列表宽度"
        tabIndex={0}
        onMouseDown={handleSidebarResizeMouseDown}
        style={{
          gridColumn: '2 / 3',
          gridRow: '2 / 3',
          visibility: sidebarVisible ? 'visible' : 'hidden',
          pointerEvents: sidebarVisible ? 'auto' : 'none',
        }}
      >
        <div className="resize-handle-line" />
      </div>

      {/* 中间区域：多视图叠加，用 CSS 控制显隐（保持浏览器状态） */}
      <div className="middle-area" style={{ gridColumn: '3 / 4', gridRow: '2 / 3', width: '100%', minWidth: 0 }}>
        {/* 外部浏览器打开时显示切换标签（支持多窗口） */}
        {browserWindows.size > 0 && (
          <div className="middle-tabs">
            <button
              type="button"
              className={`middle-tab ${middleView === 'chat' ? 'active' : ''}`}
              onClick={() => { setMiddleView('chat'); setShowSettings(false) }}
            >
              聊天
            </button>
            {Array.from(browserWindows.entries()).map(([appId, url]) => (
              <button
                key={appId}
                type="button"
                className="middle-tab"
                onClick={() => {
                  window.taco.browser.focusExternal(appId)
                }}
                title={url || `浏览器 [${appId}]`}
              >
                🌐 {appId === 'default' ? '浏览器' : appId}
                <span
                  className="middle-tab-close"
                  onClick={(e) => { e.stopPropagation(); closeBrowser(appId) }}
                  title="关闭浏览器"
                >
                  ✕
                </span>
              </button>
            ))}
          </div>
        )}

        {/* 设置视图 */}
        {middleView === 'settings' && showSettings && (
          <div className="middle-view">
            <PaneErrorBoundary
              pane="settings"
              title="设置面板"
              resetKey={`${showSettings ? '1' : '0'}:${tid}:${currentWorkspace}`}
              onError={reportPaneRenderError}
            >
              <SettingsPage
                modelConfigs={providerSettings.modelConfigs}
                activeModelConfigId={providerSettings.activeModelConfigId}
                onSetActiveModelConfigId={providerSettings.setActiveModelConfigId}
                onAddModelConfig={providerSettings.addModelConfig}
                onUpdateModelConfig={providerSettings.updateModelConfig}
                onRemoveModelConfig={providerSettings.removeModelConfig}
                guiPlusForm={guiPlusSettings.guiPlusForm}
                onUpdateGuiPlusField={guiPlusSettings.updateGuiPlusField}
                themeMode={themeMode}
                onThemeModeChange={setThemeMode}
                projectRules={currentProjectRules}
                onProjectRulesChange={(rules) => {
                  if (!tid) return
                  threadStore.updateThread(tid, { projectRules: rules })
                }}
                onClose={() => { setShowSettings(false); setMiddleView('chat') }}
                workspace={currentWorkspace}
                projectId={tid}
              />
            </PaneErrorBoundary>
          </div>
        )}

        {/* 聊天视图 */}
        <div className="middle-view" style={{ display: middleView === 'chat' || (middleView === 'settings' && !showSettings) ? 'flex' : 'none' }}>
          <PaneErrorBoundary
            pane="chat"
            title="聊天面板"
            resetKey={`${sessionId}:${messages.length}:${selectedFile ?? ''}:${viewingFile ?? ''}`}
            onError={reportPaneRenderError}
          >
            <ChatPanel
              messages={messages}
              showStreamBubble={showStreamBubble}
              streamingContent={sessionStreamingContent}
              draft={draft}
              onDraftChange={setDraft}
              sending={sessionSending}
              onSend={handleSend}
              onStop={() => sessionId && chat.stopSending(sessionId)}
              onSwitchSession={handleSwitchSession}
              onDeleteSession={handleDeleteSession}
              sessions={sessions}
              activeSessionId={sessionId}
              onResend={handleResend}
              onEditResend={handleEditResend}
              workspace={currentWorkspace}
              onSelectWorkspace={handleSelectWorkspace}
              provider={currentModelConfigId}
              onProviderChange={handleProviderChange}
              configuredProviders={providerSettings.configuredModels}
              scrollRef={scrollRef}
              totalMessageCount={totalSessionMessageCount}
              hasOlderStoredMessages={chat.hasOlderMessages(sessionId)}
              loadingOlderMessages={chat.isLoadingOlderMessages(sessionId)}
              onLoadOlderMessages={() => chat.loadOlderMessages(sessionId)}
              queue={sessionQueue}
              onRemoveFromQueue={(id) => chat.removeFromQueue(sessionId, id)}
              editor={editor}
              isSessionSending={(sid) => chat.isSending(sid)}
              selectedFileChange={selectedFileChange}
              onCloseDiff={() => setSelectedFile(null)}
              selectedFileStatus={selectedFile
                ? (stagedFileSet.has(selectedFile)
                  ? 'accepted'
                  : (unstagedFileSet.has(selectedFile)
                    ? 'pending'
                    : (fileStatuses[selectedFile] || 'pending')))
                : undefined}
              onAcceptFile={handleAcceptFile}
              onRejectFile={handleRejectFile}
              showTerminal={showTerminal}
              onToggleTerminal={() => setShowTerminal((v) => !v)}
              terminalCwd={currentWorkspace || undefined}
              onRollbackBeforeMsg={handleRollbackBeforeMsg}
              viewingFile={viewingFile}
              viewingSelection={viewingSelection}
              viewingWorkspace={currentWorkspace || undefined}
              onCloseFileEditor={handleCloseFileEditor}
              onFileSaved={() => {
                queueProjectRefresh({
                  tree: true,
                  gitStatus: true,
                  gitLog: currentMode === 'agent',
                  liveDiff: currentMode === 'agent',
                }, 0)
              }}
              onFileEdited={handleFileEdited}
              onViewDiffFromEditor={handleViewDiffFromEditor}
              onOpenFileView={handleOpenFileView}
              activeTaskStartedAt={activeTaskStartedAt}
            />
          </PaneErrorBoundary>
        </div>
      </div>

      {/* 拖拽调整中间/右侧面板大小的分隔条 */}
      <div
        className="resize-handle resize-handle-right"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整面板大小"
        tabIndex={0}
        onMouseDown={handleResizeMouseDown}
        style={{ gridColumn: '4 / 5', gridRow: '2 / 3' }}
      >
        <div className="resize-handle-line" />
      </div>

      <div style={{ gridColumn: '5 / 6', gridRow: '2 / 3', minWidth: 0, minHeight: 0, width: '100%', display: 'flex', overflow: 'hidden' }}>
        <PaneErrorBoundary
          pane="detail"
          title="右侧详情面板"
          resetKey={`${currentWorkspace}:${selectedFile ?? ''}:${detailTreeExpanded ? '1' : '0'}:${detailChangesExpanded ? '1' : '0'}:${detailGitExpanded ? '1' : '0'}`}
          onError={reportPaneRenderError}
        >
          <DetailPanel
            title={threadStore.activeThread?.title ?? '未选择项目'}
            messageCount={messages.length}
            providerLabel={
              providerSettings.configuredModels.length > 0 ? activeProviderLabel : undefined
            }
            contextPercent={contextPercent}
            usedTokens={usedTokens}
            maxTokens={maxTokens}
            projectTokenStats={projectTokenStats}
            workspaceTree={deferredWorkspaceTree}
            fileChanges={deferredFileChanges.length > 0 ? deferredFileChanges : undefined}
            selectedFile={selectedFile}
            onSelectFile={setSelectedFile}
            fileStatuses={fileStatuses}
            onAcceptFile={handleAcceptFile}
            onRejectFile={handleRejectFile}
            onAcceptAll={handleAcceptAll}
            onRejectAll={handleRejectAll}
            stagedFiles={deferredGitStagedFiles}
            unstagedFiles={deferredGitUnstagedFiles}
            gitStatusLoaded={gitStatusLoaded}
            onStageFile={handleAcceptFile}
            onStageAll={handleAcceptAll}
            gitVersions={gitVersions}
            onGitRollback={handleGitRollback}
            onLoadCommitFiles={handleLoadCommitFiles}
            workspace={currentWorkspace}
            treeExpanded={detailTreeExpanded}
            onTreeExpandedChange={setDetailTreeExpanded}
            changesExpanded={detailChangesExpanded}
            onChangesExpandedChange={setDetailChangesExpanded}
            gitExpanded={detailGitExpanded}
            onGitExpandedChange={setDetailGitExpanded}
            onRefreshTree={() => {
              queueProjectRefresh({
                tree: true,
                gitStatus: true,
                gitLog: currentMode === 'agent',
                liveDiff: currentMode === 'agent',
              }, 0)
            }}
            onOpenFileView={handleOpenFileView}
            viewingFile={viewingFile}
            onDeleteFile={handleDeleteFile}
            onDeleteDirectory={handleDeleteDirectory}
          />
        </PaneErrorBoundary>
      </div>

    </div>
  )
}
