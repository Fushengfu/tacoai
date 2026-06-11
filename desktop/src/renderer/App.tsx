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
import { ChatStatusOverlay } from './views/chat/ChatStatusOverlay'
import { SettingsPage } from './views/SettingsModal'
import TokenReportPanel from './views/token-report'
import { BridgePanel } from './views/bridge/BridgePanel'
import { LoginModal, type MemberInfo } from './views/LoginModal'
import { PaneErrorBoundary } from './views/PaneErrorBoundary'
import { useDrag } from './hooks/useDrag'
import { useUpdateCheck } from './hooks/useUpdateCheck'
import { useBridgeInit } from './hooks/useBridgeInit'
import { useFileViewer } from './hooks/useFileViewer'

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
  const fileViewer = useFileViewer({ onSwitchToChat: () => setMiddleView('chat') })
  
  /* ---- 本地 UI 状态 ---- */
  const [draft, setDraft] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [showTokenReport, setShowTokenReport] = useState(false)
  const [showTerminal, setShowTerminal] = useState(false)
  const [showStatusOverlay, setShowStatusOverlay] = useState(false)
  const [showBridgePanel, setShowBridgePanel] = useState(false)
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

  const currentProjectRules = activeThread?.projectRules ?? ''
  const currentWorkspace: string = activeThread?.workspace ?? ''

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
      fileViewer.reset()
      setShowTerminal(false)

      // 通知主进程：项目切换完成，可以推送 bridge:state 给移动端
      // 使用 ensureSessionLoaded 的完成时机，而非硬编码延迟
      const activeSessionId = sessionId || thread.activeSessionId || thread.sessions[0]?.id
      if (activeSessionId) {
        void chat.ensureSessionLoaded(activeSessionId).then(() => {
          window.taco.bridge.notifySwitchProjectLoaded({ projectId, sessionId: activeSessionId })
        })
      }
    })
    return unsubscribe
  }, [threadStore, chat])

  // 监听移动端请求切换模型
  useEffect(() => {
    const unsubscribe = window.taco.bridge.onSwitchModel((data) => {
      const modelConfigId = String(data.modelConfigId || '').trim()
      if (!modelConfigId) return
      handleProviderChangeRef.current(modelConfigId)
    })
    return unsubscribe
  }, [])

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
        case 'bridge:retry-response': {
          const retryId = String(msg.retryId || '')
          const shouldRetry = Boolean(msg.shouldRetry)
          if (retryId) {
            window.taco.agent.retryResponse(retryId, shouldRetry)
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
    fileViewer.reset()
    setShowTerminal(false)
  }

  function handleSwitchThread(id: string) {
    threadStore.switchThread(id)
    setDraft('')
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
    threadStore.deleteThread(threadId)
  }

  function handleNewSession() {
    if (!tid) return
    threadStore.createSession(tid)
    setDraft('')
    fileViewer.reset()
  }

  function handleSwitchSession(sid: string) {
    if (!tid) return
    threadStore.switchSession(tid, sid)
    setDraft('')
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
          temperature: gm.temperature,
          supportsVision: Boolean(gm.supportsVision),
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
      projectRules: thread?.projectRules ?? '',
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
    chat.resendFromExisting({
      threadId: sessionId,
      projectId: tid,
      projectRules: currentProjectRules,
      provider: provider as ProviderId,
      modelConfig,
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
        middleView,
        sidebarVisible: layout.sidebarVisible,
      },
    }).catch(() => {
      // ignore
    })
  }, [tid, currentWorkspace, sessionId, middleView, layout.sidebarVisible])

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
            resetKey={`${sessionId}:${messages.length}:${fileViewer.selectedFile ?? ''}:${fileViewer.viewingFile ?? ''}`}
            onError={reportPaneRenderError}
          >
            <ChatPanel
              messages={messages}
              showStreamBubble={false}
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
              showTerminal={showTerminal}
              onToggleTerminal={() => setShowTerminal((v) => !v)}
              terminalCwd={currentWorkspace || undefined}
              onRollbackBeforeMsg={async () => {}}
              supportsVision={Boolean(currentModelConfig?.supportsVision)}
              viewingFile={fileViewer.viewingFile}
              viewingSelection={fileViewer.viewingSelection}
              viewingWorkspace={currentWorkspace || undefined}
              onCloseFileEditor={fileViewer.handleCloseFileEditor}
              onFileSaved={() => {}}
              onFileEdited={() => {}}
              onViewDiffFromEditor={fileViewer.handleViewDiffFromEditor}
              onOpenFileView={fileViewer.handleOpenFileView}
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
          contextLength={contextLength}
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
