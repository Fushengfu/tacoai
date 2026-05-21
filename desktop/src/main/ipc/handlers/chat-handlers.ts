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
  ChatSendPayload,
  ChatStreamPayload,
  AgentStreamPayload,
  AgentConfirmPayload,
  ChatStoreSessionPatch,
  ChatStoreSessionPage,
  ChatStoreSessionSummary,
  AgentEventData,
  AgentEventChunkData,
} from '../../../shared/ipc'
import type { ProviderKey, ProviderOverrides, TokenUsage } from '../../ai/llm'
import { requestChatCompletion, requestChatCompletionStream } from '../../ai/llm'
import { runAgent, resolveConfirm } from '../../agent'
import { applyRewardScore } from '../../agent/reward-score'
import { inferIntentFromBackground, listNotes, listTaskMemories, saveNote, deleteNote, deleteTaskMemory, maintainTaskMemoriesByAI, recordTaskLog, getMemoryScopeStats, exportMemoryScope } from '../../data/notes'
import { listChatStoreSessions, loadChatStoreSessionPage, saveChatStoreSessionPatch, deleteChatStoreSession, initMemoryDb } from '../../data/memory-db'
import { getBridgeManager } from '../../bridge/bridge-manager'
import {
  extractUserQueryText,
  extractUserAssetsBlock,
} from '../../../shared/user-assets'
import {
  stripInternalContextTags,
  stripPseudoToolCallArtifacts,
  sanitizeUserFacingText,
} from '../../../shared/sanitize'
import { inferIntentTypeFromQuery } from '../../../shared/intent'
import { refreshSkills, buildActiveSkillsCatalogBlock, getActiveSkillEnv, applySkillEnvironment } from '../../project/skills'
import { log, logError } from '../../system/logger'
import type { RiskCategory } from '../../tools'
import { setAutoApproveCategories } from '../../tools'
import nodePath from 'node:path'

const STREAM_SANITIZE_HOLD_BACK = 24
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

function cleanupAssistantMemoryText(text: string): string {
  return stripPseudoToolCallArtifacts(
    stripInternalContextTags(String(text ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '')),
  ).trim()
}

function withActiveSkillsPrompt<T extends { role: string; content?: string | Array<{ type: string; [key: string]: any }> }>(messages: T[]): T[] {
  const skillCatalog = buildActiveSkillsCatalogBlock()
  if (!skillCatalog.trim()) return messages

  const systemIdx = messages.findIndex((m) => m.role === 'system')
  if (systemIdx < 0) return messages

  const current = String(messages[systemIdx].content ?? '')
  if (current.includes('[SKILLS_CATALOG]')) return messages

  const next = [...messages]
  next[systemIdx] = { ...next[systemIdx], content: `${current}\n\n${skillCatalog}` }
  return next
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
/*  Abort controllers                                                  */
/* ------------------------------------------------------------------ */

/** 当前正在运行的 chat 流式 AbortController 集合：requestId → AbortController */
export const chatAbortControllers = new Map<string, AbortController>()

/** 当前正在运行的 agent AbortController 集合：requestId → AbortController */
export const agentAbortControllers = new Map<string, AbortController>()

/* ------------------------------------------------------------------ */
/*  Chat handlers                                                      */
/* ------------------------------------------------------------------ */

/** 非流式：renderer invoke → main handle → 返回完整回复 */
export async function handleChatSend(_event: IpcMainInvokeEvent, payload: ChatSendPayload) {
  const logScope = buildLogScope(payload.projectId, undefined)
  try {
    await refreshSkills()
  } catch (err) {
    log('SKILLS_REFRESH_FAIL', { error: err instanceof Error ? err.message : String(err) }, logScope)
  }
  const messages = withActiveSkillsPrompt(payload.messages)
  const restoreSkillEnv = applySkillEnvironment(getActiveSkillEnv())
  try {
    const raw = await requestChatCompletion(
      payload.provider as ProviderKey,
      messages,
      payload.overrides as ProviderOverrides | undefined,
      undefined,
      logScope,
    )
    return sanitizeUserFacingText(raw)
  } finally {
    restoreSkillEnv()
  }
}

/** 流式：renderer send → main on → 逐块 send 回 renderer */
export async function handleChatStream(event: IpcMainEvent, payload: ChatStreamPayload) {
  const {
    requestId,
    provider,
    overrides,
    projectId,
    workspace,
    maxTokens,
    sessionId,
    sourceUserMessageId,
    sourceAssistantMessageId,
  } = payload
  const logScope = buildLogScope(projectId, workspace)
  try {
    await refreshSkills(workspace)
  } catch (err) {
    log('SKILLS_REFRESH_FAIL', { error: err instanceof Error ? err.message : String(err) }, logScope)
  }
  const messages = withActiveSkillsPrompt(payload.messages)
  const restoreSkillEnv = applySkillEnvironment(getActiveSkillEnv())
  const turnStartedAt = Date.now()
  const abortController = new AbortController()
  let lastUsage: TokenUsage | undefined
  let assistantFullText = ''
  let rawAssistantFullText = ''
  let emittedSanitizedText = ''
  
  // 提取用户消息内容（处理数组和字符串两种情况）
  const lastUserMessageObj = [...messages].reverse().find((m) => m.role === 'user')
  let lastUserGoal = ''
  if (lastUserMessageObj?.content) {
    if (Array.isArray(lastUserMessageObj.content)) {
      // 从数组中提取文本
      for (const part of lastUserMessageObj.content) {
        if (part.type === 'text') {
          lastUserGoal += part.text
        }
      }
    } else {
      lastUserGoal = lastUserMessageObj.content
    }
  }
  lastUserGoal = lastUserGoal.trim()
  
  const plainUserQuery = extractUserQueryText(lastUserGoal)
  const userAssetsBlock = extractUserAssetsBlock(lastUserGoal)

  async function persistChatTurnMemory(
    outcome: 'success' | 'aborted' | 'error',
    summaryText: string,
    errorMessage?: string,
  ): Promise<void> {
    const cleaned = cleanupAssistantMemoryText(summaryText)
    const summary = (errorMessage
      ? [cleaned, `错误信息: ${errorMessage}`].filter(Boolean).join('\n')
      : cleaned
    ) || (outcome === 'aborted' ? '(用户中止，未产出完整回复)' : '(无最终文本)')

    try {
      let intentType = inferIntentTypeFromQuery(plainUserQuery || lastUserGoal)
      let intentSummary = plainUserQuery || lastUserGoal
      let intentGoal = plainUserQuery || lastUserGoal
      let intentSource: 'llm' | 'heuristic' = 'heuristic'

      try {
        const inferred = await inferIntentFromBackground(
          workspace?.trim() ?? '',
          plainUserQuery || lastUserGoal,
          projectId,
          {
            usageTotalTokens: lastUsage?.totalTokens,
            logScope,
          },
        )
        intentType = inferred.intentType || intentType
        intentSummary = inferred.intentSummary || intentSummary
        intentGoal = inferred.intentGoal || intentGoal
        intentSource = inferred.intentSource || intentSource
      } catch (err) {
        log('CHAT_TASK_MEMORY_INTENT_INFER_FAIL', {
          error: err instanceof Error ? err.message : String(err),
        }, logScope)
      }

      await recordTaskLog(
        workspace?.trim() ?? '',
        {
          goal: plainUserQuery || lastUserGoal || '(未提取到用户提问)',
          userQuery: plainUserQuery || lastUserGoal,
          ...(userAssetsBlock ? { userAssetsBlock } : {}),
          assistantResult: summary,
          intentType,
          intentSummary,
          intentGoal,
          summary,
          outcome,
          tools: [],
          changedFiles: [],
          fileDiffs: [],
          identifiers: [],
          failures: errorMessage ? [errorMessage] : [],
          sourceRef: {
            ...(String(sessionId || projectId || '').trim() ? { sessionId: String(sessionId || projectId || '').trim() } : {}),
            ...(String(sourceUserMessageId || '').trim() ? { userMessageId: String(sourceUserMessageId || '').trim() } : {}),
            ...(String(sourceAssistantMessageId || '').trim() ? { assistantMessageId: String(sourceAssistantMessageId || '').trim() } : {}),
          },
        },
        projectId,
      )
      try {
        await maintainTaskMemoriesByAI(workspace?.trim() ?? '', projectId, {
          provider: provider as ProviderKey,
          overrides: overrides as ProviderOverrides | undefined,
          usageTotalTokens: lastUsage?.totalTokens,
          maxTokens,
          logScope,
        })
      } catch (maintainErr) {
        log('CHAT_TASK_MEMORY_MAINTAIN_FAIL', {
          error: maintainErr instanceof Error ? maintainErr.message : String(maintainErr),
        }, logScope)
      }
      log('CHAT_TASK_MEMORY_SAVED', {
        outcome,
        hasGoal: Boolean(plainUserQuery || lastUserGoal),
        intentType,
        intentSource,
        summaryLength: summary.length,
      }, logScope)

      try {
        const scored = await applyRewardScore({
          channel: 'chat',
          outcome,
          workspace,
          projectId,
          requestId,
          failures: errorMessage ? 1 : 0,
          elapsedMs: Math.max(0, Date.now() - turnStartedAt),
        })
      } catch (scoreErr) {
        log('REWARD_SCORE_APPLY_FAIL', {
          channel: 'chat',
          error: scoreErr instanceof Error ? scoreErr.message : String(scoreErr),
        }, logScope)
      }
    } catch (err) {
      log('CHAT_TASK_MEMORY_SAVE_FAIL', {
        error: err instanceof Error ? err.message : String(err),
      }, logScope)
    }
  }

  chatAbortControllers.set(requestId, abortController)

  // Bridge: 开始任务时，立即更新项目状态并推送给移动端
  try {
    const mgr = getBridgeManager()
    mgr.updateProjectStateAndPush(String(projectId ?? ''), {
      isProcessing: true,
      activeTaskId: requestId,
    })
  } catch (_) { /* bridge 未初始化时忽略 */ }

  // Bridge: 发送用户消息到移动端
  try {
    const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user')
    if (lastUserMessage) {
      // 提取 content：如果是数组，提取文本和图片；如果是字符串，直接使用
      let contentText = ''
      let imageUrls: string[] = []
      
      if (Array.isArray(lastUserMessage.content)) {
        for (const part of lastUserMessage.content) {
          if (part.type === 'text') {
            contentText += part.text
          } else if (part.type === 'image_url') {
            imageUrls.push(part.image_url.url)
          }
        }
      } else {
        contentText = lastUserMessage.content || ''
      }
      
      getBridgeManager().sendHostMessage({
        type: 'bridge:chat-user-message',
        messageId: sourceUserMessageId || `user-${requestId}`,
        content: contentText,
        images: imageUrls.length > 0 ? imageUrls : undefined,
        threadId: projectId,
        timestamp: Date.now(),
      })
    }
  } catch (_) { /* ignore bridge errors */ }

  try {
    for await (const chunk of requestChatCompletionStream(
      provider as ProviderKey,
      messages,
      overrides as ProviderOverrides | undefined,
      abortController.signal,
      logScope,
      (usage) => {
        lastUsage = usage
      },
    )) {
      rawAssistantFullText += chunk
      const sanitizedFull = sanitizeUserFacingText(rawAssistantFullText)
      if (sanitizedFull.length < emittedSanitizedText.length) {
        emittedSanitizedText = sanitizedFull
      }
      const safeRawLen = Math.max(0, rawAssistantFullText.length - STREAM_SANITIZE_HOLD_BACK)
      const safeRaw = rawAssistantFullText.slice(0, safeRawLen)
      const sanitizedSafe = sanitizeUserFacingText(safeRaw)
      const delta = sanitizedSafe.slice(emittedSanitizedText.length)
      emittedSanitizedText = sanitizedSafe
      assistantFullText = sanitizedFull
      if (event.sender.isDestroyed()) return
      if (delta) {
        event.sender.send(IpcChannel.CHAT_CHUNK, { requestId, chunk: delta, done: false })
        try {
          getBridgeManager().sendHostMessage({
            type: 'bridge:chat-delta',
            messageId: sourceAssistantMessageId || requestId,
            delta,
            done: false,
            threadId: projectId,
          })
          
          // 关键修复：使用 updateProjectStateAndPush 实时推送状态变更
          // 避免移动端因状态延迟而显示错误的发送按钮状态
          const mgr = getBridgeManager()
          const projectIdStr = String(projectId ?? '')
          const assistantMessageId = sourceAssistantMessageId || requestId
          mgr.updateProjectStateAndPush(projectIdStr, {
            lastMessageId: assistantMessageId,
            lastMessageRole: 'assistant',
            lastMessageHasContent: true,
            lastMessageIsStreaming: true,
          })
        } catch (_) { /* ignore bridge errors */ }
      }
    }
    const finalSanitized = sanitizeUserFacingText(rawAssistantFullText)
    const tailStart = Math.min(emittedSanitizedText.length, finalSanitized.length)
    const tailDelta = finalSanitized.slice(tailStart)
    assistantFullText = finalSanitized
    if (tailDelta && !event.sender.isDestroyed()) {
      event.sender.send(IpcChannel.CHAT_CHUNK, { requestId, chunk: tailDelta, done: false })
      try {
        getBridgeManager().sendHostMessage({
          type: 'bridge:chat-delta',
          messageId: sourceAssistantMessageId || requestId,
          delta: tailDelta,
          done: false,
          threadId: projectId,
        })
      } catch (_) { /* ignore bridge errors */ }
    }
    if (!event.sender.isDestroyed()) {
      event.sender.send(IpcChannel.CHAT_CHUNK, { requestId, chunk: '', done: true, usage: lastUsage })
      try {
        getBridgeManager().sendHostMessage({
          type: 'bridge:chat-delta',
          messageId: sourceAssistantMessageId || requestId,
          delta: '',
          done: true,
          threadId: projectId,
        })
      } catch (_) { /* ignore bridge errors */ }
    }
    await persistChatTurnMemory('success', assistantFullText)
  } catch (error) {
    const aborted = abortController.signal.aborted || (error instanceof Error && error.name === 'AbortError')
    if (aborted) {
      if (!event.sender.isDestroyed()) {
        event.sender.send(IpcChannel.CHAT_CHUNK, { requestId, chunk: '', done: true, usage: lastUsage })
      }
      try {
        getBridgeManager().sendHostMessage({
          type: 'bridge:chat-delta',
          messageId: sourceAssistantMessageId || requestId,
          delta: '',
          done: true,
          threadId: projectId,
        })
      } catch (_) { /* ignore bridge errors */ }
      await persistChatTurnMemory('aborted', assistantFullText)
      return
    }
    if (!event.sender.isDestroyed()) {
      event.sender.send(IpcChannel.CHAT_CHUNK, {
        requestId,
        chunk: '',
        done: true,
        error: error instanceof Error ? error.message : 'Stream failed'
      })
    }
    try {
      getBridgeManager().sendHostMessage({
        type: 'bridge:chat-delta',
        messageId: sourceAssistantMessageId || requestId,
        delta: '',
        done: true,
        threadId: projectId,
      })
    } catch (_) { /* ignore bridge errors */ }
    await persistChatTurnMemory('error', assistantFullText, error instanceof Error ? error.message : 'Stream failed')
  } finally {
    chatAbortControllers.delete(requestId)
    restoreSkillEnv()
    try {
      const mgr = getBridgeManager()
      mgr.updateProjectStateAndPush(String(projectId ?? ''), {
        isProcessing: false,
        activeTaskId: undefined,
      })
    } catch (_) { /* bridge 未初始化时忽略 */ }
  }
}

export function handleChatAbort(_event: IpcMainEvent, requestId: string) {
  const controller = chatAbortControllers.get(requestId)
  if (controller) {
    controller.abort()
    chatAbortControllers.delete(requestId)
  }
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
    maxTokens,
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
      maxTokens,
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
