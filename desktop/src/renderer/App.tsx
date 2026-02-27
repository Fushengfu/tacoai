import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChatMsg, FileChangeInfo, FileChangeStatus, GitVersionCommit, ProviderId, ThreadMode } from './types'
import type { EditorId, FileTreeEntry, BrowserConsoleLevel, MobileBridgeContextSnapshot } from '../shared/ipc'
import { providers, estimateTokens, buildSystemPrompt, resolveProviderDisplayLabel, resolveProviderMaxTokens } from './constants'
import { loadJson, saveJson } from './lib/storage'
import { useThreads } from './hooks/useThreads'
import { useChat } from './hooks/useChat'
import { useProviderSettings } from './hooks/useProviderSettings'
import { useGuiPlusSettings } from './hooks/useGuiPlusSettings'
import { Sidebar } from './components/Sidebar'
import { ChatPanel } from './components/ChatPanel'
import { DetailPanel } from './components/DetailPanel'
import { SettingsPage } from './components/SettingsModal'
import { useResize } from './hooks/useResize'

const DEV_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1'])

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
  const { width: detailWidth, handleMouseDown: handleResizeMouseDown } = useResize(
    340, 260, 700, 'taco.detailPanelWidth'
  )

  /* ---- local UI state ---- */
  const [draft, setDraft] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  /** 当前在中间区域查看/编辑的文件（非变更文件） */
  const [viewingFile, setViewingFile] = useState<string | null>(null)
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
  type MobileTarget = { threadId?: string; sessionId?: string; provider?: ProviderId; mode?: ThreadMode }
  const doSendRef = useRef<(content: string, images?: import('../types').AttachedImage[], target?: MobileTarget) => void>(() => {})
  /** 中间区域当前视图：chat / settings */
  type MiddleView = 'chat' | 'settings'
  const [middleView, setMiddleView] = useState<MiddleView>('chat')
  const [editor, setEditor] = useState<EditorId>(() =>
    (localStorage.getItem('taco.editor') as EditorId) || 'cursor'
  )
  const scrollRef = useRef<HTMLDivElement>(null)

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

  function handleEditorChange(id: EditorId) {
    setEditor(id)
    localStorage.setItem('taco.editor', id)
  }

  /* ---- derived ---- */
  const tid = threadStore.activeThreadId                           // 当前项目 ID
  const sessionId = threadStore.activeThread?.activeSessionId ?? '' // 当前会话 ID
  const sessions = threadStore.activeThread?.sessions ?? []

  // 消息、发送状态等全部以 sessionId 为 key
  const messages = chat.getMessages(sessionId)
  const sessionSending = chat.isSending(sessionId)
  const sessionStreamingContent = chat.getStreamingContent(sessionId)
  const sessionQueue = chat.getQueue(sessionId)

  // 当前项目的模式和工作空间
  const currentMode: ThreadMode = threadStore.activeThread?.mode ?? 'chat'

  // Agent 模式下文本已在消息内实时更新，不需要独立的流式气泡
  const showStreamBubble = sessionSending && currentMode !== 'agent'
  const currentWorkspace: string = threadStore.activeThread?.workspace ?? ''

  // 当前项目使用的 provider（项目级 > 全局默认）
  const currentProvider: ProviderId =
    threadStore.activeThread?.provider ?? providerSettings.activeProvider
  const activeProviderLabel = resolveProviderDisplayLabel(
    currentProvider,
    providerSettings.providerForms[currentProvider]
  )

  // 上下文窗口使用量
  const usedTokens = estimateTokens(
    buildSystemPrompt({
      mode: currentMode,
      workspace: currentWorkspace,
      provider: currentProvider,
      model: providerSettings.providerForms[currentProvider]?.model,
    })
  ) +
    messages.reduce((sum, m) => sum + estimateTokens(m.content), 0)
  const maxTokens = resolveProviderMaxTokens(currentProvider, providerSettings.providerForms[currentProvider])
  const contextPercent = Math.min(Math.round((usedTokens / maxTokens) * 100), 100)

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
  const fileChanges: FileChangeInfo[] = useMemo(() => {
    if (currentMode !== 'agent') return []
    const changes: FileChangeInfo[] = []
    for (const msg of messages) {
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
  }, [messages, currentMode, currentWorkspace])

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

  // 工作区目录树
  const [workspaceTree, setWorkspaceTree] = useState<FileTreeEntry[]>([])

  /** 刷新工作区目录树 */
  const refreshWorkspaceTree = useCallback(async () => {
    if (!currentWorkspace) {
      setWorkspaceTree([])
      return
    }
    try {
      const tree = await window.taco.workspace.tree(currentWorkspace)
      setWorkspaceTree(tree)
    } catch (err) {
      console.error('读取工作区目录失败:', err)
      setWorkspaceTree([])
    }
  }, [currentWorkspace])

  // 切换工作区时：立即刷新目录树 + 启动文件监听
  useEffect(() => {
    refreshWorkspaceTree()
    if (currentWorkspace) {
      window.taco.workspace.watch(currentWorkspace)
    }
    return () => {
      window.taco.workspace.unwatch()
    }
  }, [currentWorkspace, refreshWorkspaceTree])

  // Git 版本历史
  const [gitVersions, setGitVersions] = useState<GitVersionCommit[]>([])

  /** 刷新 Git 版本历史 */
  const refreshGitLog = useCallback(async () => {
    if (!currentWorkspace || currentMode !== 'agent') {
      setGitVersions([])
      return
    }
    try {
      const commits = await window.taco.git.log(currentWorkspace)
      setGitVersions(commits)
    } catch (err) {
      console.error('获取 Git 版本历史失败:', err)
      setGitVersions([])
    }
  }, [currentWorkspace, currentMode])

  // 切换会话/项目 或 消息变化时刷新 Git 日志
  useEffect(() => {
    refreshGitLog()
  }, [refreshGitLog, sessionId, messages.length])

  // 监听文件系统变化通知，自动刷新目录树 + Git 版本历史
  useEffect(() => {
    const unsubscribe = window.taco.workspace.onChanged(() => {
      refreshWorkspaceTree()
      refreshGitLog()
    })
    return unsubscribe
  }, [refreshWorkspaceTree, refreshGitLog])

  // （浏览器模式已统一为外部 BrowserWindow，不再需要模式切换）

  /** 打开外部浏览器 */
  const openBrowser = useCallback((url: string) => {
    window.taco.browser.openExternal(url)
  }, [])

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
    () => dedupedFileChanges.find((fc) => fc.filePath === selectedFile) ?? null,
    [dedupedFileChanges, selectedFile]
  )

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

  /** 保存（接受）单个文件变更 */
  const handleAcceptFile = useCallback((filePath: string) => {
    setFileStatuses((prev) => ({ ...prev, [filePath]: 'accepted' }))
  }, [])

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

  /** 撤销（拒绝）单个文件变更 */
  const handleRejectFile = useCallback(async (filePath: string) => {
    const change = dedupedFileChanges.find((fc) => fc.filePath === filePath)
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
      refreshGitLog()
    } catch (err) {
      console.error('撤销文件变更失败:', filePath, err)
    }
  }, [dedupedFileChanges, resolveFilePath, refreshGitLog])

  /** 保存所有 pending 变更 */
  const handleAcceptAll = useCallback(() => {
    setFileStatuses((prev) => {
      const next = { ...prev }
      for (const fc of dedupedFileChanges) {
        if (!next[fc.filePath] || next[fc.filePath] === 'pending') {
          next[fc.filePath] = 'accepted'
        }
      }
      return next
    })
  }, [dedupedFileChanges])

  /** 撤销所有 pending 变更 */
  const handleRejectAll = useCallback(async () => {
    const pending = dedupedFileChanges.filter(
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
    refreshGitLog()
  }, [dedupedFileChanges, readFileStatus, resolveFilePath, refreshGitLog])

  /** 回退到指定 Git 版本 */
  const handleGitRollback = useCallback(async (hash: string) => {
    if (!currentWorkspace) return
    try {
      await window.taco.git.rollback(currentWorkspace, hash)
      // 刷新版本历史
      await refreshGitLog()
      // 回退后清除文件审核状态（文件内容已变更）
      setFileStatuses({})
    } catch (err) {
      console.error('Git 回退失败:', err)
    }
  }, [currentWorkspace, refreshGitLog])

  /** 回滚到某条消息之前的 Git 版本：reset 到该 commit 的父提交 */
  const handleRollbackBeforeMsg = useCallback(async (commitHash: string) => {
    if (!currentWorkspace) return
    try {
      // 回退到该提交的父版本（即 agent 操作之前的状态）
      await window.taco.git.rollback(currentWorkspace, `${commitHash}~1`)
      await refreshGitLog()
      setFileStatuses({})
    } catch (err) {
      console.error('Git 回退失败:', err)
    }
  }, [currentWorkspace, refreshGitLog])

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
    threadStore.createThread('新项目', providerSettings.activeProvider)
    setDraft('')
    setSelectedFile(null)
    setViewingFile(null)
    setShowTerminal(false)
  }

  function handleSwitchThread(id: string) {
    threadStore.switchThread(id)
    setDraft('')
    setSelectedFile(null)
    setViewingFile(null)
  }

  function handleDeleteThread(threadId: string) {
    // 删除项目时清除其所有会话的消息
    const thread = threadStore.threads.find((t) => t.id === threadId)
    if (thread) {
      for (const s of thread.sessions) {
        chat.deleteThreadMessages(s.id)
      }
    }
    threadStore.deleteThread(threadId)
  }

  /** 在当前项目内新建会话 */
  function handleNewSession() {
    if (!tid) return
    threadStore.createSession(tid)
    setDraft('')
    setSelectedFile(null)
    setViewingFile(null)
  }

  /** 切换当前项目内的会话 */
  function handleSwitchSession(sid: string) {
    if (!tid) return
    threadStore.switchSession(tid, sid)
    setDraft('')
    setSelectedFile(null)
    setViewingFile(null)
  }

  /** 删除当前项目内的某个会话 */
  function handleDeleteSession(sid: string) {
    if (!tid) return
    chat.deleteThreadMessages(sid)
    threadStore.deleteSession(tid, sid)
  }

  function handleClearChat() {
    chat.clearMessages(sessionId)
  }

  /** 切换当前项目的模式 */
  function handleModeChange(mode: ThreadMode) {
    if (tid) {
      threadStore.updateThread(tid, { mode })
    }
  }

  /** 选择工作空间目录 */
  async function handleSelectWorkspace() {
    const dir = await globalThis.window.taco.dialog.selectDirectory()
    if (dir && tid) {
      threadStore.updateThread(tid, { workspace: dir })
    }
  }

  /** 切换当前项目的 provider */
  function handleProviderChange(id: ProviderId) {
    if (tid) {
      threadStore.updateThread(tid, { provider: id })
    }
    // 同时更新全局默认，新项目会继承
    providerSettings.setActiveProvider(id)
  }

  const notifyTaskCompleted = useCallback((threadTitle?: string) => {
    if (currentMode !== 'agent') return
    const title = 'Taco AI 任务完成'
    const body = threadTitle?.trim()
      ? `项目「${threadTitle.trim()}」已执行完成`
      : '当前任务已执行完成'
    void window.taco.shell.notify({ title, body, silent: false })
  }, [currentMode])

  function applyMobileSelection(target?: MobileTarget): MobileTarget {
    if (!target) return {}
    const next: MobileTarget = {}
    let targetThreadId = target.threadId
    if (!targetThreadId && target.sessionId) {
      const owner = threadStore.threads.find((t) => t.sessions.some((s) => s.id === target.sessionId))
      targetThreadId = owner?.id
    }
    if (targetThreadId && threadStore.threads.some((t) => t.id === targetThreadId)) {
      threadStore.switchThread(targetThreadId)
      next.threadId = targetThreadId
    }
    if (target.sessionId) {
      const owner = next.threadId
        ? threadStore.threads.find((t) => t.id === next.threadId)
        : threadStore.threads.find((t) => t.sessions.some((s) => s.id === target.sessionId))
      if (owner && owner.sessions.some((s) => s.id === target.sessionId)) {
        threadStore.switchSession(owner.id, target.sessionId)
        next.threadId = owner.id
        next.sessionId = target.sessionId
      }
    }
    if (target.provider) {
      const provider = providers.find((p) => p.id === target.provider)?.id
      if (provider) {
        const threadId = next.threadId ?? tid
        if (threadId) threadStore.updateThread(threadId, { provider })
        providerSettings.setActiveProvider(provider)
        next.provider = provider
      }
    }
    if (target.mode === 'chat' || target.mode === 'agent') {
      const threadId = next.threadId ?? tid
      if (threadId) {
        threadStore.updateThread(threadId, { mode: target.mode })
        next.mode = target.mode
      }
    }
    return next
  }

  /** 实际执行发送（使用 sessionId 作为消息存储 key） */
  function doSend(content: string, images?: import('../types').AttachedImage[], target?: MobileTarget) {
    const threadId = target?.threadId ?? threadStore.ensureActiveThread()
    const thread = threadStore.threads.find((t) => t.id === threadId)
    const sid = target?.sessionId ?? thread?.activeSessionId ?? ''
    if (!sid) return
    const provider = target?.provider ?? thread?.provider ?? providerSettings.activeProvider
    const mode: ThreadMode = thread?.mode ?? 'chat'
    const workspace = thread?.workspace ?? ''
    const targetMaxTokens = resolveProviderMaxTokens(provider, providerSettings.providerForms[provider])

    chat.sendMessage({
      threadId: sid,
      projectId: threadId,
      content,
      images,
      provider,
      providerForms: providerSettings.providerForms,
      mode,
      workspace,
      maxTokens: targetMaxTokens,
      onFirstMessage: (title) =>
        threadStore.updateThread(threadId, { title, updatedAt: Date.now() }),
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
        provider: cmd.provider as ProviderId | undefined,
        mode: cmd.mode as ThreadMode | undefined,
      })
      doSendRef.current(text, undefined, selected)
    })
    return unsubscribe
  }, [tid, threadStore, providerSettings])

  // 移动端桥接：仅同步选择，不发送消息
  useEffect(() => {
    const unsubscribe = window.taco.mobileBridge.onSelect((sel) => {
      applyMobileSelection({
        threadId: sel.threadId,
        sessionId: sel.sessionId,
        provider: sel.provider as ProviderId | undefined,
        mode: sel.mode as ThreadMode | undefined,
      })
    })
    return unsubscribe
  }, [tid, threadStore, providerSettings])

  // 移动端桥接：停止当前任务（与桌面 stop 语义一致，仅终止在执行任务，队列保留）
  useEffect(() => {
    const unsubscribe = window.taco.mobileBridge.onAbort((evt) => {
      const selected = applyMobileSelection({
        threadId: evt.threadId,
        sessionId: evt.sessionId,
      })
      const targetThreadId = selected.threadId ?? evt.threadId
      const targetSessionId =
        selected.sessionId ??
        evt.sessionId ??
        (targetThreadId ? threadStore.threads.find((t) => t.id === targetThreadId)?.activeSessionId : undefined) ??
        sessionId
      if (targetSessionId) {
        chat.stopSending(targetSessionId)
      }
    })
    return unsubscribe
  }, [tid, threadStore, providerSettings, sessionId, chat])

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
  }, [tid, threadStore, providerSettings])

  // 移动端桥接：在同一项目内新建会话
  useEffect(() => {
    const unsubscribe = window.taco.mobileBridge.onNewSession((evt) => {
      const selected = applyMobileSelection({ threadId: evt.threadId })
      const targetThreadId = selected.threadId ?? evt.threadId ?? tid
      if (!targetThreadId) return
      const exists = threadStore.threads.some((thread) => thread.id === targetThreadId)
      if (!exists) return
      threadStore.switchThread(targetThreadId)
      threadStore.createSession(targetThreadId)
    })
    return unsubscribe
  }, [tid, threadStore, providerSettings])

  // 移动端桥接：清空会话记录（不删除会话本身）
  useEffect(() => {
    const unsubscribe = window.taco.mobileBridge.onClearSession((evt) => {
      const selected = applyMobileSelection({
        threadId: evt.threadId,
        sessionId: evt.sessionId,
      })
      const targetThreadId = selected.threadId ?? evt.threadId
      const targetSessionId =
        selected.sessionId ??
        evt.sessionId ??
        (targetThreadId ? threadStore.threads.find((t) => t.id === targetThreadId)?.activeSessionId : undefined) ??
        sessionId
      if (!targetSessionId) return
      chat.clearMessages(targetSessionId)
    })
    return unsubscribe
  }, [tid, threadStore, providerSettings, sessionId, chat])

  // 移动端桥接：将桌面端当前会话历史/上下文同步到主进程缓存，供手机端查询
  useEffect(() => {
    const snapshot: MobileBridgeContextSnapshot = {
      updatedAt: Date.now(),
      activeThreadId: tid || undefined,
      activeSessionId: sessionId || undefined,
      activeProvider: currentProvider,
      providers: providerSettings.configuredProviders.map((p) => ({ id: p.id, label: p.label })),
      threads: threadStore.threads.map((thread) => {
        const sessionContexts = thread.sessions.map((session) => {
          const sid = session.id
          const sessionMessages = chat.getMessages(sid)
          return {
            sessionId: sid,
            title: session.title,
            messageCount: sessionMessages.length,
            messages: sessionMessages.map((msg) => ({
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
            })),
            sending: chat.isSending(sid),
            queue: chat.getQueue(sid).map((q) => q.content.slice(0, 500)),
            streamingContent: chat.getStreamingContent(sid).slice(0, 4000),
          }
        })
        return {
          threadId: thread.id,
          title: thread.title,
          updatedAt: thread.updatedAt,
          provider: thread.provider,
          mode: thread.mode,
          workspace: thread.workspace,
          activeSessionId: thread.activeSessionId,
          sessions: sessionContexts,
        }
      }),
    }
    window.taco.mobileBridge.syncContext(snapshot)
  })

  /** 重新发送：保留该消息，删掉之后的回复，重新请求 */
  function handleResend(msgId: string) {
    if (sessionSending || !sessionId) return
    const idx = messages.findIndex((m) => m.id === msgId)
    if (idx === -1) return
    chat.setMessages(sessionId, messages.slice(0, idx + 1))
    chat.resendFromExisting({
      threadId: sessionId,
      projectId: tid,
      provider: currentProvider,
      providerForms: providerSettings.providerForms,
      mode: currentMode,
      workspace: currentWorkspace,
      onComplete: () => {
        threadStore.updateThread(tid, { updatedAt: Date.now() })
        notifyTaskCompleted(threadStore.activeThread?.title)
      },
    })
  }

  /** 编辑后重新发送：更新原消息内容，删掉之后的回复，重新请求 */
  function handleEditResend(msgId: string, newContent: string) {
    if (sessionSending || !sessionId) return
    const idx = messages.findIndex((m) => m.id === msgId)
    if (idx === -1) return
    const updated = messages.slice(0, idx + 1)
    updated[idx] = { ...updated[idx], content: newContent }
    chat.setMessages(sessionId, updated)
    chat.resendFromExisting({
      threadId: sessionId,
      projectId: tid,
      provider: currentProvider,
      providerForms: providerSettings.providerForms,
      mode: currentMode,
      workspace: currentWorkspace,
      onComplete: () => {
        threadStore.updateThread(tid, { updatedAt: Date.now() })
        notifyTaskCompleted(threadStore.activeThread?.title)
      },
    })
  }

  function handleSend(images?: import('../types').AttachedImage[]) {
    const content = draft.trim()
    if ((!content && (!images || images.length === 0)) || providerSettings.configuredProviders.length === 0) return
    setDraft('')

    if (sessionSending) {
      // 当前会话正在请求 → 加入该会话的队列（队列不支持图片，仅文本）
      chat.addToQueue(sessionId, content || '(图片消息)')
    } else {
      // 空闲 → 直接发送
      doSend(content || '请分析这张图片', images)
    }
  }

  /** 在中间区域打开文件（右侧目录树点击普通文件时调用） */
  const handleOpenFileView = useCallback((filePath: string, forceDiff?: boolean) => {
    // 确保切换到聊天视图（FileEditor / DiffView 在 ChatPanel 内渲染）
    setMiddleView('chat')
    if (forceDiff) {
      // 变更文件面板点击 → 走 Diff 视图
      setSelectedFile(selectedFile === filePath ? null : filePath)
      setViewingFile(null)
    } else {
      // 目录树点击 → 永远走编辑模式
      setViewingFile(viewingFile === filePath ? null : filePath)
      setSelectedFile(null)
    }
  }, [selectedFile, viewingFile])

  /** 关闭文件编辑器 */
  const handleCloseFileEditor = useCallback(() => {
    setViewingFile(null)
  }, [])

  // （浏览器错误反馈统一在外部浏览器窗口处理）

  /** 从编辑器切换到 Diff 视图 */
  const handleViewDiffFromEditor = useCallback(() => {
    if (viewingFile) {
      const isChanged = dedupedFileChanges.some((fc) => fc.filePath === viewingFile)
      if (isChanged) {
        setSelectedFile(viewingFile)
        setViewingFile(null)
      }
    }
  }, [viewingFile, dedupedFileChanges])

  /* ---- render ---- */
  const gridStyle = {
    gridTemplateColumns: `280px minmax(0, 1fr) 0px minmax(260px, ${detailWidth}px)`,
  }

  return (
    <div className="app-shell" style={gridStyle}>
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
        onOpenSettings={() => { setShowSettings(true); setMiddleView('settings') }}
        isSending={isThreadSending}
        isCompleted={isThreadCompleted}
        contextPercent={contextPercent}
      />

      {/* 中间区域：多视图叠加，用 CSS 控制显隐（保持浏览器状态） */}
      <div className="middle-area">
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
            <SettingsPage
              providerForms={providerSettings.providerForms}
              onUpdateField={providerSettings.updateField}
              guiPlusForm={guiPlusSettings.guiPlusForm}
              onUpdateGuiPlusField={guiPlusSettings.updateGuiPlusField}
              onClose={() => { setShowSettings(false); setMiddleView('chat') }}
              workspace={currentWorkspace}
              projectId={tid}
            />
          </div>
        )}

        {/* 聊天视图 */}
        <div className="middle-view" style={{ display: middleView === 'chat' || (middleView === 'settings' && !showSettings) ? 'flex' : 'none' }}>
          <ChatPanel
            title={threadStore.activeThread?.title ?? '新项目'}
            messages={messages}
            showStreamBubble={showStreamBubble}
            streamingContent={sessionStreamingContent}
            draft={draft}
            onDraftChange={setDraft}
            sending={sessionSending}
            onSend={handleSend}
            onStop={() => sessionId && chat.stopSending(sessionId)}
            onClearChat={handleClearChat}
            onNewSession={handleNewSession}
            onSwitchSession={handleSwitchSession}
            onDeleteSession={handleDeleteSession}
            sessions={sessions}
            activeSessionId={sessionId}
            onResend={handleResend}
            onEditResend={handleEditResend}
            mode={currentMode}
            onModeChange={handleModeChange}
            workspace={currentWorkspace}
            onSelectWorkspace={handleSelectWorkspace}
            provider={currentProvider}
            onProviderChange={handleProviderChange}
            configuredProviders={providerSettings.configuredProviders}
            scrollRef={scrollRef}
            queue={sessionQueue}
            onRemoveFromQueue={(id) => chat.removeFromQueue(sessionId, id)}
            editor={editor}
            onEditorChange={handleEditorChange}
            selectedFileChange={selectedFileChange}
            onCloseDiff={() => setSelectedFile(null)}
            selectedFileStatus={selectedFile ? (fileStatuses[selectedFile] || 'pending') : undefined}
            onAcceptFile={handleAcceptFile}
            onRejectFile={handleRejectFile}
            showTerminal={showTerminal}
            onToggleTerminal={() => setShowTerminal((v) => !v)}
            terminalCwd={currentWorkspace || undefined}
            onRollbackBeforeMsg={handleRollbackBeforeMsg}
            viewingFile={viewingFile}
            viewingWorkspace={currentWorkspace || undefined}
            onCloseFileEditor={handleCloseFileEditor}
            onFileSaved={() => { refreshWorkspaceTree(); refreshGitLog() }}
            onViewDiffFromEditor={handleViewDiffFromEditor}
          />
        </div>
      </div>

      {/* 拖拽调整中间/右侧面板大小的分隔条 */}
      <div
        className="resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整面板大小"
        tabIndex={0}
        onMouseDown={handleResizeMouseDown}
      >
        <div className="resize-handle-line" />
      </div>

      <DetailPanel
        title={threadStore.activeThread?.title ?? '未选择项目'}
        messageCount={messages.length}
        providerLabel={
          providerSettings.configuredProviders.length > 0 ? activeProviderLabel : undefined
        }
        contextPercent={contextPercent}
        usedTokens={usedTokens}
        maxTokens={maxTokens}
        workspaceTree={workspaceTree}
        fileChanges={fileChanges.length > 0 ? fileChanges : undefined}
        selectedFile={selectedFile}
        onSelectFile={setSelectedFile}
        fileStatuses={fileStatuses}
        onAcceptFile={handleAcceptFile}
        onRejectFile={handleRejectFile}
        onAcceptAll={handleAcceptAll}
        onRejectAll={handleRejectAll}
        gitVersions={gitVersions}
        onGitRollback={handleGitRollback}
        onLoadCommitFiles={handleLoadCommitFiles}
        editor={editor}
        workspace={currentWorkspace}
        onRefreshTree={refreshWorkspaceTree}
        onOpenFileView={handleOpenFileView}
        viewingFile={viewingFile}
      />

    </div>
  )
}
