/**
 * Agent 循环
 *
 * 多轮工具调用循环：
 *   1. 发送消息给 LLM（带 tools）
 *   2. 如果 LLM 返回 tool_calls → 风险评估 → 需确认则等待用户授权 → 执行工具 → 将结果追加到消息 → 回到 1
 *   3. 如果 LLM 返回纯文本 → 结束
 *
 * 通过 callback 向调用方推送事件（文本流、工具调用、工具结果、确认请求）。
 */

import type { ChatMessage, ProviderOverrides, TokenUsage } from './llm/client'
import type { ProviderKey } from './llm/client'
import { requestStreamWithTools } from './llm/client'
import {
  getFilteredToolDefinitions,
  buildAllowedToolNamesForRequest,
  loadAuthLevel,
  isAutoCommitEnabled,
} from './tools'
import type { ToolCall, ToolResult, RiskInfo } from './tools'
import type { AgentServices } from './services'
import type { AgentEvent } from './types'
import type { PlanStepStatus } from './types'
import type { RecallMeta } from './memory/memory-recall'
import { gitEnsureRepo } from './git/service'
import {
  extractUserQueryText,
  extractUserAssetsBlock,
} from './shared/user-assets'
import {
  stripInternalContextTags,
  stripPseudoToolCallArtifacts,
  sanitizeUserFacingText,
  sanitizeReasoningForContext,
  sanitizeReplayRawText,
  containsPseudoToolCallSyntax,
} from './shared/sanitize'
import { inferIntentTypeFromQuery } from './shared/intent'
import { extractTextFromContent } from './llm/adapter'
import { waitForConfirm, isAbortError } from './error-handler'
import { compressAgentContext } from './context/compressor'

// ─── 子模块导入 ────────────────────────────────────────────────────────────

import {
  sleep,
  safeParseObject,
  extractThinkingFromAssistantRawText,
  buildAssistantContextContent,
  bootstrapAgentMemory,
  MAX_TOOL_ROUNDS,
  AGENT_LOOP_TIMEOUT_MS,
  AUTO_RETRY_BASE_DELAY_MS,
  AUTO_RETRY_MAX_DELAY_MS,
  STREAM_SANITIZE_HOLD_BACK,
} from './loop-utils'

export { bootstrapAgentMemory } from './loop-utils'
export { resolveConfirm, resolveRetry, isAbortError } from './loop-utils'

import {
  buildRuntimeToolPrompt,
  syncRuntimeToolPrompt,
  injectBackgroundContext,
  injectSystemPrompts,
  refreshSkillsWithEnv,
  buildUserId,
} from './loop-context'

import {
  createTrackState,
  trackToolCallsInputs,
  trackToolResultsCore,
  trackFileChanges,
} from './loop-track'
import type { TrackState } from './loop-track'

import {
  persistTaskCoreLogWithOutcome,
  finalizeAndDone,
  finalizePendingPlanStepsIfNeeded,
} from './loop-persist'

import {
  filterNoteTools,
  filterNonNoteTools,
  executeNoteTools,
  filterPlanProgressTools,
  filterNonPlanProgressTools,
  executePlanProgressTools,
  handleProposePlan,
  handleRiskAssessment,
  executeAndTrackTools,
  pushAssistantToolCallMessage,
} from './loop-exec'
import type { CurrentPlan } from './loop-exec'

/* ------------------------------------------------------------------ */
/*  Agent 事件类型                                                     */
/* ------------------------------------------------------------------ */

export type { AgentEvent } from './types'

/* ------------------------------------------------------------------ */
/*  runAgent 主入口                                                    */
/* ------------------------------------------------------------------ */

export async function runAgent(
  provider: ProviderKey,
  messages: ChatMessage[],
  overrides: ProviderOverrides | undefined,
  workspace: string,
  onEvent?: (event: AgentEvent) => void,
  contextLength?: number,
  signal?: AbortSignal,
  projectId?: string,
  sessionId?: string,
  sourceUserMessageId?: string,
  sourceAssistantMessageId?: string,
  logScope?: string,
  recallDebug = false,
  services?: AgentServices,
): Promise<void> {
  const taskStartedAt = Date.now()
  const isAutoCommitOn = () => isAutoCommitEnabled(projectId || '', services?.database)
  const log = services?.logger ?? (() => {})

  if (services) bootstrapAgentMemory(services)
  if (projectId && services?.database) loadAuthLevel(projectId, services.database)

  // 超时保护
  const loopTimeoutTimer = setTimeout(() => {
    log('AGENT_TIMEOUT_WARNING', { timeout: AGENT_LOOP_TIMEOUT_MS, message: 'Agent 运行时间过长,可能存在无限循环' }, logScope)
  }, AGENT_LOOP_TIMEOUT_MS)

  const { catalogBlock, restoreEnv } = await refreshSkillsWithEnv(workspace, log, logScope)

  try {
    if (isAutoCommitOn()) {
      try { await gitEnsureRepo(workspace) } catch (err) {
        log('GIT_INIT_FAIL', { error: err instanceof Error ? err.message : String(err) }, logScope)
      }
    } else {
      log('GIT_AUTO_OPS_DISABLED', { action: 'skip_git_ensure_repo' }, logScope)
    }

    const userId = buildUserId(provider, overrides, projectId, workspace)
    const workingMessages = [...messages]

    // 提取用户目标文本
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')
    const lastUserGoal = lastUserMsg ? extractTextFromContent(lastUserMsg.content).trim() : ''
    const plainUserQuery = extractUserQueryText(lastUserGoal)
    const userAssetsBlock = extractUserAssetsBlock(lastUserGoal)
    const normalizedMemorySessionId = String(sessionId || projectId || '').trim()
    const normalizedSourceUserMessageId = String(sourceUserMessageId || '').trim()
    const normalizedSourceAssistantMessageId = String(sourceAssistantMessageId || '').trim()

    // 背景记忆注入
    let latestRecallMeta: Pick<RecallMeta, 'intentSource' | 'intentType' | 'intentSummary' | 'intentGoal'> | null = null
    const bgResult = await injectBackgroundContext(
      workingMessages, workspace, projectId, contextLength,
      provider, overrides, signal, logScope, log, recallDebug,
    )
    let currentTaskStartIndex = bgResult.currentTaskStartIndex
    latestRecallMeta = bgResult.latestRecallMeta

    // 系统提示注入（Skills + 目录树 + 工具清单）
    await injectSystemPrompts(workingMessages, workspace, catalogBlock, log, logScope)

    // ─── 循环状态初始化 ───
    let round = 0
    const state = createTrackState()
    let currentPlan: CurrentPlan = null
    let latestGitCommitHash: string | undefined
    let lastUsageTotalTokens: number | undefined
    let contextRetries = 0
    let lastAssistantText = ''
    let pseudoToolCallRejectCount = 0
    let enforceStandardToolCall = false
    let autoNetworkRetryCount = 0
    let autoEmptyRetryCount = 0

    function cleanupAssistantText(text: string): string {
      return stripPseudoToolCallArtifacts(
        stripInternalContextTags(String(text ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '')),
      ).trim()
    }

    function pushAssistantMessageIfNew(content: string): boolean {
      const normalized = String(content ?? '').trim()
      if (!normalized) return false
      const lastMessage = workingMessages[workingMessages.length - 1]
      const lastContent = lastMessage
        ? (typeof lastMessage.content === 'string' ? lastMessage.content : extractTextFromContent(lastMessage.content))
        : ''
      if (lastMessage?.role === 'assistant' && String(lastContent ?? '').trim() === normalized) return false
      workingMessages.push({ role: 'assistant', content: normalized })
      return true
    }

    function getExecutionEvidenceCount(): number {
      return (
        [...state.toolUsageCount.values()].reduce((sum, count) => sum + count, 0) +
        state.changedFiles.size +
        state.failureLogs.length
      )
    }

    function shouldTryFinalizeDirectTextReply(finalText: string): boolean {
      return String(finalText ?? '').trim().length > 0
    }

    async function tryFinalizeReply(finalText: string): Promise<boolean> {
      finalizePendingPlanStepsIfNeeded(currentPlan, state.successfulRunCommandCount, state.successfulRunCommandSummaries, onEvent)
      lastAssistantText = finalText
      await finalizeAndDone(
        state, workspace, projectId, services?.database,
        lastUserGoal, plainUserQuery, userAssetsBlock,
        normalizedMemorySessionId, normalizedSourceUserMessageId, normalizedSourceAssistantMessageId,
        lastUsageTotalTokens, provider, overrides, contextLength, signal, logScope, log,
        messages, round, onEvent, taskStartedAt, services,
        finalText, 'success', finalText,
      )
      return true
    }

    // ─── 主循环 ──────────────────────────────────────────────────────

    while (round < MAX_TOOL_ROUNDS) {
      if (signal?.aborted) {
        log('AGENT_ABORTED', { round, reason: 'signal aborted before round start' }, logScope)
        await finalizeAndDone(
          state, workspace, projectId, services?.database,
          lastUserGoal, plainUserQuery, userAssetsBlock,
          normalizedMemorySessionId, normalizedSourceUserMessageId, normalizedSourceAssistantMessageId,
          lastUsageTotalTokens, provider, overrides, contextLength, signal, logScope, log,
          messages, round, onEvent, taskStartedAt, services,
          lastAssistantText, 'aborted',
        )
        return
      }

      round++

      // 上下文压缩
      try {
        const compressed = await compressAgentContext(
          workingMessages, contextLength ?? 1048576, provider, overrides, workspace,
          lastUserGoal, projectId, recallDebug, currentTaskStartIndex,
          {
            round, goal: lastUserGoal,
            toolUsageCount: state.toolUsageCount,
            changedFiles: state.changedFiles,
            touchedFiles: state.touchedFiles,
            touchedIdentifiers: state.touchedIdentifiers,
            failures: state.failureLogs,
            currentPlan,
          },
          lastUsageTotalTokens, signal, logScope, onEvent,
          (meta) => { latestRecallMeta = meta },
          userId,
        )
        currentTaskStartIndex = compressed.nextCurrentTaskStartIndex
      } catch (err) {
        if (isAbortError(err) || signal?.aborted) {
          log('AGENT_ABORTED', { round, reason: 'signal aborted during context compress' }, logScope)
          await finalizeAndDone(
            state, workspace, projectId, services?.database,
            lastUserGoal, plainUserQuery, userAssetsBlock,
            normalizedMemorySessionId, normalizedSourceUserMessageId, normalizedSourceAssistantMessageId,
            lastUsageTotalTokens, provider, overrides, contextLength, signal, logScope, log,
            messages, round, onEvent, taskStartedAt, services,
            lastAssistantText, 'aborted',
          )
          return
        }
        const msg = err instanceof Error ? err.message : String(err)
        await persistTaskCoreLogWithOutcome(
          state, workspace, projectId, services?.database,
          lastUserGoal, plainUserQuery, userAssetsBlock,
          normalizedMemorySessionId, normalizedSourceUserMessageId, normalizedSourceAssistantMessageId,
          lastUsageTotalTokens, provider, overrides, contextLength, signal, logScope, log,
          messages, round, onEvent, taskStartedAt, services,
          lastAssistantText, 'error', msg,
        )
        onEvent?.({ type: 'error', message: msg })
        return
      }

      syncRuntimeToolPrompt(workingMessages, buildRuntimeToolPrompt(buildAllowedToolNamesForRequest()))

      const requestMessages = workingMessages
      log('AGENT', { round, messageCount: requestMessages.length }, logScope)
      const allowedToolNames = buildAllowedToolNamesForRequest()

      // ─── LLM 流式调用 ──────────────────────────────────────────
      let textContent = ''
      let rawTextContent = ''
      let emittedSanitizedText = ''
      let rawReasoningContent = ''
      let emittedSanitizedReasoning = ''
      let assistantContextContent = ''
      let toolCallThinking = 'enabled'
      let toolCalls: ToolCall[] = []
      let invalidToolCallNames: string[] = []

      try {
        for await (const event of requestStreamWithTools(
          provider, requestMessages, overrides,
          { tools: getFilteredToolDefinitions(allowedToolNames), toolChoice: 'auto' },
          signal, logScope, userId,
        )) {
          if (signal?.aborted) {
            log('AGENT_ABORTED', { round, reason: 'signal aborted during stream' }, logScope)
            await finalizeAndDone(
              state, workspace, projectId, services?.database,
              lastUserGoal, plainUserQuery, userAssetsBlock,
              normalizedMemorySessionId, normalizedSourceUserMessageId, normalizedSourceAssistantMessageId,
              lastUsageTotalTokens, provider, overrides, contextLength, signal, logScope, log,
              messages, round, onEvent, taskStartedAt, services,
              textContent || lastAssistantText, 'aborted',
            )
            return
          }
          if (event.type === 'text') {
            rawTextContent += event.content
            const sanitizedFull = sanitizeUserFacingText(rawTextContent)
            if (sanitizedFull.length < emittedSanitizedText.length) emittedSanitizedText = sanitizedFull
            const safeRawLen = Math.max(0, rawTextContent.length - STREAM_SANITIZE_HOLD_BACK)
            const safeRaw = rawTextContent.slice(0, safeRawLen)
            const sanitizedSafe = sanitizeUserFacingText(safeRaw)
            const delta = sanitizedSafe.slice(emittedSanitizedText.length)
            emittedSanitizedText = sanitizedSafe
            textContent = sanitizedFull
            lastAssistantText = textContent
            if (delta) onEvent?.({ type: 'text', content: delta })
          } else if (event.type === 'reasoning') {
            rawReasoningContent += event.content
            const sanitizedReasoning = sanitizeReasoningForContext(rawReasoningContent)
            const reasoningDelta = sanitizedReasoning.slice(emittedSanitizedReasoning.length)
            emittedSanitizedReasoning = sanitizedReasoning
            if (reasoningDelta) onEvent?.({ type: 'reasoning', content: reasoningDelta })
          } else if (event.type === 'usage') {
            if (typeof event.usage.totalTokens === 'number' && Number.isFinite(event.usage.totalTokens)) {
              lastUsageTotalTokens = event.usage.totalTokens
            }
            onEvent?.({ type: 'usage', usage: event.usage })
          } else if (event.type === 'invalid_tool_calls') {
            invalidToolCallNames = [...new Set([...invalidToolCallNames, ...event.names])]
          } else if (event.type === 'tool_calls') {
            toolCalls = event.toolCalls
          }
        }

        // 流结束后补齐尾部文本
        const finalSanitizedText = sanitizeUserFacingText(rawTextContent)
        const tailStart = Math.min(emittedSanitizedText.length, finalSanitizedText.length)
        const tailDelta = finalSanitizedText.slice(tailStart)
        if (tailDelta) onEvent?.({ type: 'text', content: tailDelta })
        const finalSanitizedReasoning = sanitizeReasoningForContext(rawReasoningContent)
        const reasoningTailDelta = finalSanitizedReasoning.slice(emittedSanitizedReasoning.length)
        if (reasoningTailDelta) onEvent?.({ type: 'reasoning', content: reasoningTailDelta })
        textContent = finalSanitizedText
        assistantContextContent = buildAssistantContextContent(rawTextContent, finalSanitizedText, rawReasoningContent)
        toolCallThinking =
          sanitizeReasoningForContext(rawReasoningContent).trim() ||
          extractThinkingFromAssistantRawText(rawTextContent) ||
          sanitizeReplayRawText(rawTextContent)
        lastAssistantText = assistantContextContent || textContent || lastAssistantText
      } catch (err) {
        if (isAbortError(err) || signal?.aborted) {
          log('AGENT_ABORTED', { round, reason: 'signal aborted during stream request' }, logScope)
          await finalizeAndDone(
            state, workspace, projectId, services?.database,
            lastUserGoal, plainUserQuery, userAssetsBlock,
            normalizedMemorySessionId, normalizedSourceUserMessageId, normalizedSourceAssistantMessageId,
            lastUsageTotalTokens, provider, overrides, contextLength, signal, logScope, log,
            messages, round, onEvent, taskStartedAt, services,
            textContent || lastAssistantText, 'aborted',
          )
          return
        }
        const msg = err instanceof Error ? err.message : String(err)

        // 上下文超限自动压缩重试
        if (
          contextRetries < 3 &&
          (msg.includes('context length') || msg.includes('maximum') || msg.includes('too many tokens') || msg.includes('请求体过长'))
        ) {
          contextRetries++
          log('AGENT_CONTEXT_OVERFLOW', { round, retry: contextRetries, error: msg }, logScope)
          const dropped = await compressAgentContext(
            workingMessages, Math.floor((contextLength ?? 1048576) * 0.5), provider, overrides, workspace,
            lastUserGoal, projectId, recallDebug, currentTaskStartIndex,
            {
              round, goal: lastUserGoal,
              toolUsageCount: state.toolUsageCount,
              changedFiles: state.changedFiles,
              touchedFiles: state.touchedFiles,
              touchedIdentifiers: state.touchedIdentifiers,
              failures: state.failureLogs,
              currentPlan,
            },
            lastUsageTotalTokens, signal, logScope, onEvent,
            (meta) => { latestRecallMeta = meta },
            userId,
          )
          currentTaskStartIndex = dropped.nextCurrentTaskStartIndex
          if (dropped.compressed > 0) {
            log('AGENT_CONTEXT_RETRY', { dropped, newMsgCount: workingMessages.length }, logScope)
            round--
            continue
          }
        }

        // 可恢复网络错误：自动重试 + 用户确认
        const isRecoverableNetworkError = (
          msg.includes('ETIMEDOUT') || msg.includes('timeout') || msg.includes('ECONNRESET') ||
          msg.includes('ECONNREFUSED') || msg.includes('fetch failed') || msg.includes('socket hang up') ||
          msg.includes('network') || msg.includes('Request failed') || msg.includes('连接') || msg.includes('超时')
        )

        if (isRecoverableNetworkError) {
          const errorType = (msg.includes('timeout') || msg.includes('超时') || msg.includes('ETIMEDOUT'))
            ? 'timeout' as const : 'network' as const

          autoNetworkRetryCount++
          if (autoNetworkRetryCount <= 5) {
            const delayMs = Math.min(AUTO_RETRY_BASE_DELAY_MS * Math.pow(2, autoNetworkRetryCount - 1), AUTO_RETRY_MAX_DELAY_MS)
            log('AGENT_AUTO_RETRY', { round, autoRetryCount: autoNetworkRetryCount, maxRetries: 5, errorType, delayMs, error: msg }, logScope)
            await sleep(delayMs)
            round--
            continue
          }

          const retryId = `retry-${crypto.randomUUID()}`
          log('AGENT_RETRYABLE_ERROR', { round, retryId, errorType, error: msg, autoRetriesExhausted: true }, logScope)
          onEvent?.({ type: 'retry_confirm', retryId, errorType, errorMessage: `自动重试 ${autoNetworkRetryCount} 次后仍失败：${msg}`, round })

          const shouldRetry = await waitForConfirm(retryId, signal)
          log('AGENT_RETRY_DECISION', { retryId, shouldRetry }, logScope)

          if (signal?.aborted) {
            log('AGENT_ABORTED', { round, reason: 'signal aborted during retry confirm' }, logScope)
            await finalizeAndDone(
              state, workspace, projectId, services?.database,
              lastUserGoal, plainUserQuery, userAssetsBlock,
              normalizedMemorySessionId, normalizedSourceUserMessageId, normalizedSourceAssistantMessageId,
              lastUsageTotalTokens, provider, overrides, contextLength, signal, logScope, log,
              messages, round, onEvent, taskStartedAt, services,
              lastAssistantText, 'aborted',
            )
            return
          }

          if (shouldRetry) { autoNetworkRetryCount = 0; round--; continue }
          await persistTaskCoreLogWithOutcome(
            state, workspace, projectId, services?.database,
            lastUserGoal, plainUserQuery, userAssetsBlock,
            normalizedMemorySessionId, normalizedSourceUserMessageId, normalizedSourceAssistantMessageId,
            lastUsageTotalTokens, provider, overrides, contextLength, signal, logScope, log,
            messages, round, onEvent, taskStartedAt, services,
            textContent || lastAssistantText, 'error', msg,
          )
          onEvent?.({ type: 'error', message: `用户取消重试：${msg}` })
          return
        }

        // 不可恢复错误
        await persistTaskCoreLogWithOutcome(
          state, workspace, projectId, services?.database,
          lastUserGoal, plainUserQuery, userAssetsBlock,
          normalizedMemorySessionId, normalizedSourceUserMessageId, normalizedSourceAssistantMessageId,
          lastUsageTotalTokens, provider, overrides, contextLength, signal, logScope, log,
          messages, round, onEvent, taskStartedAt, services,
          textContent || lastAssistantText, 'error', msg,
        )
        onEvent?.({ type: 'error', message: msg })
        return
      }

      // ─── 无 tool_calls 时的处理 ─────────────────────────────────
      if (toolCalls.length === 0) {
        const directReplyText = textContent.trim()
        if (shouldTryFinalizeDirectTextReply(directReplyText)) {
          pseudoToolCallRejectCount = 0
          log('AGENT_DIRECT_TEXT_REPLY_ATTEMPT', {
            round, intentType: inferIntentTypeFromQuery(lastUserGoal),
            evidenceCount: getExecutionEvidenceCount(),
            rawPreview: rawTextContent.slice(0, 800),
          }, logScope)
          if (await tryFinalizeReply(directReplyText)) return
          round--
          continue
        }

        const hasPseudoToolCallText = containsPseudoToolCallSyntax(rawTextContent)
        if (hasPseudoToolCallText || invalidToolCallNames.length > 0) {
          pseudoToolCallRejectCount++
          enforceStandardToolCall = true
          log('AGENT_STANDARD_TOOL_CALL_REJECTED', {
            round, rejectCount: pseudoToolCallRejectCount,
            hasPseudoToolCallText, invalidToolCallNames,
            rawPreview: rawTextContent.slice(0, 800),
          }, logScope)
          if (pseudoToolCallRejectCount >= 6) {
            const reason = hasPseudoToolCallText
              ? `检测到 [TOOL_CALL] 文本但没有标准 tool_calls，连续出现已达上限(${pseudoToolCallRejectCount})`
              : `非标准工具调用连续出现已达上限(${pseudoToolCallRejectCount})，非法工具名: ${invalidToolCallNames.join(', ')}`
            await persistTaskCoreLogWithOutcome(
              state, workspace, projectId, services?.database,
              lastUserGoal, plainUserQuery, userAssetsBlock,
              normalizedMemorySessionId, normalizedSourceUserMessageId, normalizedSourceAssistantMessageId,
              lastUsageTotalTokens, provider, overrides, contextLength, signal, logScope, log,
              messages, round, onEvent, taskStartedAt, services,
              textContent || lastAssistantText, 'error', reason,
            )
            onEvent?.({ type: 'error', message: reason })
            return
          }
          round--
          continue
        }

        // 空响应自动重试
        const reason = '模型未返回可用文本或标准工具调用。'
        autoEmptyRetryCount++
        if (autoEmptyRetryCount <= 5) {
          const delayMs = Math.min(AUTO_RETRY_BASE_DELAY_MS * Math.pow(2, autoEmptyRetryCount - 1), AUTO_RETRY_MAX_DELAY_MS)
          log('AGENT_AUTO_RETRY_EMPTY', { round, autoRetryCount: autoEmptyRetryCount, maxRetries: 5, delayMs, rawPreview: rawTextContent.slice(0, 200) }, logScope)
          await sleep(delayMs)
          round--
          continue
        }

        const retryId = `retry-${crypto.randomUUID()}`
        log('AGENT_EMPTY_RESPONSE', { round, retryId, rawPreview: rawTextContent.slice(0, 200), autoRetriesExhausted: true }, logScope)
        onEvent?.({ type: 'retry_confirm', retryId, errorType: 'empty_response', errorMessage: `自动重试 ${autoEmptyRetryCount} 次后仍失败：${reason}`, round })

        const shouldRetry = await waitForConfirm(retryId, signal)
        log('AGENT_RETRY_DECISION', { retryId, shouldRetry }, logScope)

        if (signal?.aborted) {
          log('AGENT_ABORTED', { round, reason: 'signal aborted during retry confirm' }, logScope)
          await finalizeAndDone(
            state, workspace, projectId, services?.database,
            lastUserGoal, plainUserQuery, userAssetsBlock,
            normalizedMemorySessionId, normalizedSourceUserMessageId, normalizedSourceAssistantMessageId,
            lastUsageTotalTokens, provider, overrides, contextLength, signal, logScope, log,
            messages, round, onEvent, taskStartedAt, services,
            lastAssistantText, 'aborted',
          )
          return
        }

        if (shouldRetry) { autoEmptyRetryCount = 0; round--; continue }
        await persistTaskCoreLogWithOutcome(
          state, workspace, projectId, services?.database,
          lastUserGoal, plainUserQuery, userAssetsBlock,
          normalizedMemorySessionId, normalizedSourceUserMessageId, normalizedSourceAssistantMessageId,
          lastUsageTotalTokens, provider, overrides, contextLength, signal, logScope, log,
          messages, round, onEvent, taskStartedAt, services,
          textContent || lastAssistantText, 'error', reason,
        )
        onEvent?.({ type: 'error', message: `用户取消重试：${reason}` })
        return
      }

      // ─── 有 tool_calls：处理工具调用 ────────────────────────────
      pseudoToolCallRejectCount = 0
      enforceStandardToolCall = false

      // 追加 assistant tool_calls 消息
      pushAssistantToolCallMessage(workingMessages, toolCalls, rawReasoningContent, toolCallThinking, provider, overrides)
      onEvent?.({ type: 'tool_calls', toolCalls, ...(toolCallThinking ? { thinking: toolCallThinking } : {}) })

      // 笔记工具优先执行（不经过确认）
      const noteToolCalls = filterNoteTools(toolCalls)
      if (noteToolCalls.length > 0) {
        const shouldAbort = await executeNoteTools(noteToolCalls, workspace, signal, logScope, projectId, log, onEvent, workingMessages)
        if (shouldAbort) {
          await finalizeAndDone(
            state, workspace, projectId, services?.database,
            lastUserGoal, plainUserQuery, userAssetsBlock,
            normalizedMemorySessionId, normalizedSourceUserMessageId, normalizedSourceAssistantMessageId,
            lastUsageTotalTokens, provider, overrides, contextLength, signal, logScope, log,
            messages, round, onEvent, taskStartedAt, services,
            lastAssistantText, 'aborted',
          )
          return
        }
        if (noteToolCalls.length === toolCalls.length) continue
        toolCalls = filterNonNoteTools(toolCalls)
      }

      // 计划进度工具优先执行（不经过确认）
      const planProgressCalls = filterPlanProgressTools(toolCalls)
      if (planProgressCalls.length > 0) {
        executePlanProgressTools(planProgressCalls, currentPlan, onEvent, workingMessages)
        if (planProgressCalls.length === toolCalls.length) continue
        toolCalls = filterNonPlanProgressTools(toolCalls)
      }

      // propose_plan 确认流程
      if (toolCalls.some((tc) => tc.function.name === 'propose_plan')) {
        const planRef: { value: CurrentPlan } = { value: currentPlan }
        const result = await handleProposePlan(toolCalls, workingMessages, workspace, signal, logScope, log, onEvent, planRef)
        currentPlan = planRef.value
        if (result === 'abort') {
          await finalizeAndDone(
            state, workspace, projectId, services?.database,
            lastUserGoal, plainUserQuery, userAssetsBlock,
            normalizedMemorySessionId, normalizedSourceUserMessageId, normalizedSourceAssistantMessageId,
            lastUsageTotalTokens, provider, overrides, contextLength, signal, logScope, log,
            messages, round, onEvent, taskStartedAt, services,
            lastAssistantText, 'aborted',
          )
          return
        }
        continue
      }

      // 风险评估
      const riskResult = await handleRiskAssessment(toolCalls, workspace, signal, logScope, log, onEvent, workingMessages)
      if (riskResult === 'abort') {
        await finalizeAndDone(
          state, workspace, projectId, services?.database,
          lastUserGoal, plainUserQuery, userAssetsBlock,
          normalizedMemorySessionId, normalizedSourceUserMessageId, normalizedSourceAssistantMessageId,
          lastUsageTotalTokens, provider, overrides, contextLength, signal, logScope, log,
          messages, round, onEvent, taskStartedAt, services,
          lastAssistantText, 'aborted',
        )
        return
      }
      if (riskResult === 'skip') continue // 用户拒绝 → 进入下一轮让 LLM 处理

      // 中断检查
      if (signal?.aborted) {
        log('AGENT_ABORTED', { round, reason: 'signal aborted before tool execution' }, logScope)
        await finalizeAndDone(
          state, workspace, projectId, services?.database,
          lastUserGoal, plainUserQuery, userAssetsBlock,
          normalizedMemorySessionId, normalizedSourceUserMessageId, normalizedSourceAssistantMessageId,
          lastUsageTotalTokens, provider, overrides, contextLength, signal, logScope, log,
          messages, round, onEvent, taskStartedAt, services,
          lastAssistantText, 'aborted',
        )
        return
      }

      // 执行工具
      trackToolCallsInputs(state, toolCalls)
      const results = await executeAndTrackTools(
        toolCalls, workspace, signal, logScope, projectId,
        allowedToolNames, overrides, services, onEvent, workingMessages,
      )
      if (signal?.aborted) {
        log('AGENT_ABORTED', { round, reason: 'signal aborted during tool execution' }, logScope)
        await finalizeAndDone(
          state, workspace, projectId, services?.database,
          lastUserGoal, plainUserQuery, userAssetsBlock,
          normalizedMemorySessionId, normalizedSourceUserMessageId, normalizedSourceAssistantMessageId,
          lastUsageTotalTokens, provider, overrides, contextLength, signal, logScope, log,
          messages, round, onEvent, taskStartedAt, services,
          lastAssistantText, 'aborted',
        )
        return
      }
      trackFileChanges(state, results)
      trackToolResultsCore(state, workspace, results)
    }

    // 超出最大轮次
    await persistTaskCoreLogWithOutcome(
      state, workspace, projectId, services?.database,
      lastUserGoal, plainUserQuery, userAssetsBlock,
      normalizedMemorySessionId, normalizedSourceUserMessageId, normalizedSourceAssistantMessageId,
      lastUsageTotalTokens, provider, overrides, contextLength, signal, logScope, log,
      messages, round, onEvent, taskStartedAt, services,
      lastAssistantText, 'error', `Agent exceeded max tool rounds (${MAX_TOOL_ROUNDS})`,
    )
    onEvent?.({ type: 'error', message: `Agent 循环次数过多(${MAX_TOOL_ROUNDS}次),已自动终止,请检查任务是否合理` })
    clearTimeout(loopTimeoutTimer)
  } finally {
    restoreEnv()
    clearTimeout(loopTimeoutTimer)
  }
}
