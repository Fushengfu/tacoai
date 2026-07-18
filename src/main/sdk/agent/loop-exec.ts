/**
 * Agent 循环 - 工具执行编排
 *
 * 包含 propose_plan 确认流程、笔记/计划进度工具优先执行、风险评估。
 * 所有函数通过参数接收状态，不持有模块级可变状态。
 */

import type { ChatMessage, ProviderOverrides } from './llm/client'
import type { ProviderKey } from './llm/client'
import type { ToolCall, ToolResult, RiskInfo } from './tools'
import type { AgentEvent } from './types'
import type { PlanStepStatus } from './types'
import { executeToolCalls, assessToolCallsRisk, setBrowserAutoApproved, setDesktopAutoApproved, getGlobalAuthLevel } from './tools'
import { sanitizeReasoningForContext } from './shared/sanitize'
import { waitForConfirm, isAbortError } from './error-handler'
import { truncateToolResultForContext } from './context/compressor'
import { extractTextFromContent } from './llm/adapter'

/* ------------------------------------------------------------------ */
/*  笔记工具优先执行（不经过确认）                                      */
/* ------------------------------------------------------------------ */

const NOTE_TOOLS = new Set(['save_note', 'delete_note'])

export function filterNoteTools(toolCalls: ToolCall[]): ToolCall[] {
  return toolCalls.filter((tc) => NOTE_TOOLS.has(tc.function.name))
}

export function filterNonNoteTools(toolCalls: ToolCall[]): ToolCall[] {
  return toolCalls.filter((tc) => !NOTE_TOOLS.has(tc.function.name))
}

export async function executeNoteTools(
  noteToolCalls: ToolCall[],
  workspace: string,
  signal: AbortSignal | undefined,
  logScope: string | undefined,
  projectId: string | undefined,
  log: (...args: any[]) => void,
  onEvent: ((event: AgentEvent) => void) | undefined,
  workingMessages: ChatMessage[],
): Promise<boolean> {
  if (noteToolCalls.length === 0) return false

  const noteResults = await executeToolCalls(noteToolCalls, workspace, signal, logScope, projectId)
  if (signal?.aborted) {
    log('AGENT_ABORTED', { reason: 'signal aborted during note tools' }, logScope)
    return true // signal caller to abort
  }
  onEvent?.({ type: 'tool_results', results: noteResults })
  for (const result of noteResults) {
    workingMessages.push({
      role: 'tool',
      content: result.content,
      tool_call_id: result.tool_call_id,
    })
  }
  return false
}

/* ------------------------------------------------------------------ */
/*  计划进度更新工具优先执行（不经过确认）                              */
/* ------------------------------------------------------------------ */

export function filterPlanProgressTools(toolCalls: ToolCall[]): ToolCall[] {
  return toolCalls.filter((tc) => tc.function.name === 'update_plan_progress')
}

export function filterNonPlanProgressTools(toolCalls: ToolCall[]): ToolCall[] {
  return toolCalls.filter((tc) => tc.function.name !== 'update_plan_progress')
}

export function executePlanProgressTools(
  planProgressCalls: ToolCall[],
  currentPlan: CurrentPlan,
  onEvent: ((event: AgentEvent) => void) | undefined,
  workingMessages: ChatMessage[],
) {
  for (const tc of planProgressCalls) {
    try {
      const args = JSON.parse(tc.function.arguments)
      const stepIndex = args.stepIndex as number
      const status = args.status as PlanStepStatus
      const note = args.note as string | undefined

      if (currentPlan) {
        const step = currentPlan.steps.find((s) => s.index === stepIndex)
        if (step) {
          step.status = status
          if (note) step.note = note
        }
      }

      onEvent?.({ type: 'plan_progress', stepIndex, status, note })

      const resultContent = `步骤 ${stepIndex} 状态已更新为「${status}」${note ? `：${note}` : ''}`
      onEvent?.({ type: 'tool_results', results: [{ tool_call_id: tc.id, name: tc.function.name, content: resultContent, success: true }] })
      workingMessages.push({ role: 'tool', content: resultContent, tool_call_id: tc.id })
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      onEvent?.({ type: 'tool_results', results: [{ tool_call_id: tc.id, name: tc.function.name, content: `更新失败: ${errMsg}`, success: false }] })
      workingMessages.push({ role: 'tool', content: `更新失败: ${errMsg}`, tool_call_id: tc.id })
    }
  }
}

/* ------------------------------------------------------------------ */
/*  propose_plan 确认流程                                              */
/* ------------------------------------------------------------------ */

export async function handleProposePlan(
  toolCalls: ToolCall[],
  workingMessages: ChatMessage[],
  workspace: string,
  signal: AbortSignal | undefined,
  logScope: string | undefined,
  log: (...args: any[]) => void,
  onEvent: ((event: AgentEvent) => void) | undefined,
  currentPlanRef: { value: CurrentPlan },
): Promise<'continue' | 'abort'> {
  const planCall = toolCalls.find((tc) => tc.function.name === 'propose_plan')!
  const confirmId = `plan-${crypto.randomUUID()}`
  log('AGENT_PLAN', { confirmId, plan: planCall.function.arguments }, logScope)

  let approved: boolean

  if (getGlobalAuthLevel() === 'auto') {
    log('AGENT_PLAN_AUTO_APPROVED', { confirmId, reason: 'auto mode' }, logScope)
    approved = true
  } else {
    const planRisks: RiskInfo[] = [{
      toolCallId: planCall.id,
      toolName: 'propose_plan',
      level: 'warning',
      reason: '执行计划需要确认',
      detail: planCall.function.arguments,
    }]
    onEvent?.({ type: 'confirm', confirmId, toolCalls: [planCall], risks: planRisks })

    approved = await waitForConfirm(confirmId, signal)
    log('AGENT_PLAN_CONFIRM', { confirmId, approved }, logScope)
  }

  if (signal?.aborted) {
    log('AGENT_ABORTED', { reason: 'signal aborted during plan confirm' }, logScope)
    return 'abort'
  }

  if (!approved) {
    currentPlanRef.value = null
    const deniedResults: ToolResult[] = toolCalls.map((tc) => ({
      tool_call_id: tc.id,
      name: tc.function.name,
      content: tc.function.name === 'propose_plan'
        ? '你提出的执行计划被用户拒绝。你必须立即停止当前所有操作：禁止调用任何执行类工具（write_file、edit_file、delete_file、run_command、terminal_run 等），只允许只读工具。只输出询问文本，向用户确认具体需要如何调整计划，等待用户明确回复后再重新制定方案。禁止以任何理由绕过确认直接执行。'
        : '计划未获批准，此操作被取消。',
      success: false,
    }))
    onEvent?.({ type: 'tool_results', results: deniedResults })

    for (const result of deniedResults) {
      workingMessages.push({ role: 'tool', content: result.content, tool_call_id: result.tool_call_id })
    }
    return 'continue'
  }

  // 用户确认 → 解析并存储计划
  try {
    const planArgs = JSON.parse(planCall.function.arguments)
    const rawSteps: unknown[] = Array.isArray(planArgs.steps) ? planArgs.steps : []
    const steps: Array<{ index: number; title: string; content: string }> = rawSteps.map((s, idx) => {
      if (s && typeof s === 'object') {
        const obj = s as Record<string, unknown>
        return {
          index: typeof obj.index === 'number' ? obj.index : idx + 1,
          title: String(obj.title || obj.text || `步骤 ${idx + 1}`),
          content: String(obj.content || obj.text || ''),
        }
      }
      return { index: idx + 1, title: `步骤 ${idx + 1}`, content: String(s) }
    }).filter((s) => s.content || s.title)

    const validSteps = steps.filter((s) => s.title && s.content)
    if (validSteps.length === 0) {
      log('PLAN_INIT_EMPTY_STEPS', { rawCount: rawSteps.length, filteredCount: steps.length }, logScope)
      const invalidPlanError: ToolResult = {
        tool_call_id: planCall.id,
        name: 'propose_plan',
        content: 'propose_plan 失败：steps 数组为空或所有步骤都缺少 title/content。每个步骤必须同时具有 index、title、content 三个字段。请重新调用 propose_plan 并提供有效步骤。',
        success: false,
      }
      onEvent?.({ type: 'tool_results', results: [invalidPlanError] })
      workingMessages.push({ role: 'tool', content: invalidPlanError.content, tool_call_id: planCall.id })
      return 'continue'
    }

    currentPlanRef.value = {
      summary: planArgs.summary || '',
      reasoning: planArgs.reasoning,
      steps: validSteps.map((s) => ({ ...s, status: 'pending' as PlanStepStatus })),
    }
    onEvent?.({ type: 'plan_init', summary: currentPlanRef.value.summary, steps: validSteps, reasoning: currentPlanRef.value.reasoning })
    log('PLAN_INIT', { summary: currentPlanRef.value.summary, stepCount: validSteps.length }, logScope)
  } catch (e) {
    log('PLAN_INIT_PARSE_FAIL', { error: e instanceof Error ? e.message : String(e) }, logScope)
  }

  // 构建计划确认结果
  const planResult: ToolResult = {
    tool_call_id: planCall.id,
    name: 'propose_plan',
    content: '用户已确认此执行计划，请按照计划开始执行。请在开始执行每个步骤前调用 update_plan_progress(stepIndex, "in_progress")，完成后调用 update_plan_progress(stepIndex, "done")，以便用户实时看到执行进度。',
    success: true,
  }

  if (toolCalls.length === 1) {
    onEvent?.({ type: 'tool_results', results: [planResult] })
    workingMessages.push({ role: 'tool', content: planResult.content, tool_call_id: planResult.tool_call_id })
    return 'continue'
  }

  // 如果同时有其他工具调用：禁止在计划确认回合直接执行
  const otherToolCalls = toolCalls.filter((tc) => tc.function.name !== 'propose_plan')
  const deferredResults: ToolResult[] = otherToolCalls.map((tc) => ({
    tool_call_id: tc.id,
    name: tc.function.name,
    content: '该操作未执行：执行计划刚被确认，请在下一轮基于已确认计划重新发起工具调用。',
    success: false,
  }))
  const allResults = [planResult, ...deferredResults]
  onEvent?.({ type: 'tool_results', results: allResults })

  workingMessages.push({ role: 'tool', content: planResult.content, tool_call_id: planResult.tool_call_id })
  for (const result of deferredResults) {
    workingMessages.push({ role: 'tool', content: result.content, tool_call_id: result.tool_call_id })
  }
  return 'continue'
}

/* ------------------------------------------------------------------ */
/*  风险评估与用户确认                                                 */
/* ------------------------------------------------------------------ */

export async function handleRiskAssessment(
  toolCalls: ToolCall[],
  workspace: string,
  signal: AbortSignal | undefined,
  logScope: string | undefined,
  log: (...args: any[]) => void,
  onEvent: ((event: AgentEvent) => void) | undefined,
  workingMessages: ChatMessage[],
): Promise<'execute' | 'skip' | 'abort'> {
  const risks = assessToolCallsRisk(toolCalls, workspace)

  if (risks.length === 0) return 'execute'

  const confirmId = `confirm-${crypto.randomUUID()}`
  log('AGENT_RISK', { confirmId, risks }, logScope)
  onEvent?.({ type: 'confirm', confirmId, toolCalls, risks })

  const approved = await waitForConfirm(confirmId, signal)
  log('AGENT_CONFIRM', { confirmId, approved }, logScope)

  if (signal?.aborted) {
    log('AGENT_ABORTED', { reason: 'signal aborted during risk confirm' }, logScope)
    return 'abort'
  }

  if (!approved) {
    const deniedBrowserOps = toolCalls.some((tc) => tc.function.name.startsWith('browser_'))
    const deniedDesktopOps = toolCalls.some((tc) => tc.function.name.startsWith('desktop_'))
    if (deniedBrowserOps) {
      setBrowserAutoApproved(false)
      log('BROWSER_AUTO_APPROVED_RESET', { reason: 'user denied browser operation' }, logScope)
    }
    if (deniedDesktopOps) {
      setDesktopAutoApproved(false)
      log('DESKTOP_AUTO_APPROVED_RESET', { reason: 'user denied desktop operation' }, logScope)
    }

    const deniedResults: ToolResult[] = toolCalls.map((tc) => ({
      tool_call_id: tc.id,
      name: tc.function.name,
      content: '用户拒绝了此操作。你必须立即停止当前所有执行类工具调用（write_file、edit_file、delete_file、run_command、terminal_run 等）。只输出询问文本，向用户确认替代方案或重新请求许可。在用户明确同意前禁止直接执行。',
      success: false,
    }))
    onEvent?.({ type: 'tool_results', results: deniedResults })

    for (const result of deniedResults) {
      workingMessages.push({ role: 'tool', content: result.content, tool_call_id: result.tool_call_id })
    }
    return 'skip'
  }

  // 用户确认后自动放行同类操作
  const hasBrowserRisk = risks.some((r) => r.toolName.startsWith('browser_'))
  if (hasBrowserRisk) {
    setBrowserAutoApproved(true)
    log('BROWSER_AUTO_APPROVED', { msg: '用户已确认浏览器操作，后续自动放行' }, logScope)
  }
  const hasDesktopRisk = risks.some((r) => r.toolName.startsWith('desktop_'))
  if (hasDesktopRisk) {
    setDesktopAutoApproved(true)
    log('DESKTOP_AUTO_APPROVED', { msg: '用户已确认电脑操作，后续自动放行' }, logScope)
  }

  return 'execute'
}

/* ------------------------------------------------------------------ */
/*  工具执行 + 结果处理                                                */
/* ------------------------------------------------------------------ */

export async function executeAndTrackTools(
  toolCalls: ToolCall[],
  workspace: string,
  signal: AbortSignal | undefined,
  logScope: string | undefined,
  projectId: string | undefined,
  allowedToolNames: Set<string>,
  overrides: ProviderOverrides | undefined,
  services: any,
  onEvent: ((event: AgentEvent) => void) | undefined,
  workingMessages: ChatMessage[],
): Promise<ToolResult[]> {
  const results = await executeToolCalls(toolCalls, workspace, signal, logScope, projectId, {
    allowedToolNames,
    overrides,
    services,
  })
  if (signal?.aborted) return results

  onEvent?.({ type: 'tool_results', results })

  for (const result of results) {
    workingMessages.push({
      role: 'tool',
      content: truncateToolResultForContext(result),
      tool_call_id: result.tool_call_id,
    })
  }

  return results
}

/* ------------------------------------------------------------------ */
/*  assistant tool_calls 消息构建                                      */
/* ------------------------------------------------------------------ */

export function pushAssistantToolCallMessage(
  workingMessages: ChatMessage[],
  toolCalls: ToolCall[],
  rawReasoningContent: string,
  toolCallThinking: string,
  provider: ProviderKey,
  overrides: ProviderOverrides | undefined,
) {
  const sanitizedReasoningForToolCall = sanitizeReasoningForContext(rawReasoningContent).trim()
  const reasoningForToolCall =
    sanitizedReasoningForToolCall
    || sanitizeReasoningForContext(toolCallThinking).trim()
  const assistantToolCallContent = ''
  const assistantToolCallMessage: ChatMessage & { reasoning_content?: string } = {
    role: 'assistant',
    content: assistantToolCallContent,
    tool_calls: toolCalls,
  }
  const modelSupportsReasoning = overrides?.[provider]?.supportsReasoning ?? true
  if (modelSupportsReasoning) {
    assistantToolCallMessage.reasoning_content = reasoningForToolCall || '继续'
  }
  workingMessages.push(assistantToolCallMessage)
}

// 类型定义（当前计划的状态引用）
export type CurrentPlan = {
  summary: string
  reasoning?: string
  steps: Array<{ index: number; title: string; content: string; status: PlanStepStatus; note?: string }>
} | null
