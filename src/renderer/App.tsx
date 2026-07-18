/**
 * App 主组件 (重构版)
 * 
 * 职责:
 * - 组合各个 hooks
 * - 协调跨模块通信
 * - 渲染主布局
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AttachedAsset, AttachedImage, ChatMsg, FileChangeInfo, ProviderId, ThemeMode } from './types'
import type { EditorId } from '../shared/ipc'
import { estimateTokens, buildSystemPrompt, resolveModelConfigContextLength } from './constants'
import { useThreads } from './hooks/useThreads'
import { useChat } from './hooks/useChat'
import { useProviderSettings } from './hooks/useProviderSettings'
import { useGatewayModels } from './hooks/useGatewayModels'
import { useResolvedModel } from './hooks/useResolvedModel'
import { useAuth } from './hooks/useAuth'
import { useLayout } from './hooks/useLayout'
import { useBrowser } from './hooks/useBrowser'
import { Sidebar } from './views/Sidebar'
import { ChatPanel } from './views/chat/ChatPanel'
import { SettingsPage } from './views/SettingsModal'
import { ModelsSettingsOverlay } from './views/settings/ModelsSettingsOverlay'
import { SkillsSettingsOverlay } from './views/settings/SkillsSettingsOverlay'
import { NotesSettingsOverlay } from './views/settings/NotesSettingsOverlay'
import { McpSettingsOverlay } from './views/settings/McpSettingsOverlay'
import { TokenReportSidebar } from './views/token-report/TokenReportSidebar'
import { BridgePanel } from './views/bridge/BridgePanel'
import { MobileDownloadPanel } from './views/bridge/MobileDownloadPanel'
import { LoginModal, type MemberInfo } from './views/LoginModal'
import { PaneErrorBoundary } from './views/PaneErrorBoundary'
import { OnboardingOverlay, isOnboardingCompleted, markOnboardingCompleted } from './views/OnboardingOverlay'
import { useDrag } from './hooks/useDrag'
import { useUpdateCheck } from './hooks/useUpdateCheck'
import { useBridgeInit } from './hooks/useBridgeInit'
import { useFileViewer } from './hooks/useFileViewer'
import type { WorkspaceTreeHandle } from './components/WorkspaceTree'
import { TerminalPanel } from './views/terminal/TerminalPanel'
import { Topbar } from './views/Topbar'
import { useSaveOnExit } from './hooks/useSaveOnExit'
import { useProjectRules } from './hooks/useProjectRules'
import { useBridgeListeners } from './hooks/useBridgeListeners'

export default function App() {
  /* ---- 业务 hooks ---- */
  const threadStore = useThreads()
  const chat = useChat()
  const providerSettings = useProviderSettings()
  const gatewayModels = useGatewayModels()
  const auth = useAuth()
  const layout = useLayout()
  
  /* ---- 抽取的 hooks ---- */
  const { updateStatus, updateChecking, handleOpenUpdateDialog } = useUpdateCheck()
  useBridgeInit()
  const fileViewer = useFileViewer()
  
  /* ---- 本地 UI 状态 ---- */
  const [draftByProject, setDraftByProject] = useState<Record<string, string>>({})
  const [imagesByProject, setImagesByProject] = useState<Record<string, AttachedImage[]>>({})
  const [assetsByProject, setAssetsByProject] = useState<Record<string, AttachedAsset[]>>({})
  // 统一管理所有顶部滑出弹窗（设置/报表/模型/上传/Skills/记忆/MCP），互斥
  const [activeOverlay, setActiveOverlay] = useState<string | null>(null)
  const overlayPanelRef = useRef<HTMLDivElement>(null)

  // 弹窗滑入动画：mount 后下一帧添加 open class
  useEffect(() => {
    if (activeOverlay && overlayPanelRef.current) {
      const raf = requestAnimationFrame(() => {
        overlayPanelRef.current?.classList.add('settings-overlay-panel-open')
      })
      return () => cancelAnimationFrame(raf)
    }
  }, [activeOverlay])
  const [terminalOpenMap, setTerminalOpenMap] = useState<Record<string, boolean>>({})
  const [showBridgePanel, setShowBridgePanel] = useState(false)
  const [showMobileDownloadPanel, setShowMobileDownloadPanel] = useState(false)
  const [showWorkspaceTree, setShowWorkspaceTree] = useState(false)
  const workspaceTreeRef = useRef<WorkspaceTreeHandle>(null)
  const closeOverlay = useCallback(() => setActiveOverlay(null), [])
  const [editor, setEditor] = useState<EditorId>(() =>
    (localStorage.getItem('taco.editor') as EditorId) || 'cursor'
  )
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    const saved = String(localStorage.getItem('taco.themeMode') || '').trim()
    if (saved === 'light' || saved === 'dark') return saved
    return 'dark'
  })



  /* ---- 首次使用引导 ---- */
  const [onboardingStep, setOnboardingStep] = useState(0)
  const [showOnboarding, setShowOnboarding] = useState(() => !isOnboardingCompleted())

  const handleOnboardingNext = useCallback(() => {
    setOnboardingStep((s) => s + 1)
  }, [])

  const handleOnboardingPrev = useCallback(() => {
    setOnboardingStep((s) => Math.max(0, s - 1))
  }, [])

  const handleOnboardingSkip = useCallback(() => {
    setShowOnboarding(false)
    markOnboardingCompleted()
  }, [])

  const handleOnboardingComplete = useCallback(() => {
    setShowOnboarding(false)
    markOnboardingCompleted()
    // 引导完成后，如果是全新用户（无项目），自动创建一个项目
    if (threadStore.threads.length === 0) {
      threadStore.createThread('我的项目', providerSettings.activeModelConfigId || undefined)
    }
  }, [threadStore, providerSettings.activeModelConfigId])

  const hasAnyProviders =
    providerSettings.configuredModels.length > 0 || gatewayModels.models.length > 0
  const hasAnyWorkspace = threadStore.threads.some((t) => Boolean(t.workspace?.trim()))
  
  const scrollRef = useRef<HTMLDivElement>(null)
  const doSendRef = useRef<(contentParts: MessageContentPart[], target?: any) => void>(() => {})
  const handleProviderChangeRef = useRef<(id: string) => void>(() => {})

  useSaveOnExit(
    threadStore.threads,
    providerSettings.modelConfigs,
    threadStore.activeThreadId,
    providerSettings.activeModelConfigId,
  )

  /* ---- Derived state ---- */
  const activeThread = threadStore.activeThread
  const tid = activeThread?.id ?? ''

  // 按项目记忆输入框草稿，切换项目时自动保留/恢复
  const draft = useMemo(() => tid ? (draftByProject[tid] ?? '') : '', [tid, draftByProject])
  const setDraft = useCallback((value: string) => {
    if (tid) {
      setDraftByProject((prev) => ({ ...prev, [tid]: value }))
    }
  }, [tid])

  // 按项目记忆附件图片
  const attachedImages = useMemo(() => tid ? (imagesByProject[tid] ?? []) : [], [tid, imagesByProject])
  const setAttachedImages = useCallback((value: AttachedImage[] | ((prev: AttachedImage[]) => AttachedImage[])) => {
    if (tid) {
      setImagesByProject((prev) => {
        const next = typeof value === 'function' ? value(prev[tid] ?? []) : value
        return { ...prev, [tid]: next }
      })
    }
  }, [tid])

  // 按项目记忆文件附件
  const attachedAssets = useMemo(() => tid ? (assetsByProject[tid] ?? []) : [], [tid, assetsByProject])
  const setAttachedAssets = useCallback((value: AttachedAsset[] | ((prev: AttachedAsset[]) => AttachedAsset[])) => {
    if (tid) {
      setAssetsByProject((prev) => {
        const next = typeof value === 'function' ? value(prev[tid] ?? []) : value
        return { ...prev, [tid]: next }
      })
    }
  }, [tid])

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
  const activeConfirmIds = hasValidActiveSession ? chat.getActiveConfirmIds(sessionId) : new Set<string>()
  const activeRetryIds = hasValidActiveSession ? chat.getActiveRetryIds(sessionId) : new Set<string>()

  const currentWorkspace: string = activeThread?.workspace ?? ''

  const currentProjectRules = useProjectRules(currentWorkspace)

  // 各项目的工作空间映射（供终端获取 cwd）
  const projectWorkspaces = useMemo(() => {
    const map: Record<string, string | undefined> = {}
    for (const t of threadStore.threads) {
      map[t.id] = t.workspace || undefined
    }
    return map
  }, [threadStore.threads])

  const currentModelConfigId = threadStore.activeThread?.modelConfigId ?? providerSettings.activeModelConfigId
  
  // 解析当前模型配置（优先本地自定义，回退到网关模型）
  const { currentModelConfig, currentProvider, activeProviderLabel, mergedModels } = useResolvedModel({
    currentModelConfigId,
    providerSettings: {
      getModelConfig: providerSettings.getModelConfig.bind(providerSettings),
      configuredModels: providerSettings.configuredModels,
      activeModelConfigId: providerSettings.activeModelConfigId,
    },
    gatewayModels,
    memberToken: auth.memberToken,
  })

  // 同步 refs
  useEffect(() => {
    handleProviderChangeRef.current = handleProviderChange
  }, [tid, providerSettings])

  // Token 上下文计算
  const estimatedTokens = estimateTokens(
    buildSystemPrompt({
      workspace: currentWorkspace,
      provider: currentProvider ?? 'deepseek',
      model: currentModelConfig?.model,
      supportsVision: Boolean(currentModelConfig?.supportsVision),
      projectRules: currentProjectRules,
    })
  ) + messages.reduce((sum, m) => sum + estimateTokens(m.content), 0)
  
  const usageTotalTokens = chat.getUsageTotalTokens(sessionId)
  const usedTokens = typeof usageTotalTokens === 'number' ? usageTotalTokens : estimatedTokens
  const contextLength = resolveModelConfigContextLength(currentModelConfig)
  const contextPercent = Math.min(Math.round((usedTokens / contextLength) * 100), 100)
  const projectTokenStats = tid ? chat.getProjectTokenStats(tid) : undefined
  const runTokenStats = sessionId ? chat.getRunTokenStats(sessionId) : { inputTokens: 0, hitTokens: 0, outputTokens: 0 }

  // 主题持久化
  useEffect(() => {
    localStorage.setItem('taco.themeMode', themeMode)
    document.documentElement.setAttribute('data-theme', themeMode)
  }, [themeMode])

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

  useBridgeListeners({ threadStore, chat, fileViewer, doSendRef, handleProviderChangeRef })

  function handleNewThread() {
    threadStore.createThread('新项目', providerSettings.activeModelConfigId || undefined)
    fileViewer.reset()
  }

  function handleSwitchThread(id: string) {
    threadStore.switchThread(id)
    fileViewer.reset()
  }

  function handleDeleteThread(threadId: string) {
    const thread = threadStore.threads.find((t) => t.id === threadId)
    if (thread) {
      for (const s of thread.sessions) {
        chat.deleteThreadMessages(s.id)
      }
    }
    chat.clearProjectTokenStats(threadId)
    setDraftByProject((prev) => {
      const next = { ...prev }
      delete next[threadId]
      return next
    })
    setImagesByProject((prev) => {
      const next = { ...prev }
      delete next[threadId]
      return next
    })
    setAssetsByProject((prev) => {
      const next = { ...prev }
      delete next[threadId]
      return next
    })
    threadStore.deleteThread(threadId)
  }

  function handleNewSession() {
    if (!tid) return
    threadStore.createSession(tid)
    fileViewer.reset()
  }

  function handleSwitchSession(sid: string) {
    if (!tid) return
    threadStore.switchSession(tid, sid)
    fileViewer.reset()
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

  async function handleSelectWorkspace(defaultPath?: string) {
    const dir = await globalThis.window.taco.dialog.selectDirectory(defaultPath)
    if (!dir) return
    if (!tid) {
      // 没有活跃项目 → 自动创建项目并绑定工作空间
      const projectName = dir.split(/[/\\]/).pop() || '我的项目'
      const newId = threadStore.createThread(projectName, providerSettings.activeModelConfigId || undefined)
      threadStore.updateThread(newId, { workspace: dir })
    } else {
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
    const title = 'Taco AI 任务完成'
    const body = threadTitle?.trim()
      ? `项目「${threadTitle.trim()}」已执行完成`
      : '当前任务已执行完成'
    void window.taco.shell.notify({ title, body, silent: false })
  }, [])

  type MessageContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } } | { type: 'video_url'; video_url: { url: string } } | { type: 'audio_url'; audio_url: { url: string } }

  /**
   * 根据模型配置 ID 解析完整的 ModelConfig。
   * 优先从 mergedModels（网关系统模型）中查找，再回退到本地自定义模型。
   */
  function resolveModelConfigFromId(configId: string): { provider: ProviderId; modelConfig: NonNullable<ReturnType<typeof providerSettings.getModelConfig>> } | null {
    const mergedModel = mergedModels.find((m) => m.id === configId)
    if (mergedModel?.source === 'system' && mergedModel.gatewayModel) {
      const gm = mergedModel.gatewayModel
      return {
        provider: gm.provider as ProviderId,
        modelConfig: {
          id: gm.id,
          provider: gm.provider as ProviderId,
          name: gm.displayName || gm.name,
          baseUrl: gm.baseUrl,
          apiKey: gm.apiKey,
          model: gm.model,
          contextLength: String(gm.contextLength),
          maxTokens: gm.maxTokens,
          temperature: gm.temperature,
          supportsVision: Boolean(gm.supportsVision),
          supportsReasoning: Boolean(gm.supportsReasoning),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      }
    }
    const config = providerSettings.getModelConfig(configId)
    if (!config?.provider) return null
    return { provider: config.provider as ProviderId, modelConfig: config }
  }

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
    
    const resolved = resolveModelConfigFromId(modelConfigId)
    if (!resolved) return
    const { provider, modelConfig } = resolved
    
    if (threadId && thread?.modelConfigId !== modelConfigId) {
      threadStore.updateThread(threadId, { modelConfigId })
    }
    
    const workspace = thread?.workspace ?? ''
    const targetContextLength = resolveModelConfigContextLength(modelConfig)

    chat.sendMessage({
      threadId: sid,
      projectId: threadId,
      projectRules: currentProjectRules,
      content: contentParts,
      provider: modelConfig.provider,
      modelConfig,
      workspace,
      contextLength: targetContextLength,
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
    return resolveModelConfigFromId(configId)
  }

  /**
   * 重发消息（支持可选的内容修改）。
   * newContent 为空时原样重发，非空时先修改消息内容再重发。
   */
  async function handleResend(msgId: string, newContent?: string) {
    if (sessionSending || !sessionId) return
    const resolved = await resolveActiveModelConfig()
    if (!resolved) return
    const { provider, modelConfig } = resolved
    await chat.ensureSessionFullyLoaded(sessionId)
    const latestMessages = chat.getMessages(sessionId)
    const idx = latestMessages.findIndex((m) => m.id === msgId)
    if (idx === -1) return
    const updated = latestMessages.slice(0, idx + 1)
    if (newContent !== undefined) {
      updated[idx] = { ...updated[idx], content: newContent }
    }
    chat.setMessages(sessionId, updated)
    const targetContextLength = resolveModelConfigContextLength(modelConfig)
    chat.resendFromExisting({
      threadId: sessionId,
      projectId: tid,
      projectRules: currentProjectRules,
      provider: provider as ProviderId,
      modelConfig,
      workspace: currentWorkspace,
      contextLength: targetContextLength,
      onComplete: () => {
        threadStore.updateThread(tid, { updatedAt: Date.now() })
        notifyTaskCompleted(threadStore.activeThread?.title)
      },
    })
  }

  function handleSend(contentParts?: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } } | { type: 'video_url'; video_url: { url: string } } | { type: 'audio_url'; audio_url: { url: string } }>) {
    // 检查是否有有效内容（本地模型为空时允许使用系统内置模型）
    if (!contentParts || contentParts.length === 0 || (providerSettings.configuredModels.length === 0 && mergedModels.length === 0)) return

    if (sessionSending) {
      // 队列也接收数组格式
      chat.addToQueue(sessionId, contentParts)
    } else {
      doSend(contentParts)
    }
  }

  // 滚动逻辑已移至 ChatPanel 内部统一管理（App.tsx 不再管理滚动）

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
        mode: 'agent',
        sidebarVisible: layout.sidebarVisible,
      },
    }).catch(() => {
      // ignore
    })
  }, [tid, currentWorkspace, sessionId, layout.sidebarVisible])

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
      <Topbar
        showWindowControls={showWindowControls}
        hasMacTrafficLights={hasMacTrafficLights}
        onMouseDown={drag.onMouseDown}
        didMoveRef={drag.didMoveRef}
        sidebarVisible={layout.sidebarVisible}
        onToggleSidebar={() => layout.setSidebarVisible((v) => !v)}
        activeThreadTitle={activeThreadTitle}
        updateStatus={updateStatus}
        updateChecking={updateChecking}
        onOpenUpdateDialog={handleOpenUpdateDialog}
        themeMode={themeMode}
        onToggleTheme={() => setThemeMode(themeMode === 'dark' ? 'light' : 'dark')}
        messagesCount={messages.length}
        onClearChat={handleClearChat}
        terminalOpen={terminalOpenMap[tid] || false}
        onToggleTerminal={() => setTerminalOpenMap((prev) => ({ ...prev, [tid]: !prev[tid] }))}
        showBridgePanel={showBridgePanel}
        setShowBridgePanel={setShowBridgePanel}
        showMobileDownloadPanel={showMobileDownloadPanel}
        setShowMobileDownloadPanel={setShowMobileDownloadPanel}
        showWorkspaceTree={showWorkspaceTree}
        setShowWorkspaceTree={setShowWorkspaceTree}
        activeOverlay={activeOverlay}
        setActiveOverlay={setActiveOverlay}
        currentWorkspace={currentWorkspace}
        workspaceTreeRef={workspaceTreeRef}
      />

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
            onOpenSettings={() => setActiveOverlay('settings')}
            isSending={isThreadSending}
            isCompleted={isThreadCompleted}
            memberInfo={auth.memberInfo}
            onLoginClick={auth.showLogin}
            onLogoutClick={auth.handleLogout}
            updateStatus={updateStatus}
            updateChecking={updateChecking}
            onCheckUpdate={handleOpenUpdateDialog}
            onOpenModels={() => setActiveOverlay('models')}
            onOpenSkills={() => setActiveOverlay('skills')}
            onOpenNotes={() => setActiveOverlay('notes')}
            onOpenMcp={() => setActiveOverlay('mcp')}
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

        <div className="middle-view" style={{ display: 'flex' }}>
          <PaneErrorBoundary
            key={tid}
            pane="chat"
            title="聊天面板"
            resetKey={`${sessionId}:${messages.length}`}
            onError={reportPaneRenderError}
          >
            <ChatPanel
              messages={messages}
              showStreamBubble={false}
              streamingContent={sessionStreamingContent}
              draft={draft}
              onDraftChange={setDraft}
              attachedImages={attachedImages}
              onAttachedImagesChange={setAttachedImages}
              attachedAssets={attachedAssets}
              onAttachedAssetsChange={setAttachedAssets}
              sending={sessionSending}
              onSend={(contentParts) => handleSend(contentParts)}
              onStop={() => sessionId && chat.stopSending(sessionId)}
              onSwitchSession={handleSwitchSession}
              onDeleteSession={handleDeleteSession}
              sessions={sessions}
              activeSessionId={sessionId}
              onResend={handleResend}
              onEditResend={(msgId, newContent) => handleResend(msgId, newContent)}
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
              onCloseDiff={() => fileViewer.reset()}
              selectedFileStatus={undefined}
              onAcceptFile={async () => {}}
              onRejectFile={async () => {}}
              showTerminal={terminalOpenMap[tid] || false}
              onToggleTerminal={() => setTerminalOpenMap((prev) => ({ ...prev, [tid]: false }))}
              onRollbackBeforeMsg={async () => {}}
              supportsVision={Boolean(currentModelConfig?.supportsVision)}
              onOpenFileView={(path) => {
                setShowWorkspaceTree(true)
                workspaceTreeRef.current?.openFile(path)
              }}
              contextPercent={contextPercent}
              projectTokenStats={projectTokenStats}
              runTokenStats={runTokenStats}
              activeTaskStartedAt={activeTaskStartedAt}
              projectId={tid}
              onOpenModels={() => setActiveOverlay('models')}
              activeConfirmIds={activeConfirmIds}
              activeRetryIds={activeRetryIds}
            />
          </PaneErrorBoundary>

          {/* 各项目独立终端：仅活跃项目可见，其余隐藏但保持挂载（PTY 进程存活） */}
          {Object.keys(terminalOpenMap).filter((k) => terminalOpenMap[k]).map((projectId) => (
            <div
              key={`terminal-wrapper-${projectId}`}
              style={{
                display: projectId === tid ? undefined : 'none',
                flex: '0 0 auto',
              }}
            >
              <TerminalPanel
                cwd={projectWorkspaces[projectId]}
                onClose={() => setTerminalOpenMap((prev) => ({ ...prev, [projectId]: false }))}
              />
            </div>
          ))}
        </div>

        {activeOverlay && (
          <>
            <div className="settings-overlay-backdrop" onClick={closeOverlay} />
            <div className="settings-overlay-panel" ref={overlayPanelRef} key={activeOverlay}>
              {activeOverlay === 'settings' && (
                <PaneErrorBoundary
                  pane="settings"
                  title="设置面板"
                  resetKey={`${tid}:${currentWorkspace}`}
                  onError={reportPaneRenderError}
                >
                  <SettingsPage
                    onClose={closeOverlay}
                    workspace={currentWorkspace}
                    projectId={tid}
                  />
                </PaneErrorBoundary>
              )}
              {activeOverlay === 'models' && (
                <ModelsSettingsOverlay
                  onClose={closeOverlay}
                  modelConfigs={providerSettings.modelConfigs}
                  activeModelConfigId={providerSettings.activeModelConfigId}
                  onSetActiveModelConfigId={providerSettings.setActiveModelConfigId}
                  onAddModelConfig={providerSettings.addModelConfig}
                  onUpdateModelConfig={providerSettings.updateModelConfig}
                  onRemoveModelConfig={providerSettings.removeModelConfig}
                />
              )}
              {activeOverlay === 'skills' && (
                <SkillsSettingsOverlay
                  onClose={closeOverlay}
                  workspace={currentWorkspace}
                />
              )}
              {activeOverlay === 'notes' && (
                <NotesSettingsOverlay
                  onClose={closeOverlay}
                  workspace={currentWorkspace}
                  projectId={tid}
                />
              )}
              {activeOverlay === 'mcp' && (
                <McpSettingsOverlay onClose={closeOverlay} />
              )}
              {activeOverlay === 'tokenReport' && (
                <div className="token-report-overlay" style={{ height: '100%', overflow: 'auto' }}>
                  <TokenReportSidebar
                    onClose={closeOverlay}
                    projectTokenStats={threadStore.threads.reduce((acc, t) => {
                      acc[t.id] = chat.getProjectTokenStats(t.id)
                      return acc
                    }, {} as Record<string, import('./hooks/useChat').ProjectTokenStats>)}
                    threadTitles={threadStore.threads.reduce((acc, t) => {
                      acc[t.id] = t.title || `任务 ${t.id.slice(0, 8)}`
                      return acc
                    }, {} as Record<string, string>)}
                    threadModels={threadStore.threads.reduce((acc, t) => {
                      // 优先查找本地自定义模型配置
                      const config = providerSettings.getModelConfig(t.modelConfigId || '')
                      if (config) {
                        acc[t.id] = { 
                          model: config.name || config.model || 'unknown', 
                          provider: config.provider || 'unknown' 
                        }
                      } else if (t.modelConfigId) {
                        // 回退查找系统内置网关模型
                        const gwModel = (gatewayModels.models ?? []).find(m => m.id === t.modelConfigId)
                        if (gwModel) {
                          acc[t.id] = { 
                            model: gwModel.displayName || gwModel.name || 'unknown', 
                            provider: gwModel.provider || 'unknown' 
                          }
                        } else {
                          acc[t.id] = { model: 'unknown', provider: 'unknown' }
                        }
                      } else {
                        acc[t.id] = { model: 'unknown', provider: 'unknown' }
                      }
                      return acc
                    }, {} as Record<string, { model: string; provider: string }>)}
                  />
                </div>
              )}
            </div>
          </>
        )}

      </div>

      {showBridgePanel && (
        <BridgePanel onClose={() => setShowBridgePanel(false)} memberToken={auth.memberToken} />
      )}

      {showMobileDownloadPanel && (
        <MobileDownloadPanel onClose={() => setShowMobileDownloadPanel(false)} />
      )}



      {auth.showLoginModal && (
        <LoginModal
          onClose={auth.hideLogin}
          onLoginSuccess={auth.handleLoginSuccess}
        />
      )}

      {/* 首次使用引导 */}
      {showOnboarding && (
        <OnboardingOverlay
          step={onboardingStep}
          onNext={handleOnboardingNext}
          onPrev={handleOnboardingPrev}
          onSkip={handleOnboardingSkip}
          onComplete={handleOnboardingComplete}
          hasProviders={hasAnyProviders}
          hasWorkspace={hasAnyWorkspace}
        />
      )}
    </div>
  )
}
