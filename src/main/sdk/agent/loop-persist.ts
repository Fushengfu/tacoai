/**
 * Agent 循环 - 任务持久化
 *
 * 包含任务记忆保存、自动 Git 提交、奖励评分、Agent 结束收尾。
 * 所有函数通过参数接收状态，不持有模块级可变状态。
 */

import type { ChatMessage, ProviderOverrides } from './llm/client'
import type { ProviderKey } from './llm/client'
import type { ToolCall, ToolResult } from './tools'
import type { AgentEvent } from './types'
import type { PlanStepStatus } from './types'
import type { RecallMeta } from './memory/memory-recall'
import { gitCommit, gitEnsureRepo } from './git/service'
import { isAutoCommitEnabled } from './tools'
import { maintainTaskMemoriesByAI, recordTaskLog } from './memory/'
import { applyRewardScore } from './reward'
import { extractTextFromContent } from './llm/adapter'
import {
  extractUserQueryText,
  collectUserMediaRefsFromContent,
  collectUserMediaRefsFromMessages,
  appendMediaRefsToSummary,
} from './shared/user-assets'
import {
  stripInternalContextTags,
  stripPseudoToolCallArtifacts,
} from './shared/sanitize'
import type { TrackState } from './loop-track'
import { isVerificationPlanStep } from './loop-track'

/* ------------------------------------------------------------------ */
/*  工具函数                                                           */
/* ------------------------------------------------------------------ */

function cleanupAssistantText(text: string): string {
  return stripPseudoToolCallArtifacts(
    stripInternalContextTags(String(text ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '')),
  ).trim()
}

export function shouldPersistTaskCoreLog(): { persist: boolean; reason: string } {
  return { persist: true, reason: 'always_persist_each_query' }
}

/* ------------------------------------------------------------------ */
/*  自动 Git 提交                                                      */
/* ------------------------------------------------------------------ */

export async function autoCommit(
  workspace: string,
  projectId: string | undefined,
  database: any,
  messages: ChatMessage[],
  round: number,
  log: (...args: any[]) => void,
  logScope: string | undefined,
  onEvent: ((event: AgentEvent) => void) | undefined,
): Promise<string | undefined> {
  if (!isAutoCommitEnabled(projectId || '', database)) return undefined

  try {
    await gitEnsureRepo(workspace)
  } catch (err) {
    log('GIT_INIT_FAIL', { error: err instanceof Error ? err.message : String(err) }, logScope)
    return undefined
  }

  // 从消息历史中提取最后一条用户消息作为提交摘要
  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')
  const contentText = lastUserMsg
    ? (typeof lastUserMsg.content === 'string' ? lastUserMsg.content : extractTextFromContent(lastUserMsg.content))
    : ''
  const plainUserSummary = extractUserQueryText(contentText)
  const summary = plainUserSummary
    ? plainUserSummary.replace(/[\n\r]+/g, ' ').slice(0, 60)
    : `Agent round ${round}`
  try {
    const hash = await gitCommit(workspace, summary)
    if (hash) {
      log('GIT_COMMIT', { hash, message: summary }, logScope)
      onEvent?.({ type: 'git_commit', hash, message: summary })
    }
    return hash ?? undefined
  } catch (err) {
    log('GIT_COMMIT_FAIL', { error: err instanceof Error ? err.message : String(err) }, logScope)
    return undefined
  }
}

/* ------------------------------------------------------------------ */
/*  任务日志持久化                                                     */
/* ------------------------------------------------------------------ */

export async function persistTaskCoreLog(
  state: TrackState,
  workspace: string,
  projectId: string | undefined,
  lastUserGoal: string,
  plainUserQuery: string,
  userAssetsBlock: string,
  finalSummary: string,
  normalizedMemorySessionId: string,
  normalizedSourceUserMessageId: string,
  normalizedSourceAssistantMessageId: string,
  lastUsageTotalTokens: number | undefined,
  provider: ProviderKey,
  overrides: ProviderOverrides | undefined,
  contextLength: number | undefined,
  signal: AbortSignal | undefined,
  logScope: string | undefined,
  log: (...args: any[]) => void,
  outcome: 'success' | 'aborted' | 'error' = 'success',
): Promise<void> {
  log('TASK_PERSIST_CHECK', {
    workspace: workspace ? `[${workspace}]` : '(empty)',
    projectId: projectId ? `[${projectId}]` : '(empty)',
    outcome,
    summaryLength: finalSummary?.length || 0,
  }, logScope)

  if ((!workspace || !workspace.trim()) && (!projectId || !projectId.trim())) {
    log('TASK_PERSIST_SKIPPED_NO_SCOPE', { workspace, projectId }, logScope)
    return
  }
  const decision = shouldPersistTaskCoreLog()
  if (!decision.persist) {
    log('TASK_CORE_NOTE_SKIPPED', { reason: decision.reason, goal: lastUserGoal }, logScope)
    return
  }
  const { toolUsageCount, changedFiles, touchedFiles, failureLogs } = state
  const tools = [...toolUsageCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name} x${count}`)
  const modifiedFiles = changedFiles.size > 0 ? [...changedFiles] : [...touchedFiles]
  try {
    const userMediaRefs = collectUserMediaRefsFromContent(lastUserGoal)
    const summaryWithMediaRefs = appendMediaRefsToSummary(finalSummary, userMediaRefs)

    const savedTaskMemory = await recordTaskLog(
      workspace,
      {
        userQuery: plainUserQuery || lastUserGoal,
        ...(userAssetsBlock ? { userAssetsBlock } : {}),
        assistantResult: summaryWithMediaRefs,
        outcome,
        tools,
        changedFiles: modifiedFiles.slice(0, 80),
        fileDiffs: [],
        failures: failureLogs.slice(0, 12),
        sourceRef: {
          ...(normalizedMemorySessionId ? { sessionId: normalizedMemorySessionId } : {}),
          ...(normalizedSourceUserMessageId ? { userMessageId: normalizedSourceUserMessageId } : {}),
          ...(normalizedSourceAssistantMessageId ? { assistantMessageId: normalizedSourceAssistantMessageId } : {}),
        },
      },
      projectId,
    )
    if (savedTaskMemory) {
      try {
        await maintainTaskMemoriesByAI(workspace, projectId, {
          provider,
          overrides,
          usageTotalTokens: lastUsageTotalTokens,
          contextLength,
          signal,
          logScope,
        })
      } catch (err) {
        log('TASK_MEMORY_MAINTAIN_FAIL', { error: err instanceof Error ? err.message : String(err) }, logScope)
      }
    }
    log('TASK_CORE_NOTE_SAVED', {
      reason: decision.reason,
      toolKinds: tools.length,
      fileCount: modifiedFiles.length,
      persisted: Boolean(savedTaskMemory),
    }, logScope)
  } catch (err) {
    log('TASK_CORE_NOTE_SAVE_FAIL', { error: err instanceof Error ? err.message : String(err) }, logScope)
  }
}

/* ------------------------------------------------------------------ */
/*  Agent 收尾                                                         */
/* ------------------------------------------------------------------ */

export async function persistTaskCoreLogWithOutcome(
  state: TrackState,
  workspace: string,
  projectId: string | undefined,
  database: any,
  lastUserGoal: string,
  plainUserQuery: string,
  userAssetsBlock: string,
  normalizedMemorySessionId: string,
  normalizedSourceUserMessageId: string,
  normalizedSourceAssistantMessageId: string,
  lastUsageTotalTokens: number | undefined,
  provider: ProviderKey,
  overrides: ProviderOverrides | undefined,
  contextLength: number | undefined,
  signal: AbortSignal | undefined,
  logScope: string | undefined,
  log: (...args: any[]) => void,
  messages: ChatMessage[],
  round: number,
  onEvent: ((event: AgentEvent) => void) | undefined,
  taskStartedAt: number,
  services: any,
  summaryText: string,
  outcome: 'success' | 'aborted' | 'error',
  errorMessage?: string,
): Promise<void> {
  await autoCommit(workspace, projectId, database, messages, round, log, logScope, onEvent)
  const cleanedSummary = cleanupAssistantText(summaryText)
  const finalSummary = (errorMessage
    ? [cleanedSummary, `错误信息: ${errorMessage}`].filter(Boolean).join('\n')
    : cleanedSummary
  ) || (outcome === 'aborted' ? '(任务中止，未产出最终文本)' : '(无最终文本)')
  await persistTaskCoreLog(
    state, workspace, projectId, lastUserGoal, plainUserQuery, userAssetsBlock,
    finalSummary,
    normalizedMemorySessionId, normalizedSourceUserMessageId, normalizedSourceAssistantMessageId,
    lastUsageTotalTokens, provider, overrides, contextLength, signal, logScope, log, outcome,
  )

  try {
    const { toolUsageCount, changedFiles, failureLogs } = state
    const toolCalls = [...toolUsageCount.values()].reduce((sum, count) => sum + count, 0)
    await applyRewardScore({
      outcome,
      workspace,
      projectId,
      requestId: `${projectId || workspace || 'global'}:${Date.now()}`,
      toolCalls,
      changedFiles: changedFiles.size,
      failures: failureLogs.length + (errorMessage ? 1 : 0),
      elapsedMs: Math.max(0, Date.now() - taskStartedAt),
    }, services?.fsProvider ?? { getUserDataPath: () => '', getHomeDir: () => '', trashFile: async () => {} })
  } catch (err) {
    log('REWARD_SCORE_APPLY_FAIL', { error: err instanceof Error ? err.message : String(err) }, logScope)
  }
}

export async function finalizeAndDone(
  state: TrackState,
  workspace: string,
  projectId: string | undefined,
  database: any,
  lastUserGoal: string,
  plainUserQuery: string,
  userAssetsBlock: string,
  normalizedMemorySessionId: string,
  normalizedSourceUserMessageId: string,
  normalizedSourceAssistantMessageId: string,
  lastUsageTotalTokens: number | undefined,
  provider: ProviderKey,
  overrides: ProviderOverrides | undefined,
  contextLength: number | undefined,
  signal: AbortSignal | undefined,
  logScope: string | undefined,
  log: (...args: any[]) => void,
  messages: ChatMessage[],
  round: number,
  onEvent: ((event: AgentEvent) => void) | undefined,
  taskStartedAt: number,
  services: any,
  summaryText: string,
  outcome: 'success' | 'aborted' = 'success',
  finalText?: string,
): Promise<void> {
  try {
    await persistTaskCoreLogWithOutcome(
      state, workspace, projectId, database, lastUserGoal, plainUserQuery, userAssetsBlock,
      normalizedMemorySessionId, normalizedSourceUserMessageId, normalizedSourceAssistantMessageId,
      lastUsageTotalTokens, provider, overrides, contextLength, signal, logScope, log,
      messages, round, onEvent, taskStartedAt, services,
      summaryText, outcome,
    )
  } catch (err) {
    log('FINALIZE_PERSIST_FAIL', { error: err instanceof Error ? err.message : String(err) }, logScope)
  }
  onEvent?.({ type: 'done', finalText: outcome === 'success' ? finalText : undefined })
}

/* ------------------------------------------------------------------ */
/*  计划步骤收尾                                                       */
/* ------------------------------------------------------------------ */

export function finalizePendingPlanStepsIfNeeded(
  currentPlan: { summary: string; reasoning?: string; steps: Array<{ index: number; title: string; content: string; status: PlanStepStatus; note?: string }> } | null,
  successfulRunCommandCount: number,
  successfulRunCommandSummaries: string[],
  onEvent: ((event: AgentEvent) => void) | undefined,
) {
  const finalPlan = currentPlan
  const unfinishedPlanSteps = finalPlan
    ? finalPlan.steps.filter((step) => step.status === 'pending' || step.status === 'in_progress')
    : []
  if (!finalPlan || unfinishedPlanSteps.length === 0) return

  for (const step of unfinishedPlanSteps) {
    const autoDone = isVerificationPlanStep(step.title || step.content) && successfulRunCommandCount > 0
    const status: PlanStepStatus = autoDone ? 'done' : 'failed'
    const evidenceText = successfulRunCommandSummaries.length > 0
      ? `；证据命令: ${successfulRunCommandSummaries.join('、')}`
      : ''
    const note = autoDone
      ? `本轮结束前未显式更新该步骤状态；检测到成功的 run_command 验证证据，系统自动补记为 done（原状态: ${step.status}）${evidenceText}`
      : `本轮结束前未更新该步骤状态，系统自动标记为 failed（原状态: ${step.status}）`
    step.status = status
    step.note = note
    onEvent?.({ type: 'plan_progress', stepIndex: step.index, status, note })
  }
}
