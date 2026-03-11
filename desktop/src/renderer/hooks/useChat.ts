import { useCallback, useEffect, useRef, useState } from 'react'
import type { ActivePlan, AgentStep, AttachedImage, ChatMsg, ProviderId, ProviderForms, QueuedMessage, TaskTiming, ThreadMode, ToolCallInfo, ToolResultInfo } from '../types'
import type { ChatStoreSessionPatch, ChatStoreSessionSnapshot, PromptConfig } from '../../shared/ipc'
import { buildSystemPrompt } from '../constants'
import { loadJson, saveJson, uid } from '../lib/storage'

type SessionStoreMeta = {
  projectId?: string
  workspace?: string
}

const CHAT_STORE_FLUSH_DEBOUNCE_MS = 280

function normalizeChatStoreMessages(messages: unknown[]): ChatMsg[] {
  return Array.isArray(messages) ? (messages as ChatMsg[]) : []
}

function serializeChatStoreMessage(message: ChatMsg): string {
  try {
    return JSON.stringify(message)
  } catch {
    return ''
  }
}

function areChatStoreMessagesEqual(prev: ChatMsg | undefined, next: ChatMsg | undefined): boolean {
  if (prev === next) return true
  if (!prev || !next) return false
  if (prev.id !== next.id) return false
  if (prev.role !== next.role) return false
  if (prev.content !== next.content) return false
  if ((prev.gitCommitHash || '') !== (next.gitCommitHash || '')) return false
  return serializeChatStoreMessage(prev) === serializeChatStoreMessage(next)
}

function findFirstChangedMessageIndex(prevMessages: ChatMsg[], nextMessages: ChatMsg[]): number {
  const sharedLength = Math.min(prevMessages.length, nextMessages.length)
  for (let index = 0; index < sharedLength; index++) {
    if (!areChatStoreMessagesEqual(prevMessages[index], nextMessages[index])) {
      return index
    }
  }
  return sharedLength
}

function normalizePlanStatus(status: string): 'pending' | 'in_progress' | 'done' | 'failed' {
  const s = String(status ?? '').trim().toLowerCase()
  if (s === 'in-progress' || s === 'inprogress' || s === 'running') return 'in_progress'
  if (s === 'complete' || s === 'completed' || s === 'success' || s === 'succeeded') return 'done'
  if (s === 'error') return 'failed'
  if (s === 'pending' || s === 'in_progress' || s === 'done' || s === 'failed') return s
  return 'pending'
}

function buildTaskTiming(startedAt: number, endedAt = Date.now()): TaskTiming {
  const safeStart = Number.isFinite(startedAt) ? startedAt : Date.now()
  const safeEnd = Number.isFinite(endedAt) ? endedAt : Date.now()
  const normalizedEnd = safeEnd >= safeStart ? safeEnd : safeStart
  return {
    startedAt: safeStart,
    endedAt: normalizedEnd,
    durationMs: normalizedEnd - safeStart,
  }
}

function mapMessageForApi(msg: ChatMsg): { role: ChatMsg['role']; content: string } {
  if (msg.role !== 'user') return { role: msg.role, content: msg.content }
  const raw = String(msg.content ?? '')
  const wrapped = raw.match(/\[USER_QUERY\]([\s\S]*?)\[\/USER_QUERY\]/i)
  if (wrapped && wrapped[1] !== undefined) {
    return { role: msg.role, content: raw.trim() }
  }
  const body = raw.trim()
  return { role: msg.role, content: `[USER_QUERY]\n${body}\n[/USER_QUERY]` }
}

function buildMessagesForApi(messages: ChatMsg[], mode?: ThreadMode): Array<{ role: ChatMsg['role']; content: string }> {
  if (mode === 'agent') {
    // Agent 模式优先发送最近上下文，避免“仅发最后一条用户消息”导致在记忆为空时丢失链路。
    const MAX_RECENT_MESSAGES = 8
    const MAX_RECENT_USER_TURNS = 3
    const recent: ChatMsg[] = []
    let userTurns = 0
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role === 'system') continue
      recent.push(msg)
      if (msg.role === 'user') userTurns++
      if (recent.length >= MAX_RECENT_MESSAGES || userTurns >= MAX_RECENT_USER_TURNS) break
    }
    if (recent.length > 0) {
      return recent.reverse().map((msg) => mapMessageForApi(msg))
    }
    const last = messages[messages.length - 1]
    return last ? [mapMessageForApi(last)] : []
  }
  return messages.map((m) => mapMessageForApi(m))
}

function isRecallDebugEnabled(): boolean {
  return localStorage.getItem('taco.recallDebugEnabled') === 'true'
}

export type ProjectTokenStats = {
  inputTokens: number
  outputTokens: number
  hitTokens: number
  missTokens: number
  totalTokens: number
  turns: number
  updatedAt: number
}

type TokenUsageSnapshot = {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  cachedTokens?: number
}

type UsageAggregate = {
  inputTokens: number
  outputTokens: number
  hitTokens: number
  missTokens: number
  totalTokens: number
}

function toFiniteTokenCount(value: unknown): number | undefined {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return undefined
  return Math.floor(n)
}

function normalizeProjectTokenStatsMap(raw: Record<string, unknown>): Record<string, ProjectTokenStats> {
  const out: Record<string, ProjectTokenStats> = {}
  for (const [threadId, value] of Object.entries(raw ?? {})) {
    if (!threadId.trim() || !value || typeof value !== 'object') continue
    const obj = value as Record<string, unknown>
    const inputTokens = toFiniteTokenCount(obj.inputTokens) ?? 0
    const outputTokens = toFiniteTokenCount(obj.outputTokens) ?? 0
    const hitTokens = toFiniteTokenCount(obj.hitTokens) ?? 0
    const missTokens = toFiniteTokenCount(obj.missTokens) ?? 0
    const totalTokens = toFiniteTokenCount(obj.totalTokens) ?? 0
    const turns = toFiniteTokenCount(obj.turns) ?? 0
    const updatedAt = toFiniteTokenCount(obj.updatedAt) ?? Date.now()
    out[threadId] = { inputTokens, outputTokens, hitTokens, missTokens, totalTokens, turns, updatedAt }
  }
  return out
}

function mergeUsageSnapshot(
  prev: TokenUsageSnapshot | null,
  next: TokenUsageSnapshot | undefined,
): TokenUsageSnapshot | null {
  if (!next || typeof next !== 'object') return prev
  const promptTokens = toFiniteTokenCount(next.promptTokens)
  const completionTokens = toFiniteTokenCount(next.completionTokens)
  const totalTokens = toFiniteTokenCount(next.totalTokens)
  const cachedTokens = toFiniteTokenCount(next.cachedTokens)

  const merged: TokenUsageSnapshot = { ...(prev ?? {}) }
  if (promptTokens !== undefined) merged.promptTokens = promptTokens
  if (completionTokens !== undefined) merged.completionTokens = completionTokens
  if (totalTokens !== undefined) merged.totalTokens = totalTokens
  if (cachedTokens !== undefined) merged.cachedTokens = cachedTokens

  const hasAny =
    merged.promptTokens !== undefined
    || merged.completionTokens !== undefined
    || merged.totalTokens !== undefined
    || merged.cachedTokens !== undefined
  return hasAny ? merged : prev
}

function resolveUsageTotalTokens(usage: TokenUsageSnapshot | null): number | undefined {
  if (!usage) return undefined
  if (usage.totalTokens !== undefined) return usage.totalTokens
  const prompt = usage.promptTokens ?? 0
  const completion = usage.completionTokens ?? 0
  const fallback = prompt + completion
  return fallback > 0 ? fallback : undefined
}

function usageToAggregate(usage: TokenUsageSnapshot | null): UsageAggregate {
  if (!usage) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      hitTokens: 0,
      missTokens: 0,
      totalTokens: 0,
    }
  }
  const prompt = usage.promptTokens ?? 0
  const completion = usage.completionTokens ?? 0
  const cached = Math.min(prompt, usage.cachedTokens ?? 0)
  const miss = Math.max(0, prompt - cached)
  const total = resolveUsageTotalTokens(usage) ?? (prompt + completion)
  return {
    inputTokens: Math.max(0, prompt),
    outputTokens: Math.max(0, completion),
    hitTokens: Math.max(0, cached),
    missTokens: Math.max(0, miss),
    totalTokens: Math.max(0, total),
  }
}

function diffUsageAggregate(next: UsageAggregate, prev: UsageAggregate): UsageAggregate {
  return {
    inputTokens: Math.max(0, next.inputTokens - prev.inputTokens),
    outputTokens: Math.max(0, next.outputTokens - prev.outputTokens),
    hitTokens: Math.max(0, next.hitTokens - prev.hitTokens),
    missTokens: Math.max(0, next.missTokens - prev.missTokens),
    totalTokens: Math.max(0, next.totalTokens - prev.totalTokens),
  }
}

function hasUsageDelta(delta: UsageAggregate): boolean {
  return delta.inputTokens > 0
    || delta.outputTokens > 0
    || delta.hitTokens > 0
    || delta.missTokens > 0
    || delta.totalTokens > 0
}

function applyUsageDeltaToProjectStats(base: ProjectTokenStats, delta: UsageAggregate, incrementTurn: boolean): ProjectTokenStats {
  return {
    inputTokens: base.inputTokens + delta.inputTokens,
    outputTokens: base.outputTokens + delta.outputTokens,
    hitTokens: base.hitTokens + delta.hitTokens,
    missTokens: base.missTokens + delta.missTokens,
    totalTokens: base.totalTokens + delta.totalTokens,
    turns: base.turns + (incrementTurn ? 1 : 0),
    updatedAt: Date.now(),
  }
}

export type SendMessageParams = {
  threadId: string
  /** 项目标识（用于项目级日志与笔记隔离） */
  projectId?: string
  /** 当前项目的自定义规则（自动注入 system prompt） */
  projectRules?: string
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
  const [threadMessages, setThreadMessages] = useState<Record<string, ChatMsg[]>>({})

  /** 每个 thread 是否正在发送 */
  const [sendingThreads, setSendingThreads] = useState<Record<string, boolean>>({})
  /** 每个 thread 的流式内容 */
  const [streamingContents, setStreamingContents] = useState<Record<string, string>>({})
  /** 每个 thread 的待发送队列 */
  const [queues, setQueues] = useState<Record<string, QueuedMessage[]>>({})
  /** 每个 thread 最近一次真实 usage.total_tokens */
  const [usageTotalTokensByThread, setUsageTotalTokensByThread] = useState<Record<string, number | undefined>>({})
  /** 每个项目（thread）累计 token 统计 */
  const [projectTokenStatsByThread, setProjectTokenStatsByThread] = useState<Record<string, ProjectTokenStats>>(() =>
    normalizeProjectTokenStatsMap(loadJson('taco.projectTokenStatsByThread', {}))
  )
  /** 每个 thread 当前任务开始时间（用于实时耗时显示） */
  const [activeTaskStartedAtByThread, setActiveTaskStartedAtByThread] = useState<Record<string, number | undefined>>({})
  /** 刚完成的 thread（短暂显示 ✓ 后自动清除） */
  const [completedThreads, setCompletedThreads] = useState<Record<string, boolean>>({})

  // Ref：始终指向最新 threadMessages，供异步回调读取
  const threadMessagesRef = useRef(threadMessages)
  threadMessagesRef.current = threadMessages
  const sessionStoreMetaRef = useRef<Map<string, SessionStoreMeta>>(new Map())
  const persistTimersRef = useRef<Map<string, number>>(new Map())
  const pendingPersistRef = useRef<Map<string, ChatStoreSessionPatch>>(new Map())

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

  const rememberSessionStoreMeta = useCallback((sessionId: string, meta?: SessionStoreMeta) => {
    const key = String(sessionId || '').trim()
    if (!key) return
    const previous = sessionStoreMetaRef.current.get(key) ?? {}
    sessionStoreMetaRef.current.set(key, {
      projectId: String(meta?.projectId || previous.projectId || '').trim() || undefined,
      workspace: String(meta?.workspace || previous.workspace || '').trim() || undefined,
    })
  }, [])

  const flushPersistedSession = useCallback(async (sessionId: string) => {
    const key = String(sessionId || '').trim()
    if (!key) return
    const timer = persistTimersRef.current.get(key)
    if (typeof timer === 'number') {
      window.clearTimeout(timer)
      persistTimersRef.current.delete(key)
    }
    const patch = pendingPersistRef.current.get(key)
    if (!patch) return
    pendingPersistRef.current.delete(key)
    try {
      await window.taco.chatStore.save(patch)
    } catch (err) {
      console.error('[chat-store] 持久化会话消息失败:', key, err)
    }
  }, [])

  const schedulePersistedSession = useCallback((sessionId: string, prevMessages: ChatMsg[], nextMessages: ChatMsg[]) => {
    const key = String(sessionId || '').trim()
    if (!key) return
    const fromSeq = findFirstChangedMessageIndex(prevMessages, nextMessages)
    const pending = pendingPersistRef.current.get(key)
    const mergedFromSeq = pending ? Math.min(pending.fromSeq, fromSeq) : fromSeq
    const meta = sessionStoreMetaRef.current.get(key) ?? {}
    pendingPersistRef.current.set(key, {
      projectId: String(meta.projectId || '').trim(),
      sessionId: key,
      workspace: String(meta.workspace || '').trim() || undefined,
      updatedAt: Date.now(),
      fromSeq: mergedFromSeq,
      messages: nextMessages.slice(mergedFromSeq) as unknown[],
    })
    const prevTimer = persistTimersRef.current.get(key)
    if (typeof prevTimer === 'number') {
      window.clearTimeout(prevTimer)
    }
    const timer = window.setTimeout(() => {
      void flushPersistedSession(key)
    }, CHAT_STORE_FLUSH_DEBOUNCE_MS)
    persistTimersRef.current.set(key, timer)
  }, [flushPersistedSession])

  const deletePersistedSession = useCallback(async (sessionId: string) => {
    const key = String(sessionId || '').trim()
    if (!key) return
    const timer = persistTimersRef.current.get(key)
    if (typeof timer === 'number') {
      window.clearTimeout(timer)
      persistTimersRef.current.delete(key)
    }
    pendingPersistRef.current.delete(key)
    sessionStoreMetaRef.current.delete(key)
    try {
      await window.taco.chatStore.deleteSession(key)
    } catch (err) {
      console.error('[chat-store] 删除会话消息失败:', key, err)
    }
  }, [])

  const flushAllPersistedSessions = useCallback(() => {
    const sessionIds = Array.from(pendingPersistRef.current.keys())
    if (sessionIds.length <= 0) return
    for (const sessionId of sessionIds) {
      void flushPersistedSession(sessionId)
    }
  }, [flushPersistedSession])

  // 从 SQLite 恢复完整消息；如存在旧 localStorage 数据则导入一次后清理。
  useEffect(() => {
    let cancelled = false

    const hydrateMessages = async () => {
      try {
        const entries = await window.taco.chatStore.list()
        if (cancelled) return

        const loaded: Record<string, ChatMsg[]> = {}
        for (const entry of entries) {
          const sessionId = String(entry.sessionId || '').trim()
          if (!sessionId) continue
          loaded[sessionId] = normalizeChatStoreMessages(entry.messages)
          rememberSessionStoreMeta(sessionId, {
            projectId: entry.projectId,
            workspace: entry.workspace,
          })
        }

        const legacy = loadJson<Record<string, ChatMsg[]>>('taco.messages', {})
        const legacyEntries = Object.entries(legacy ?? {}).filter(([sessionId, messages]) =>
          sessionId.trim() && Array.isArray(messages) && messages.length > 0,
        )

        for (const [sessionId, messages] of legacyEntries) {
          if (!loaded[sessionId]) {
            loaded[sessionId] = messages
          }
        }

        setThreadMessages((prev) => {
          const merged = { ...loaded, ...prev }
          threadMessagesRef.current = merged
          return merged
        })

        if (legacyEntries.length > 0) {
          const saveTasks = legacyEntries.map(async ([sessionId, messages]) => {
            try {
              await window.taco.chatStore.save({
                projectId: '',
                sessionId,
                updatedAt: Date.now(),
                fromSeq: 0,
                messages: messages as unknown[],
              })
            } catch (err) {
              console.error('[chat-store] 导入旧会话消息失败:', sessionId, err)
              throw err
            }
          })
          try {
            await Promise.all(saveTasks)
            localStorage.removeItem('taco.messages')
          } catch {
            // 保留旧缓存，避免导入失败后数据直接丢失
          }
        }
      } catch (err) {
        if (!cancelled) {
          console.error('[chat-store] 加载持久化消息失败:', err)
        }
      }
    }

    void hydrateMessages()

    return () => {
      cancelled = true
      flushAllPersistedSessions()
      for (const timer of persistTimersRef.current.values()) {
        window.clearTimeout(timer)
      }
      persistTimersRef.current.clear()
    }
  }, [flushAllPersistedSessions, rememberSessionStoreMeta])

  useEffect(() => {
    const handleBeforeUnload = () => {
      flushAllPersistedSessions()
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [flushAllPersistedSessions])

  useEffect(() => {
    saveJson('taco.projectTokenStatsByThread', projectTokenStatsByThread)
  }, [projectTokenStatsByThread])

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

  function getUsageTotalTokens(threadId: string): number | undefined {
    const value = usageTotalTokensByThread[threadId]
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  }

  function getActiveTaskStartedAt(threadId: string): number | undefined {
    const value = activeTaskStartedAtByThread[threadId]
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  }

  function getProjectTokenStats(threadId: string): ProjectTokenStats {
    return projectTokenStatsByThread[threadId] ?? {
      inputTokens: 0,
      outputTokens: 0,
      hitTokens: 0,
      missTokens: 0,
      totalTokens: 0,
      turns: 0,
      updatedAt: Date.now(),
    }
  }

  function clearProjectTokenStats(threadId: string) {
    const key = String(threadId ?? '').trim()
    if (!key) return
    setProjectTokenStatsByThread((prev) => {
      if (!(key in prev)) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  /* ------------------------------------------------------------------ */
  /*  Message CRUD                                                       */
  /* ------------------------------------------------------------------ */

  const setMessages = useCallback(
    (threadId: string, updater: ChatMsg[] | ((prev: ChatMsg[]) => ChatMsg[])) => {
      setThreadMessages((prev) => {
        const current = prev[threadId] ?? []
        const next = typeof updater === 'function' ? updater(current) : updater
        const updated = next.length > 0
          ? { ...prev, [threadId]: next }
          : (() => {
              const clone = { ...prev }
              delete clone[threadId]
              return clone
            })()
        // 同步更新 ref，确保 resendFromExisting 等异步调用能立即读到最新消息
        threadMessagesRef.current = updated
        if (next.length > 0) {
          schedulePersistedSession(threadId, current, next)
        } else {
          void deletePersistedSession(threadId)
        }
        return updated
      })
    },
    [deletePersistedSession, schedulePersistedSession]
  )

  function clearMessages(threadId: string) {
    setMessages(threadId, [])
    setUsageTotalTokensByThread((prev) => {
      const next = { ...prev }
      delete next[threadId]
      return next
    })
    setActiveTaskStartedAtByThread((prev) => {
      const next = { ...prev }
      delete next[threadId]
      return next
    })
  }

  function deleteThreadMessages(threadId: string) {
    setThreadMessages((prev) => {
      const next = { ...prev }
      delete next[threadId]
      threadMessagesRef.current = next
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
    setUsageTotalTokensByThread((prev) => {
      const next = { ...prev }
      delete next[threadId]
      return next
    })
    setActiveTaskStartedAtByThread((prev) => {
      const next = { ...prev }
      delete next[threadId]
      return next
    })
    inFlightThreadsRef.current.delete(threadId)
    sendParamsRefs.current.delete(threadId)
    streamCleanupRefs.current.delete(threadId)
    abortRejectRefs.current.delete(threadId)
    requestIdRefs.current.delete(threadId)
    void deletePersistedSession(threadId)
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
    const { threadId, projectId, projectRules, content, images, provider, providerForms, mode, workspace, maxTokens, onFirstMessage, onComplete } = params
    rememberSessionStoreMeta(threadId, { projectId, workspace })

    // 保存参数供队列重发
    sendParamsRefs.current.set(threadId, {
      threadId,
      projectId,
      projectRules,
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
    const taskStartedAt = Date.now()

    // 用 ref 读取最新消息，避免闭包过期
    const currentMsgs = threadMessagesRef.current[threadId] ?? []
    const userMsg: ChatMsg = { id: uid(), role: 'user', content, ...(images && images.length > 0 ? { images } : {}) }
    const sourceUserMessageId = userMsg.id
    const streamAssistantMessageId = uid()
    const updatedMsgs = [...currentMsgs, userMsg]

    setMessages(threadId, updatedMsgs)
    setSendingThreads((prev) => ({ ...prev, [threadId]: true }))
    setStreamingContents((prev) => ({ ...prev, [threadId]: '' }))
    setUsageTotalTokensByThread((prev) => ({ ...prev, [threadId]: undefined }))
    setActiveTaskStartedAtByThread((prev) => ({ ...prev, [threadId]: taskStartedAt }))

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
      projectRules,
      promptConfig,
    })
    const isAgent = mode === 'agent'
    const chatMsgs = buildMessagesForApi(updatedMsgs, mode)

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

    let accumulated = ''
    let requestUsage: TokenUsageSnapshot | null = null
    let appliedUsage: TokenUsageSnapshot | null = null
    let usageTurnCounted = false
    const projectKey = String(projectId ?? threadId ?? '').trim()
    const applyProjectUsage = (usage: TokenUsageSnapshot | null) => {
      if (!usage || !projectKey) return
      const nextAgg = usageToAggregate(usage)
      const prevAgg = usageToAggregate(appliedUsage)
      const delta = diffUsageAggregate(nextAgg, prevAgg)
      const shouldCountTurn = !usageTurnCounted && (nextAgg.totalTokens > 0 || nextAgg.inputTokens > 0 || nextAgg.outputTokens > 0)
      if (!hasUsageDelta(delta) && !shouldCountTurn) return
      setProjectTokenStatsByThread((prev) => {
        const base = prev[projectKey] ?? {
          inputTokens: 0,
          outputTokens: 0,
          hitTokens: 0,
          missTokens: 0,
          totalTokens: 0,
          turns: 0,
          updatedAt: Date.now(),
        }
        return {
          ...prev,
          [projectKey]: applyUsageDeltaToProjectStats(base, delta, shouldCountTurn),
        }
      })
      appliedUsage = usage
      if (shouldCountTurn) usageTurnCounted = true
    }
    const trackRequestUsage = (usage?: TokenUsageSnapshot) => {
      requestUsage = mergeUsageSnapshot(requestUsage, usage)
      const totalTokens = resolveUsageTotalTokens(requestUsage)
      if (typeof totalTokens === 'number' && Number.isFinite(totalTokens)) {
        setUsageTotalTokensByThread((prev) => ({ ...prev, [threadId]: totalTokens }))
      }
      applyProjectUsage(requestUsage)
    }
    try {
      const requestId = `req-${Date.now()}-${threadId}`
      // 记录当前 requestId 以便 stopSending 能发送 abort IPC
      requestIdRefs.current.set(threadId, requestId)

      if (isAgent) {
        // ── Agent 模式：整合为单条 assistant 消息，步骤折叠显示 ──
        await new Promise<void>((resolve, reject) => {
          abortRejectRefs.current.set(threadId, reject)

          // Agent 唯一的 assistant 消息 ID（与主进程记忆来源指针保持一致）
          const agentMsgId = streamAssistantMessageId
          const steps: AgentStep[] = []
          let currentRound = 0
          let commitHash: string | undefined
          let activePlan: ActivePlan | undefined
          let reasoningAccumulated = ''

          // 辅助：更新 agent 消息（追加或更新）
          const flushAgentMsg = (finalContent?: string, taskTiming?: TaskTiming) => {
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
                taskTiming,
              }
              if (idx === -1) return [...prev, msg]
              const next = [...prev]
              next[idx] = msg
              return next
            })
          }

          const runningTaskTiming: TaskTiming = { startedAt: taskStartedAt }
          const cleanup = globalThis.window.taco.agent.onEvent((event) => {
            if (event.requestId !== requestId) return

            if (event.type === 'text') {
              accumulated += event.content
              // Agent 模式下直接更新消息内容，不使用独立的 streamingContent
              flushAgentMsg(undefined, runningTaskTiming)
            } else if (event.type === 'reasoning') {
              reasoningAccumulated += event.content
            } else if (event.type === 'usage') {
              trackRequestUsage(event.usage)
            } else if (event.type === 'tool_calls') {
              // AI 决定调用工具 → 当前文本作为该步骤的 thinking
              currentRound++
              const toolThinking = String(event.thinking ?? '').trim()
              const toolCalls: ToolCallInfo[] = event.toolCalls.map((tc) => ({
                id: tc.id,
                name: tc.function.name,
                arguments: tc.function.arguments,
              }))
              steps.push({
                round: currentRound,
                thinking: toolThinking || reasoningAccumulated.trim() || accumulated,
                toolCalls,
                toolResults: [],
                status: 'running',
              })
              // 清空累积文本，后续文本属于下一轮或最终回复
              accumulated = ''
              reasoningAccumulated = ''
              flushAgentMsg(undefined, runningTaskTiming)
            } else if (event.type === 'system_notice') {
              currentRound++
              steps.push({
                round: currentRound,
                systemTitle: event.title,
                systemDetail: event.message || '',
                thinking: event.message || event.title,
                toolCalls: [],
                toolResults: [],
                status: 'done',
              })
              flushAgentMsg(undefined, runningTaskTiming)
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
              flushAgentMsg(undefined, runningTaskTiming)
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
              flushAgentMsg(undefined, runningTaskTiming)
            } else if (event.type === 'git_commit') {
              // Agent 自动提交完成，记录 commit hash
              commitHash = event.hash
              flushAgentMsg(undefined, runningTaskTiming)
            } else if (event.type === 'plan_init') {
              // 计划初始化：用户确认了执行计划
              activePlan = {
                summary: event.summary,
                reasoning: event.reasoning,
                steps: event.steps.map((text) => ({ text, status: 'pending' as const })),
                startedAt: Date.now(),
              }
              flushAgentMsg(undefined, runningTaskTiming)
            } else if (event.type === 'plan_progress') {
              // 计划步骤进度更新
              if (activePlan && event.stepIndex >= 0 && event.stepIndex < activePlan.steps.length) {
                activePlan.steps[event.stepIndex].status = normalizePlanStatus(event.status)
                if (event.note) activePlan.steps[event.stepIndex].note = event.note
              }
              flushAgentMsg(undefined, runningTaskTiming)
            } else if (event.type === 'done') {
              // 最终回复写入 content
              const finishedAt = Date.now()
              if (activePlan && !activePlan.endedAt) activePlan.endedAt = finishedAt
              flushAgentMsg(accumulated, buildTaskTiming(taskStartedAt, finishedAt))
              cleanup()
              resolve()
            } else if (event.type === 'error') {
              const finishedAt = Date.now()
              if (activePlan && !activePlan.endedAt) activePlan.endedAt = finishedAt
              flushAgentMsg(accumulated, buildTaskTiming(taskStartedAt, finishedAt))
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
            recallDebug: isRecallDebugEnabled(),
            sessionId: threadId,
            sourceUserMessageId,
            sourceAssistantMessageId: streamAssistantMessageId,
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
            if (data.done) {
              trackRequestUsage(data.usage)
              cleanup()
              resolve()
              return
            }
            accumulated += data.chunk
            setStreamingContents((prev) => ({ ...prev, [threadId]: accumulated }))
          })
          streamCleanupRefs.current.set(threadId, cleanup)
          globalThis.window.taco.chat.stream({
            requestId,
            provider,
            messages: apiMessages,
            overrides,
            projectId,
            workspace,
            maxTokens,
            sessionId: threadId,
            sourceUserMessageId,
            sourceAssistantMessageId: streamAssistantMessageId,
          })
        })
      }

      abortRejectRefs.current.delete(threadId)
      requestIdRefs.current.delete(threadId)
      if (!isAgent) {
        // Chat 模式才在此追加消息，Agent 模式已在事件回调中维护
        if (accumulated) {
          const assistantMsg: ChatMsg = {
            id: streamAssistantMessageId,
            role: 'assistant',
            content: accumulated,
            taskTiming: buildTaskTiming(taskStartedAt),
          }
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
          const timing = buildTaskTiming(taskStartedAt)
          setMessages(threadId, (prev) => {
            for (let i = prev.length - 1; i >= 0; i--) {
              if (prev[i]?.role !== 'assistant') continue
              const updated = [...prev]
              const tail = updated[i]
              const stoppedContent = (tail.content || accumulated).includes('*[已停止]*')
                ? (tail.content || accumulated)
                : `${tail.content || accumulated}\n\n*[已停止]*`
              updated[i] = { ...tail, content: stoppedContent, taskTiming: timing }
              return updated
            }
            if (!accumulated) return prev
            return [...prev, { id: streamAssistantMessageId, role: 'assistant', content: accumulated + '\n\n*[已停止]*', taskTiming: timing }]
          })
        } else if (accumulated) {
          const stoppedMsg: ChatMsg = {
            id: streamAssistantMessageId,
            role: 'assistant',
            content: accumulated + '\n\n*[已停止]*',
            taskTiming: buildTaskTiming(taskStartedAt),
          }
          setMessages(threadId, (prev) => [...prev, stoppedMsg])
        }
      } else {
        const errChatMsg: ChatMsg = {
          id: streamAssistantMessageId,
          role: 'assistant',
          content: `[Error] ${errMsg}`,
          taskTiming: buildTaskTiming(taskStartedAt),
        }
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
      setActiveTaskStartedAtByThread((prev) => {
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
    const { threadId, projectId, projectRules, provider, providerForms, mode, workspace, maxTokens, onFirstMessage, onComplete } = params
    rememberSessionStoreMeta(threadId, { projectId, workspace })

    const currentMsgs = threadMessagesRef.current[threadId] ?? []
    if (currentMsgs.length === 0) return
    const sourceUserMessageId = [...currentMsgs].reverse().find((msg) => msg.role === 'user')?.id || ''
    const streamAssistantMessageId = uid()

    if (inFlightThreadsRef.current.has(threadId)) return
    inFlightThreadsRef.current.add(threadId)
    const taskStartedAt = Date.now()

    sendParamsRefs.current.set(threadId, { threadId, projectId, projectRules, provider, providerForms, mode, workspace, onFirstMessage, onComplete })

    setSendingThreads((prev) => ({ ...prev, [threadId]: true }))
    setStreamingContents((prev) => ({ ...prev, [threadId]: '' }))
    setUsageTotalTokensByThread((prev) => ({ ...prev, [threadId]: undefined }))
    setActiveTaskStartedAtByThread((prev) => ({ ...prev, [threadId]: taskStartedAt }))

    const promptConfig = await ensurePromptConfigLoaded()
    const model = String(providerForms[provider]?.model ?? '').trim() || undefined
    const isAgent = mode === 'agent'
    const apiMessages = [
      { role: 'system' as const, content: buildSystemPrompt({ mode, workspace, provider, model, projectRules, promptConfig }) },
      ...buildMessagesForApi(currentMsgs, mode)
    ]

    const overrides = {
      [provider]: {
        baseUrl: providerForms[provider]?.baseUrl || undefined,
        apiKey: providerForms[provider]?.apiKey || undefined,
        model: providerForms[provider]?.model || undefined
      }
    }

    let accumulated = ''
    let requestUsage: TokenUsageSnapshot | null = null
    let appliedUsage: TokenUsageSnapshot | null = null
    let usageTurnCounted = false
    const projectKey = String(projectId ?? threadId ?? '').trim()
    const applyProjectUsage = (usage: TokenUsageSnapshot | null) => {
      if (!usage || !projectKey) return
      const nextAgg = usageToAggregate(usage)
      const prevAgg = usageToAggregate(appliedUsage)
      const delta = diffUsageAggregate(nextAgg, prevAgg)
      const shouldCountTurn = !usageTurnCounted && (nextAgg.totalTokens > 0 || nextAgg.inputTokens > 0 || nextAgg.outputTokens > 0)
      if (!hasUsageDelta(delta) && !shouldCountTurn) return
      setProjectTokenStatsByThread((prev) => {
        const base = prev[projectKey] ?? {
          inputTokens: 0,
          outputTokens: 0,
          hitTokens: 0,
          missTokens: 0,
          totalTokens: 0,
          turns: 0,
          updatedAt: Date.now(),
        }
        return {
          ...prev,
          [projectKey]: applyUsageDeltaToProjectStats(base, delta, shouldCountTurn),
        }
      })
      appliedUsage = usage
      if (shouldCountTurn) usageTurnCounted = true
    }
    const trackRequestUsage = (usage?: TokenUsageSnapshot) => {
      requestUsage = mergeUsageSnapshot(requestUsage, usage)
      const totalTokens = resolveUsageTotalTokens(requestUsage)
      if (typeof totalTokens === 'number' && Number.isFinite(totalTokens)) {
        setUsageTotalTokensByThread((prev) => ({ ...prev, [threadId]: totalTokens }))
      }
      applyProjectUsage(requestUsage)
    }
    try {
      const requestId = `req-${Date.now()}-${threadId}`
      requestIdRefs.current.set(threadId, requestId)

      if (isAgent) {
        await new Promise<void>((resolve, reject) => {
          abortRejectRefs.current.set(threadId, reject)

          const agentMsgId = streamAssistantMessageId
          const steps: AgentStep[] = []
          let currentRound = 0
          let commitHash: string | undefined
          let activePlan: ActivePlan | undefined
          let reasoningAccumulated = ''

          const flushAgentMsg = (finalContent?: string, taskTiming?: TaskTiming) => {
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
                taskTiming,
              }
              if (idx === -1) return [...prev, msg]
              const next = [...prev]
              next[idx] = msg
              return next
            })
          }

          const runningTaskTiming: TaskTiming = { startedAt: taskStartedAt }
          const cleanup = window.taco.agent.onEvent((evt) => {
            if (evt.requestId !== requestId) return

            if (evt.type === 'text') {
              accumulated += evt.content
              flushAgentMsg(undefined, runningTaskTiming)
            } else if (evt.type === 'reasoning') {
              reasoningAccumulated += evt.content
            } else if (evt.type === 'usage') {
              trackRequestUsage(evt.usage)
            } else if (evt.type === 'tool_calls') {
              currentRound++
              const toolThinking = String(evt.thinking ?? '').trim()
              const toolCalls: ToolCallInfo[] = evt.toolCalls.map((tc) => ({
                id: tc.id,
                name: tc.function.name,
                arguments: tc.function.arguments,
              }))
              steps.push({
                round: currentRound,
                thinking: toolThinking || reasoningAccumulated.trim() || accumulated,
                toolCalls,
                toolResults: [],
                status: 'running',
              })
              accumulated = ''
              reasoningAccumulated = ''
              flushAgentMsg(undefined, runningTaskTiming)
            } else if (evt.type === 'system_notice') {
              currentRound++
              steps.push({
                round: currentRound,
                systemTitle: evt.title,
                systemDetail: evt.message || '',
                thinking: evt.message || evt.title,
                toolCalls: [],
                toolResults: [],
                status: 'done',
              })
              flushAgentMsg(undefined, runningTaskTiming)
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
              flushAgentMsg(undefined, runningTaskTiming)
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
              flushAgentMsg(undefined, runningTaskTiming)
            } else if (evt.type === 'git_commit') {
              commitHash = evt.hash
              flushAgentMsg(undefined, runningTaskTiming)
            } else if (evt.type === 'plan_init') {
              activePlan = {
                summary: evt.summary,
                reasoning: evt.reasoning,
                steps: evt.steps.map((text) => ({ text, status: 'pending' as const })),
                startedAt: Date.now(),
              }
              flushAgentMsg(undefined, runningTaskTiming)
            } else if (evt.type === 'plan_progress') {
              if (activePlan && evt.stepIndex >= 0 && evt.stepIndex < activePlan.steps.length) {
                activePlan.steps[evt.stepIndex].status = normalizePlanStatus(evt.status)
                if (evt.note) activePlan.steps[evt.stepIndex].note = evt.note
              }
              flushAgentMsg(undefined, runningTaskTiming)
            } else if (evt.type === 'done') {
              const finishedAt = Date.now()
              if (activePlan && !activePlan.endedAt) activePlan.endedAt = finishedAt
              flushAgentMsg(accumulated, buildTaskTiming(taskStartedAt, finishedAt))
              cleanup()
              resolve()
            } else if (evt.type === 'error') {
              const finishedAt = Date.now()
              if (activePlan && !activePlan.endedAt) activePlan.endedAt = finishedAt
              flushAgentMsg(accumulated, buildTaskTiming(taskStartedAt, finishedAt))
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
            recallDebug: isRecallDebugEnabled(),
            sessionId: threadId,
            sourceUserMessageId,
            sourceAssistantMessageId: streamAssistantMessageId,
          })
        })
      } else {
        await new Promise<void>((resolve, reject) => {
          abortRejectRefs.current.set(threadId, reject)

          const cleanup = window.taco.chat.onChunk((data) => {
            if (data.requestId !== requestId) return
            if (data.error) { cleanup(); reject(new Error(data.error)); return }
            if (data.done) {
              trackRequestUsage(data.usage)
              cleanup()
              resolve()
              return
            }
            accumulated += data.chunk
            setStreamingContents((prev) => ({ ...prev, [threadId]: accumulated }))
          })
          streamCleanupRefs.current.set(threadId, cleanup)
          window.taco.chat.stream({
            requestId,
            provider,
            messages: apiMessages,
            overrides,
            projectId,
            workspace,
            maxTokens,
            sessionId: threadId,
            sourceUserMessageId,
            sourceAssistantMessageId: streamAssistantMessageId,
          })
        })
      }

      abortRejectRefs.current.delete(threadId)
      requestIdRefs.current.delete(threadId)
      if (!isAgent && accumulated) {
        const assistantMsg: ChatMsg = {
          id: streamAssistantMessageId,
          role: 'assistant',
          content: accumulated,
          taskTiming: buildTaskTiming(taskStartedAt),
        }
        setMessages(threadId, (prev) => [...prev, assistantMsg])
      }
      onComplete?.()
    } catch (error) {
      abortRejectRefs.current.delete(threadId)
      requestIdRefs.current.delete(threadId)
      const errMsg = error instanceof Error ? error.message : '请求失败'
      if (errMsg === '__stopped__') {
        if (isAgent) {
          const timing = buildTaskTiming(taskStartedAt)
          setMessages(threadId, (prev) => {
            for (let i = prev.length - 1; i >= 0; i--) {
              if (prev[i]?.role !== 'assistant') continue
              const updated = [...prev]
              const tail = updated[i]
              const stoppedContent = (tail.content || accumulated).includes('*[已停止]*')
                ? (tail.content || accumulated)
                : `${tail.content || accumulated}\n\n*[已停止]*`
              updated[i] = { ...tail, content: stoppedContent, taskTiming: timing }
              return updated
            }
            if (!accumulated) return prev
            return [...prev, { id: streamAssistantMessageId, role: 'assistant', content: accumulated + '\n\n*[已停止]*', taskTiming: timing }]
          })
        } else if (accumulated) {
          const stoppedMsg: ChatMsg = {
            id: streamAssistantMessageId,
            role: 'assistant',
            content: accumulated + '\n\n*[已停止]*',
            taskTiming: buildTaskTiming(taskStartedAt),
          }
          setMessages(threadId, (prev) => [...prev, stoppedMsg])
        }
      } else {
        const errChatMsg: ChatMsg = {
          id: streamAssistantMessageId,
          role: 'assistant',
          content: `[Error] ${errMsg}`,
          taskTiming: buildTaskTiming(taskStartedAt),
        }
        setMessages(threadId, (prev) => [...prev, errChatMsg])
      }
    } finally {
      inFlightThreadsRef.current.delete(threadId)
      setSendingThreads((prev) => ({ ...prev, [threadId]: false }))
      setStreamingContents((prev) => { const next = { ...prev }; delete next[threadId]; return next })
      setActiveTaskStartedAtByThread((prev) => {
        const next = { ...prev }
        delete next[threadId]
        return next
      })
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
    sendingThreads,
    streamingContents,
    queues,
    isSending,
    isCompleted,
    getStreamingContent,
    getQueue,
    getMessages,
    getUsageTotalTokens,
    getActiveTaskStartedAt,
    getProjectTokenStats,
    setMessages,
    clearMessages,
    deleteThreadMessages,
    clearProjectTokenStats,
    sendMessage,
    resendFromExisting,
    stopSending,
    addToQueue,
    removeFromQueue,
  }
}
