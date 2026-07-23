/**
 * Chat & Agent IPC Handlers
 *
 * 包含聊天流式/非流式请求、Agent 流式处理、聊天存储、请求终止等。
 */

import { ipcMain, BrowserWindow } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { IpcChannel } from '../../../shared/ipc'
import type {
  AppStateProvidersPayload,
  AppStateSnapshot,
  AppStateThreadsPayload,
  AppNotifyPayload,
  RendererErrorPayload,
  AgentStreamPayload,
  AgentConfirmPayload,
  ChatStoreSessionPatch,
  ChatStoreSessionPage,
  ChatStoreSessionSummary,
  AgentEventData,
  AgentEventChunkData,
} from '../../../shared/ipc'
import type { ProviderKey, ProviderOverrides } from '../../sdk/agent/llm/client'
import { requestChatCompletionWithConfig } from '../../sdk/agent/llm/client'
import { runAgent, resolveConfirm, resolveRetry } from '../../sdk/agent'
import { listChatStoreSessions, loadChatStoreSessionPage, saveChatStoreSessionPatch, deleteChatStoreSession, initMemoryDb } from '../../repositories/memory-db/index'
import {
  sanitizeUserFacingText,
} from '../../../shared/sanitize'
import { log, logError } from '../../infrastructure/logger'
import { buildAgentServices } from '../../services/agent-services-factory'
import { getBridgeManager } from '../../bridge/bridge-manager'
import type { RiskCategory } from '../../sdk/agent/tools'
import { setAutoApproveCategories } from '../../sdk/agent/tools'
import nodePath from 'node:path'

/* ------------------------------------------------------------------ */
/*  Agent Abort tracking                                               */
/* ------------------------------------------------------------------ */

/** 当前正在运行的 agent AbortController 集合：requestId → AbortController */
export const agentAbortControllers = new Map<string, AbortController>()

const AGENT_EVENT_CHUNK_THRESHOLD_BYTES = 180 * 1024
const AGENT_EVENT_CHUNK_SIZE_CHARS = 48 * 1024

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function buildLogScope(projectId?: string, workspace?: string): string | undefined {
  if (projectId && projectId.trim()) return `project:${projectId.trim()}`
  if (workspace && workspace.trim()) return `workspace:${nodePath.resolve(workspace.trim())}`
  return undefined
}

function sendAgentEventSafely(
  sender: Electron.WebContents,
  payload: AgentEventData,
  logScope?: string,
): void {
  if (sender.isDestroyed()) return

  let serialized = ''
  try {
    serialized = JSON.stringify(payload)
  } catch (err) {
    log('AGENT_EVENT_SERIALIZE_FAIL', {
      error: err instanceof Error ? err.message : String(err),
      requestId: payload.requestId,
      type: (payload as { type?: string }).type ?? 'unknown',
    }, logScope)
    sender.send(IpcChannel.AGENT_EVENT, {
      requestId: payload.requestId,
      type: 'error',
      message: 'Agent 事件序列化失败',
    } satisfies AgentEventData)
    return
  }

  const size = Buffer.byteLength(serialized, 'utf8')
  if (size <= AGENT_EVENT_CHUNK_THRESHOLD_BYTES) {
    sender.send(IpcChannel.AGENT_EVENT, payload)
    return
  }

  const total = Math.max(1, Math.ceil(serialized.length / AGENT_EVENT_CHUNK_SIZE_CHARS))
  const chunkId = `chunk-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  for (let index = 0; index < total; index++) {
    const start = index * AGENT_EVENT_CHUNK_SIZE_CHARS
    const payloadChunk = serialized.slice(start, start + AGENT_EVENT_CHUNK_SIZE_CHARS)
    const chunk: AgentEventChunkData = {
      requestId: payload.requestId,
      chunkId,
      index,
      total,
      payloadChunk,
    }
    sender.send(IpcChannel.AGENT_EVENT_CHUNK, chunk)
  }

  log('AGENT_EVENT_CHUNK_SENT', {
    requestId: payload.requestId,
    type: (payload as { type?: string }).type ?? 'unknown',
    size,
    total,
  }, logScope)
}

/* ------------------------------------------------------------------ */
/*  Agent handlers                                                     */
/* ------------------------------------------------------------------ */

export async function handleAgentStream(event: IpcMainEvent, payload: AgentStreamPayload): Promise<void> {
  const {
    requestId,
    provider,
    messages,
    overrides,
    workspace,
    contextLength,
    images,
    projectId,
    recallDebug,
    sessionId,
    sourceUserMessageId,
    sourceAssistantMessageId,
  } = payload
  const logScope = buildLogScope(projectId, workspace)

  if (images && images.length > 0) {
    log('IMAGES_RECEIVED', { count: images.length, urls: images.slice(0, 3) }, logScope)
  }

  const abortController = new AbortController()
  agentAbortControllers.set(requestId, abortController)

  try {
    const mgr = getBridgeManager()
    mgr.updateProjectStateAndPush(String(projectId ?? ''), {
      isProcessing: true,
      activeTaskId: requestId,
    })
  } catch (_) { /* bridge 未初始化时忽略 */ }

  // 推送用户消息到桥接（让移动端实时显示用户消息）
  try {
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')
    if (lastUserMsg) {
      let userText = ''
      let userImages: string[] = []
      if (typeof lastUserMsg.content === 'string') {
        userText = lastUserMsg.content
      } else if (Array.isArray(lastUserMsg.content)) {
        const textParts: string[] = []
        for (const part of lastUserMsg.content) {
          if (part.type === 'text') textParts.push(part.text)
          else if (part.type === 'image_url' && part.image_url?.url) userImages.push(part.image_url.url)
        }
        userText = textParts.join('\n')
      }
      // 压缩 base64 dataUrl 图片后一并发送（不再过滤掉）
      const processedImages: string[] = userImages.map(url => {
        if (!url.startsWith('data:')) return url // 云端 URL 原样保留
        try {
          const { nativeImage } = require('electron')
          const img = nativeImage.createFromDataURL(url)
          if (img.isEmpty()) return url
          const size = img.getSize()
          const maxDim = 800
          let scale = 1
          if (size.width > maxDim || size.height > maxDim) {
            scale = Math.min(maxDim / size.width, maxDim / size.height)
          }
          const resized = img.resize({
            width: Math.max(1, Math.round(size.width * scale)),
            height: Math.max(1, Math.round(size.height * scale)),
            quality: 'best',
          })
          const buf = resized.toJPEG(55)
          return `data:image/jpeg;base64,${buf.toString('base64')}`
        } catch {
          return url
        }
      })
      if (userText || processedImages.length > 0) {
        getBridgeManager().sendHostMessage({
          type: 'bridge:chat-user-message',
          messageId: sourceUserMessageId || `user-${requestId}`,
          content: userText,
          images: processedImages.length > 0 ? processedImages : undefined,
          threadId: projectId,
          timestamp: Date.now(),
        } as any)
      }
    }
  } catch (_) { /* bridge 未初始化时忽略 */ }

  try {
    await runAgent(
      provider as ProviderKey,
      messages,
      overrides as ProviderOverrides | undefined,
      workspace,
      (agentEvent) => {
        if (event.sender.isDestroyed()) return
        sendAgentEventSafely(event.sender, { requestId, ...agentEvent }, logScope)
        try {
          // tool_calls 也转发给移动端，让手机端实时显示 Agent 工具调用进度
          getBridgeManager().sendHostMessage({
            type: 'bridge:agent-event',
            requestId: sourceAssistantMessageId || requestId,
            originalRequestId: requestId,
            threadId: projectId,
            event: agentEvent,
          } as any, 'high')
          
          // 新增：根据事件类型更新项目状态
          const mgr = getBridgeManager()
          const projectIdStr = String(projectId ?? '')
          const assistantMessageId = sourceAssistantMessageId || requestId
          
          if (agentEvent.type === 'text' || agentEvent.type === 'reasoning') {
            // 流式输出中 - 实时推送状态变更
            mgr.updateProjectStateAndPush(projectIdStr, {
              lastMessageId: assistantMessageId,
              lastMessageRole: 'assistant',
              lastMessageHasContent: true,
              lastMessageIsStreaming: true,
            })
          } else if (agentEvent.type === 'tool_calls') {
            // 工具调用 - 实时推送状态变更
            mgr.updateProjectStateAndPush(projectIdStr, {
              lastMessageId: assistantMessageId,
              lastMessageRole: 'assistant',
              lastMessageHasContent: true,
              lastMessageIsStreaming: false,
            })
          } else if (agentEvent.type === 'plan_init' || agentEvent.type === 'plan_progress') {
            // 执行计划 - 实时推送状态变更
            mgr.updateProjectStateAndPush(projectIdStr, {
              lastMessageId: assistantMessageId,
              lastMessageRole: 'assistant',
              lastMessageHasContent: true,
              lastMessageHasPlan: true,
              lastMessageIsStreaming: false,
            })
          } else if (agentEvent.type === 'done') {
            // 任务完成 - 立即推送 isProcessing=false，与 done 事件同时到达移动端
            // 不再等待 finally 块，避免移动端收到 done 事件后仍显示处理中状态
            mgr.updateProjectStateAndPush(projectIdStr, {
              isProcessing: false,
              activeTaskId: undefined,
              lastMessageId: assistantMessageId,
              lastMessageRole: 'assistant',
              lastMessageHasContent: true,
              lastMessageIsStreaming: false,
              lastMessageHasPlan: false,
            })
          } else if (agentEvent.type === 'error') {
            // 任务出错 - 立即推送 isProcessing=false
            mgr.updateProjectStateAndPush(projectIdStr, {
              isProcessing: false,
              activeTaskId: undefined,
              lastMessageId: assistantMessageId,
              lastMessageRole: 'assistant',
              lastMessageHasContent: true,
              lastMessageIsStreaming: false,
              lastMessageHasPlan: false,
            })
          }
        } catch (_) { /* ignore bridge errors */ }
      },
      contextLength,
      abortController.signal,
      projectId,
      sessionId,
      sourceUserMessageId,
      sourceAssistantMessageId,
      logScope,
      Boolean(recallDebug),
      buildAgentServices(),
    )
  } finally {
    agentAbortControllers.delete(requestId)
    
    try {
      const mgr = getBridgeManager()
      mgr.updateProjectStateAndPush(String(projectId ?? ''), {
        isProcessing: false,
        activeTaskId: undefined,
      })
    } catch (_) { /* bridge 未初始化时忽略 */ }
  }
}

export function handleAgentAbort(_event: IpcMainEvent, requestId: string) {
  const controller = agentAbortControllers.get(requestId)
  if (controller) {
    controller.abort()
  }
}

export function handleAgentConfirm(_event: IpcMainEvent, payload: AgentConfirmPayload) {
  resolveConfirm(payload.confirmId, payload.approved)
  try {
    getBridgeManager().sendHostMessage({
      type: 'bridge:agent-confirm-resolved',
      confirmId: payload.confirmId,
      approved: payload.approved,
    } as any)
  } catch (_) { /* bridge 未初始化时忽略 */ }
}

export function handleAgentRetryResponse(_event: IpcMainEvent, payload: { retryId: string; shouldRetry: boolean }) {
  resolveRetry(payload.retryId, payload.shouldRetry)
  try {
    getBridgeManager().sendHostMessage({
      type: 'bridge:agent-retry-resolved',
      retryId: payload.retryId,
      shouldRetry: payload.shouldRetry,
    } as any)
  } catch (_) { /* bridge 未初始化时忽略 */ }
}

/* ------------------------------------------------------------------ */
/*  Renderer error handler                                             */
/* ------------------------------------------------------------------ */

export async function handleRendererError(_event: IpcMainInvokeEvent, payload: RendererErrorPayload): Promise<void> {
  const source = String(payload?.source ?? '').trim() || 'unknown'
  const message = String(payload?.message ?? '').trim() || 'Renderer error'
  const scope = buildLogScope(payload?.projectId, payload?.workspace)
  logError('renderer-error', `[${source}] ${message}`, {
    stack: payload?.stack,
    componentStack: payload?.componentStack,
    metadata: payload?.metadata,
  }, scope)
}

/* ------------------------------------------------------------------ */
/*  Chat store handlers                                                */
/* ------------------------------------------------------------------ */

export async function handleChatStoreList(): Promise<ChatStoreSessionSummary[]> {
  initMemoryDb()
  return listChatStoreSessions().map((entry) => ({
    projectId: entry.projectId,
    sessionId: entry.sessionId,
    workspace: entry.workspace,
    updatedAt: entry.updatedAt,
    messageCount: Number.isFinite(Number(entry.messageCount)) ? Number(entry.messageCount) : 0,
  }))
}

export async function handleChatStoreLoadPage(
  _event: IpcMainInvokeEvent,
  sessionId: string,
  options?: { beforeSeq?: number; limit?: number },
): Promise<ChatStoreSessionPage | null> {
  initMemoryDb()
  const page = loadChatStoreSessionPage(sessionId, options)
  if (!page) return null
  return {
    projectId: page.projectId,
    sessionId: page.sessionId,
    workspace: page.workspace,
    updatedAt: page.updatedAt,
    totalCount: page.totalCount,
    startSeq: page.startSeq,
    endSeq: page.endSeq,
    messages: Array.isArray(page.messages) ? page.messages : [],
  }
}

export async function handleChatStoreSave(_event: IpcMainInvokeEvent, patch: ChatStoreSessionPatch): Promise<void> {
  initMemoryDb()
  saveChatStoreSessionPatch({
    projectId: String(patch?.projectId || ''),
    sessionId: String(patch?.sessionId || ''),
    workspace: String(patch?.workspace || ''),
    updatedAt: Number.isFinite(Number(patch?.updatedAt)) ? Number(patch.updatedAt) : Date.now(),
    fromSeq: Number.isFinite(Number(patch?.fromSeq)) ? Number(patch.fromSeq) : 0,
    messages: Array.isArray(patch?.messages) ? patch.messages : [],
  })
}

export async function handleChatStoreDeleteSession(_event: IpcMainInvokeEvent, sessionId: string): Promise<void> {
  initMemoryDb()
  deleteChatStoreSession(sessionId)
}

/* ------------------------------------------------------------------ */
/*  App notify                                                         */
/* ------------------------------------------------------------------ */

import { Notification } from 'electron'

export async function handleAppNotify(_event: IpcMainInvokeEvent, payload: AppNotifyPayload): Promise<boolean> {
  if (!Notification.isSupported()) return false
  const title = payload.title?.trim() || 'Taco AI'
  const body = payload.body?.trim() || '任务执行完成'
  const notification = new Notification({
    title,
    body,
    silent: payload.silent ?? false,
  })
  notification.show()
  return true
}

/* ------------------------------------------------------------------ */
/*  Config handlers (AppState)                              */
/* ------------------------------------------------------------------ */

import { getAppState, saveAppProvidersState, saveAppThreadsState } from '../../infrastructure/app-state'

export async function handleAppStateGet(): Promise<AppStateSnapshot> {
  return await getAppState()
}

export async function handleAppStateSaveThreads(
  _event: IpcMainInvokeEvent,
  payload: AppStateThreadsPayload,
): Promise<AppStateThreadsPayload> {
  const result = await saveAppThreadsState(payload)
  try {
    const mgr = getBridgeManager()
    const newActiveId = result.activeThreadId || null
    if (mgr.getActiveThreadId() !== newActiveId) {
      const orderedProjectIds = result.threads.map(t => t.id)
      mgr.setActiveThread(newActiveId, orderedProjectIds)
    }
  } catch {
    // bridge 未初始化时忽略
  }
  return result
}

export async function handleAppStateSaveProviders(
  _event: IpcMainInvokeEvent,
  payload: AppStateProvidersPayload,
): Promise<AppStateProvidersPayload> {
  return await saveAppProvidersState(payload)
}

/** 渲染层确认状态已保存完毕 → 执行 WAL checkpoint + app.exit(0) */
export function handleAppStateSaveComplete(): void {
  const { resolveQuitSave } = require('../../main')
  resolveQuitSave()
}

/* ------------------------------------------------------------------ */
/*  TTS Rewrite Text — AI 口语化改写                                    */
/* ------------------------------------------------------------------ */

const TTS_REWRITE_SYSTEM_PROMPT = `你是文本口语化助手。将以下文本改写为适合语音朗读的自然口语：
- 保留所有关键信息，不要省略任何实质内容
- 长句拆短句，每句不超过 25 个字
- 特殊符号用口语表达（✅→已完成，❌→不可用，→→然后，⚠️→注意）
- 去掉所有 markdown 标记（**、*、\`、#、- 等）
- 像朋友聊天一样自然流畅
- 代码/数字/文件名照读不省略

直接输出改写后的文本，不要加任何解释、前缀或后缀。`

export async function handleTtsRewriteText(
  _event: IpcMainInvokeEvent,
  payload: { text: string; modelConfigId?: string },
): Promise<string> {
  const { text, modelConfigId } = payload
  if (!text?.trim()) return text

  // 查找模型配置
  let providerConfig: { provider: string; baseUrl: string; apiKey: string; model: string } | null = null

  if (modelConfigId) {
    try {
      const { getAppState } = await import('../../infrastructure/app-state')
      const state = await getAppState()
      const modelConfig = state.providersState.modelConfigs.find(c => c.id === modelConfigId)
      if (modelConfig?.apiKey && modelConfig?.model) {
        providerConfig = {
          provider: modelConfig.provider,
          baseUrl: modelConfig.baseUrl,
          apiKey: modelConfig.apiKey,
          model: modelConfig.model,
        }
      }
    } catch (err) {
      logError('TTS_REWRITE_CONFIG_FAIL', String(err))
    }
  }

  // 本地配置找不到 → 搜索网关系统模型（如 deepseek-v4-flash）
  if (!providerConfig && modelConfigId) {
    try {
      const { getGatewayModelListCache } = await import('./gateway-handlers')
      const gwModels = getGatewayModelListCache()
      const gw = gwModels?.find(m => m.id === modelConfigId)
      if (gw?.apiKey && gw?.model) {
        providerConfig = {
          provider: gw.provider,
          baseUrl: gw.baseUrl,
          apiKey: gw.apiKey,
          model: gw.model,
        }
      }
    } catch (_) { /* ignore */ }
  }

  // 都没有 → fallback：本地第一个可用 → 网关第一个可用
  if (!providerConfig) {
    try {
      const { getAppState } = await import('../../infrastructure/app-state')
      const state = await getAppState()
      const firstConfig = state.providersState.modelConfigs.find(c => c.apiKey && c.model)
      if (firstConfig) {
        providerConfig = {
          provider: firstConfig.provider,
          baseUrl: firstConfig.baseUrl,
          apiKey: firstConfig.apiKey,
          model: firstConfig.model,
        }
      }
    } catch (_) { /* ignore */ }
  }

  if (!providerConfig) {
    try {
      const { getGatewayModelListCache } = await import('./gateway-handlers')
      const gwModels = getGatewayModelListCache()
      const firstGw = gwModels?.find(m => m.apiKey && m.model)
      if (firstGw) {
        providerConfig = {
          provider: firstGw.provider,
          baseUrl: firstGw.baseUrl,
          apiKey: firstGw.apiKey,
          model: firstGw.model,
        }
      }
    } catch (_) { /* ignore */ }
  }

  if (!providerConfig) {
    throw new Error('没有可用的模型配置，请先在设置中配置至少一个模型')
  }

  // 规范化 baseUrl：去除尾部 /chat/completions（buildRequest 会自动追加）
  const baseUrl = providerConfig.baseUrl.replace(/\/chat\/completions\/?$/, '').replace(/\/+$/, '')

  log('TTS_REWRITE_REQUEST', {
    provider: providerConfig.provider,
    model: providerConfig.model,
    baseUrl,
    textLength: text.length,
  })

  const result = await requestChatCompletionWithConfig(
    providerConfig.provider as ProviderKey,
    {
      baseUrl,
      apiKey: providerConfig.apiKey,
      model: providerConfig.model,
    },
    [
      { role: 'system', content: TTS_REWRITE_SYSTEM_PROMPT },
      { role: 'user', content: text },
    ],
    undefined,
    'tts-rewrite',
    undefined,
  )

  return result?.trim() || text
}
