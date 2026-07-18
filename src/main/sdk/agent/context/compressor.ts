/**
 * Agent 上下文压缩
 *
 * 当上下文 token 数超过阈值时，调用 LLM 对早期消息进行续跑摘要压缩，
 * 在保留关键信息的前提下减少上下文长度。
 */

import type { ChatMessage, ProviderOverrides, TokenUsage } from '../llm/client'
import type { ProviderKey } from '../llm/client'
import { requestChatCompletion } from '../llm/client'
import type { Logger } from '../services'
import { buildCurrentTaskCompressionStateCard } from './builder'
import type { ContextBuildState } from './builder'
import { isAbortError } from '../error-handler'
import type { AgentEvent } from '../types'
import type { RecallMeta } from '../memory/memory-recall'
import { maintainTaskMemoriesByAI } from '../memory/memory-maintain'
import { sanitizeContextArtifacts } from '../shared/sanitize'
import { extractTextFromContent } from '../llm/adapter'
import { collectUserMediaRefsFromMessages } from '../shared/user-assets'

/** 模块级 logger，由外部通过 setCompressorLogger 注入 */
let _log: Logger = () => {}
export function setCompressorLogger(logger: Logger) { _log = logger }

/* ------------------------------------------------------------------ */
/*  工具函数                                                           */
/* ------------------------------------------------------------------ */

export function compactLine(text: string, max = 260): string {
  const lines = String(text ?? '')
    .replace(/\r/g, '')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (lines.length === 0) return '(无输出)'

  const first = lines[0]
  if (lines.length === 1) {
    return first.length <= max ? first : `${first.slice(0, max)}...`
  }

  // 多行输出：保留首行 + 最多 5 个关键行（错误/警告/失败标记），避免丢失定位信息
  const keyPattern = /(error|Error|ERROR|warn|WARN|fail|FAIL|exception|Exception|panic|fatal|timeout|abort|✗|✘|❌|×)/
  const keyLines = lines.slice(1).filter((l) => keyPattern.test(l)).slice(0, 5)

  if (keyLines.length === 0) {
    return first.length <= max ? first : `${first.slice(0, max)}...`
  }

  const joined = [first, ...keyLines].join('\n')
  const cap = Math.max(max, 160)
  return joined.length <= cap ? joined : `${joined.slice(0, cap)}...`
}

export function maskSensitiveText(text: string): string {
  let masked = String(text ?? '')
  const keyValuePattern = /((?:token|access_token|api[_-]?key|authorization|bearer|password|passwd|pwd|secret)\s*[:=]\s*)([^\s'"]+)/ig
  masked = masked.replace(keyValuePattern, (_m, prefix: string) => `${prefix}***`)
  const bearerPattern = /(bearer\s+)([a-zA-Z0-9._\-]+)/ig
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

import type { ToolResult } from '../tools'

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
  userId?: string,
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
      content: `你是对话压缩助手。将 AI Agent 的对话历史压缩为可直接续跑的上下文摘要。

保留（续跑必需信息）：
- 当前任务目标、执行阶段（正在做什么）
- 所有文件变更（路径 + 改动内容）
- 关键命令结果（成功的核心输出、失败的完整错误信息）
- 当前计划状态：已完成步骤 / 待继续步骤
- 用户约束、偏好、显式拒绝的方案
- 未解决的疑问、待确认事项

丢弃（对续跑无用）：
- 中间步骤的详细过程（只保留结论）
- 工具调用参数细节（只保留结果）
- 重复的编译/构建成功信息（只记一次）
- 思考/推理过程（只保留最终决策）
- 问候语、闲聊、确认性对话

禁止：写成"任务完成"总结。必须明确标注"哪些尚未完成、下一步做什么"。
使用中文，条理清晰。`,
    },
    {
      role: 'user',
      content: `请将以下对话历史压缩成精炼的摘要：\n\n${conversationText}`,
    },
  ]

  try {
    const summary = await requestChatCompletion(provider, summaryPrompt, overrides, signal, logScope, userId)
    return summary
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) throw err
    _log('SUMMARIZE_FAIL', { error: err instanceof Error ? err.message : String(err) }, logScope)
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
  userId?: string,
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
      content: `你是当前任务续跑压缩助手。将"当前未完成任务"的消息序列压缩为可直接续跑的进度总结。

保留：
- 当前任务目标
- 已完成的步骤与关键证据（文件变更、命令结果、失败信息）
- 当前计划状态：已完成步骤 / 待继续步骤 / 下一步行动
- 用户约束与偏好、待确认事项
- 若有执行计划，必须明确保留各步骤的完成状态
- 若用户提交了媒体文件，原样保留其路径或链接

丢弃：
- 中间推理过程、工具调用参数细节
- 重复性信息（如多次编译成功只记一次）

这是"未完成任务续跑摘要"，严禁写成任务已完成。
使用中文，结构化输出。`,
    },
    {
      role: 'user',
      content: `${buildCurrentTaskCompressionStateCard(state)}\n\n# 需要压缩的当前任务消息\n${lines.join('\n\n')}`,
    },
  ]

  try {
    return await requestChatCompletion(provider, prompt, overrides, signal, logScope, userId)
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) throw err
    _log('CURRENT_TASK_SUMMARIZE_FAIL', { error: err instanceof Error ? err.message : String(err) }, logScope)
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
  userId?: string,
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

  _log('AGENT_CONTEXT_SUMMARIZE_START', {
    sourceTotalTokens: usageTotalTokensHint,
    totalTokens: total,
    budget: tokenBudget,
    compressCount,
    currentTaskStartIndex: safeTaskAnchorIndex,
    taskTrailStartIndex,
    keepReplayPrefix: safeTaskAnchorIndex > 1,
    preserveCurrentUserQuery: true,
  }, logScope)

  const summary = await summarizeCurrentTaskProgress(provider, overrides, toCompress, state, signal, logScope, userId)

  const summaryMsg: ChatMessage = {
    role: 'assistant',
    content: `[CURRENT_TASK_SUMMARY]\n任务未完成，基于上一条 user 消息续跑。有执行计划时继续调用 update_plan_progress。\n\n${summary}\n[/CURRENT_TASK_SUMMARY]`,
  }

  msgs.splice(taskTrailStartIndex, compressCount, summaryMsg)

  void maintainTaskMemoriesByAI(workspace, projectId, {
    provider,
    overrides,
    usageTotalTokens: usageTotalTokensHint,
    contextLength: tokenBudget,
    signal,
    logScope,
  }, userId).catch((err) => {
    _log('AGENT_TASK_MEMORY_MAINTAIN_FAIL', { error: err instanceof Error ? err.message : String(err) }, logScope)
  })

  _log('AGENT_CONTEXT_SUMMARIZE_DONE', {
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
