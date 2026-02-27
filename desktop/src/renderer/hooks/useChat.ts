import { useCallback, useEffect, useRef, useState } from 'react'
import type { ActivePlan, AgentStep, AttachedImage, ChatMsg, ProviderId, ProviderForms, QueuedMessage, RiskInfo, ThreadMode, ToolCallInfo, ToolResultInfo } from '../types'
import type { PromptConfig } from '../../shared/ipc'
import { buildSystemPrompt } from '../constants'
import { loadJson, saveJson, uid } from '../lib/storage'

function normalizePlanStatus(status: string): 'pending' | 'in_progress' | 'done' | 'failed' {
  const s = String(status ?? '').trim().toLowerCase()
  if (s === 'in-progress' || s === 'inprogress' || s === 'running') return 'in_progress'
  if (s === 'complete' || s === 'completed' || s === 'success' || s === 'succeeded') return 'done'
  if (s === 'error') return 'failed'
  if (s === 'pending' || s === 'in_progress' || s === 'done' || s === 'failed') return s
  return 'pending'
}

export type SendMessageParams = {
  threadId: string
  /** 项目标识（用于项目级日志与笔记隔离） */
  projectId?: string
  content: string
  /** 用户附带的图片 */
  images?: AttachedImage[]
  provider: ProviderId
  providerForms: ProviderForms
  /** 会话模式 */
  mode?: ThreadMode
  /** Agent 模式的工作空间目录 */
  workspace?: string
  /** 模型上下文窗口大小（token 数），用于自动压缩 */
  maxTokens?: number
  /** 首条消息时回调，用于自动命名线程 */
  onFirstMessage?: (autoTitle: string) => void
  /** 完成后回调，用于更新线程时间戳 */
  onComplete?: () => void
}

/**
 * 每个 thread 独立管理：sending / streamingContent / queue
 * 不同会话可并行；同一会话严格串行（绝不并发请求）。
 */
export function useChat() {
  const [threadMessages, setThreadMessages] = useState<Record<string, ChatMsg[]>>(() =>
    loadJson('taco.messages', {})
  )

  /** 每个 thread 是否正在发送 */
  const [sendingThreads, setSendingThreads] = useState<Record<string, boolean>>({})
  /** 每个 thread 的流式内容 */
  const [streamingContents, setStreamingContents] = useState<Record<string, string>>({})
  /** 每个 thread 的待发送队列 */
  const [queues, setQueues] = useState<Record<string, QueuedMessage[]>>({})
  /** 刚完成的 thread（短暂显示 ✓ 后自动清除） */
  const [completedThreads, setCompletedThreads] = useState<Record<string, boolean>>({})

  // Ref：始终指向最新 threadMessages，供异步回调读取
  const threadMessagesRef = useRef(threadMessages)
  threadMessagesRef.current = threadMessages

  // 每个 thread 的 stream cleanup
  const streamCleanupRefs = useRef<Map<string, () => void>>(new Map())
  // 每个 thread 的 abort reject（用于从外部终止 Promise）
  const abortRejectRefs = useRef<Map<string, (reason: Error) => void>>(new Map())
  // 每个 thread 当前正在运行的 requestId（用于发送 abort IPC 到后端）
  const requestIdRefs = useRef<Map<string, string>>(new Map())
  // 每个 thread 最后一次发送的参数（用于队列自动重发）
  const sendParamsRefs = useRef<Map<string, Omit<SendMessageParams, 'content'>>>(new Map())
  // 每个 thread 的互斥锁：同一 thread 同时只能有一个在途请求
  const inFlightThreadsRef = useRef<Set<string>>(new Set())
  // 始终指向最新的 sendMessage 函数
  const sendMessageRef = useRef<(params: SendMessageParams) => Promise<void>>()
  // Prompt 配置（来自 ~/.taco/prompt-config.json，不存在时回退硬编码）
  const promptConfigRef = useRef<PromptConfig | null>(null)
  const promptConfigLoadedRef = useRef(false)

  // 持久化
  useEffect(() => {
    saveJson('taco.messages', threadMessages)
  }, [threadMessages])

  useEffect(() => {
    let cancelled = false
    if (!window.taco.prompt?.getConfig) return
    window.taco.prompt.getConfig()
      .then((config) => {
        if (cancelled) return
        promptConfigRef.current = config
        promptConfigLoadedRef.current = true
      })
      .catch(() => {
        if (cancelled) return
        promptConfigRef.current = null
        promptConfigLoadedRef.current = true
      })
    return () => {
      cancelled = true
    }
  }, [])

  /* ------------------------------------------------------------------ */
  /*  Per-thread accessors                                               */
  /* ------------------------------------------------------------------ */

  function isSending(threadId: string): boolean {
    return (sendingThreads[threadId] ?? false) || inFlightThreadsRef.current.has(threadId)
  }

  function isCompleted(threadId: string): boolean {
    return completedThreads[threadId] ?? false
  }

  /** 终止某 thread 的当前流式请求，保留队列等待继续发送 */
  function stopSending(threadId: string) {
    // 严格停止语义：仅发送 abort，请求必须等待后端 done/结束确认后才会 finally -> processQueue。
    // 不在前端本地强制 reject，也不提前移除监听，避免“未确认已停就发送下一个”。
    const requestId = requestIdRefs.current.get(threadId)
    if (requestId) {
      window.taco.chat.abort(requestId)
      window.taco.agent.abort(requestId)
    }
    // 不清空队列：后端确认停止后，finally 中会继续 processQueue
  }

  function getStreamingContent(threadId: string): string {
    return streamingContents[threadId] ?? ''
  }

  function getQueue(threadId: string): QueuedMessage[] {
    return queues[threadId] ?? []
  }

  function getMessages(threadId: string): ChatMsg[] {
    return threadMessages[threadId] ?? []
  }

  /* ------------------------------------------------------------------ */
  /*  Message CRUD                                                       */
  /* ------------------------------------------------------------------ */

  const setMessages = useCallback(
    (threadId: string, updater: ChatMsg[] | ((prev: ChatMsg[]) => ChatMsg[])) => {
      setThreadMessages((prev) => {
        const current = prev[threadId] ?? []
        const next = typeof updater === 'function' ? updater(current) : updater
        const updated = { ...prev, [threadId]: next }
        // 同步更新 ref，确保 resendFromExisting 等异步调用能立即读到最新消息
        threadMessagesRef.current = updated
        return updated
      })
    },
    []
  )

  function clearMessages(threadId: string) {
    setMessages(threadId, [])
  }

  function deleteThreadMessages(threadId: string) {
    setThreadMessages((prev) => {
      const next = { ...prev }
      delete next[threadId]
      return next
    })
    // 同时清理该 thread 的队列
    setQueues((prev) => {
      const next = { ...prev }
      delete next[threadId]
      return next
    })
    setSendingThreads((prev) => {
      const next = { ...prev }
      delete next[threadId]
      return next
    })
    inFlightThreadsRef.current.delete(threadId)
    sendParamsRefs.current.delete(threadId)
    streamCleanupRefs.current.delete(threadId)
    abortRejectRefs.current.delete(threadId)
    requestIdRefs.current.delete(threadId)
  }

  /* ------------------------------------------------------------------ */
  /*  Queue management                                                   */
  /* ------------------------------------------------------------------ */

  function addToQueue(threadId: string, content: string) {
    const normalized = content.trim()
    if (!normalized) return

    setQueues((prev) => {
      const currentQueue = prev[threadId] ?? []
      const lastQueued = currentQueue[currentQueue.length - 1]

      // 防止重复入队：若队尾与本次内容一致，直接忽略
      if (lastQueued?.content === normalized) return prev

      // 防止与当前已发送的最后一条用户消息重复（常见于发送中重复按 Enter）
      const latestMsg = (threadMessagesRef.current[threadId] ?? []).at(-1)
      if (latestMsg?.role === 'user' && latestMsg.content.trim() === normalized) return prev

      return {
        ...prev,
        [threadId]: [...currentQueue, { id: uid(), content: normalized }]
      }
    })
  }

  function removeFromQueue(threadId: string, queueItemId: string) {
    setQueues((prev) => ({
      ...prev,
      [threadId]: (prev[threadId] ?? []).filter((m) => m.id !== queueItemId)
    }))
  }

  /** 完成后自动处理该 thread 队首消息 */
  function processQueue(threadId: string) {
    setQueues((prev) => {
      const threadQueue = prev[threadId] ?? []
      if (threadQueue.length === 0) return prev

      const [next, ...rest] = threadQueue
      const savedParams = sendParamsRefs.current.get(threadId)
      if (savedParams) {
        // 下一轮宏任务执行，确保 React state 已提交
        setTimeout(() => {
          sendMessageRef.current?.({ ...savedParams, content: next.content })
        }, 0)
      }
      return { ...prev, [threadId]: rest }
    })
  }

  async function ensurePromptConfigLoaded(): Promise<PromptConfig | null> {
    if (promptConfigLoadedRef.current) return promptConfigRef.current
    if (!window.taco.prompt?.getConfig) {
      promptConfigLoadedRef.current = true
      promptConfigRef.current = null
      return null
    }
    try {
      promptConfigRef.current = await window.taco.prompt.getConfig()
    } catch {
      promptConfigRef.current = null
    } finally {
      promptConfigLoadedRef.current = true
    }
    return promptConfigRef.current
  }

  /* ------------------------------------------------------------------ */
  /*  Send message (per-thread, non-blocking)                            */
  /* ------------------------------------------------------------------ */

  async function sendMessage(params: SendMessageParams) {
    const { threadId, projectId, content, images, provider, providerForms, mode, workspace, maxTokens, onFirstMessage, onComplete } = params

    // 保存参数供队列重发
    sendParamsRefs.current.set(threadId, {
      threadId,
      projectId,
      provider,
      providerForms,
      mode,
      workspace,
      onFirstMessage,
      onComplete,
    })

    // 同一会话绝对串行：若已有在途请求，本次直接入队
    if (inFlightThreadsRef.current.has(threadId)) {
      const queueText = content.trim() || (images && images.length > 0 ? '(图片消息)' : '')
      if (queueText) addToQueue(threadId, queueText)
      return
    }
    inFlightThreadsRef.current.add(threadId)

    // 用 ref 读取最新消息，避免闭包过期
    const currentMsgs = threadMessagesRef.current[threadId] ?? []
    const userMsg: ChatMsg = { id: uid(), role: 'user', content, ...(images && images.length > 0 ? { images } : {}) }
    const updatedMsgs = [...currentMsgs, userMsg]

    setMessages(threadId, updatedMsgs)
    setSendingThreads((prev) => ({ ...prev, [threadId]: true }))
    setStreamingContents((prev) => ({ ...prev, [threadId]: '' }))

    // 首条消息 → 自动命名
    if (currentMsgs.length === 0 && onFirstMessage) {
      const title = content.length > 30 ? content.slice(0, 30) + '...' : content
      onFirstMessage(title)
    }

    // 构造 API 消息（支持 provider/model 差异化 + 配置文件可选覆盖）
    const promptConfig = await ensurePromptConfigLoaded()
    const model = String(providerForms[provider]?.model ?? '').trim() || undefined
    const systemContent = buildSystemPrompt({
      mode,
      workspace,
      provider,
      model,
      promptConfig,
    })
    const chatMsgs = updatedMsgs.map((m) => ({ role: m.role, content: m.content }))

    // ── 初始上下文预检：截断超长单条消息，防止极端情况下直接超限 ──
    // （AI 摘要压缩由 Agent 后端在每轮 LLM 请求前自动执行）
    const tokenBudget = maxTokens ?? 131072
    const MAX_MSG_CHARS = 32000
    for (let i = 0; i < chatMsgs.length; i++) {
      if (chatMsgs[i].content && chatMsgs[i].content.length > MAX_MSG_CHARS) {
        chatMsgs[i] = {
          ...chatMsgs[i],
          content: chatMsgs[i].content.slice(0, MAX_MSG_CHARS) + '\n\n[...内容已截断]',
        }
      }
    }

    const apiMessages = [
      { role: 'system' as const, content: systemContent },
      ...chatMsgs
    ]

    const overrides = {
      [provider]: {
        baseUrl: providerForms[provider]?.baseUrl || undefined,
        apiKey: providerForms[provider]?.apiKey || undefined,
        model: providerForms[provider]?.model || undefined
      }
    }

    const isAgent = mode === 'agent'
    let accumulated = ''

    try {
      const requestId = `req-${Date.now()}-${threadId}`
      // 记录当前 requestId 以便 stopSending 能发送 abort IPC
      requestIdRefs.current.set(threadId, requestId)

      if (isAgent) {
        // ── Agent 模式：整合为单条 assistant 消息，步骤折叠显示 ──
        await new Promise<void>((resolve, reject) => {
          abortRejectRefs.current.set(threadId, reject)

          // Agent 唯一的 assistant 消息 ID
          const agentMsgId = uid()
          const steps: AgentStep[] = []
          let currentRound = 0
          let commitHash: string | undefined
          let activePlan: ActivePlan | undefined

          // 辅助：更新 agent 消息（追加或更新）
          const flushAgentMsg = (finalContent?: string) => {
            const nextContent = finalContent ?? accumulated
            const hasRenderableContent = Boolean(nextContent.trim())
            const hasRenderableMeta = steps.length > 0 || Boolean(activePlan) || Boolean(commitHash)
            setMessages(threadId, (prev) => {
              const idx = prev.findIndex((m) => m.id === agentMsgId)
              if (idx === -1 && !hasRenderableContent && !hasRenderableMeta) {
                return prev
              }
              const msg: ChatMsg = {
                id: agentMsgId,
                role: 'assistant',
                content: nextContent,
                agentSteps: steps.length > 0 ? [...steps] : undefined,
                gitCommitHash: commitHash,
                activePlan: activePlan ? { ...activePlan, steps: activePlan.steps.map((s) => ({ ...s })) } : undefined,
              }
              if (idx === -1) return [...prev, msg]
              const next = [...prev]
              next[idx] = msg
              return next
            })
          }

          const cleanup = globalThis.window.taco.agent.onEvent((event) => {
            if (event.requestId !== requestId) return

            if (event.type === 'text') {
              accumulated += event.content
              // Agent 模式下直接更新消息内容，不使用独立的 streamingContent
              flushAgentMsg()
            } else if (event.type === 'tool_calls') {
              // AI 决定调用工具 → 当前文本作为该步骤的 thinking
              currentRound++
              const toolCalls: ToolCallInfo[] = event.toolCalls.map((tc) => ({
                id: tc.id,
                name: tc.function.name,
                arguments: tc.function.arguments,
              }))
              steps.push({
                round: currentRound,
                thinking: accumulated,
                toolCalls,
                toolResults: [],
                status: 'running',
              })
              // 清空累积文本，后续文本属于下一轮或最终回复
              accumulated = ''
              flushAgentMsg()
            } else if (event.type === 'confirm') {
              // 风险操作需要用户确认 → 更新当前步骤状态
              const lastStep = steps[steps.length - 1]
              if (lastStep) {
                lastStep.status = 'confirm'
                lastStep.confirmId = event.confirmId
                lastStep.risks = event.risks.map((r) => ({
                  toolCallId: r.toolCallId,
                  toolName: r.toolName,
                  level: r.level,
                  reason: r.reason,
                  detail: r.detail,
                }))
              }
              flushAgentMsg()
            } else if (event.type === 'tool_results') {
              const results: ToolResultInfo[] = event.results.map((r) => ({
                tool_call_id: r.tool_call_id,
                name: r.name,
                content: r.content,
                success: r.success,
                fileChange: r.fileChange ? {
                  filePath: r.fileChange.filePath,
                  oldContent: r.fileChange.oldContent,
                  newContent: r.fileChange.newContent,
                } : undefined,
              }))
              // 将结果写入当前步骤
              const lastStep = steps[steps.length - 1]
              if (lastStep) {
                lastStep.toolResults = results
                lastStep.status = 'done'
              }
              flushAgentMsg()
            } else if (event.type === 'git_commit') {
              // Agent 自动提交完成，记录 commit hash
              commitHash = event.hash
              flushAgentMsg()
            } else if (event.type === 'plan_init') {
              // 计划初始化：用户确认了执行计划
              activePlan = {
                summary: event.summary,
                reasoning: event.reasoning,
                steps: event.steps.map((text) => ({ text, status: 'pending' as const })),
                startedAt: Date.now(),
              }
              flushAgentMsg()
            } else if (event.type === 'plan_progress') {
              // 计划步骤进度更新
              if (activePlan && event.stepIndex >= 0 && event.stepIndex < activePlan.steps.length) {
                activePlan.steps[event.stepIndex].status = normalizePlanStatus(event.status)
                if (event.note) activePlan.steps[event.stepIndex].note = event.note
              }
              flushAgentMsg()
            } else if (event.type === 'done') {
              // 最终回复写入 content
              if (activePlan && !activePlan.endedAt) activePlan.endedAt = Date.now()
              flushAgentMsg(accumulated)
              cleanup()
              resolve()
            } else if (event.type === 'error') {
              if (activePlan && !activePlan.endedAt) activePlan.endedAt = Date.now()
              flushAgentMsg(accumulated)
              cleanup()
              reject(new Error(event.message))
            }
          })
          streamCleanupRefs.current.set(threadId, cleanup)
          // 找到最新用户消息中的图片
          const lastUserImages = images?.map((img) => img.dataUrl)
          globalThis.window.taco.agent.stream({
            requestId,
            provider,
            messages: apiMessages,
            overrides,
            projectId,
            workspace: params.workspace ?? '',
            maxTokens,
            ...(lastUserImages && lastUserImages.length > 0 ? { images: lastUserImages } : {}),
          })
        })
      } else {
        // ── Chat 模式：纯文本流 ──
        await new Promise<void>((resolve, reject) => {
          abortRejectRefs.current.set(threadId, reject)

          const cleanup = globalThis.window.taco.chat.onChunk((data) => {
            if (data.requestId !== requestId) return
            if (data.error) { cleanup(); reject(new Error(data.error)); return }
            if (data.done) { cleanup(); resolve(); return }
            accumulated += data.chunk
            setStreamingContents((prev) => ({ ...prev, [threadId]: accumulated }))
          })
          streamCleanupRefs.current.set(threadId, cleanup)
          globalThis.window.taco.chat.stream({ requestId, provider, messages: apiMessages, overrides, projectId, workspace })
        })
      }

      abortRejectRefs.current.delete(threadId)
      requestIdRefs.current.delete(threadId)
      if (!isAgent) {
        // Chat 模式才在此追加消息，Agent 模式已在事件回调中维护
        if (accumulated) {
          const assistantMsg: ChatMsg = { id: uid(), role: 'assistant', content: accumulated }
          setMessages(threadId, (prev) => [...prev, assistantMsg])
        }
      }
      onComplete?.()
    } catch (error) {
      abortRejectRefs.current.delete(threadId)
      requestIdRefs.current.delete(threadId)
      const errMsg = error instanceof Error ? error.message : '请求失败'
      if (errMsg === '__stopped__') {
        if (isAgent) {
          // Agent 模式：消息已在事件流中维护，追加 [已停止] 标记
          if (accumulated) {
            setMessages(threadId, (prev) => {
              const last = prev[prev.length - 1]
              if (last?.role === 'assistant') {
                const updated = [...prev]
                updated[prev.length - 1] = { ...last, content: (last.content || accumulated) + '\n\n*[已停止]*' }
                return updated
              }
              return [...prev, { id: uid(), role: 'assistant', content: accumulated + '\n\n*[已停止]*' }]
            })
          }
        } else if (accumulated) {
          const stoppedMsg: ChatMsg = {
            id: uid(),
            role: 'assistant',
            content: accumulated + '\n\n*[已停止]*'
          }
          setMessages(threadId, (prev) => [...prev, stoppedMsg])
        }
      } else {
        const errChatMsg: ChatMsg = { id: uid(), role: 'assistant', content: `[Error] ${errMsg}` }
        setMessages(threadId, (prev) => [...prev, errChatMsg])
      }
    } finally {
      inFlightThreadsRef.current.delete(threadId)
      setSendingThreads((prev) => ({ ...prev, [threadId]: false }))
      setStreamingContents((prev) => {
        const next = { ...prev }
        delete next[threadId]
        return next
      })
      streamCleanupRefs.current.delete(threadId)

      setCompletedThreads((prev) => ({ ...prev, [threadId]: true }))
      setTimeout(() => {
        setCompletedThreads((prev) => {
          const next = { ...prev }
          delete next[threadId]
          return next
        })
      }, 3000)

      processQueue(threadId)
    }
  }

  /**
   * 基于已有消息列表重新请求（不创建新用户消息）。
   * 用于「编辑后重发」或「原样重发」场景：先由外部修改好 messages，再调用此方法。
   */
  async function resendFromExisting(params: Omit<SendMessageParams, 'content'>) {
    const { threadId, projectId, provider, providerForms, mode, workspace, maxTokens, onFirstMessage, onComplete } = params

    const currentMsgs = threadMessagesRef.current[threadId] ?? []
    if (currentMsgs.length === 0) return

    if (inFlightThreadsRef.current.has(threadId)) return
    inFlightThreadsRef.current.add(threadId)

    sendParamsRefs.current.set(threadId, { threadId, projectId, provider, providerForms, mode, workspace, onFirstMessage, onComplete })

    setSendingThreads((prev) => ({ ...prev, [threadId]: true }))
    setStreamingContents((prev) => ({ ...prev, [threadId]: '' }))

    const promptConfig = await ensurePromptConfigLoaded()
    const model = String(providerForms[provider]?.model ?? '').trim() || undefined
    const apiMessages = [
      { role: 'system' as const, content: buildSystemPrompt({ mode, workspace, provider, model, promptConfig }) },
      ...currentMsgs.map((m) => ({ role: m.role, content: m.content }))
    ]

    const overrides = {
      [provider]: {
        baseUrl: providerForms[provider]?.baseUrl || undefined,
        apiKey: providerForms[provider]?.apiKey || undefined,
        model: providerForms[provider]?.model || undefined
      }
    }

    const isAgent = mode === 'agent'
    let accumulated = ''
    try {
      const requestId = `req-${Date.now()}-${threadId}`
      requestIdRefs.current.set(threadId, requestId)

      if (isAgent) {
        await new Promise<void>((resolve, reject) => {
          abortRejectRefs.current.set(threadId, reject)

          const agentMsgId = uid()
          const steps: AgentStep[] = []
          let currentRound = 0
          let commitHash: string | undefined
          let activePlan: ActivePlan | undefined

          const flushAgentMsg = (finalContent?: string) => {
            const nextContent = finalContent ?? accumulated
            const hasRenderableContent = Boolean(nextContent.trim())
            const hasRenderableMeta = steps.length > 0 || Boolean(activePlan) || Boolean(commitHash)
            setMessages(threadId, (prev) => {
              const idx = prev.findIndex((m) => m.id === agentMsgId)
              if (idx === -1 && !hasRenderableContent && !hasRenderableMeta) return prev
              const msg: ChatMsg = {
                id: agentMsgId,
                role: 'assistant',
                content: nextContent,
                agentSteps: steps.length > 0 ? [...steps] : undefined,
                gitCommitHash: commitHash,
                activePlan: activePlan ? { ...activePlan, steps: activePlan.steps.map((s) => ({ ...s })) } : undefined,
              }
              if (idx === -1) return [...prev, msg]
              const next = [...prev]
              next[idx] = msg
              return next
            })
          }

          const cleanup = window.taco.agent.onEvent((evt) => {
            if (evt.requestId !== requestId) return

            if (evt.type === 'text') {
              accumulated += evt.content
              flushAgentMsg()
            } else if (evt.type === 'tool_calls') {
              currentRound++
              const toolCalls: ToolCallInfo[] = evt.toolCalls.map((tc) => ({
                id: tc.id,
                name: tc.function.name,
                arguments: tc.function.arguments,
              }))
              steps.push({
                round: currentRound,
                thinking: accumulated,
                toolCalls,
                toolResults: [],
                status: 'running',
              })
              accumulated = ''
              flushAgentMsg()
            } else if (evt.type === 'confirm') {
              const lastStep = steps[steps.length - 1]
              if (lastStep) {
                lastStep.status = 'confirm'
                lastStep.confirmId = evt.confirmId
                lastStep.risks = evt.risks.map((r) => ({
                  toolCallId: r.toolCallId,
                  toolName: r.toolName,
                  level: r.level,
                  reason: r.reason,
                  detail: r.detail,
                }))
              }
              flushAgentMsg()
            } else if (evt.type === 'tool_results') {
              const results: ToolResultInfo[] = evt.results.map((r) => ({
                tool_call_id: r.tool_call_id,
                name: r.name,
                content: r.content,
                success: r.success,
                fileChange: r.fileChange ? {
                  filePath: r.fileChange.filePath,
                  oldContent: r.fileChange.oldContent,
                  newContent: r.fileChange.newContent,
                } : undefined,
              }))
              const lastStep = steps[steps.length - 1]
              if (lastStep) {
                lastStep.toolResults = results
                lastStep.status = 'done'
              }
              flushAgentMsg()
            } else if (evt.type === 'git_commit') {
              commitHash = evt.hash
              flushAgentMsg()
            } else if (evt.type === 'plan_init') {
              activePlan = {
                summary: evt.summary,
                reasoning: evt.reasoning,
                steps: evt.steps.map((text) => ({ text, status: 'pending' as const })),
                startedAt: Date.now(),
              }
              flushAgentMsg()
            } else if (evt.type === 'plan_progress') {
              if (activePlan && evt.stepIndex >= 0 && evt.stepIndex < activePlan.steps.length) {
                activePlan.steps[evt.stepIndex].status = normalizePlanStatus(evt.status)
                if (evt.note) activePlan.steps[evt.stepIndex].note = evt.note
              }
              flushAgentMsg()
            } else if (evt.type === 'done') {
              if (activePlan && !activePlan.endedAt) activePlan.endedAt = Date.now()
              flushAgentMsg(accumulated)
              cleanup()
              resolve()
            } else if (evt.type === 'error') {
              if (activePlan && !activePlan.endedAt) activePlan.endedAt = Date.now()
              flushAgentMsg(accumulated)
              cleanup()
              reject(new Error(evt.message))
            }
          })
          streamCleanupRefs.current.set(threadId, cleanup)
          window.taco.agent.stream({
            requestId,
            provider,
            messages: apiMessages,
            overrides,
            projectId,
            workspace: workspace ?? '',
            maxTokens,
          })
        })
      } else {
        await new Promise<void>((resolve, reject) => {
          abortRejectRefs.current.set(threadId, reject)

          const cleanup = window.taco.chat.onChunk((data) => {
            if (data.requestId !== requestId) return
            if (data.error) { cleanup(); reject(new Error(data.error)); return }
            if (data.done) { cleanup(); resolve(); return }
            accumulated += data.chunk
            setStreamingContents((prev) => ({ ...prev, [threadId]: accumulated }))
          })
          streamCleanupRefs.current.set(threadId, cleanup)
          window.taco.chat.stream({ requestId, provider, messages: apiMessages, overrides, projectId, workspace })
        })
      }

      abortRejectRefs.current.delete(threadId)
      requestIdRefs.current.delete(threadId)
      if (!isAgent && accumulated) {
        const assistantMsg: ChatMsg = { id: uid(), role: 'assistant', content: accumulated }
        setMessages(threadId, (prev) => [...prev, assistantMsg])
      }
      onComplete?.()
    } catch (error) {
      abortRejectRefs.current.delete(threadId)
      requestIdRefs.current.delete(threadId)
      const errMsg = error instanceof Error ? error.message : '请求失败'
      if (errMsg === '__stopped__') {
        if (isAgent) {
          if (accumulated) {
            setMessages(threadId, (prev) => {
              const last = prev[prev.length - 1]
              if (last?.role === 'assistant') {
                const updated = [...prev]
                updated[prev.length - 1] = { ...last, content: (last.content || accumulated) + '\n\n*[已停止]*' }
                return updated
              }
              return [...prev, { id: uid(), role: 'assistant', content: accumulated + '\n\n*[已停止]*' }]
            })
          }
        } else if (accumulated) {
          const stoppedMsg: ChatMsg = { id: uid(), role: 'assistant', content: accumulated + '\n\n*[已停止]*' }
          setMessages(threadId, (prev) => [...prev, stoppedMsg])
        }
      } else {
        const errChatMsg: ChatMsg = { id: uid(), role: 'assistant', content: `[Error] ${errMsg}` }
        setMessages(threadId, (prev) => [...prev, errChatMsg])
      }
    } finally {
      inFlightThreadsRef.current.delete(threadId)
      setSendingThreads((prev) => ({ ...prev, [threadId]: false }))
      setStreamingContents((prev) => { const next = { ...prev }; delete next[threadId]; return next })
      streamCleanupRefs.current.delete(threadId)

      setCompletedThreads((prev) => ({ ...prev, [threadId]: true }))
      setTimeout(() => {
        setCompletedThreads((prev) => { const next = { ...prev }; delete next[threadId]; return next })
      }, 3000)

      processQueue(threadId)
    }
  }

  // 保持 ref 指向最新函数
  sendMessageRef.current = sendMessage

  return {
    threadMessages,
    isSending,
    isCompleted,
    getStreamingContent,
    getQueue,
    getMessages,
    setMessages,
    clearMessages,
    deleteThreadMessages,
    sendMessage,
    resendFromExisting,
    stopSending,
    addToQueue,
    removeFromQueue,
  }
}
