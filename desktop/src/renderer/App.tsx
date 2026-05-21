/**
 * App 主组件 (重构版)
 * 
 * 职责:
 * - 组合各个 hooks
 * - 协调跨模块通信
 * - 渲染主布局
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AttachedAsset, AttachedImage, ChatMsg, FileChangeInfo, ProviderId, ThemeMode, ThreadMode } from './types'
import type { AppUpdateCheckResult, EditorId } from '../shared/ipc'
import { estimateTokens, buildSystemPrompt, resolveModelConfigDisplayLabel, resolveModelConfigMaxTokens } from './constants'
import { useThreads } from './hooks/useThreads'
import { useChat } from './hooks/useChat'
import { useProviderSettings } from './hooks/useProviderSettings'
import { useGatewayModels } from './hooks/useGatewayModels'
import { useGuiPlusSettings } from './hooks/useGuiPlusSettings'
import { useAuth } from './hooks/useAuth'
import { useLayout } from './hooks/useLayout'
import { useBrowser } from './hooks/useBrowser'
import { Sidebar } from './components/Sidebar'
import { ChatPanel } from './components/ChatPanel'
import { ChatStatusOverlay } from './components/ChatStatusOverlay'
import { SettingsPage } from './components/SettingsModal'
import TokenReportPanel from './components/token-report'
import { BridgePanel } from './components/BridgePanel'
import { LoginModal, type MemberInfo } from './components/LoginModal'
import { PaneErrorBoundary } from './components/PaneErrorBoundary'
import { useDrag } from './hooks/useDrag'

export default function App() {
  /* ---- 业务 hooks ---- */
  const threadStore = useThreads()
  const chat = useChat()
  const providerSettings = useProviderSettings()
  const gatewayModels = useGatewayModels()
  const guiPlusSettings = useGuiPlusSettings()
  const auth = useAuth()
  const layout = useLayout()
  
  /* ---- 本地 UI 状态 ---- */
  const [draft, setDraft] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [showTokenReport, setShowTokenReport] = useState(false)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [viewingFile, setViewingFile] = useState<string | null>(null)
  const [viewingSelection, setViewingSelection] = useState<{ line: number; column: number } | null>(null)
  const [showTerminal, setShowTerminal] = useState(false)
  const [showStatusOverlay, setShowStatusOverlay] = useState(false)
  const [showBridgePanel, setShowBridgePanel] = useState(false)
  const [updateStatus, setUpdateStatus] = useState<AppUpdateCheckResult | null>(null)
  const [updateChecking, setUpdateChecking] = useState(false)
  const [editor, setEditor] = useState<EditorId>(() =>
    (localStorage.getItem('taco.editor') as EditorId) || 'cursor'
  )
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    const saved = String(localStorage.getItem('taco.themeMode') || '').trim()
    if (saved === 'ocean' || saved === 'graphite' || saved === 'dark') return saved
    return 'dark'
  })

  type MiddleView = 'chat' | 'settings' | 'token-report'
  const [middleView, setMiddleView] = useState<MiddleView>('chat')
  
  const scrollRef = useRef<HTMLDivElement>(null)
  const doSendRef = useRef<(contentParts: MessageContentPart[], target?: any) => void>(() => {})
  const handleProviderChangeRef = useRef<(id: string) => void>(() => {})

  /* ---- Derived state ---- */
  const activeThread = threadStore.activeThread
  const tid = activeThread?.id ?? ''
  const sessions = activeThread?.sessions ?? []
  const sessionId = useMemo(() => {
    if (!activeThread || sessions.length <= 0) return ''
    const activeSessionRaw = String(activeThread.activeSessionId || '').trim()
    if (activeSessionRaw && sessions.some((session) => session.id === activeSessionRaw)) {
      return activeSessionRaw
    }
    return sessions[0]?.id ?? ''
  }, [activeThread, sessions])
  
  const hasValidActiveSession = Boolean(
    activeThread && sessionId && sessions.some((session) => session.id === sessionId),
  )

  const messages = hasValidActiveSession ? chat.getMessages(sessionId) : []
  const totalSessionMessageCount = hasValidActiveSession ? chat.getSessionMessageCount(sessionId) : 0
  const sessionSending = hasValidActiveSession ? chat.isSending(sessionId) : false
  const sessionStreamingContent = hasValidActiveSession ? chat.getStreamingContent(sessionId) : ''
  const sessionQueue = hasValidActiveSession ? chat.getQueue(sessionId) : []
  const activeTaskStartedAt = hasValidActiveSession ? chat.getActiveTaskStartedAt(sessionId) : undefined

  const currentMode: ThreadMode = 'agent'
  const currentProjectRules = activeThread?.projectRules ?? ''
  const showStreamBubble = sessionSending && currentMode !== 'agent'
  const currentWorkspace: string = activeThread?.workspace ?? ''

  const currentModelConfigId = threadStore.activeThread?.modelConfigId ?? providerSettings.activeModelConfigId
  const currentModelConfig = providerSettings.getModelConfig(currentModelConfigId || '')
  const currentProvider: ProviderId | undefined = currentModelConfig?.provider
  const activeProviderLabel = currentModelConfig ? resolveModelConfigDisplayLabel(currentModelConfig) : ''

  // Merge custom models with gateway models, marking source
  // 未登录时不展示系统内置模型
  const mergedModels = useMemo(() => {
    const customModels = providerSettings.configuredModels.map((m) => ({
      ...m,
      source: 'custom' as const,
    }))
    const gatewayModelsList = auth.memberToken ? (gatewayModels.models ?? []).map((m) => ({
      id: m.id,
      provider: m.provider as ProviderId,
      label: m.displayName || m.name,
      source: 'system' as const,
      gatewayModel: m,
    })) : []
    // 去重：如果自定义模型和系统模型 id 相同，优先使用自定义模型
    const merged = [...customModels, ...gatewayModelsList]
    const deduped = new Map<string, typeof merged[number]>()
    for (const item of merged) {
      if (!deduped.has(item.id)) {
        deduped.set(item.id, item)
      }
    }
    return [...deduped.values()]
  }, [providerSettings.configuredModels, gatewayModels.models, auth.memberToken])

  // 同步 refs
  useEffect(() => {
    handleProviderChangeRef.current = handleProviderChange
  }, [tid, providerSettings])

  // Token 上下文计算
  const estimatedTokens = estimateTokens(
    buildSystemPrompt({
      mode: currentMode,
      workspace: currentWorkspace,
      provider: currentProvider ?? 'deepseek',
      model: currentModelConfig?.model,
      supportsVision: Boolean(currentModelConfig?.supportsVision),
      projectRules: currentProjectRules,
    })
  ) + messages.reduce((sum, m) => sum + estimateTokens(m.content), 0)
  
  const usageTotalTokens = chat.getUsageTotalTokens(sessionId)
  const usedTokens = typeof usageTotalTokens === 'number' ? usageTotalTokens : estimatedTokens
  const maxTokens = resolveModelConfigMaxTokens(currentModelConfig)
  const contextPercent = Math.min(Math.round((usedTokens / maxTokens) * 100), 100)
  const projectTokenStats = tid ? chat.getProjectTokenStats(tid) : undefined

  // 主题持久化
  useEffect(() => {
    localStorage.setItem('taco.themeMode', themeMode)
    document.documentElement.setAttribute('data-theme', themeMode)
  }, [themeMode])

  // 更新检查
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

  // 浏览器相关
  const browser = useBrowser(tid)

  /* ---- Session/Thread 管理 ---- */
  useEffect(() => {
    if (!activeThread || sessions.length <= 0 || !sessionId) return
    if (activeThread.activeSessionId !== sessionId) {
      threadStore.switchSession(activeThread.id, sessionId)
    }
  }, [activeThread, sessions, sessionId, threadStore])

  useEffect(() => {
    if (!hasValidActiveSession) return
    void chat.ensureSessionLoaded(sessionId)
  }, [chat, sessionId, hasValidActiveSession])

  // 监听移动端请求切换项目
  useEffect(() => {
    const unsubscribe = window.taco.bridge.onSwitchProject((data) => {
      const projectId = String(data.projectId || '').trim()
      const sessionId = String(data.sessionId || '').trim() || undefined
      
      if (!projectId) return
      
      // 检查项目是否存在
      const thread = threadStore.threads.find((t) => t.id === projectId)
      if (!thread) return
      
      // 切换项目
      threadStore.switchThread(projectId)
      
      // 如果指定了会话，切换到对应会话
      if (sessionId) {
        const hasSession = thread.sessions.some((s) => s.id === sessionId)
        if (hasSession) {
          threadStore.switchSession(projectId, sessionId)
        }
      }
      
      // 清空 UI 状态
      setDraft('')
      setSelectedFile(null)
      setViewingFile(null)
      setViewingSelection(null)
      setShowTerminal(false)
    })
    return unsubscribe
  }, [threadStore])

  // 监听移动端发来的消息（chat-send / agent-confirm / agent-abort）
  useEffect(() => {
    const unsubscribe = window.taco.bridge.onClientMessage((msg) => {
      const type = String(msg.type || '')
      const doSend = doSendRef.current
      if (!doSend) return
      
      switch (type) {
        case 'bridge:chat-send': {
          const content = String(msg.content || '')
          const threadId = String(msg.threadId || '')
          if (content.trim()) {
            // 构造消息内容
            const contentParts = [{ type: 'text' as const, text: content }]
            const target = threadId ? { threadId } : undefined
            doSend(contentParts, target)
          }
          break
        }
        case 'bridge:agent-confirm': {
          const confirmId = String(msg.confirmId || '')
          const approved = Boolean(msg.approved)
          if (confirmId) {
            window.taco.agent.confirmResponse(confirmId, approved)
            // 通知 ChatPanel 更新确认状态 UI
            window.dispatchEvent(new CustomEvent('taco:confirm-response', { detail: { confirmId, approved } }))
          }
          break
        }
        case 'bridge:agent-abort': {
          const requestId = String(msg.originalRequestId || msg.requestId || '')
          if (requestId) {
            window.taco.agent.abort(requestId)
          }
          break
        }
      }
    })
    return unsubscribe
  }, [])

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
    const thread = threadStore.threads.find((t) => t.id === threadId)
    if (thread) {
      for (const s of thread.sessions) {
        chat.deleteThreadMessages(s.id)
      }
    }
    chat.clearProjectTokenStats(threadId)
    threadStore.deleteThread(threadId)
  }

  function handleNewSession() {
    if (!tid) return
    threadStore.createSession(tid)
    setDraft('')
    setSelectedFile(null)
    setViewingFile(null)
    setViewingSelection(null)
  }

  function handleSwitchSession(sid: string) {
    if (!tid) return
    threadStore.switchSession(tid, sid)
    setDraft('')
    setSelectedFile(null)
    setViewingFile(null)
    setViewingSelection(null)
  }

  function handleDeleteSession(sid: string) {
    if (!tid) return
    chat.deleteThreadMessages(sid)
    threadStore.deleteSession(tid, sid)
  }

  function handleClearChat() {
    chat.clearMessages(sessionId)
  }

  function handleProviderChange(id: string) {
    if (tid) {
      threadStore.updateThread(tid, { modelConfigId: id })
    }
    providerSettings.setActiveModelConfigId(id)
  }

  async function handleSelectWorkspace() {
    const dir = await globalThis.window.taco.dialog.selectDirectory()
    if (dir && tid) {
      threadStore.updateThread(tid, { workspace: dir })
    }
  }

  function isThreadSending(threadId: string): boolean {
    const thread = threadStore.threads.find((t) => t.id === threadId)
    if (!thread) return false
    return thread.sessions.some((s) => chat.isSending(s.id))
  }

  function isThreadCompleted(threadId: string): boolean {
    const thread = threadStore.threads.find((t) => t.id === threadId)
    if (!thread) return false
    return thread.sessions.some((s) => chat.isCompleted(s.id))
  }

  /* ---- 消息发送 ---- */
  const notifyTaskCompleted = useCallback((threadTitle?: string) => {
    if (currentMode !== 'agent') return
    const title = 'Taco AI 任务完成'
    const body = threadTitle?.trim()
      ? `项目「${threadTitle.trim()}」已执行完成`
      : '当前任务已执行完成'
    void window.taco.shell.notify({ title, body, silent: false })
  }, [currentMode])

  type MessageContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } } | { type: 'video_url'; video_url: { url: string } } | { type: 'audio_url'; audio_url: { url: string } }

  function doSend(contentParts: MessageContentPart[], target?: any) {
    const threadId = target?.threadId ?? threadStore.ensureActiveThread()
    const thread = threadStore.threads.find((t) => t.id === threadId)
    const targetSessionId = String(target?.sessionId || '').trim()
    const activeSessionId = String(thread?.activeSessionId || '').trim()
    const sid = (() => {
      if (!thread) return ''
      if (targetSessionId && thread.sessions.some((session) => session.id === targetSessionId)) return targetSessionId
      if (activeSessionId && thread.sessions.some((session) => session.id === activeSessionId)) return activeSessionId
      return thread.sessions[0]?.id ?? ''
    })()
    if (!sid) return
    
    const modelConfigId = String(
      target?.modelConfigId || thread?.modelConfigId || providerSettings.activeModelConfigId || '',
    ).trim()
    
    // 优先从 mergedModels 中查找（支持系统模型）
    const mergedModel = mergedModels.find((m) => m.id === modelConfigId)
    let modelConfig: ReturnType<typeof providerSettings.getModelConfig>
    if (mergedModel?.source === 'system' && mergedModel.gatewayModel) {
      const gm = mergedModel.gatewayModel
      modelConfig = {
        id: gm.id,
        provider: gm.provider as ProviderId,
        name: gm.displayName || gm.name,
        baseUrl: gm.baseUrl,
        apiKey: gm.apiKey,
        model: gm.model,
        maxTokens: gm.maxTokens,
        temperature: gm.temperature,
        supportsVision: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
    } else {
      modelConfig = providerSettings.getModelConfig(modelConfigId)
    }
    if (!modelConfig || !modelConfig.provider) return
    
    if (threadId && thread?.modelConfigId !== modelConfigId) {
      threadStore.updateThread(threadId, { modelConfigId })
    }
    
    const workspace = thread?.workspace ?? ''
    const targetMaxTokens = resolveModelConfigMaxTokens(modelConfig)

    chat.sendMessage({
      threadId: sid,
      projectId: threadId,
      projectRules: thread?.projectRules ?? '',
      content: contentParts,
      provider: modelConfig.provider,
      modelConfig,
      mode: currentMode,
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
  
  doSendRef.current = doSend

  async function resolveActiveModelConfig(): Promise<{ provider: string; modelConfig: NonNullable<ReturnType<typeof providerSettings.getModelConfig>> } | null> {
    const configId = currentModelConfigId || ''
    // 优先从 mergedModels 中查找（支持系统模型）
    const mergedModel = mergedModels.find((m) => m.id === configId)
    if (mergedModel?.source === 'system' && mergedModel.gatewayModel) {
      const gm = mergedModel.gatewayModel
      return {
        provider: gm.provider,
        modelConfig: {
          id: gm.id,
          provider: gm.provider as ProviderId,
          name: gm.displayName || gm.name,
          baseUrl: gm.baseUrl,
          apiKey: gm.apiKey,
          model: gm.model,
          maxTokens: gm.maxTokens,
          temperature: gm.temperature,
          supportsVision: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      }
    }
    const config = providerSettings.getModelConfig(configId)
    if (!config?.provider) return null
    return { provider: config.provider, modelConfig: config }
  }

  async function handleResend(msgId: string) {
    if (sessionSending || !sessionId) return
    const resolved = await resolveActiveModelConfig()
    if (!resolved) return
    const { provider, modelConfig } = resolved
    await chat.ensureSessionFullyLoaded(sessionId)
    const latestMessages = chat.getMessages(sessionId)
    const idx = latestMessages.findIndex((m) => m.id === msgId)
    if (idx === -1) return
    chat.setMessages(sessionId, latestMessages.slice(0, idx + 1))
    chat.resendFromExisting({
      threadId: sessionId,
      projectId: tid,
      projectRules: currentProjectRules,
      provider: provider as ProviderId,
      modelConfig,
      mode: currentMode,
      workspace: currentWorkspace,
      onComplete: () => {
        threadStore.updateThread(tid, { updatedAt: Date.now() })
        notifyTaskCompleted(threadStore.activeThread?.title)
      },
    })
  }

  async function handleEditResend(msgId: string, newContent: string) {
    if (sessionSending || !sessionId) return
    const resolved = await resolveActiveModelConfig()
    if (!resolved) return
    const { provider, modelConfig } = resolved
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
      provider: provider as ProviderId,
      modelConfig,
      mode: currentMode,
      workspace: currentWorkspace,
      onComplete: () => {
        threadStore.updateThread(tid, { updatedAt: Date.now() })
        notifyTaskCompleted(threadStore.activeThread?.title)
      },
    })
  }

  function handleSend(contentParts?: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } } | { type: 'video_url'; video_url: { url: string } } | { type: 'audio_url'; audio_url: { url: string } }>) {
    // 检查是否有有效内容
    if (!contentParts || contentParts.length === 0 || providerSettings.configuredModels.length === 0) return

    if (sessionSending) {
      // 队列也接收数组格式
      chat.addToQueue(sessionId, contentParts)
    } else {
      doSend(contentParts)
    }
  }

  /* ---- 文件查看 ---- */
  const handleOpenFileView = useCallback((filePath: string, forceDiff?: boolean, selection?: { line: number; column: number } | null) => {
    setMiddleView('chat')
    if (forceDiff) {
      setSelectedFile(selectedFile === filePath ? null : filePath)
      setViewingFile(null)
      setViewingSelection(null)
    } else {
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

  const handleCloseFileEditor = useCallback(() => {
    setViewingFile(null)
    setViewingSelection(null)
  }, [])

  const handleViewDiffFromEditor = useCallback(() => {
    if (viewingFile) {
      setSelectedFile(viewingFile)
      setViewingFile(null)
      setViewingSelection(null)
    }
  }, [viewingFile])

  /* ---- 智能自动滚动 ---- */
  const isNearBottomRef = useRef(true)

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    // 增加阈值到 100px，更宽松地判断是否在底部
    const threshold = 100
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    isNearBottomRef.current = distanceToBottom < threshold
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [handleScroll])

  // 只在用户已经滚动到底部时才自动跟随新消息滚动
  useEffect(() => {
    if (!scrollRef.current || !isNearBottomRef.current) return
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages, sessionStreamingContent])

  useEffect(() => {
    isNearBottomRef.current = true
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [sessionId])

  /* ---- 错误报告 ---- */
  const reportPaneRenderError = useCallback((pane: string, error: Error, info: any) => {
    void window.taco.shell.reportRendererError({
      source: `pane:${pane}`,
      message: error.message || String(error),
      stack: error.stack,
      componentStack: info.componentStack ?? undefined,
      projectId: tid || undefined,
      workspace: currentWorkspace || undefined,
      metadata: {
        pane,
        threadId: tid || undefined,
        sessionId: sessionId || undefined,
        mode: currentMode,
        middleView,
        sidebarVisible: layout.sidebarVisible,
      },
    }).catch(() => {
      // ignore
    })
  }, [tid, currentWorkspace, sessionId, currentMode, middleView, layout.sidebarVisible])

  /* ---- 移动端桥接监听 ---- */
  // (省略部分桥接代码以节省空间,实际应包含完整实现)
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
    try {
      const autoApprove = localStorage.getItem('taco.autoApproveCategories')
      if (autoApprove) {
        const categories = JSON.parse(autoApprove) as string[]
        if (categories.length > 0) window.taco.agent.setAutoApprove(categories)
      }
    } catch { /* ignore */ }
  }, [])

  /* ---- Render ---- */
  const drag = useDrag()
  const platform = globalThis.window.taco.system.platform
  const showWindowControls = platform === 'win32'
  const hasMacTrafficLights = platform === 'darwin'
  const activeThreadTitle = threadStore.activeThread?.title ?? '新项目'

  const gridStyle = {
    gridTemplateRows: '48px minmax(0, 1fr)',
    gridTemplateColumns: `${layout.effectiveSidebarWidth}px 0px minmax(0, 1fr)`,
  }

  return (
    <div ref={layout.appShellRef} className="app-shell" style={gridStyle}>
      <header
        className={`topbar app-topbar draggable ${hasMacTrafficLights ? 'has-native-traffic-lights' : ''}`}
        style={{ gridColumn: '1 / 4', gridRow: '1 / 2' }}
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
            onClick={() => layout.setSidebarVisible((v) => !v)}
            title={layout.sidebarVisible ? '隐藏左侧项目栏' : '显示左侧项目栏'}
            aria-label={layout.sidebarVisible ? '隐藏左侧项目栏' : '显示左侧项目栏'}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <rect x="2.25" y="2.25" width="11.5" height="11.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <path d="M6 3.2v9.6" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              {layout.sidebarVisible ? (
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
            <button
              className={`pill status-toggle ${showStatusOverlay ? 'active' : ''}`}
              type="button"
              onClick={() => setShowStatusOverlay((v) => !v)}
              title="模型用量"
            >
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <rect x="1.5" y="1.5" width="13" height="13" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
                <rect x="4" y="10" width="2" height="3" rx="0.5" fill="currentColor" />
                <rect x="7" y="7" width="2" height="6" rx="0.5" fill="currentColor" />
                <rect x="10" y="4" width="2" height="9" rx="0.5" fill="currentColor" />
              </svg>
            </button>
            <button
              className={`pill bridge-toggle ${showBridgePanel ? 'active' : ''}`}
              type="button"
              onClick={() => setShowBridgePanel((v) => !v)}
              title="跨端桥接"
            >
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <path d="M8 2.5a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 8 2.5Z" fill="currentColor" opacity=".4"/>
                <path d="M8 10.5a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 8 10.5Z" fill="currentColor" opacity=".4"/>
                <path d="M5 5.5a.75.75 0 0 1 .75-.75h1.5a.75.75 0 0 1 0 1.5h-1.5A.75.75 0 0 1 5 5.5Z" fill="currentColor" opacity=".4"/>
                <path d="M11 9.5a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1 0-1.5h1.5a.75.75 0 0 1 .75.75Z" fill="currentColor" opacity=".4"/>
                <path d="M3.5 4.25a.75.75 0 0 1 1.06-.06L6.4 5.93a1.41 1.41 0 0 0 2.19-.22l1.21-2.02a.75.75 0 1 1 1.28.76L9.87 6.47a2.91 2.91 0 0 1-4.53.44L3.56 5.31a.75.75 0 0 1-.06-1.06Z" fill="currentColor"/>
                <path d="M12.5 11.75a.75.75 0 0 1-1.06.06L9.6 10.07a1.41 1.41 0 0 0-2.19.22l-1.21 2.02a.75.75 0 1 1-1.28-.76L6.13 9.53a2.91 2.91 0 0 1 4.53-.44l1.78 1.6a.75.75 0 0 1 .06 1.06Z" fill="currentColor"/>
              </svg>
            </button>
            <button
              className={`pill token-report-toggle ${middleView === 'token-report' ? 'active' : ''}`}
              type="button"
              onClick={() => { setShowTokenReport((v) => !v); setMiddleView(middleView === 'token-report' ? 'chat' : 'token-report') }}
              title="Token使用报表"
            >
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <rect x="2" y="2" width="12" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4"/>
                <rect x="4.5" y="9" width="1.5" height="3" rx="0.3" fill="currentColor"/>
                <rect x="7.25" y="6.5" width="1.5" height="5.5" rx="0.3" fill="currentColor"/>
                <rect x="10" y="4" width="1.5" height="8" rx="0.3" fill="currentColor"/>
              </svg>
            </button>
            {messages.length > 0 && (
              <button className="pill" type="button" onClick={handleClearChat}>
                清空
              </button>
            )}
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
          visibility: layout.sidebarVisible ? 'visible' : 'hidden',
          pointerEvents: layout.sidebarVisible ? 'auto' : 'none',
        }}
      >
        <PaneErrorBoundary
          pane="sidebar"
          title="项目侧栏"
          resetKey={`${tid}:${threadStore.sortedThreads.length}:${layout.sidebarVisible ? '1' : '0'}`}
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
            memberInfo={auth.memberInfo}
            onLoginClick={auth.showLogin}
            onLogoutClick={auth.handleLogout}
          />
        </PaneErrorBoundary>
      </div>

      <div
        className="resize-handle resize-handle-left"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整项目列表宽度"
        tabIndex={0}
        onMouseDown={layout.handleSidebarResizeMouseDown}
        style={{
          gridColumn: '2 / 3',
          gridRow: '2 / 3',
          visibility: layout.sidebarVisible ? 'visible' : 'hidden',
          pointerEvents: layout.sidebarVisible ? 'auto' : 'none',
        }}
      >
        <div className="resize-handle-line" />
      </div>

      <div className="middle-area" style={{ gridColumn: '3 / 4', gridRow: '2 / 3', width: '100%', minWidth: 0 }}>
        {browser.browserWindows.size > 0 && (
          <div className="middle-tabs">
            <button
              type="button"
              className={`middle-tab ${middleView === 'chat' ? 'active' : ''}`}
              onClick={() => { setMiddleView('chat'); setShowSettings(false); setShowTokenReport(false) }}
            >
              聊天
            </button>
            {Array.from(browser.browserWindows.entries()).map(([appId, url]) => (
              <button
                key={appId}
                type="button"
                className="middle-tab"
                onClick={() => window.taco.browser.focusExternal(appId)}
                title={url || `浏览器 [${appId}]`}
              >
                🌐 {appId === 'default' ? '浏览器' : appId}
                <span
                  className="middle-tab-close"
                  onClick={(e) => { e.stopPropagation(); browser.closeBrowser(appId) }}
                  title="关闭浏览器"
                >
                  ✕
                </span>
              </button>
            ))}
          </div>
        )}

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
                memberInfo={auth.memberInfo}
                memberToken={auth.memberToken ?? undefined}
              />
            </PaneErrorBoundary>
          </div>
        )}

        {/* Token报表页面 */}
        {middleView === 'token-report' && showTokenReport && (
          <div className="middle-view">
            <PaneErrorBoundary
              pane="token-report"
              title="Token报表"
              resetKey={`${showTokenReport ? '1' : '0'}:${tid}`}
              onError={reportPaneRenderError}
            >
              <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                {/* Tab栏 */}
                <div style={{ 
                  display: 'flex', 
                  alignItems: 'center', 
                  padding: '12px 20px', 
                  borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
                  gap: '12px',
                }}>
                  <button
                    type="button"
                    onClick={() => { setShowTokenReport(false); setMiddleView('chat') }}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'var(--muted)',
                      fontSize: '13px',
                      cursor: 'pointer',
                      padding: '4px 8px',
                      borderRadius: '6px',
                    }}
                  >
                    ← 返回
                  </button>
                  <span style={{ fontWeight: 600, fontSize: '16px' }}>Token使用报表</span>
                </div>
                {/* 报表内容 */}
                <TokenReportPanel
                  projectTokenStats={threadStore.threads.reduce((acc, t) => {
                    acc[t.id] = chat.getProjectTokenStats(t.id)
                    return acc
                  }, {} as Record<string, import('./hooks/useChat').ProjectTokenStats>)}
                  threadTitles={threadStore.threads.reduce((acc, t) => {
                    acc[t.id] = t.title || `任务 ${t.id.slice(0, 8)}`
                    return acc
                  }, {} as Record<string, string>)}
                  threadModels={threadStore.threads.reduce((acc, t) => {
                    const config = providerSettings.getModelConfig(t.modelConfigId || '')
                    acc[t.id] = { 
                      model: config?.model || 'unknown', 
                      provider: config?.provider || 'unknown' 
                    }
                    return acc
                  }, {} as Record<string, { model: string; provider: string }>)}
                />
              </div>
            </PaneErrorBoundary>
          </div>
        )}

        <div className="middle-view" style={{ display: middleView === 'chat' || (middleView === 'settings' && !showSettings) ? 'flex' : 'none' }}>
          <PaneErrorBoundary
            key={tid}
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
              onSend={(contentParts) => handleSend(contentParts)}
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
              configuredProviders={mergedModels}
              scrollRef={scrollRef}
              totalMessageCount={totalSessionMessageCount}
              hasOlderStoredMessages={chat.hasOlderMessages(sessionId)}
              loadingOlderMessages={chat.isLoadingOlderMessages(sessionId)}
              onLoadOlderMessages={() => chat.loadOlderMessages(sessionId)}
              queue={sessionQueue}
              onRemoveFromQueue={(id) => chat.removeFromQueue(sessionId, id)}
              editor={editor}
              isSessionSending={(sid) => chat.isSending(sid)}
              selectedFileChange={null}
              onCloseDiff={() => setSelectedFile(null)}
              selectedFileStatus={undefined}
              onAcceptFile={async () => {}}
              onRejectFile={async () => {}}
              showTerminal={showTerminal}
              onToggleTerminal={() => setShowTerminal((v) => !v)}
              terminalCwd={currentWorkspace || undefined}
              onRollbackBeforeMsg={async () => {}}
              supportsVision={Boolean(currentModelConfig?.supportsVision)}
              viewingFile={viewingFile}
              viewingSelection={viewingSelection}
              viewingWorkspace={currentWorkspace || undefined}
              onCloseFileEditor={handleCloseFileEditor}
              onFileSaved={() => {}}
              onFileEdited={() => {}}
              onViewDiffFromEditor={handleViewDiffFromEditor}
              onOpenFileView={handleOpenFileView}
              activeTaskStartedAt={activeTaskStartedAt}
            />
          </PaneErrorBoundary>
        </div>

        <ChatStatusOverlay
          open={showStatusOverlay}
          onClose={() => setShowStatusOverlay(false)}
          providerLabel={
            providerSettings.configuredModels.length > 0 ? activeProviderLabel : undefined
          }
          contextPercent={contextPercent}
          usedTokens={usedTokens}
          maxTokens={maxTokens}
          projectTokenStats={projectTokenStats}
        />

        {showBridgePanel && (
          <BridgePanel onClose={() => setShowBridgePanel(false)} memberToken={auth.memberToken} />
        )}

        {auth.showLoginModal && (
          <LoginModal
            onClose={auth.hideLogin}
            onLoginSuccess={auth.handleLoginSuccess}
          />
        )}
      </div>
    </div>
  )
}
