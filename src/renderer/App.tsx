import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FileChangeInfo, FileChangeStatus, GitVersionCommit, ProviderId, ThreadMode } from './types'
import type { EditorId, FileTreeEntry, BrowserConsoleLevel } from '../shared/ipc'
import { providers, estimateTokens, buildSystemPrompt } from './constants'
import { loadJson, saveJson } from './lib/storage'
import { useThreads } from './hooks/useThreads'
import { useChat } from './hooks/useChat'
import { useProviderSettings } from './hooks/useProviderSettings'
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

export default function App() {
  /* ---- hooks ---- */
  const threadStore = useThreads()
  const chat = useChat()
  const providerSettings = useProviderSettings()
  const { width: detailWidth, handleMouseDown: handleResizeMouseDown } = useResize(
    300, 200, 600, 'taco.detailPanelWidth'
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
  /** 浏览器致命错误待发送队列 */
  const pendingBrowserErrorsRef = useRef<string[]>([])
  const browserErrorTimerRef = useRef<ReturnType<typeof setTimeout>>()
  /** doSend 的 ref，避免 useEffect 闭包捕获旧引用 */
  const doSendRef = useRef<(content: string) => void>(() => {})
  /** 中间区域当前视图：chat / settings */
  type MiddleView = 'chat' | 'settings'
  const [middleView, setMiddleView] = useState<MiddleView>('chat')
  const [editor, setEditor] = useState<EditorId>(() =>
    (localStorage.getItem('taco.editor') as EditorId) || 'cursor'
  )
  const scrollRef = useRef<HTMLDivElement>(null)

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
  const activeProviderInfo = providers.find((p) => p.id === currentProvider)
  const activeProviderLabel = activeProviderInfo?.label

  // 上下文窗口使用量
  const usedTokens = estimateTokens(buildSystemPrompt()) +
    messages.reduce((sum, m) => sum + estimateTokens(m.content), 0)
  const maxTokens = activeProviderInfo?.maxTokens ?? 65536
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
          if (tr.fileChange) changes.push(tr.fileChange)
        }
      }
    }
    return changes
  }, [messages, currentMode])

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

        // 存储日志
        setBrowserConsoleLogs(prev => {
          const entry: BrowserConsoleEntry = {
            id: ++consoleIdRef.current,
            appId,
            level,
            message,
            source: status.consoleSource,
            line: status.consoleLine,
            timestamp: Date.now(),
          }
          const next = [...prev, entry]
          return next.length > 500 ? next.slice(-500) : next
        })

        // 致命错误（页面加载失败、JS 运行时异常）自动反馈给 AI
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
          pendingBrowserErrorsRef.current.push(`[浏览器:${appId}] ${message}`)
          // 批量延迟 3 秒发送，合并多个错误
          clearTimeout(browserErrorTimerRef.current)
          browserErrorTimerRef.current = setTimeout(() => {
            const errors = pendingBrowserErrorsRef.current.splice(0)
            if (errors.length > 0) {
              const errorText = `[系统自动反馈] 浏览器出现以下错误:\n${errors.join('\n')}`
              doSendRef.current(errorText)
            }
          }, 3000)
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
  }, [])

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
    loadJson(fileStatusKey, {})
  )

  /** 保存（接受）单个文件变更 */
  const handleAcceptFile = useCallback((filePath: string) => {
    setFileStatuses((prev) => ({ ...prev, [filePath]: 'accepted' }))
  }, [])

  /** 将相对路径解析为绝对路径 */
  const resolveFilePath = useCallback((filePath: string) => {
    // 如果已经是绝对路径则直接返回
    if (filePath.startsWith('/')) return filePath
    // 否则拼接工作空间路径
    if (currentWorkspace) return `${currentWorkspace}/${filePath}`
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
      (fc) => !fileStatuses[fc.filePath] || fileStatuses[fc.filePath] === 'pending'
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
  }, [dedupedFileChanges, fileStatuses, resolveFilePath, refreshGitLog])

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
      setFileStatuses(loadJson(`taco.fileStatuses.${sessionId}`, {}))
    }
  }, [sessionId])

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

  /** 实际执行发送（使用 sessionId 作为消息存储 key） */
  function doSend(content: string, images?: import('../types').AttachedImage[]) {
    const threadId = threadStore.ensureActiveThread()
    const thread = threadStore.threads.find((t) => t.id === threadId)
    const sid = thread?.activeSessionId ?? ''
    if (!sid) return

    chat.sendMessage({
      threadId: sid,
      projectId: threadId,
      content,
      images,
      provider: currentProvider,
      providerForms: providerSettings.providerForms,
      mode: currentMode,
      workspace: currentWorkspace,
      maxTokens,
      onFirstMessage: (title) =>
        threadStore.updateThread(threadId, { title, updatedAt: Date.now() }),
      onComplete: () =>
        threadStore.updateThread(threadId, { updatedAt: Date.now() }),
    })
  }
  // 保持 ref 指向最新的 doSend
  doSendRef.current = doSend

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
      onComplete: () => threadStore.updateThread(tid, { updatedAt: Date.now() }),
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
      onComplete: () => threadStore.updateThread(tid, { updatedAt: Date.now() }),
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
    gridTemplateColumns: `280px minmax(0, 1fr) 0px minmax(180px, ${detailWidth}px)`,
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
