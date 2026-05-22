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
import type { ProviderKey, ProviderOverrides } from '../../ai/llm'
import { runAgent, resolveConfirm } from '../../agent'
import { listChatStoreSessions, loadChatStoreSessionPage, saveChatStoreSessionPatch, deleteChatStoreSession, initMemoryDb } from '../../data/memory-db'
import {
  sanitizeUserFacingText,
} from '../../../shared/sanitize'
import { log, logError } from '../../system/logger'
import { getBridgeManager } from '../../bridge/bridge-manager'
import type { RiskCategory } from '../../tools'
import { setAutoApproveCategories } from '../../tools'
import nodePath from 'node:path'

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

/** 当前正在运行的 agent AbortController 集合：requestId → AbortController */
export const agentAbortControllers = new Map<string, AbortController>()

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
          getBridgeManager().sendHostMessage({
            type: 'bridge:agent-event',
            requestId: sourceAssistantMessageId || requestId,
            originalRequestId: requestId,
            threadId: projectId,
            event: agentEvent,
          } as any)
          
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
            // 任务完成 - 实时推送状态变更
            mgr.updateProjectStateAndPush(projectIdStr, {
              lastMessageId: assistantMessageId,
              lastMessageRole: 'assistant',
              lastMessageHasContent: true,
              lastMessageIsStreaming: false,
              lastMessageHasPlan: false,
            })
          } else if (agentEvent.type === 'error') {
            // 任务出错 - 实时推送状态变更
            mgr.updateProjectStateAndPush(projectIdStr, {
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
    agentAbortControllers.delete(requestId)
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
/*  Config handlers (GUI-Plus, AppState, PromptConfig)                 */
/* ------------------------------------------------------------------ */

import { getGuiPlusConfig, saveGuiPlusConfig } from '../../automation/gui-plus'
import type { GuiPlusConfig, PromptConfig } from '../../../shared/ipc'
import { getPromptConfig, savePromptConfig } from '../../project/prompt-config'
import { getAppState, saveAppProvidersState, saveAppThreadsState } from '../../system/app-state'

export async function handleGuiPlusGet(): Promise<GuiPlusConfig> {
  return await getGuiPlusConfig()
}

export async function handleGuiPlusSave(_event: IpcMainInvokeEvent, config: GuiPlusConfig): Promise<void> {
  await saveGuiPlusConfig(config)
}

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

export async function handlePromptConfigGet(): Promise<PromptConfig> {
  return await getPromptConfig()
}

export async function handlePromptConfigSave(_event: IpcMainInvokeEvent, config: PromptConfig): Promise<PromptConfig> {
  return await savePromptConfig(config)
}
