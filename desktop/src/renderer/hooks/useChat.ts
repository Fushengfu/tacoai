import { useCallback, useEffect, useRef, useState } from 'react'
import type { ActivePlan, AgentStep, AttachedAsset, AttachedImage, ChatMsg, ModelConfig, ProviderId, QueuedMessage, TaskTiming, ToolCallInfo, ToolResultInfo } from '../types'
import type { ChatStoreSessionPage, ChatStoreSessionPatch, ChatStoreSessionSummary, IpcChatMessage, IpcChatOverrides } from '../../shared/ipc'
import { buildSystemPrompt } from '../constants'
import { loadJson, saveJson, uid } from '../lib/storage'
import { loadUploadSettings, toIpcUploadConfig } from '../lib/upload-config'
import { buildUserAssetsBlockFromAttachments, inferAttachmentType, stripUserAssetsBlock, isMediaFile, inferMediaSubtype } from '../../shared/user-assets'
import { validateModelConfig, parseConfiguredTemperature } from '../../shared/validation'

type SessionStoreMeta = {
  projectId?: string
  workspace?: string
}

const CHAT_STORE_FLUSH_DEBOUNCE_MS = 280
const CHAT_STORE_INITIAL_PAGE_SIZE = 120
const CHAT_STORE_OLDER_PAGE_SIZE = 120

// 重试配置
const MAX_RETRY_ATTEMPTS = 2
const RETRY_DELAY_MS = 1000
const RETRYABLE_ERRORS = [
  'network',
  'timeout',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'fetch failed',
  'request failed',
]

type SessionLoadMeta = {
  totalCount: number
  loadedStartSeq: number
  loadedEndSeq: number
  isLoaded: boolean
  isLoading: boolean
  isLoadingOlder: boolean
}

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

/**
 * API 消息类型 - 统一使用标准 content 数组格式
 * 
 * 前端始终使用统一格式，后端根据 provider 转换
 * 
 * content 数组支持的类型：
 * - text: 文本内容
 * - image_url: 图片 URL
 * - video_url: 视频 URL
 * - audio_url: 音频 URL
 * 
 * 非媒体文件（代码、文档等）使用标签包裹插入文本：[FILE]path[/FILE]
 */
type ApiChatMessage = {
  role: ChatMsg['role']
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
    | { type: 'video_url'; video_url: { url: string } }
    | { type: 'audio_url'; audio_url: { url: string } }
  >
}

/**
 * 将 ChatMsg 转换为统一的标准 API 消息格式
 */
function mapMessageForApi(msg: ChatMsg, isLastUserMessage = false): ApiChatMessage {
  // system 和 assistant 消息也使用数组格式
  if (msg.role !== 'user') {
    return {
      role: msg.role,
      content: [{ type: 'text', text: `[HISTORICAL_TASK_RESULT]\n${msg.content}\n[/HISTORICAL_TASK_RESULT]` }]
    }
  }

  // 构建用户消息的 content 数组
  const parts: ApiChatMessage['content'] = []

  // 1. 构建文本内容
  const raw = stripUserAssetsBlock(String(msg.content ?? ''))
  const wrapped = raw.match(/\[USER_QUERY\]([\s\S]*?)\[\/USER_QUERY\]/i)
  let textContent: string
  if (wrapped && wrapped[1] !== undefined) {
    textContent = raw.trim()
  } else if (isLastUserMessage) {
    // 最后一条最新用户消息：不包裹 USER_QUERY 标签
    textContent = raw.trim()
  } else {
    // 历史用户消息：使用 USER_QUERY 标签包裹
    textContent = `[USER_QUERY]\n${raw.trim()}\n[/USER_QUERY]`
  }

  // 2. 处理附件：媒体文件加入数组，非媒体文件用标签包裹插入文本
  const mediaFiles: Array<{ type: string; url: string }> = []
  const nonMediaFiles: string[] = []

  if (msg.attachments && msg.attachments.length > 0) {
    for (const asset of msg.attachments) {
      const subtype = inferMediaSubtype(asset.path)
      if (subtype) {
        // 媒体文件：加入数组
        mediaFiles.push({ type: subtype, url: asset.path })
      } else {
        // 非媒体文件：用标签包裹
        nonMediaFiles.push(asset.path)
      }
    }
  }

  // 将非媒体文件路径添加到文本中
  if (nonMediaFiles.length > 0) {
    textContent += '\n\n' + nonMediaFiles.map(p => `[FILE]${p}[/FILE]`).join('\n')
  }

  // 添加文本部分
  parts.push({ type: 'text', text: textContent })

  // 3. 添加图片部分（使用 cloudUrl）
  const imageUrls = (msg.images ?? [])
    .map((img) => {
      const cloudUrl = String(img?.cloudUrl ?? '').trim()
      return cloudUrl
    })
    .filter(Boolean)

  for (const url of imageUrls) {
    parts.push({ type: 'image_url', image_url: { url } })
  }

  // 4. 添加其他媒体文件
  for (const media of mediaFiles) {
    if (media.type === 'image_url') {
      parts.push({ type: 'image_url', image_url: { url: media.url } })
    } else if (media.type === 'video_url') {
      parts.push({ type: 'video_url', video_url: { url: media.url } })
    } else if (media.type === 'audio_url') {
      parts.push({ type: 'audio_url', audio_url: { url: media.url } })
    }
  }

  return { role: msg.role, content: parts }
}

/**
 * 构建 API 消息数组
 */
function buildMessagesForApi(messages: ChatMsg[]): ApiChatMessage[] {
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
    const reversed = recent.reverse()
    // 找到最后一条用户消息的索引
    let lastUserIndex = -1
    for (let i = reversed.length - 1; i >= 0; i--) {
      if (reversed[i].role === 'user') {
        lastUserIndex = i
        break
      }
    }
    return reversed.map((msg, idx) => mapMessageForApi(msg, idx === lastUserIndex))
  }
  const last = messages[messages.length - 1]
  return last ? [mapMessageForApi(last, last.role === 'user')] : []
}

function isRecallDebugEnabled(): boolean {
  return localStorage.getItem('taco.recallDebugEnabled') === 'true'
}

/**
 * 判断错误是否可重试
 */
function isRetryableError(error: Error): boolean {
  const message = error.message.toLowerCase()
  return RETRYABLE_ERRORS.some((keyword) => message.includes(keyword))
}

/**
 * 延迟函数
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function resolveUploadOverrideForProvider(provider: ProviderId) {
  return toIpcUploadConfig(loadUploadSettings())
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

/** 本轮次任务循环累计 token 统计 */
export type RunTokenStats = {
  inputTokens: number
  hitTokens: number
  outputTokens: number
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

/** API 消息 content 数组元素类型 */
type MessageContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } } | { type: 'video_url'; video_url: { url: string } } | { type: 'audio_url'; audio_url: { url: string } }

export type SendMessageParams = {
  threadId: string
  /** 项目标识（用于项目级日志与笔记隔离） */
  projectId?: string
  /** 当前项目的自定义规则（自动注入 system prompt） */
  projectRules?: string
  /** 统一的 content 数组格式 */
  content: string | MessageContentPart[]
  /** 用户附带的图片（兼容旧格式，优先使用 content 数组） */
  images?: AttachedImage[]
  /** 用户附带的文件附件（绝对路径，兼容旧格式，优先使用 content 数组） */
  attachments?: AttachedAsset[]
  provider: ProviderId
  modelConfig: ModelConfig
  /** Agent 模式的工作空间目录 */
  workspace?: string
  /** 上下文窗口大小（token 数），用于自动压缩 */
  contextLength?: number
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
  const [sessionLoadMetaById, setSessionLoadMetaById] = useState<Record<string, SessionLoadMeta>>({})

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
  /** 每个 thread 本轮次任务循环累计 token 统计 */
  const [runTokenStatsByThread, setRunTokenStatsByThread] = useState<Record<string, RunTokenStats>>({})
  /** 每个 thread 当前任务开始时间（用于实时耗时显示） */
  const [activeTaskStartedAtByThread, setActiveTaskStartedAtByThread] = useState<Record<string, number | undefined>>({})
  /** 刚完成的 thread（短暂显示 ✓ 后自动清除） */
  const [completedThreads, setCompletedThreads] = useState<Record<string, boolean>>({})

  // Ref：始终指向最新 threadMessages，供异步回调读取
  const threadMessagesRef = useRef(threadMessages)
  threadMessagesRef.current = threadMessages
  const sessionLoadMetaRef = useRef(sessionLoadMetaById)
  sessionLoadMetaRef.current = sessionLoadMetaById
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

  const commitThreadMessages = useCallback((next: Record<string, ChatMsg[]>) => {
    threadMessagesRef.current = next
    setThreadMessages(next)
  }, [])

  const setSessionLoadMetaEntry = useCallback((
    sessionId: string,
    updater: SessionLoadMeta | ((prev?: SessionLoadMeta) => SessionLoadMeta | undefined) | undefined,
  ) => {
    const key = String(sessionId || '').trim()
    if (!key) return
    const prevAll = sessionLoadMetaRef.current
    const prevEntry = prevAll[key]
    const nextEntry = typeof updater === 'function'
      ? updater(prevEntry)
      : updater
    if (!nextEntry) {
      if (!(key in prevAll)) return
      const nextAll = { ...prevAll }
      delete nextAll[key]
      sessionLoadMetaRef.current = nextAll
      setSessionLoadMetaById(nextAll)
      return
    }
    const nextAll = { ...prevAll, [key]: nextEntry }
    sessionLoadMetaRef.current = nextAll
    setSessionLoadMetaById(nextAll)
  }, [])

  const rememberSessionStoreMeta = useCallback((sessionId: string, meta?: SessionStoreMeta) => {
    const key = String(sessionId || '').trim()
    if (!key) return
    const previous = sessionStoreMetaRef.current.get(key) ?? {}
    sessionStoreMetaRef.current.set(key, {
      projectId: String(meta?.projectId || previous.projectId || '').trim() || undefined,
      workspace: String(meta?.workspace || previous.workspace || '').trim() || undefined,
    })
  }, [])

  const rememberSessionSummary = useCallback((summary: ChatStoreSessionSummary) => {
    const key = String(summary.sessionId || '').trim()
    if (!key) return
    rememberSessionStoreMeta(key, {
      projectId: summary.projectId,
      workspace: summary.workspace,
    })
    setSessionLoadMetaEntry(key, (prev) => {
      const totalCount = Math.max(0, Math.floor(Number(summary.messageCount) || 0))
      if (!prev) {
        return {
          totalCount,
          loadedStartSeq: totalCount,
          loadedEndSeq: totalCount > 0 ? totalCount - 1 : -1,
          isLoaded: false,
          isLoading: false,
          isLoadingOlder: false,
        }
      }
      const loadedCount = prev.isLoaded && prev.loadedEndSeq >= prev.loadedStartSeq
        ? (prev.loadedEndSeq - prev.loadedStartSeq + 1)
        : 0
      const maxStartSeq = Math.max(0, totalCount - loadedCount)
      const nextStartSeq = prev.isLoaded
        ? Math.min(prev.loadedStartSeq, maxStartSeq)
        : totalCount
      const nextEndSeq = prev.isLoaded
        ? (loadedCount > 0 ? nextStartSeq + loadedCount - 1 : -1)
        : (totalCount > 0 ? totalCount - 1 : -1)
      return {
        ...prev,
        totalCount,
        loadedStartSeq: nextStartSeq,
        loadedEndSeq: nextEndSeq,
      }
    })
  }, [rememberSessionStoreMeta, setSessionLoadMetaEntry])

  const applyLoadedSessionPage = useCallback((
    sessionId: string,
    page: ChatStoreSessionPage | null,
    mode: 'replace' | 'prepend',
  ) => {
    const key = String(sessionId || '').trim()
    if (!key) return
    const messages = normalizeChatStoreMessages(page?.messages ?? [])
    const totalCount = Math.max(0, Math.floor(Number(page?.totalCount) || 0))
    const startSeq = typeof page?.startSeq === 'number'
      ? Math.max(0, Math.floor(page.startSeq))
      : totalCount
    const endSeq = typeof page?.endSeq === 'number'
      ? Math.max(startSeq - 1, Math.floor(page.endSeq))
      : (messages.length > 0 ? startSeq + messages.length - 1 : startSeq - 1)

    if (page) {
      rememberSessionStoreMeta(key, {
        projectId: page.projectId,
        workspace: page.workspace,
      })
    }

    const currentAll = threadMessagesRef.current
    const current = currentAll[key] ?? []
    const nextMessages = mode === 'prepend' ? [...messages, ...current] : messages
    const nextAll = nextMessages.length > 0
      ? { ...currentAll, [key]: nextMessages }
      : (() => {
          const clone = { ...currentAll }
          delete clone[key]
          return clone
        })()
    commitThreadMessages(nextAll)

    setSessionLoadMetaEntry(key, (prev) => ({
      ...(prev ?? {}),
      totalCount,
      loadedStartSeq: nextMessages.length > 0 ? startSeq : totalCount,
      loadedEndSeq: nextMessages.length > 0 ? endSeq : (totalCount > 0 ? totalCount - 1 : -1),
      isLoaded: true,
      isLoading: false,
      isLoadingOlder: false,
    }))
  }, [commitThreadMessages, rememberSessionStoreMeta, setSessionLoadMetaEntry])

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
    const loadedStartSeq = sessionLoadMetaRef.current[key]?.isLoaded
      ? Math.max(0, Math.floor(sessionLoadMetaRef.current[key]?.loadedStartSeq ?? 0))
      : 0
    const fromSeq = loadedStartSeq + findFirstChangedMessageIndex(prevMessages, nextMessages)
    const pending = pendingPersistRef.current.get(key)
    const mergedFromSeq = pending ? Math.min(pending.fromSeq, fromSeq) : fromSeq
    const meta = sessionStoreMetaRef.current.get(key) ?? {}
    const sliceStart = Math.max(0, mergedFromSeq - loadedStartSeq)
    pendingPersistRef.current.set(key, {
      projectId: String(meta.projectId || '').trim(),
      sessionId: key,
      workspace: String(meta.workspace || '').trim() || undefined,
      updatedAt: Date.now(),
      fromSeq: mergedFromSeq,
      messages: nextMessages.slice(sliceStart) as unknown[],
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
        for (const entry of entries) {
          rememberSessionSummary(entry)
        }

        const legacy = loadJson<Record<string, ChatMsg[]>>('taco.messages', {})
        const legacyEntries = Object.entries(legacy ?? {}).filter(([sessionId, messages]) =>
          sessionId.trim() && Array.isArray(messages) && messages.length > 0,
        )

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
              if (!cancelled) {
                rememberSessionSummary({
                  projectId: '',
                  sessionId,
                  updatedAt: Date.now(),
                  messageCount: messages.length,
                })
              }
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
  }, [flushAllPersistedSessions, rememberSessionSummary])

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

  const ensureSessionLoaded = useCallback(async (sessionId: string, limit = CHAT_STORE_INITIAL_PAGE_SIZE) => {
    const key = String(sessionId || '').trim()
    if (!key) return
    const currentMeta = sessionLoadMetaRef.current[key]
    if (currentMeta?.isLoaded || currentMeta?.isLoading) return

    setSessionLoadMetaEntry(key, (prev) => ({
      totalCount: prev?.totalCount ?? 0,
      loadedStartSeq: prev?.loadedStartSeq ?? (prev?.totalCount ?? 0),
      loadedEndSeq: prev?.loadedEndSeq ?? ((prev?.totalCount ?? 0) > 0 ? (prev?.totalCount ?? 1) - 1 : -1),
      isLoaded: prev?.isLoaded ?? false,
      isLoading: true,
      isLoadingOlder: prev?.isLoadingOlder ?? false,
    }))

    try {
      const page = await window.taco.chatStore.loadPage(key, { limit })
      applyLoadedSessionPage(key, page, 'replace')
    } catch (err) {
      console.error('[chat-store] 加载会话消息失败:', key, err)
      setSessionLoadMetaEntry(key, (prev) => prev ? { ...prev, isLoading: false } : {
        totalCount: 0,
        loadedStartSeq: 0,
        loadedEndSeq: -1,
        isLoaded: false,
        isLoading: false,
        isLoadingOlder: false,
      })
    }
  }, [applyLoadedSessionPage, setSessionLoadMetaEntry])

  const loadOlderMessages = useCallback(async (sessionId: string, limit = CHAT_STORE_OLDER_PAGE_SIZE) => {
    const key = String(sessionId || '').trim()
    if (!key) return
    const meta = sessionLoadMetaRef.current[key]
    if (!meta?.isLoaded) {
      await ensureSessionLoaded(key, limit)
      return
    }
    if (meta.isLoadingOlder || meta.loadedStartSeq <= 0) return

    setSessionLoadMetaEntry(key, { ...meta, isLoadingOlder: true })
    try {
      const page = await window.taco.chatStore.loadPage(key, {
        beforeSeq: meta.loadedStartSeq,
        limit,
      })
      if (!page || !Array.isArray(page.messages) || page.messages.length <= 0) {
        setSessionLoadMetaEntry(key, (prev) => prev ? {
          ...prev,
          totalCount: page?.totalCount ?? prev.totalCount,
          loadedStartSeq: 0,
          isLoadingOlder: false,
          isLoading: false,
        } : undefined)
        return
      }
      applyLoadedSessionPage(key, page, 'prepend')
    } catch (err) {
      console.error('[chat-store] 加载更早消息失败:', key, err)
      setSessionLoadMetaEntry(key, (prev) => prev ? { ...prev, isLoadingOlder: false } : undefined)
    }
  }, [applyLoadedSessionPage, ensureSessionLoaded, setSessionLoadMetaEntry])

  const ensureSessionFullyLoaded = useCallback(async (sessionId: string) => {
    const key = String(sessionId || '').trim()
    if (!key) return
    await ensureSessionLoaded(key)
    while (true) {
      const meta = sessionLoadMetaRef.current[key]
      if (!meta || !meta.isLoaded || meta.loadedStartSeq <= 0) break
      await loadOlderMessages(key, CHAT_STORE_OLDER_PAGE_SIZE)
    }
  }, [ensureSessionLoaded, loadOlderMessages])

  /* ------------------------------------------------------------------ */
  /*  Per-thread accessors                                               */
  /* ------------------------------------------------------------------ */

  function isSending(threadId: string): boolean {
    return (sendingThreads[threadId] ?? false) || inFlightThreadsRef.current.has(threadId)
  }

  function isCompleted(threadId: string): boolean {
    return completedThreads[threadId] ?? false
  }

  function stopSending(threadId: string) {
    const requestId = requestIdRefs.current.get(threadId)
    if (requestId) {
      window.taco.agent.abort(requestId)
    }
  }

  function getStreamingContent(threadId: string): string {
    return streamingContents[threadId] ?? ''
  }

  function getQueue(threadId: string): QueuedMessage[] {
    return queues[threadId] ?? []
  }

  function getMessages(threadId: string): ChatMsg[] {
    return threadMessagesRef.current[threadId] ?? []
  }

  function getSessionMessageCount(threadId: string): number {
    const meta = sessionLoadMetaRef.current[threadId]
    if (meta) return meta.totalCount
    return (threadMessagesRef.current[threadId] ?? []).length
  }

  function hasOlderMessages(threadId: string): boolean {
    const meta = sessionLoadMetaRef.current[threadId]
    if (!meta) return false
    if (!meta.isLoaded) return meta.totalCount > 0
    return meta.loadedStartSeq > 0
  }

  function isLoadingOlderMessages(threadId: string): boolean {
    return Boolean(sessionLoadMetaRef.current[threadId]?.isLoadingOlder)
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

  function getRunTokenStats(threadId: string): RunTokenStats {
    return runTokenStatsByThread[threadId] ?? { inputTokens: 0, hitTokens: 0, outputTokens: 0 }
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
      const currentAll = threadMessagesRef.current
      const current = currentAll[threadId] ?? []
      const next = typeof updater === 'function' ? updater(current) : updater
      const updated = next.length > 0
        ? { ...currentAll, [threadId]: next }
        : (() => {
            const clone = { ...currentAll }
            delete clone[threadId]
            return clone
          })()
      commitThreadMessages(updated)

      const prevMeta = sessionLoadMetaRef.current[threadId]
      if (next.length > 0) {
        const loadedStartSeq = prevMeta?.isLoaded ? prevMeta.loadedStartSeq : 0
        setSessionLoadMetaEntry(threadId, {
          totalCount: loadedStartSeq + next.length,
          loadedStartSeq,
          loadedEndSeq: loadedStartSeq + next.length - 1,
          isLoaded: true,
          isLoading: false,
          isLoadingOlder: false,
        })
        schedulePersistedSession(threadId, current, next)
      } else {
        setSessionLoadMetaEntry(threadId, {
          totalCount: 0,
          loadedStartSeq: 0,
          loadedEndSeq: -1,
          isLoaded: true,
          isLoading: false,
          isLoadingOlder: false,
        })
        void deletePersistedSession(threadId)
      }
    },
    [commitThreadMessages, deletePersistedSession, schedulePersistedSession, setSessionLoadMetaEntry]
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
    const nextMessages = { ...threadMessagesRef.current }
    delete nextMessages[threadId]
    commitThreadMessages(nextMessages)
    setSessionLoadMetaEntry(threadId, undefined)
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

  function addToQueue(threadId: string, content: string | MessageContentPart[]) {
    // 提取文本内容用于队列显示
    const textContent = Array.isArray(content) 
      ? (content.find(p => p.type === 'text') as { type: 'text'; text: string } | undefined)?.text || ''
      : String(content ?? '')
    
    const normalized = textContent.trim()
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
          // 再次检查是否已有在途请求，避免重复发送
          if (!inFlightThreadsRef.current.has(threadId)) {
            sendMessageRef.current?.({ ...savedParams, content: next.content })
          }
        }, 0)
      }
      return { ...prev, [threadId]: rest }
    })
  }

  /** 清空指定 thread 的队列 */
  function clearQueue(threadId: string) {
    setQueues((prev) => {
      const next = { ...prev }
      delete next[threadId]
      return next
    })
  }

  /* ------------------------------------------------------------------ */
  /*  Agent Stream 执行器（sendMessage / resendFromExisting 共用）        */
  /* ------------------------------------------------------------------ */

  /**
   * 公共的 Agent 流式执行逻辑。
   * 封装了：事件监听、消息渲染、Token 统计、重试、错误处理、状态清理。
   */
  async function executeAgentStream(params: {
    threadId: string
    requestId: string
    provider: ProviderId
    apiMessages: IpcChatMessage[]
    overrides: IpcChatOverrides
    projectId?: string
    workspace?: string
    contextLength?: number
    sourceUserMessageId: string
    streamAssistantMessageId: string
    taskStartedAt: number
    lastUserImages?: string[]
    enableRetry?: boolean
    onComplete?: () => void
  }) {
    const {
      threadId, requestId, provider, apiMessages, overrides,
      projectId, workspace, contextLength,
      sourceUserMessageId, streamAssistantMessageId, taskStartedAt,
      lastUserImages, enableRetry, onComplete,
    } = params

    let accumulated = ''
    let usageTurnCounted = false
    const projectKey = String(projectId ?? threadId ?? '').trim()

    // 重置本轮次任务循环 token 统计
    setRunTokenStatsByThread((prev) => {
      if (!prev[threadId]) return prev
      const next = { ...prev }
      delete next[threadId]
      return next
    })

    /** 累加单轮 API 调用的 token 成本到项目统计 */
    const applyProjectUsage = (usage: TokenUsageSnapshot | null) => {
      if (!usage || !projectKey) return
      const currentAgg = usageToAggregate(usage)
      const hasCost = currentAgg.totalTokens > 0 || currentAgg.inputTokens > 0 || currentAgg.outputTokens > 0
      if (!hasCost) return
      const shouldCountTurn = !usageTurnCounted
      setProjectTokenStatsByThread((prev) => {
        const base = prev[projectKey] ?? {
          inputTokens: 0, outputTokens: 0, hitTokens: 0, missTokens: 0,
          totalTokens: 0, turns: 0, updatedAt: Date.now(),
        }
        return {
          ...prev,
          [projectKey]: {
            inputTokens: base.inputTokens + currentAgg.inputTokens,
            outputTokens: base.outputTokens + currentAgg.outputTokens,
            hitTokens: base.hitTokens + currentAgg.hitTokens,
            missTokens: base.missTokens + currentAgg.missTokens,
            totalTokens: base.totalTokens + currentAgg.totalTokens,
            turns: base.turns + (shouldCountTurn ? 1 : 0),
            updatedAt: Date.now(),
          }
        }
      })
      if (shouldCountTurn) usageTurnCounted = true
    }

    /** 追踪每次 API 调用的 token 使用 */
    const trackRequestUsage = (usage?: TokenUsageSnapshot) => {
      if (!usage) return
      const currentTotal = resolveUsageTotalTokens(usage)
      if (typeof currentTotal === 'number' && Number.isFinite(currentTotal)) {
        setUsageTotalTokensByThread((prev) => ({ ...prev, [threadId]: currentTotal }))
      }
      applyProjectUsage(usage)
      // 累加到本轮次任务循环统计
      const currentAgg = usageToAggregate(usage)
      if (currentAgg.inputTokens > 0 || currentAgg.outputTokens > 0) {
        setRunTokenStatsByThread((prev) => {
          const base = prev[threadId] ?? { inputTokens: 0, hitTokens: 0, outputTokens: 0 }
          return {
            ...prev,
            [threadId]: {
              inputTokens: base.inputTokens + currentAgg.inputTokens,
              hitTokens: base.hitTokens + currentAgg.hitTokens,
              outputTokens: base.outputTokens + currentAgg.outputTokens,
            },
          }
        })
      }
    }

    try {
      requestIdRefs.current.set(threadId, requestId)

      await new Promise<void>((resolve, reject) => {
        abortRejectRefs.current.set(threadId, reject)

        const agentMsgId = streamAssistantMessageId
        const steps: AgentStep[] = []
        let currentRound = 0
        let commitHash: string | undefined
        let activePlan: ActivePlan | undefined
        let reasoningAccumulated = ''

        /** 更新 agent 消息（追加或更新） */
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
        const cleanup = window.taco.agent.onEvent((event) => {
          if (event.requestId !== requestId) return

          if (event.type === 'text') {
            accumulated += event.content
            flushAgentMsg(undefined, runningTaskTiming)
          } else if (event.type === 'reasoning') {
            reasoningAccumulated += event.content
          } else if (event.type === 'usage') {
            trackRequestUsage(event.usage)
          } else if (event.type === 'tool_calls') {
            currentRound++
            const toolThinking = String(event.thinking ?? '').trim()
            const toolCalls: ToolCallInfo[] = event.toolCalls.map((tc) => ({
              id: tc.id, name: tc.function.name, arguments: tc.function.arguments,
            }))
            steps.push({
              round: currentRound,
              thinking: toolThinking || reasoningAccumulated.trim() || accumulated,
              toolCalls, toolResults: [], status: 'running',
            })
            accumulated = ''
            reasoningAccumulated = ''
            flushAgentMsg(undefined, runningTaskTiming)
          } else if (event.type === 'system_notice') {
            currentRound++
            steps.push({
              round: currentRound, systemTitle: event.title,
              systemDetail: event.message || '',
              thinking: event.message || event.title,
              toolCalls: [], toolResults: [], status: 'done',
            })
            flushAgentMsg(undefined, runningTaskTiming)
          } else if (event.type === 'confirm') {
            const lastStep = steps[steps.length - 1]
            if (lastStep) {
              lastStep.status = 'confirm'
              lastStep.confirmId = event.confirmId
              lastStep.risks = event.risks.map((r) => ({
                toolCallId: r.toolCallId, toolName: r.toolName,
                level: r.level, reason: r.reason, detail: r.detail,
              }))
            }
            flushAgentMsg(undefined, runningTaskTiming)
          } else if (event.type === 'retry_confirm') {
            // 可恢复错误：创建新的步骤用于显示重试确认 UI
            steps.push({
              round: event.round,
              thinking: '',
              toolCalls: [],
              toolResults: [],
              status: 'retry_confirm',
              retryId: event.retryId,
              retryErrorType: event.errorType,
              retryErrorMessage: event.errorMessage,
            })
            flushAgentMsg(undefined, runningTaskTiming)
          } else if (event.type === 'tool_results') {
            const results: ToolResultInfo[] = event.results.map((r) => ({
              tool_call_id: r.tool_call_id, name: r.name, content: r.content,
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
          } else if (event.type === 'git_commit') {
            commitHash = event.hash
            flushAgentMsg(undefined, runningTaskTiming)
          } else if (event.type === 'plan_init') {
            activePlan = {
              summary: event.summary, reasoning: event.reasoning,
              steps: event.steps.map((s) => ({ index: s.index, title: s.title, content: s.content, status: 'pending' as const })),
              startedAt: Date.now(),
            }
            flushAgentMsg(undefined, runningTaskTiming)
          } else if (event.type === 'plan_progress') {
            if (activePlan) {
              const targetStep = activePlan.steps.find((s) => s.index === event.stepIndex)
              if (targetStep) {
                targetStep.status = normalizePlanStatus(event.status)
                if (event.note) targetStep.note = event.note
              }
            }
            flushAgentMsg(undefined, runningTaskTiming)
          } else if (event.type === 'done') {
            const finishedAt = Date.now()
            if (typeof event.finalText === 'string') accumulated = event.finalText
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

        // 执行流式请求（可选重试）
        const executeStream = async (attempt: number): Promise<void> => {
          try {
            window.taco.agent.stream({
              requestId, provider, messages: apiMessages, overrides,
              projectId, workspace: workspace ?? '', contextLength,
              recallDebug: isRecallDebugEnabled(),
              sessionId: threadId, sourceUserMessageId,
              sourceAssistantMessageId: streamAssistantMessageId,
              ...(lastUserImages && lastUserImages.length > 0 ? { images: lastUserImages } : {}),
            })
          } catch (error) {
            if (enableRetry && isRetryableError(error as Error) && attempt < MAX_RETRY_ATTEMPTS) {
              await delay(RETRY_DELAY_MS * (attempt + 1))
              return executeStream(attempt + 1)
            }
            throw error
          }
        }
        executeStream(0).catch(reject)
      })

      abortRejectRefs.current.delete(threadId)
      requestIdRefs.current.delete(threadId)
      onComplete?.()
    } catch (error) {
      abortRejectRefs.current.delete(threadId)
      requestIdRefs.current.delete(threadId)
      const errMsg = error instanceof Error ? error.message : '请求失败'
      if (errMsg === '__stopped__') {
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
      } else {
        const errChatMsg: ChatMsg = {
          id: streamAssistantMessageId, role: 'assistant',
          content: `[Error] ${errMsg}`, taskTiming: buildTaskTiming(taskStartedAt),
        }
        setMessages(threadId, (prev) => [...prev, errChatMsg])
      }
    } finally {
      inFlightThreadsRef.current.delete(threadId)
      setSendingThreads((prev) => ({ ...prev, [threadId]: false }))
      setStreamingContents((prev) => { const next = { ...prev }; delete next[threadId]; return next })
      setActiveTaskStartedAtByThread((prev) => { const next = { ...prev }; delete next[threadId]; return next })
      streamCleanupRefs.current.delete(threadId)
      setCompletedThreads((prev) => ({ ...prev, [threadId]: true }))
      setTimeout(() => {
        setCompletedThreads((prev) => { const next = { ...prev }; delete next[threadId]; return next })
      }, 3000)
      processQueue(threadId)
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Send message (per-thread, non-blocking)                            */
  /* ------------------------------------------------------------------ */

  async function sendMessage(params: SendMessageParams) {
    const { threadId, projectId, projectRules, content, images, attachments, provider, modelConfig, workspace, contextLength, onFirstMessage, onComplete } = params

    // 处理 content 参数：支持字符串或数组
    const contentText = Array.isArray(content)
      ? (content.find(p => p.type === 'text') as { type: 'text'; text: string } | undefined)?.text || ''
      : String(content ?? '')

    // 从 content 数组中提取图片和附件（如果是数组格式）
    let effectiveImages = images
    let effectiveAttachments = attachments

    if (Array.isArray(content)) {
      const extractedImages: AttachedImage[] = []
      const extractedAttachments: AttachedAsset[] = []

      for (const part of content) {
        if (part.type === 'image_url') {
          const url = part.image_url.url
          if (url.startsWith('http://') || url.startsWith('https://')) {
            extractedImages.push({
              id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              dataUrl: '', cloudUrl: url, name: 'image', uploadStatus: 'done',
            })
          } else {
            extractedAttachments.push({
              id: `asset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              name: url.split('/').pop() || 'image', path: url,
            })
          }
        } else if (part.type === 'video_url' || part.type === 'audio_url') {
          const url = part.type === 'video_url' ? part.video_url.url : part.audio_url.url
          extractedAttachments.push({
            id: `asset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: url.split('/').pop() || 'media', path: url,
          })
        }
      }

      effectiveImages = extractedImages.length > 0 ? extractedImages : images
      effectiveAttachments = extractedAttachments.length > 0 ? extractedAttachments : attachments
    }

    // 验证模型配置
    const validation = validateModelConfig({
      provider, baseUrl: modelConfig.baseUrl, apiKey: modelConfig.apiKey,
      model: modelConfig.model, contextLength: modelConfig.contextLength,
      temperature: modelConfig.temperature,
    })
    if (!validation.valid) {
      const errorMsg = `模型配置验证失败: ${validation.errors.join('; ')}`
      console.error('[sendMessage]', errorMsg)
      const errChatMsg: ChatMsg = {
        id: uid(), role: 'assistant', content: `[Error] ${errorMsg}`,
        taskTiming: buildTaskTiming(Date.now()),
      }
      setMessages(threadId, (prev) => [...prev, errChatMsg])
      return
    }

    rememberSessionStoreMeta(threadId, { projectId, workspace })
    sendParamsRefs.current.set(threadId, {
      threadId, projectId, projectRules, provider, modelConfig, workspace, onFirstMessage, onComplete,
    })

    // 同一会话绝对串行：若已有在途请求，本次直接入队
    if (inFlightThreadsRef.current.has(threadId)) {
      const queueText = contentText.trim()
        || (effectiveImages && effectiveImages.length > 0 ? '(图片消息)' : '')
        || (effectiveAttachments && effectiveAttachments.length > 0 ? '(附件消息)' : '')
      if (queueText) addToQueue(threadId, queueText)
      return
    }
    inFlightThreadsRef.current.add(threadId)
    const taskStartedAt = Date.now()

    // 创建用户消息
    const currentMsgs = threadMessagesRef.current[threadId] ?? []
    const userMsg: ChatMsg = {
      id: uid(), role: 'user', content: contentText,
      ...(effectiveImages && effectiveImages.length > 0 ? { images: effectiveImages } : {}),
      ...(effectiveAttachments && effectiveAttachments.length > 0 ? { attachments: effectiveAttachments } : {}),
    }
    const updatedMsgs = [...currentMsgs, userMsg]
    setMessages(threadId, updatedMsgs)
    setSendingThreads((prev) => ({ ...prev, [threadId]: true }))
    setStreamingContents((prev) => ({ ...prev, [threadId]: '' }))
    setUsageTotalTokensByThread((prev) => ({ ...prev, [threadId]: undefined }))
    setActiveTaskStartedAtByThread((prev) => ({ ...prev, [threadId]: taskStartedAt }))

    // 首条消息 → 自动命名
    if (currentMsgs.length === 0 && onFirstMessage) {
      const title = contentText.length > 30 ? contentText.slice(0, 30) + '...' : contentText
      onFirstMessage(title)
    }

    // 构造 API 消息
    const systemContent = buildSystemPrompt({
      workspace,
      supportsVision: Boolean(modelConfig.supportsVision),
      projectRules,
    })
    const apiMessages = [
      { role: 'system' as const, content: systemContent },
      ...buildMessagesForApi(updatedMsgs),
 ]
    const overrides = {
      [provider]: {
        baseUrl: modelConfig.baseUrl || undefined,
        apiKey: modelConfig.apiKey || undefined,
        model: modelConfig.model || undefined,
        temperature: parseConfiguredTemperature(modelConfig.temperature),
        upload: resolveUploadOverrideForProvider(provider),
        supportsVision: Boolean(modelConfig.supportsVision),
        supportsReasoning: Boolean(modelConfig.supportsReasoning),
      }
    }

    // 提取图片用于 API
    const lastUserImages = effectiveImages
      ?.map((img) => img.cloudUrl)
      .filter((url): url is string => Boolean(url))

    // 执行 Agent 流式请求（公共逻辑）
    await executeAgentStream({
      threadId,
      requestId: `req-${Date.now()}-${threadId}`,
      provider, apiMessages, overrides,
      projectId, workspace: params.workspace ?? '', contextLength,
      sourceUserMessageId: userMsg.id,
      streamAssistantMessageId: uid(),
      taskStartedAt,
      lastUserImages: lastUserImages && lastUserImages.length > 0 ? lastUserImages : undefined,
      enableRetry: true,
      onComplete,
    })
  }

  /**
   * 基于已有消息列表重新请求（不创建新用户消息）。
   * 用于「编辑后重发」或「原样重发」场景：先由外部修改好 messages，再调用此方法。
   */
  async function resendFromExisting(params: Omit<SendMessageParams, 'content'>) {
    const { threadId, projectId, projectRules, provider, modelConfig, workspace, contextLength, onFirstMessage, onComplete } = params
    rememberSessionStoreMeta(threadId, { projectId, workspace })

    const currentMsgs = threadMessagesRef.current[threadId] ?? []
    if (currentMsgs.length === 0) return
    const sourceUserMessageId = [...currentMsgs].reverse().find((msg) => msg.role === 'user')?.id || ''

    if (inFlightThreadsRef.current.has(threadId)) return
    inFlightThreadsRef.current.add(threadId)
    const taskStartedAt = Date.now()

    sendParamsRefs.current.set(threadId, { threadId, projectId, projectRules, provider, modelConfig, workspace, onFirstMessage, onComplete })
    setSendingThreads((prev) => ({ ...prev, [threadId]: true }))
    setStreamingContents((prev) => ({ ...prev, [threadId]: '' }))
    setUsageTotalTokensByThread((prev) => ({ ...prev, [threadId]: undefined }))
    setActiveTaskStartedAtByThread((prev) => ({ ...prev, [threadId]: taskStartedAt }))

    // 构造 API 消息
    const apiMessages = [
      {
        role: 'system' as const,
        content: buildSystemPrompt({
          workspace,
          supportsVision: Boolean(modelConfig.supportsVision),
          projectRules,
        }),
      },
      ...buildMessagesForApi(currentMsgs),
 ]
    const overrides = {
      [provider]: {
        baseUrl: modelConfig.baseUrl || undefined,
        apiKey: modelConfig.apiKey || undefined,
        model: modelConfig.model || undefined,
        temperature: parseConfiguredTemperature(modelConfig.temperature),
        upload: resolveUploadOverrideForProvider(provider),
        supportsVision: Boolean(modelConfig.supportsVision),
        supportsReasoning: Boolean(modelConfig.supportsReasoning),
      }
    }

    // 执行 Agent 流式请求（公共逻辑）
    await executeAgentStream({
      threadId,
      requestId: `req-${Date.now()}-${threadId}`,
      provider, apiMessages, overrides,
      projectId, workspace: workspace ?? '', contextLength,
      sourceUserMessageId,
      streamAssistantMessageId: uid(),
      taskStartedAt,
      enableRetry: false,
      onComplete,
    })
  }

  // 保持 ref 指向最新函数
  sendMessageRef.current = sendMessage

  return {
    threadMessages,
    sessionLoadMetaById,
    sendingThreads,
    streamingContents,
    queues,
    isSending,
    isCompleted,
    getStreamingContent,
    getQueue,
    getMessages,
    getSessionMessageCount,
    hasOlderMessages,
    isLoadingOlderMessages,
    getUsageTotalTokens,
    getActiveTaskStartedAt,
    getProjectTokenStats,
    getRunTokenStats,
    setMessages,
    clearMessages,
    deleteThreadMessages,
    clearProjectTokenStats,
    ensureSessionLoaded,
    ensureSessionFullyLoaded,
    loadOlderMessages,
    sendMessage,
    resendFromExisting,
    stopSending,
    addToQueue,
    removeFromQueue,
  }
}
