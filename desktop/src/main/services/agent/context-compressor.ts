/**
 * Agent 上下文压缩
 *
 * 当上下文 token 数超过阈值时，调用 LLM 对早期消息进行续跑摘要压缩，
 * 在保留关键信息的前提下减少上下文长度。
 */

import type { ChatMessage, ProviderOverrides, TokenUsage } from '../../ai/llm'
import type { ProviderKey } from '../../ai/llm'
import { requestChatCompletion } from '../../ai/llm'
import { log } from '../../system/logger'
import { buildCurrentTaskCompressionStateCard } from '../../agent/context-builder'
import type { ContextBuildState } from '../../agent/context-builder'
import { isAbortError } from './error-handler'
import type { AgentEvent } from './agent-types'
import type { RecallMeta } from '../../data/notes'
import { maintainTaskMemoriesByAI } from '../../data/notes'
import { sanitizeContextArtifacts } from '../../../shared/sanitize'
import { extractTextFromContent } from '../../provider/message-adapter'
import { collectUserMediaRefsFromMessages } from '../../../shared/user-assets'

/* ------------------------------------------------------------------ */
/*  工具函数                                                           */
/* ------------------------------------------------------------------ */

export function compactLine(text: string, max = 260): string {
  const line = String(text ?? '')
    .replace(/\r/g, '')
    .split('\n')
    .map((s) => s.trim())
    .find((s) => s.length > 0) ?? ''
  if (!line) return '(无输出)'
  return line.length <= max ? line : `${line.slice(0, max)}...`
}

export function maskSensitiveText(text: string): string {
  let masked = String(text ?? '')
  const keyValuePattern = /((?:token|access_token|api[_-]?key|authorization|bearer|password|passwd|pwd|secret)\s*[:=]\s*)([^\s'"]+)/ig
  masked = masked.replace(keyValuePattern, (_m, prefix: string) => `${prefix}***`)
  const bearerPattern = /(bearer\s+)([a-z0-9._\-]+)/ig
  masked = masked.replace(bearerPattern, (_m, prefix: string) => `${prefix}***`)
  return masked
}

export function summarizeRunCommand(command: string): string {
  const masked = maskSensitiveText(command.trim())
  if (!masked) return ''

  if (/npm\s+run\s+dev/i.test(masked)) return '启动前端开发服务'
  if (/npm\s+(run\s+)?build/i.test(masked)) return '构建项目'
  if (/go\s+test|npm\s+test|pnpm\s+test|yarn\s+test/i.test(masked)) return '执行测试'
  if (/lint|eslint|golangci-lint|biome\s+check/i.test(masked)) return '执行 lint 检查'
  if (/typecheck|tsc\b/i.test(masked)) return '执行类型检查'
  if (/go\s+build|cargo\s+build|vite\s+build|pnpm\s+build|yarn\s+build/i.test(masked)) return '执行构建验证'

  return masked.length > 80 ? `${masked.slice(0, 77)}...` : masked
}

export function extractIdentifiers(text: string): string[] {
  const source = String(text ?? '')
  if (!source) return []
  const patterns = [
    /\bfunction\s+([A-Za-z_]\w*)\b/g,
    /\bfunc\s+([A-Za-z_]\w*)\b/g,
    /\bclass\s+([A-Za-z_]\w*)\b/g,
    /\binterface\s+([A-Za-z_]\w*)\b/g,
    /\btype\s+([A-Za-z_]\w*)\b/g,
    /\b(?:const|let|var)\s+([A-Za-z_]\w*)\b/g,
  ]
  const out: string[] = []
  for (const p of patterns) {
    p.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = p.exec(source)) !== null) {
      const id = m[1]
      if (!out.includes(id)) out.push(id)
      if (out.length >= 60) return out
    }
  }
  return out
}

import type { ToolResult } from '../../tools'

/** 工具结果截断（当前阶段直接透传，预留截断扩展点） */
export function truncateToolResultForContext(result: ToolResult): string {
  return result.content
}

/* ------------------------------------------------------------------ */
/*  AI 摘要压缩                                                        */
/* ------------------------------------------------------------------ */

/**
 * 调用 LLM 为一组早期消息生成摘要。
 */
export async function summarizeMessages(
  provider: ProviderKey,
  overrides: ProviderOverrides | undefined,
  messagesToSummarize: ChatMessage[],
  signal?: AbortSignal,
  logScope?: string,
): Promise<string> {
  const lines: string[] = []
  for (const m of messagesToSummarize) {
    const role = m.role === 'assistant' ? 'AI助手'
      : m.role === 'user' ? '用户'
      : m.role === 'tool' ? '工具结果'
      : '系统'
    lines.push(`[${role}] ${m.content}`)
  }

  const conversationText = lines.join('\n\n')

  const summaryPrompt: ChatMessage[] = [
    {
      role: 'system',
      content: `你是一个对话压缩助手。你需要将一段 AI Agent 的对话历史压缩成可续跑的完整上下文。

要求：
1. 不得遗漏信息，必须覆盖原始对话中的全部事实、步骤、结果、失败与重试记录
2. 完整保留技术细节：文件路径、函数名、配置项、命令、参数、错误信息
3. 完整保留当前进展、未完成项、用户约束和待确认事项
4. 使用结构化格式，条理清晰
5. 这不是"任务完成总结"，必须显式标注"哪些尚未完成、下一步要执行什么"
6. 严禁输出"已完成/已修复/全部正常"等终态结论语
7. 使用中文输出`,
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
    return messagesToSummarize.map((m) => {
      const tag = m.role === 'assistant' ? 'AI' : m.role === 'user' ? 'User' : m.role
      return `[${tag}] ${m.content}`
    }).join('\n')
  }
}

/**
 * 调用 LLM 生成当前任务的续跑进度总结
 */
export async function summarizeCurrentTaskProgress(
  provider: ProviderKey,
  overrides: ProviderOverrides | undefined,
  messagesToSummarize: ChatMessage[],
  state: ContextBuildState,
  signal?: AbortSignal,
  logScope?: string,
): Promise<string> {
  const lines: string[] = []
  const userMediaRefs = collectUserMediaRefsFromMessages(messagesToSummarize)
  for (const m of messagesToSummarize) {
    const contentText = typeof m.content === 'string' ? m.content : extractTextFromContent(m.content)
    const sanitizedContent = sanitizeContextArtifacts(String(contentText ?? ''))
    if (!sanitizedContent) continue
    const role = m.role === 'assistant' ? 'AI助手'
      : m.role === 'user' ? '用户'
      : m.role === 'tool' ? '工具结果'
      : '系统'
    const compacted = m.role === 'system' ? compactLine(sanitizedContent, 360) : sanitizedContent
    lines.push(`[${role}] ${compacted}`)
  }
  if (userMediaRefs.length > 0) {
    lines.push(`[用户提交媒体文件]\n${userMediaRefs.map((ref) => `- ${ref}`).join('\n')}`)
  }

  const prompt: ChatMessage[] = [
    {
      role: 'system',
      content: `你是当前任务续跑压缩助手。你需要把"当前未完成任务"的消息序列压缩成一段可直接续跑的任务进度总结。

要求：
1. 必须完整保留当前目标、已完成动作、关键工具证据、文件变更、失败与重试、当前计划状态。
2. 必须明确写出：哪些步骤已完成、哪些步骤待继续、下一步该做什么。
3. 这是"未完成任务的续跑摘要"，严禁写成任务已完成。
4. 不要丢失文件路径、函数名、命令、报错、关键结论。
5. 用户原始问题会在上下文里单独保留，摘要不要重复改写用户问题本身，重点总结该问题之后的执行进度。
6. 如果当前存在执行计划，必须明确保留计划已完成步骤、待继续步骤，以及后续继续执行时仍需更新计划状态。
7. 若用户提交了媒体文件（图片/视频等），必须在总结中原样保留这些媒体文件的路径或链接。
8. 使用中文结构化输出。`,
    },
    {
      role: 'user',
      content: `${buildCurrentTaskCompressionStateCard(state)}\n\n# 需要压缩的当前任务消息\n${lines.join('\n\n')}`,
    },
  ]

  try {
    return await requestChatCompletion(provider, prompt, overrides, signal, logScope)
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) throw err
    log('CURRENT_TASK_SUMMARIZE_FAIL', { error: err instanceof Error ? err.message : String(err) }, logScope)
    return buildCurrentTaskCompressionStateCard(state)
  }
}

/**
 * Agent 循环内的上下文 AI 摘要压缩。
 *
 * 策略：
 * 1. 仅使用 usage.total_tokens 判断是否需要压缩
 * 2. 触发压缩时，保留 system prompt、记忆回放消息和当前用户问题
 * 3. 仅将"当前用户问题之后的本轮执行轨迹"压成一条续跑摘要
 *
 * @returns 被压缩替换的消息数（0 表示无需压缩）
 */
export async function compressAgentContext(
  msgs: ChatMessage[],
  tokenBudget: number,
  provider: ProviderKey,
  overrides: ProviderOverrides | undefined,
  workspace: string,
  userQuery: string,
  projectId: string | undefined,
  recallDebug: boolean,
  currentTaskStartIndex: number,
  state: ContextBuildState,
  usageTotalTokensHint?: number,
  signal?: AbortSignal,
  logScope?: string,
  onEvent?: (event: AgentEvent) => void,
  onRecallMeta?: (meta: RecallMeta) => void,
): Promise<{ compressed: number; nextCurrentTaskStartIndex: number }> {
  const threshold = Math.floor(tokenBudget * 0.80)

  if (!(typeof usageTotalTokensHint === 'number' && Number.isFinite(usageTotalTokensHint) && usageTotalTokensHint > 0)) {
    return { compressed: 0, nextCurrentTaskStartIndex: currentTaskStartIndex }
  }
  const total = usageTotalTokensHint
  if (total <= threshold) return { compressed: 0, nextCurrentTaskStartIndex: currentTaskStartIndex }

  const safeTaskAnchorIndex = Math.max(1, Math.min(currentTaskStartIndex, Math.max(1, msgs.length - 1)))
  const taskTrailStartIndex = Math.min(msgs.length, safeTaskAnchorIndex + 1)
  const toCompress = msgs.slice(taskTrailStartIndex)
  const compressCount = toCompress.length
  if (compressCount <= 0) return { compressed: 0, nextCurrentTaskStartIndex: currentTaskStartIndex }

  log('AGENT_CONTEXT_SUMMARIZE_START', {
    sourceTotalTokens: usageTotalTokensHint,
    totalTokens: total,
    budget: tokenBudget,
    compressCount,
    currentTaskStartIndex: safeTaskAnchorIndex,
    taskTrailStartIndex,
    keepReplayPrefix: safeTaskAnchorIndex > 1,
    preserveCurrentUserQuery: true,
  }, logScope)

  const summary = await summarizeCurrentTaskProgress(provider, overrides, toCompress, state, signal, logScope)

  const summaryMsg: ChatMessage = {
    role: 'assistant',
    content: `[CURRENT_TASK_SUMMARY]\n以下是"当前用户问题之后"的本轮任务进度总结，不代表任务已完成。\n当前用户问题仍以上一条 user 消息为准；请基于该问题与以下进度继续执行当前任务。\n若存在执行计划，继续执行时仍需按步骤调用 update_plan_progress 更新状态。\n\n${summary}\n[/CURRENT_TASK_SUMMARY]`,
  }

  msgs.splice(taskTrailStartIndex, compressCount, summaryMsg)

  void maintainTaskMemoriesByAI(workspace, projectId, {
    provider,
    overrides,
    usageTotalTokens: usageTotalTokensHint,
    contextLength: tokenBudget,
    signal,
    logScope,
  }).catch((err) => {
    log('AGENT_TASK_MEMORY_MAINTAIN_FAIL', { error: err instanceof Error ? err.message : String(err) }, logScope)
  })

  log('AGENT_CONTEXT_SUMMARIZE_DONE', {
    compressed: compressCount,
    beforeTokens: total,
    afterTokens: undefined,
    budget: tokenBudget,
  }, logScope)

  onEvent?.({
    type: 'system_notice',
    title: '背景信息已自动压缩',
    message: `上下文已达到阈值，系统已保留系统消息、记忆回放和当前用户问题，并将本轮后续执行轨迹压缩为当前任务总结后继续执行。已压缩 ${compressCount} 条消息。`,
  })

  return { compressed: compressCount, nextCurrentTaskStartIndex: safeTaskAnchorIndex }
}
