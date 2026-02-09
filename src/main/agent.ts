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

import type { ChatMessage, ProviderOverrides } from './llm'
import type { ProviderKey } from './llm'
import { requestChatCompletion, requestStreamWithTools } from './llm'
import { getAllToolDefinitions, executeToolCalls, assessToolCallsRisk, setBrowserAutoApproved, getWorkspaceTree } from './tools'
import type { ToolCall, ToolResult, RiskInfo } from './tools'
import { log } from './logger'
import { gitCommit, gitEnsureRepo } from './git'
import { getActiveSkillInstructions } from './skills'
import { getNotesPromptBlock } from './notes'

/* ------------------------------------------------------------------ */
/*  Agent 事件                                                         */
/* ------------------------------------------------------------------ */

import type { PlanStepStatus } from '../shared/ipc'

export type AgentEvent =
  /** 文本流片段 */
  | { type: 'text'; content: string }
  /** AI 决定调用工具 */
  | { type: 'tool_calls'; toolCalls: ToolCall[] }
  /** 风险操作需要用户确认 */
  | { type: 'confirm'; confirmId: string; toolCalls: ToolCall[]; risks: RiskInfo[] }
  /** 工具执行结果 */
  | { type: 'tool_results'; results: ToolResult[] }
  /** Git 自动提交完成 */
  | { type: 'git_commit'; hash: string; message: string }
  /** 计划初始化（用户确认后） */
  | { type: 'plan_init'; summary: string; steps: string[]; reasoning?: string }
  /** 计划步骤进度更新 */
  | { type: 'plan_progress'; stepIndex: number; status: PlanStepStatus; note?: string }
  /** Agent 循环完成 */
  | { type: 'done' }
  /** 错误 */
  | { type: 'error'; message: string }

/* ------------------------------------------------------------------ */
/*  确认等待机制                                                        */
/* ------------------------------------------------------------------ */

/** 待处理的确认请求：confirmId → resolve(approved) */
const pendingConfirms = new Map<string, (approved: boolean) => void>()

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return err.name === 'AbortError' || err.message === 'AbortError' || err.message === 'Aborted'
}

/** 外部调用：用户响应了确认请求 */
export function resolveConfirm(confirmId: string, approved: boolean) {
  const resolver = pendingConfirms.get(confirmId)
  if (resolver) {
    resolver(approved)
    pendingConfirms.delete(confirmId)
  }
}

/** 创建一个确认请求并等待用户响应 */
function waitForConfirm(confirmId: string, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    pendingConfirms.set(confirmId, resolve)
    // 如果 signal 已被中断，立即 resolve(false) 以跳出等待
    if (signal?.aborted) {
      pendingConfirms.delete(confirmId)
      resolve(false)
      return
    }
    const onAbort = () => {
      pendingConfirms.delete(confirmId)
      resolve(false)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/* ------------------------------------------------------------------ */
/*  Agent 运行                                                         */
/* ------------------------------------------------------------------ */

const MAX_TOOL_ROUNDS = 1000 // 防止无限循环
let confirmCounter = 0

/* ------------------------------------------------------------------ */
/*  Token 估算 & AI 摘要压缩                                             */
/* ------------------------------------------------------------------ */

/** 粗略估算字符串的 token 数 */
function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length
  const other = text.length - cjk
  return Math.ceil(cjk * 1.2 + other * 0.25)
}

/** 单条消息内容的最大字符数（超过则截断，约 8K tokens） */
const MAX_SINGLE_MSG_CHARS = 32000

/**
 * 调用 LLM 为一组早期消息生成摘要。
 *
 * 将待压缩的消息序列化成文本交给 AI，让 AI 提炼出关键信息，
 * 包括：用户意图、已完成的操作、关键文件变更、发现的问题等。
 */
async function summarizeMessages(
  provider: ProviderKey,
  overrides: ProviderOverrides | undefined,
  messagesToSummarize: ChatMessage[],
  signal?: AbortSignal,
  logScope?: string,
): Promise<string> {
  // 将消息序列化为可读文本
  const lines: string[] = []
  for (const m of messagesToSummarize) {
    const role = m.role === 'assistant' ? 'AI助手'
      : m.role === 'user' ? '用户'
      : m.role === 'tool' ? '工具结果'
      : '系统'
    // 对超长内容进行截断以控制摘要请求自身的 token 量
    const content = m.content.length > 8000
      ? m.content.slice(0, 8000) + '...[截断]'
      : m.content
    lines.push(`[${role}] ${content}`)
  }

  const conversationText = lines.join('\n\n')

  const summaryPrompt: ChatMessage[] = [
    {
      role: 'system',
      content: `你是一个对话摘要助手。你需要将一段 AI Agent 的对话历史压缩成精炼的摘要。

要求：
1. 保留所有关键信息：用户的原始需求、AI已完成的操作步骤、修改的文件列表、遇到的问题和解决方案
2. 保留重要的技术细节：文件路径、函数名、配置项、命令等
3. 保留当前的工作进展和待办事项
4. 使用结构化格式，条理清晰
5. 摘要长度控制在 1500 字以内
6. 使用中文输出`,
    },
    {
      role: 'user',
      content: `请将以下对话历史压缩成精炼的摘要：\n\n${conversationText}`,
    },
  ]

  try {
    const summary = await requestChatCompletion(provider, summaryPrompt, overrides, signal, logScope)
    return summary
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) throw err
    log('SUMMARIZE_FAIL', { error: err instanceof Error ? err.message : String(err) }, logScope)
    // 摘要失败时回退为简单文本拼接
    return messagesToSummarize.map((m) => {
      const tag = m.role === 'assistant' ? 'AI' : m.role === 'user' ? 'User' : m.role
      return `[${tag}] ${m.content.slice(0, 200)}`
    }).join('\n')
  }
}

/**
 * Agent 循环内的上下文 AI 摘要压缩。
 *
 * 策略（多层递进）：
 * 1. 截断超长的单条消息（tool results / assistant 文本）
 * 2. 如果总 token 仍超预算 → 提取要压缩的旧消息 → 调用 AI 生成摘要 → 替换
 * 3. 始终保留 system prompt（第 0 条）和最近 N 条消息
 *
 * @returns  被压缩替换的消息数（0 表示无需压缩）
 */
async function compressAgentContext(
  msgs: ChatMessage[],
  tokenBudget: number,
  provider: ProviderKey,
  overrides: ProviderOverrides | undefined,
  signal?: AbortSignal,
  logScope?: string,
): Promise<number> {
  const threshold = Math.floor(tokenBudget * 0.70) // 留 30% 给回复

  // ── 第一步：截断超长的单条消息 ──
  for (let i = 1; i < msgs.length; i++) {
    const m = msgs[i]
    if (m.content && m.content.length > MAX_SINGLE_MSG_CHARS) {
      const truncated = m.content.slice(0, MAX_SINGLE_MSG_CHARS)
      msgs[i] = { ...m, content: truncated + '\n\n[...内容已截断以适配上下文窗口]' }
    }
  }

  // ── 第二步：计算总 token ──
  let total = msgs.reduce((s, m) => s + estimateTokens(m.content), 0)
  if (total <= threshold) return 0

  // ── 第三步：确定要压缩的消息范围 ──
  // 保留: msgs[0] (system) + 最近 minKeep 条
  const minKeep = Math.min(8, msgs.length - 1)
  const compressEnd = msgs.length - minKeep // 压缩 msgs[1..compressEnd)
  if (compressEnd <= 1) return 0 // 没有可压缩的消息

  const toCompress = msgs.slice(1, compressEnd)
  const compressCount = toCompress.length

  log('AGENT_CONTEXT_SUMMARIZE_START', {
    totalTokens: total,
    budget: tokenBudget,
    compressCount,
    keepCount: minKeep,
  }, logScope)

  // ── 第四步：调用 AI 生成摘要 ──
  const summary = await summarizeMessages(provider, overrides, toCompress, signal, logScope)

  // ── 第五步：用摘要替换旧消息 ──
  const summaryMsg: ChatMessage = {
    role: 'system',
    content: `[对话历史摘要 — 以下是之前 ${compressCount} 条消息的 AI 总结]\n\n${summary}\n\n[摘要结束 — 请基于以上摘要和后续的最新消息继续工作]`,
  }

  // 移除 msgs[1..compressEnd) 并插入摘要
  msgs.splice(1, compressCount, summaryMsg)

  const newTotal = msgs.reduce((s, m) => s + estimateTokens(m.content), 0)
  log('AGENT_CONTEXT_SUMMARIZE_DONE', {
    compressed: compressCount,
    beforeTokens: total,
    afterTokens: newTotal,
    budget: tokenBudget,
  }, logScope)

  return compressCount
}

/**
 * 执行 agent 循环。
 *
 * @param provider     LLM provider
 * @param messages     初始消息列表（含 system prompt + 历史消息）
 * @param overrides    provider 配置覆盖
 * @param workspace    工作空间目录（工具操作的安全边界）
 * @param onEvent      事件回调，每次有新事件时调用
 * @param maxTokens    模型上下文窗口大小（token 数），用于自动压缩
 * @param signal       AbortSignal，外部可通过它终止 agent 循环
 */
export async function runAgent(
  provider: ProviderKey,
  messages: ChatMessage[],
  overrides: ProviderOverrides | undefined,
  workspace: string,
  onEvent?: (event: AgentEvent) => void,
  maxTokens?: number,
  signal?: AbortSignal,
  projectId?: string,
  logScope?: string,
): Promise<void> {
  // 确保工作空间是 git 仓库
  try {
    await gitEnsureRepo(workspace)
  } catch (err) {
    log('GIT_INIT_FAIL', { error: err instanceof Error ? err.message : String(err) }, logScope)
  }

  // 将启用的 skills 指令注入 system prompt
  const skillInstructions = getActiveSkillInstructions()
  const workingMessages = [...messages]
  if (workingMessages.length > 0 && workingMessages[0].role === 'system') {
    let extraPrompt = ''

    // Skills 注入
    if (skillInstructions.length > 0) {
      extraPrompt += '\n\n# 已启用的 Skills\n以下是你应当遵循的额外能力指令：\n\n' + skillInstructions.join('\n\n---\n\n')
    }

    // 项目笔记注入
    try {
      const notesBlock = await getNotesPromptBlock(workspace, projectId)
      if (notesBlock) extraPrompt += notesBlock
    } catch (err) {
      log('NOTES_LOAD_FAIL', { error: err instanceof Error ? err.message : String(err) }, logScope)
    }

    // 工作空间目录结构注入（让 AI 从一开始就了解项目全貌，减少重复 list_directory 调用）
    try {
      const tree = await getWorkspaceTree(workspace, 6, true)
      if (tree) {
        extraPrompt += '\n\n# 当前工作空间目录结构\n以下是项目目录树（自动生成，无需再次调用 list_directory 查看根目录结构）：\n```\n' + tree + '\n```\n注意：此目录树在对话开始时生成。如果你在执行过程中创建了新文件，目录树不会实时更新，可按需调用 list_directory 查看最新状态。'
      }
    } catch (err) {
      log('WORKSPACE_TREE_FAIL', { error: err instanceof Error ? err.message : String(err) }, logScope)
    }

    if (extraPrompt) {
      workingMessages[0] = { ...workingMessages[0], content: workingMessages[0].content + extraPrompt }
    }
  }
  let round = 0
  let hasFileChanges = false // 跟踪整个 agent 运行期间是否有文件变更

  // 当前活跃的执行计划（用于跟踪步骤进度）
  let currentPlan: { summary: string; reasoning?: string; steps: { text: string; status: PlanStepStatus; note?: string }[] } | null = null

  /** 工具结果中如果包含文件变更，标记 hasFileChanges */
  function trackFileChanges(results: ToolResult[]) {
    for (const r of results) {
      if (r.fileChange) { hasFileChanges = true; break }
    }
  }

  /** 在 agent 结束前尝试自动 git commit */
  async function autoCommit() {
    if (!hasFileChanges) return
    try {
      // 从消息历史中提取最后一条用户消息作为提交摘要
      const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')
      const summary = lastUserMsg?.content
        ? lastUserMsg.content.replace(/[\n\r]+/g, ' ').slice(0, 60)
        : `Agent round ${round}`
      const hash = await gitCommit(workspace, summary)
      if (hash) {
        log('GIT_COMMIT', { hash, message: summary }, logScope)
        onEvent?.({ type: 'git_commit', hash, message: summary })
      }
    } catch (err) {
      log('GIT_COMMIT_FAIL', { error: err instanceof Error ? err.message : String(err) }, logScope)
    }
  }

  const tokenBudget = maxTokens ?? 131072
  let contextRetries = 0

  while (round < MAX_TOOL_ROUNDS) {
    // ── 检查是否被中断 ──
    if (signal?.aborted) {
      log('AGENT_ABORTED', { round, reason: 'signal aborted before round start' }, logScope)
      await autoCommit()
      onEvent?.({ type: 'done' })
      return
    }

    round++

    // ── 每轮 LLM 请求前检查并压缩上下文（含首轮） ──
    try {
      await compressAgentContext(workingMessages, tokenBudget, provider, overrides, signal, logScope)
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) {
        log('AGENT_ABORTED', { round, reason: 'signal aborted during context compress' }, logScope)
        await autoCommit()
        onEvent?.({ type: 'done' })
        return
      }
      onEvent?.({ type: 'error', message: err instanceof Error ? err.message : String(err) })
      return
    }

    log('AGENT', { round, messageCount: workingMessages.length }, logScope)

    let textContent = ''
    let toolCalls: ToolCall[] = []

    try {
      for await (const event of requestStreamWithTools(
        provider,
        workingMessages,
        overrides,
        { tools: getAllToolDefinitions() },
        signal,
        logScope,
      )) {
        // 每收到一个 chunk 就检查是否被中断
        if (signal?.aborted) {
          log('AGENT_ABORTED', { round, reason: 'signal aborted during stream' }, logScope)
          await autoCommit()
          onEvent?.({ type: 'done' })
          return
        }
        if (event.type === 'text') {
          textContent += event.content
          onEvent?.({ type: 'text', content: event.content })
        } else if (event.type === 'tool_calls') {
          toolCalls = event.toolCalls
        }
      }
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) {
        log('AGENT_ABORTED', { round, reason: 'signal aborted during stream request' }, logScope)
        await autoCommit()
        onEvent?.({ type: 'done' })
        return
      }
      const msg = err instanceof Error ? err.message : String(err)

      // 如果是上下文长度超限错误，尝试强制压缩后重试（最多重试 3 次）
      if (
        contextRetries < 3 &&
        (msg.includes('context length') || msg.includes('maximum') || msg.includes('too many tokens') || msg.includes('请求体过长'))
      ) {
        contextRetries++
        log('AGENT_CONTEXT_OVERFLOW', { round, retry: contextRetries, error: msg }, logScope)
        const dropped = await compressAgentContext(workingMessages, Math.floor(tokenBudget * 0.5), provider, overrides, signal, logScope)
        if (dropped > 0) {
          log('AGENT_CONTEXT_RETRY', { dropped, newMsgCount: workingMessages.length }, logScope)
          round-- // 不消耗轮次，重试当前步骤
          continue
        }
      }

      onEvent?.({ type: 'error', message: msg })
      return
    }

    // 如果没有 tool_calls → 纯文本回复，循环结束
    if (toolCalls.length === 0) {
      await autoCommit()
      onEvent?.({ type: 'done' })
      return
    }

    // ── 有 tool_calls：检查 propose_plan / 风险评估 → 可能需要确认 → 执行工具 ──

    // 追加 assistant 消息（含 tool_calls）
    workingMessages.push({
      role: 'assistant',
      content: textContent || '',
      tool_calls: toolCalls,
    })

    // 通知前端：AI 要调用工具了
    onEvent?.({ type: 'tool_calls', toolCalls })

    // ── 笔记工具优先执行（不经过任何确认流程）──
    const NOTE_TOOLS = new Set(['save_note', 'delete_note'])
    const noteToolCalls = toolCalls.filter((tc) => NOTE_TOOLS.has(tc.function.name))
    if (noteToolCalls.length > 0) {
      const noteResults = await executeToolCalls(noteToolCalls, workspace, signal, logScope, projectId)
      if (signal?.aborted) {
        log('AGENT_ABORTED', { round, reason: 'signal aborted during note tools' }, logScope)
        await autoCommit()
        onEvent?.({ type: 'done' })
        return
      }
      onEvent?.({ type: 'tool_results', results: noteResults })
      for (const result of noteResults) {
        workingMessages.push({
          role: 'tool',
          content: result.content,
          tool_call_id: result.tool_call_id,
        })
      }
      // 如果只有笔记工具调用，直接进入下一轮
      if (noteToolCalls.length === toolCalls.length) continue
      // 否则剩余的工具调用继续走正常流程
      toolCalls = toolCalls.filter((tc) => !NOTE_TOOLS.has(tc.function.name))
    }

    // ── 计划进度更新工具优先执行（不经过任何确认流程）──
    const planProgressCalls = toolCalls.filter((tc) => tc.function.name === 'update_plan_progress')
    if (planProgressCalls.length > 0) {
      for (const tc of planProgressCalls) {
        try {
          const args = JSON.parse(tc.function.arguments)
          const stepIdx = args.stepIndex as number
          const status = args.status as PlanStepStatus
          const note = args.note as string | undefined

          // 更新本地计划状态
          if (currentPlan && stepIdx >= 0 && stepIdx < currentPlan.steps.length) {
            currentPlan.steps[stepIdx].status = status
            if (note) currentPlan.steps[stepIdx].note = note
          }

          // 发射进度事件到前端
          onEvent?.({ type: 'plan_progress', stepIndex: stepIdx, status, note })

          const resultContent = `步骤 ${stepIdx + 1} 状态已更新为「${status}」${note ? `：${note}` : ''}`
          onEvent?.({ type: 'tool_results', results: [{ tool_call_id: tc.id, name: tc.function.name, content: resultContent, success: true }] })
          workingMessages.push({ role: 'tool', content: resultContent, tool_call_id: tc.id })
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e)
          onEvent?.({ type: 'tool_results', results: [{ tool_call_id: tc.id, name: tc.function.name, content: `更新失败: ${errMsg}`, success: false }] })
          workingMessages.push({ role: 'tool', content: `更新失败: ${errMsg}`, tool_call_id: tc.id })
        }
      }
      if (planProgressCalls.length === toolCalls.length) continue
      toolCalls = toolCalls.filter((tc) => tc.function.name !== 'update_plan_progress')
    }

    // ── 检查是否有 propose_plan（计划确认）──
    const planCall = toolCalls.find((tc) => tc.function.name === 'propose_plan')
    if (planCall) {
      const confirmId = `plan-${Date.now()}-${++confirmCounter}`
      log('AGENT_PLAN', { confirmId, plan: planCall.function.arguments }, logScope)

      // 以 plan 类型的 risk 触发确认流程（复用现有 confirm 机制）
      const planRisks: RiskInfo[] = [{
        toolCallId: planCall.id,
        toolName: 'propose_plan',
        level: 'warning',
        reason: '执行计划需要确认',
        detail: planCall.function.arguments,
      }]
      onEvent?.({ type: 'confirm', confirmId, toolCalls: [planCall], risks: planRisks })

      const approved = await waitForConfirm(confirmId, signal)
      log('AGENT_PLAN_CONFIRM', { confirmId, approved }, logScope)

      // 等待确认期间可能被中断
      if (signal?.aborted) {
        log('AGENT_ABORTED', { round, reason: 'signal aborted during plan confirm' }, logScope)
        await autoCommit()
        onEvent?.({ type: 'done' })
        return
      }

      if (!approved) {
        // 用户拒绝计划 → 反馈给 LLM，让它调整方案
        const deniedResults: ToolResult[] = toolCalls.map((tc) => ({
          tool_call_id: tc.id,
          name: tc.function.name,
          content: tc.function.name === 'propose_plan'
            ? '用户没有批准此执行计划。请根据用户的反馈调整方案，或者询问用户希望如何修改。不要直接开始执行未经确认的操作。'
            : '计划未获批准，此操作被取消。',
          success: false,
        }))
        onEvent?.({ type: 'tool_results', results: deniedResults })

        for (const result of deniedResults) {
          workingMessages.push({
            role: 'tool',
            content: result.content,
            tool_call_id: result.tool_call_id,
          })
        }
        continue
      }

      // 用户确认 → 存储计划并发射 plan_init 事件
      try {
        const planArgs = JSON.parse(planCall.function.arguments)
        const steps: string[] = planArgs.steps || []
        currentPlan = {
          summary: planArgs.summary || '',
          reasoning: planArgs.reasoning,
          steps: steps.map((s: string) => ({ text: s, status: 'pending' as PlanStepStatus })),
        }
        onEvent?.({ type: 'plan_init', summary: currentPlan.summary, steps, reasoning: currentPlan.reasoning })
        log('PLAN_INIT', { summary: currentPlan.summary, stepCount: steps.length }, logScope)
      } catch (e) {
        log('PLAN_INIT_PARSE_FAIL', { error: e instanceof Error ? e.message : String(e) }, logScope)
      }

      // propose_plan 本身的结果是"已确认"，继续执行其余工具
      const planResult: ToolResult = {
        tool_call_id: planCall.id,
        name: 'propose_plan',
        content: '用户已确认此执行计划，请按照计划开始执行。请在开始执行每个步骤前调用 update_plan_progress(stepIndex, "in_progress")，完成后调用 update_plan_progress(stepIndex, "done")，以便用户实时看到执行进度。',
        success: true,
      }

      // 如果 propose_plan 是唯一的工具调用，返回结果让 LLM 开始执行
      if (toolCalls.length === 1) {
        onEvent?.({ type: 'tool_results', results: [planResult] })
        workingMessages.push({
          role: 'tool',
          content: planResult.content,
          tool_call_id: planResult.tool_call_id,
        })
        continue
      }

      // 如果同时有其他工具调用，先追加 plan 结果，再执行其余工具
      workingMessages.push({
        role: 'tool',
        content: planResult.content,
        tool_call_id: planResult.tool_call_id,
      })

      // 执行非 propose_plan 的工具
      const otherToolCalls = toolCalls.filter((tc) => tc.function.name !== 'propose_plan')
      const otherResults = await executeToolCalls(otherToolCalls, workspace, signal, logScope, projectId)
      if (signal?.aborted) {
        log('AGENT_ABORTED', { round, reason: 'signal aborted during plan tools' }, logScope)
        await autoCommit()
        onEvent?.({ type: 'done' })
        return
      }
      trackFileChanges(otherResults)
      const allResults = [planResult, ...otherResults]

      onEvent?.({ type: 'tool_results', results: allResults })
      for (const result of otherResults) {
        workingMessages.push({
          role: 'tool',
          content: result.content,
          tool_call_id: result.tool_call_id,
        })
      }
      continue
    }

    // ── 风险评估（非 propose_plan 的普通工具调用）──
    const risks = assessToolCallsRisk(toolCalls)

    if (risks.length > 0) {
      const confirmId = `confirm-${Date.now()}-${++confirmCounter}`
      log('AGENT_RISK', { confirmId, risks }, logScope)

      // 通知前端：需要用户确认
      onEvent?.({ type: 'confirm', confirmId, toolCalls, risks })

      // 等待用户响应
      const approved = await waitForConfirm(confirmId, signal)
      log('AGENT_CONFIRM', { confirmId, approved }, logScope)

      // 等待确认期间可能被中断
      if (signal?.aborted) {
        log('AGENT_ABORTED', { round, reason: 'signal aborted during risk confirm' }, logScope)
        await autoCommit()
        onEvent?.({ type: 'done' })
        return
      }

      if (!approved) {
        // 用户拒绝 → 将拒绝信息作为工具结果反馈给 LLM
        const deniedResults: ToolResult[] = toolCalls.map((tc) => ({
          tool_call_id: tc.id,
          name: tc.function.name,
          content: '用户拒绝了此操作的执行。请告知用户你原本打算执行的操作，并询问是否需要其他方式来完成任务。',
          success: false,
        }))
        onEvent?.({ type: 'tool_results', results: deniedResults })

        for (const result of deniedResults) {
          workingMessages.push({
            role: 'tool',
            content: result.content,
            tool_call_id: result.tool_call_id,
          })
        }

        // 继续循环让 LLM 处理拒绝情况
        continue
      }

      // 如果用户确认了浏览器操作，后续自动放行
      const hasBrowserRisk = risks.some((r) => r.toolName.startsWith('browser_'))
      if (hasBrowserRisk) {
        setBrowserAutoApproved(true)
        log('BROWSER_AUTO_APPROVED', { msg: '用户已确认浏览器操作，后续自动放行' }, logScope)
      }
    }

    // ── 检查是否被中断（在执行工具之前）──
    if (signal?.aborted) {
      log('AGENT_ABORTED', { round, reason: 'signal aborted before tool execution' }, logScope)
      await autoCommit()
      onEvent?.({ type: 'done' })
      return
    }

    // ── 执行工具（限制在 workspace 内，异步不阻塞主进程）──
    const results = await executeToolCalls(toolCalls, workspace, signal, logScope, projectId)
    if (signal?.aborted) {
      log('AGENT_ABORTED', { round, reason: 'signal aborted during tool execution' }, logScope)
      await autoCommit()
      onEvent?.({ type: 'done' })
      return
    }
    trackFileChanges(results)

    // 通知前端：工具执行结果
    onEvent?.({ type: 'tool_results', results })

    // 追加 tool 结果消息（对超长结果进行截断以避免上下文膨胀）
    for (const result of results) {
      let content = result.content
      if (content.length > MAX_SINGLE_MSG_CHARS) {
        content = content.slice(0, MAX_SINGLE_MSG_CHARS) + '\n\n[...输出已截断，共 ' + result.content.length + ' 字符]'
      }
      workingMessages.push({
        role: 'tool',
        content,
        tool_call_id: result.tool_call_id,
      })
    }

    // 继续循环，让 LLM 处理工具结果
  }

  // 超出最大轮次
  await autoCommit()
  onEvent?.({ type: 'error', message: `Agent exceeded max tool rounds (${MAX_TOOL_ROUNDS})` })
}
