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

import path from 'node:path'
import type { ChatMessage, ProviderOverrides, TokenUsage } from './llm'
import type { ProviderKey } from './llm'
import { requestChatCompletion, requestStreamWithTools } from './llm'
import { getFilteredToolDefinitions, buildAllowedToolNamesForRequest, executeToolCalls, assessToolCallsRisk, setBrowserAutoApproved, setDesktopAutoApproved, getWorkspaceTree, getToolDesignPromptBlock, getAutoApproveCategories } from './tools'
import type { ToolCall, ToolResult, RiskInfo } from './tools'
import { log } from './logger'
import { gitCommit, gitEnsureRepo } from './git'
import { refreshSkills, buildActiveSkillsCatalogBlock, getActiveSkillEnv, applySkillEnvironment } from './skills'
import { buildBackgroundContextConversationMessages, inferIntentFromBackground, maintainTaskMemoriesByAI, recordMemorySnapshot, recordTaskLog, stripInternalContextTags, stripPseudoToolCallArtifacts } from './notes'
import type { RecallMeta } from './notes'
import { buildAgentRequestMessages, buildCurrentTaskCompressionStateCard, validateCompletionClaim } from './context-builder'
import type { ContextBuildState } from './context-builder'
import { applyRewardScore } from './reward-score'

/* ------------------------------------------------------------------ */
/*  Agent 事件                                                         */
/* ------------------------------------------------------------------ */

import type { PlanStepStatus } from '../shared/ipc'

export type AgentEvent =
  /** 文本流片段 */
  | { type: 'text'; content: string }
  /** 思考/推理片段（用于步骤展示，不进入最终回复正文） */
  | { type: 'reasoning'; content: string }
  /** AI 决定调用工具 */
  | { type: 'tool_calls'; toolCalls: ToolCall[]; thinking?: string }
  /** 系统级提示（如上下文自动压缩） */
  | { type: 'system_notice'; title: string; message?: string }
  /** 风险操作需要用户确认 */
  | { type: 'confirm'; confirmId: string; toolCalls: ToolCall[]; risks: RiskInfo[] }
  /** 工具执行结果 */
  | { type: 'tool_results'; results: ToolResult[] }
  /** Git 自动提交完成 */
  | { type: 'git_commit'; hash: string; message: string }
  /** 本轮请求 token 使用量 */
  | { type: 'usage'; usage: TokenUsage }
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

function safeParseObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    return null
  } catch {
    return null
  }
}

const USER_ASSETS_BLOCK_REGEX = /\s*\[USER_ASSETS\][\s\S]*?\[\/USER_ASSETS\]\s*/gi
const USER_ASSETS_BLOCK_CAPTURE_REGEX = /\[USER_ASSETS\]([\s\S]*?)\[\/USER_ASSETS\]/i

function stripUserAssetsBlock(content: string): string {
  return String(content ?? '')
    .replace(USER_ASSETS_BLOCK_REGEX, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function extractUserQueryText(content: string): string {
  const raw = stripUserAssetsBlock(content)
  const wrapped = raw.match(/\[USER_QUERY\]([\s\S]*?)\[\/USER_QUERY\]/i)
  if (wrapped && wrapped[1]) return wrapped[1].trim()
  return raw.trim()
}

function extractUserAssetsBlock(content: string): string {
  const raw = String(content ?? '')
  const wrapped = raw.match(USER_ASSETS_BLOCK_CAPTURE_REGEX)
  if (!wrapped || !wrapped[1]) return ''
  return wrapped[1].trim()
}

function inferIntentTypeFromQuery(query: string): string {
  const text = String(query ?? '').trim().toLowerCase()
  if (!text) return 'other'
  if (/(报错|错误|异常|排查|调试|debug|error|bug|trace|崩溃)/.test(text)) return 'debug'
  if (/(实现|新增|开发|编写|添加|implement|create|build|功能)/.test(text)) return 'implement'
  if (/(重构|优化|整理|抽离|refactor|optimize|cleanup)/.test(text)) return 'refactor'
  if (/(删除|重命名|移动|部署|发布|配置|运行|执行|remove|delete|rm |mv |deploy)/.test(text)) return 'ops'
  if (/(是什么|为什么|怎么|如何|请解释|是否|吗|\?|？|what|why|how|can you)/.test(text)) return 'qa'
  return 'other'
}

const STREAM_SANITIZE_HOLD_BACK = 24

const USER_VISIBLE_SOURCE_PHRASE_RULES: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /从(?:项目)?历史(?:记录|记忆|信息|上下文)来看/g, replacement: '结合当前上下文来看' },
  { pattern: /根据(?:项目)?历史(?:记录|记忆|信息|上下文)(?:显示|来看|可知|可见)?/g, replacement: '结合当前上下文' },
  { pattern: /基于(?:项目)?历史(?:记录|记忆|信息|上下文)/g, replacement: '结合当前上下文' },
  { pattern: /根据(?:背景|上下文)信息/g, replacement: '结合当前上下文' },
  { pattern: /根据\s*BACKGROUND_CONTEXT/gi, replacement: '结合当前上下文' },
  { pattern: /based on (?:the )?(?:project )?(?:history|historical (?:records?|memory|context))/gi, replacement: 'based on current context' },
  { pattern: /from (?:the )?background context/gi, replacement: 'from current context' },
]

const PSEUDO_TOOL_CALL_TEXT_PATTERNS = [
  /\[TOOL_CALL[^\]]*\]/i,
  /<invoke\b/i,
  /<minimax:tool_call\b/i,
  /<parameter\b/i,
]

function containsPseudoToolCallSyntax(input: string): boolean {
  const text = String(input ?? '')
  return PSEUDO_TOOL_CALL_TEXT_PATTERNS.some((pattern) => pattern.test(text))
}

function stripReasoningArtifacts(input: string): string {
  return String(input ?? '')
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '\n')
    .replace(/<reflection\b[^>]*>[\s\S]*?<\/reflection>/gi, '\n')
    .replace(/<tool_code\b[^>]*>[\s\S]*?<\/tool_code>/gi, '\n')
    .replace(/<\/?(?:think|reflection|tool_code)\b[^>]*>/gi, ' ')
}

function sanitizeContextArtifacts(input: string): string {
  let output = stripReasoningArtifacts(stripPseudoToolCallArtifacts(stripInternalContextTags(String(input ?? ''))))
  output = output
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return output
}

function sanitizeUserFacingText(input: string): string {
  let output = sanitizeContextArtifacts(input)
  for (const rule of USER_VISIBLE_SOURCE_PHRASE_RULES) {
    output = output.replace(rule.pattern, rule.replacement)
  }
  return output
}

function sanitizeReplayRawText(input: string): string {
  return stripPseudoToolCallArtifacts(stripInternalContextTags(String(input ?? '')))
    .replace(/\r/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function extractThinkingFromAssistantRawText(rawText: string): string {
  const text = String(rawText ?? '')
  if (!text.trim()) return ''
  const matches = [...text.matchAll(/<think\b[^>]*>([\s\S]*?)<\/think>/gi)]
  if (matches.length > 0) {
    const merged = matches.map((m) => String(m[1] || '').trim()).filter(Boolean).join('\n\n')
    return sanitizeContextArtifacts(merged).trim()
  }
  const openTag = text.search(/<think\b[^>]*>/i)
  if (openTag >= 0) {
    const tagEnd = text.indexOf('>', openTag)
    if (tagEnd >= 0) {
      return sanitizeContextArtifacts(text.slice(tagEnd + 1)).trim()
    }
  }
  return ''
}

function buildAssistantContextContent(rawText: string, sanitizedText: string, rawReasoning: string): string {
  const replayRawText = sanitizeReplayRawText(rawText)
  const visibleText = sanitizeUserFacingText(sanitizedText).trim()
  const reasoning = sanitizeContextArtifacts(rawReasoning).trim()
  const primaryText = replayRawText || visibleText

  if (primaryText && reasoning) {
    if (/<think\b/i.test(primaryText)) return primaryText
    return `<think>\n${reasoning}\n</think>\n\n${primaryText}`.trim()
  }
  if (primaryText) return primaryText
  if (reasoning) return `思考：${reasoning}`
  return ''
}

function compactLine(text: string, max = 260): string {
  const line = String(text ?? '')
    .replace(/\r/g, '')
    .split('\n')
    .map((s) => s.trim())
    .find((s) => s.length > 0) ?? ''
  if (!line) return '(无输出)'
  return line.length <= max ? line : `${line.slice(0, max)}...`
}

function maskSensitiveText(text: string): string {
  let masked = String(text ?? '')
  const keyValuePattern = /((?:token|access_token|api[_-]?key|authorization|bearer|password|passwd|pwd|secret)\s*[:=]\s*)([^\s'"]+)/ig
  masked = masked.replace(keyValuePattern, (_m, prefix: string) => `${prefix}***`)
  const bearerPattern = /(bearer\s+)([a-z0-9._\-]+)/ig
  masked = masked.replace(bearerPattern, (_m, prefix: string) => `${prefix}***`)
  return masked
}

function summarizeRunCommand(command: string): string {
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

function extractIdentifiers(text: string): string[] {
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

/* ------------------------------------------------------------------ */
/*  Agent 运行                                                         */
/* ------------------------------------------------------------------ */

const MAX_TOOL_ROUNDS = 1000 // 防止无限循环
let confirmCounter = 0

/* ------------------------------------------------------------------ */
/*  AI 摘要压缩                                                        */
/* ------------------------------------------------------------------ */

function truncateToolResultForContext(result: ToolResult): string {
  return result.content
}

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
5. 这不是“任务完成总结”，必须显式标注“哪些尚未完成、下一步要执行什么”
6. 严禁输出“已完成/已修复/全部正常”等终态结论语
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
    // 摘要失败时回退为简单文本拼接
    return messagesToSummarize.map((m) => {
      const tag = m.role === 'assistant' ? 'AI' : m.role === 'user' ? 'User' : m.role
      return `[${tag}] ${m.content}`
    }).join('\n')
  }
}

async function summarizeCurrentTaskProgress(
  provider: ProviderKey,
  overrides: ProviderOverrides | undefined,
  messagesToSummarize: ChatMessage[],
  state: ContextBuildState,
  signal?: AbortSignal,
  logScope?: string,
): Promise<string> {
  const lines: string[] = []
  for (const m of messagesToSummarize) {
    const sanitizedContent = sanitizeContextArtifacts(String(m.content ?? ''))
    if (!sanitizedContent) continue
    const role = m.role === 'assistant' ? 'AI助手'
      : m.role === 'user' ? '用户'
      : m.role === 'tool' ? '工具结果'
      : '系统'
    const compacted = m.role === 'system' ? compactLine(sanitizedContent, 360) : sanitizedContent
    lines.push(`[${role}] ${compacted}`)
  }

  const prompt: ChatMessage[] = [
    {
      role: 'system',
      content: `你是当前任务续跑压缩助手。你需要把“当前未完成任务”的消息序列压缩成一段可直接续跑的任务进度总结。

要求：
1. 必须完整保留当前目标、已完成动作、关键工具证据、文件变更、失败与重试、当前计划状态。
2. 必须明确写出：哪些步骤已完成、哪些步骤待继续、下一步该做什么。
3. 这是“未完成任务的续跑摘要”，严禁写成任务已完成。
4. 不要丢失文件路径、函数名、命令、报错、关键结论。
5. 用户原始问题会在上下文里单独保留，摘要不要重复改写用户问题本身，重点总结该问题之后的执行进度。
6. 如果当前存在执行计划，必须明确保留计划已完成步骤、待继续步骤，以及后续继续执行时仍需更新计划状态。
7. 使用中文结构化输出。`,
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
 * 3. 仅将“当前用户问题之后的本轮执行轨迹”压成一条续跑摘要
 *
 * @returns  被压缩替换的消息数（0 表示无需压缩）
 */
async function compressAgentContext(
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
  const threshold = Math.floor(tokenBudget * 0.80) // 留 20% 给回复

  // 仅接受 usage.total_tokens 作为压缩触发依据
  if (!(typeof usageTotalTokensHint === 'number' && Number.isFinite(usageTotalTokensHint) && usageTotalTokensHint > 0)) {
    return { compressed: 0, nextCurrentTaskStartIndex: currentTaskStartIndex }
  }
  const total = usageTotalTokensHint
  if (total <= threshold) return { compressed: 0, nextCurrentTaskStartIndex: currentTaskStartIndex }

  // 保留当前用户问题本身，只压缩“当前用户问题之后的执行轨迹”。
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

  // ── 第四步：仅对当前任务消息做续跑摘要 ──
  const summary = await summarizeCurrentTaskProgress(provider, overrides, toCompress, state, signal, logScope)

  // ── 第五步：用摘要替换旧消息 ──
  const summaryMsg: ChatMessage = {
    role: 'assistant',
    content: `[CURRENT_TASK_SUMMARY]\n以下是“当前用户问题之后”的本轮任务进度总结，不代表任务已完成。\n当前用户问题仍以上一条 user 消息为准；请基于该问题与以下进度继续执行当前任务。\n若存在执行计划，继续执行时仍需按步骤调用 update_plan_progress 更新状态。\n\n${summary}\n[/CURRENT_TASK_SUMMARY]`,
  }

  // 仅替换“当前用户问题之后”的执行轨迹，前面的记忆回放段和当前用户问题保持不变。
  msgs.splice(taskTrailStartIndex, compressCount, summaryMsg)

  // 记录压缩快照，供后续记忆召回时重建关键上下文链路
  try {
    await recordMemorySnapshot(
      workspace,
      {
        summary,
        sourceMessageCount: compressCount,
        usageTotalTokens: usageTotalTokensHint,
        maxTokens: tokenBudget,
      },
      projectId,
    )
  } catch (err) {
    log('AGENT_MEMORY_SNAPSHOT_SAVE_FAIL', { error: err instanceof Error ? err.message : String(err) }, logScope)
  }

  // 高压时触发记忆整理，但不阻塞当前任务续跑。
  void maintainTaskMemoriesByAI(workspace, projectId, {
    provider,
    overrides,
    usageTotalTokens: usageTotalTokensHint,
    maxTokens: tokenBudget,
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
  sessionId?: string,
  sourceUserMessageId?: string,
  sourceAssistantMessageId?: string,
  logScope?: string,
  recallDebug = false,
): Promise<void> {
  const taskStartedAt = Date.now()
  const isGitAutoOpsEnabled = () => getAutoApproveCategories().includes('git_ops')
  try {
    await refreshSkills(workspace)
  } catch (err) {
    log('SKILLS_REFRESH_FAIL', { error: err instanceof Error ? err.message : String(err) }, logScope)
  }
  const restoreSkillEnv = applySkillEnvironment(getActiveSkillEnv())
  try {
  // 仅在开启 git_ops 自动授权时，才允许自动初始化/自动提交
  if (isGitAutoOpsEnabled()) {
    try {
      await gitEnsureRepo(workspace)
    } catch (err) {
      log('GIT_INIT_FAIL', { error: err instanceof Error ? err.message : String(err) }, logScope)
    }
  } else {
    log('GIT_AUTO_OPS_DISABLED', { action: 'skip_git_ensure_repo' }, logScope)
  }

  // 将启用的 skills 目录注入 system prompt
  const skillsCatalogBlock = buildActiveSkillsCatalogBlock()
  const workingMessages = [...messages]
  const activatedSkillIds = new Set<string>()
  const lastUserGoal = [...messages].reverse().find((m) => m.role === 'user')?.content?.trim() || ''
  const plainUserQuery = extractUserQueryText(lastUserGoal)
  const userAssetsBlock = extractUserAssetsBlock(lastUserGoal)
  const normalizedMemorySessionId = String(sessionId || projectId || '').trim()
  const normalizedSourceUserMessageId = String(sourceUserMessageId || '').trim()
  const normalizedSourceAssistantMessageId = String(sourceAssistantMessageId || '').trim()
  let currentTaskStartIndex = Math.max(1, workingMessages.map((m) => m.role).lastIndexOf('user'))
  let latestRecallMeta: Pick<RecallMeta, 'intentSource' | 'intentType' | 'intentSummary' | 'intentGoal'> | null = null
  const TOOL_PROMPT_SENTINEL_START = '<!--TACO_RUNTIME_TOOL_PROMPT_START-->'
  const TOOL_PROMPT_SENTINEL_END = '<!--TACO_RUNTIME_TOOL_PROMPT_END-->'
  const TOOL_PROMPT_LEGACY_BLOCK_REGEX = /\[RUNTIME_TOOL_PROMPT\][\s\S]*?\[\/RUNTIME_TOOL_PROMPT\]/g
  const TOOL_PROMPT_SENTINEL_BLOCK_REGEX = /<!--TACO_RUNTIME_TOOL_PROMPT_START-->[\s\S]*?<!--TACO_RUNTIME_TOOL_PROMPT_END-->/g

  function buildRuntimeToolPrompt(allowedToolNames: Iterable<string>): string {
    return `${TOOL_PROMPT_SENTINEL_START}\n[RUNTIME_TOOL_PROMPT]\n${getToolDesignPromptBlock(allowedToolNames)}\n[/RUNTIME_TOOL_PROMPT]\n${TOOL_PROMPT_SENTINEL_END}`
  }

  function syncRuntimeToolPrompt(allowedToolNames: Iterable<string>) {
    if (!workingMessages.length || workingMessages[0].role !== 'system') return
    const nextBlock = buildRuntimeToolPrompt(allowedToolNames)
    const current = String(workingMessages[0].content ?? '')
    const cleanedBase = current
      .replace(TOOL_PROMPT_SENTINEL_BLOCK_REGEX, '\n')
      .replace(TOOL_PROMPT_LEGACY_BLOCK_REGEX, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd()
    workingMessages[0] = {
      ...workingMessages[0],
      content: cleanedBase ? `${cleanedBase}\n\n${nextBlock}` : nextBlock,
    }
  }

  // 每轮任务：将历史任务记忆重组为 user/assistant 消息序列，并在末尾追加本轮用户提问
  try {
    let lastUserIdx = -1
    for (let i = workingMessages.length - 1; i >= 0; i--) {
      if (workingMessages[i].role === 'user') {
        lastUserIdx = i
        break
      }
    }
    if (lastUserIdx >= 0) {
      const rawUserQuery = String(workingMessages[lastUserIdx].content ?? '')
      const injected = await buildBackgroundContextConversationMessages(
        workspace,
        rawUserQuery,
        projectId,
        {
          maxTokens,
          reason: 'initial',
          replayMode: 'full',
          provider,
          overrides,
          signal,
          logScope,
        },
      )
      workingMessages.splice(lastUserIdx, 1, ...injected.messages)
      currentTaskStartIndex = lastUserIdx + Math.max(0, injected.messages.length - 1)
      latestRecallMeta = {
        intentSource: injected.recallMeta.intentSource,
        intentType: injected.recallMeta.intentType,
        intentSummary: injected.recallMeta.intentSummary,
        intentGoal: injected.recallMeta.intentGoal,
      }
      log('BACKGROUND_CONTEXT_REPLAY_INJECTED', {
        lastUserIndex: lastUserIdx,
        replayedSnapshots: injected.replayedSnapshots.length,
        droppedSnapshotReplayCount: injected.droppedSnapshotReplayCount,
        replayedTurns: injected.replayedTaskMemories.length,
        droppedReplayCount: injected.droppedReplayCount,
        notesCount: injected.notes.length,
        recalledCount: injected.recalled.length,
        recallMeta: injected.recallMeta,
        rawUserQuery,
        recalledNotes: injected.notes,
        recalledItems: injected.recalled,
        ...(recallDebug ? { recallDebug: injected.recallDebug } : {}),
      }, logScope)
    }
  } catch (err) {
    log('NOTES_USER_CONTEXT_INJECT_FAIL', { error: err instanceof Error ? err.message : String(err) }, logScope)
  }

  if (workingMessages.length > 0 && workingMessages[0].role === 'system') {
    let extraPrompt = ''

    // Skills 目录注入
    if (skillsCatalogBlock.trim()) {
      extraPrompt += `\n\n${skillsCatalogBlock}`
    }

    // 工作空间目录结构注入（让 AI 从一开始就了解项目全貌，减少重复 list_dir 调用）
    try {
      const tree = await getWorkspaceTree(workspace, 3, true)
      if (tree) {
        extraPrompt += '\n\n# 当前工作空间目录结构\n以下是项目目录树（自动生成，无需再次调用 list_dir 查看根目录结构）：\n```\n' + tree + '\n```\n注意：此目录树在对话开始时生成。如果你在执行过程中创建了新文件，目录树不会实时更新，可按需调用 list_dir 查看最新状态。'
      }
    } catch (err) {
      log('WORKSPACE_TREE_FAIL', { error: err instanceof Error ? err.message : String(err) }, logScope)
    }

    // 工具设计清单注入（与后端工具 schema 同步）
    try {
      extraPrompt += `\n\n${buildRuntimeToolPrompt(buildAllowedToolNamesForRequest(activatedSkillIds))}`
    } catch (err) {
      log('TOOL_DESIGN_PROMPT_FAIL', { error: err instanceof Error ? err.message : String(err) }, logScope)
    }

    if (extraPrompt) {
      workingMessages[0] = { ...workingMessages[0], content: workingMessages[0].content + extraPrompt }
    }
  }
  let round = 0
  let hasFileChanges = false // 跟踪整个 agent 运行期间是否有文件变更

  // 当前活跃的执行计划（用于跟踪步骤进度）
  let currentPlan: { summary: string; reasoning?: string; steps: { text: string; status: PlanStepStatus; note?: string }[] } | null = null
  const toolUsageCount = new Map<string, number>()
  const changedFiles = new Set<string>()
  const touchedFiles = new Set<string>()
  const touchedIdentifiers = new Set<string>()
  const failureLogs: string[] = []
  let successfulRunCommandCount = 0
  const runCommandSummaryByToolCallId = new Map<string, string>()
  const toolInputContextByToolCallId = new Map<string, { path?: string; query?: string; pattern?: string; type?: string }>()
  const successfulRunCommandSummaries: string[] = []
  const memoryEvidenceFacts: string[] = []

  function toWorkspaceRelativeFactPath(value: string): string {
    const raw = String(value ?? '').trim()
    if (!raw) return ''
    const normalized = raw.replace(/\\/g, '/')
    if (!workspace || !workspace.trim()) return normalized
    try {
      const ws = path.normalize(workspace)
      const target = path.normalize(raw)
      if (path.isAbsolute(target) && (target === ws || target.startsWith(`${ws}${path.sep}`))) {
        const rel = path.relative(ws, target).replace(/\\/g, '/')
        return rel || '.'
      }
    } catch {
      return normalized
    }
    return normalized
  }

  function shortMemoryFactText(value: string): string {
    const text = String(value ?? '').replace(/\r/g, '').replace(/\s+/g, ' ').trim()
    return text
  }

  function pushMemoryEvidenceFact(value: string) {
    const fact = shortMemoryFactText(value)
    if (!fact) return
    if (memoryEvidenceFacts.includes(fact)) return
    memoryEvidenceFacts.push(fact)
  }

  function collectSearchMatchRefs(content: string, limit = 3): string[] {
    const refs: string[] = []
    for (const rawLine of String(content ?? '').split('\n')) {
      const line = rawLine.trim()
      const match = line.match(/^([^:\n]+):(\d+)(?::|-)/)
      if (!match) continue
      const ref = `${toWorkspaceRelativeFactPath(match[1])}:${match[2]}`
      if (!ref || refs.includes(ref)) continue
      refs.push(ref)
      if (refs.length >= limit) break
    }
    return refs
  }

  function collectFindResultPaths(content: string, limit = 3): string[] {
    const refs: string[] = []
    for (const rawLine of String(content ?? '').split('\n')) {
      const line = rawLine.trim()
      const match = line.match(/^\[(?:F|D)\]\s+(.+?)(?:\/)?$/)
      if (!match) continue
      const ref = toWorkspaceRelativeFactPath(match[1])
      if (!ref || refs.includes(ref)) continue
      refs.push(ref)
      if (refs.length >= limit) break
    }
    return refs
  }

  function buildReadFileFact(content: string, requestedPath?: string): string {
    const metaPathMatch = String(content ?? '').match(/\[read_file\]\s+path:\s*(.+)/)
    const resolvedPath = toWorkspaceRelativeFactPath(metaPathMatch?.[1] || requestedPath || '')
    if (!resolvedPath) return ''
    const withoutMeta = String(content ?? '').replace(/^\[read_file\][^\n]*\n?/gm, '')
    const hintMarker = '\n[提示]'
    const hintIndex = withoutMeta.indexOf(hintMarker)
    const body = (hintIndex >= 0 ? withoutMeta.slice(0, hintIndex) : withoutMeta).trim()
    const identifiers = extractIdentifiers(body).slice(0, 3)
    return identifiers.length > 0
      ? `查看 ${resolvedPath}（涉及 ${identifiers.join('、')}）`
      : `查看 ${resolvedPath}`
  }

  function buildFileChangeFact(fileChange: ToolResult['fileChange']): string {
    if (!fileChange?.filePath) return ''
    const relPath = toWorkspaceRelativeFactPath(fileChange.filePath)
    if (!relPath) return ''
    const action = fileChange.oldContent === null
      ? '新增'
      : fileChange.newContent === null
        ? '删除'
        : '修改'
    const identifiers = extractIdentifiers(`${fileChange.oldContent || ''}\n${fileChange.newContent || ''}`).slice(0, 3)
    return identifiers.length > 0
      ? `${action} ${relPath}（涉及 ${identifiers.join('、')}）`
      : `${action} ${relPath}`
  }

  function shouldPersistTaskCoreLog(): { persist: boolean; reason: string } {
    // 每轮用户提问都写入任务记忆（包括未调用工具的问答轮次）。
    return { persist: true, reason: 'always_persist_each_query' }
  }

  function trackToolCallsInputs(calls: ToolCall[]) {
    for (const tc of calls) {
      const name = tc.function.name
      if (!name || name === 'save_note' || name === 'delete_note') continue
      const current = toolUsageCount.get(name) ?? 0
      toolUsageCount.set(name, current + 1)

      const args = safeParseObject(tc.function.arguments)
      if (!args) continue
      if (name === 'run_command') {
        const command = typeof args.command === 'string' ? args.command : ''
        const summary = summarizeRunCommand(command)
        if (summary) runCommandSummaryByToolCallId.set(tc.id, summary)
      }
      if (name === 'read_file') {
        const requestedPath = typeof args.path === 'string' ? args.path.trim() : ''
        if (requestedPath) toolInputContextByToolCallId.set(tc.id, { path: requestedPath })
      } else if (name === 'codebase_search') {
        const query = typeof args.query === 'string'
          ? args.query.trim()
          : typeof args.pattern === 'string'
            ? args.pattern.trim()
            : ''
        const requestedPath = typeof args.path === 'string'
          ? args.path.trim()
          : typeof args.directory === 'string'
            ? args.directory.trim()
            : ''
        toolInputContextByToolCallId.set(tc.id, { query, path: requestedPath })
      } else if (name === 'find_file') {
        const pattern = typeof args.pattern === 'string' ? args.pattern.trim() : ''
        const requestedPath = typeof args.directory === 'string' ? args.directory.trim() : ''
        const type = typeof args.type === 'string' ? args.type.trim() : ''
        toolInputContextByToolCallId.set(tc.id, { pattern, path: requestedPath, type })
      } else if (name === 'list_dir') {
        const requestedPath = typeof args.path === 'string' ? args.path.trim() : ''
        if (requestedPath) toolInputContextByToolCallId.set(tc.id, { path: requestedPath })
      }
      const pathKeys = ['path', 'filePath', 'cwd']
      for (const key of pathKeys) {
        const value = args[key]
        if (typeof value === 'string' && value.trim()) touchedFiles.add(value.trim())
      }
      if (name === 'write_file' || name === 'edit_file') {
        const oldText = typeof args.oldText === 'string' ? args.oldText : ''
        const newText = typeof args.newText === 'string' ? args.newText : ''
        for (const id of extractIdentifiers(oldText)) touchedIdentifiers.add(id)
        for (const id of extractIdentifiers(newText)) touchedIdentifiers.add(id)
      }
    }
  }

  function trackToolResultsCore(results: ToolResult[]) {
    for (const result of results) {
      if (result.name === 'save_note' || result.name === 'delete_note') continue
      if (result.name === 'run_command' && result.success) {
        successfulRunCommandCount++
        const summary = runCommandSummaryByToolCallId.get(result.tool_call_id) || ''
        if (summary && !successfulRunCommandSummaries.includes(summary)) {
          successfulRunCommandSummaries.push(summary)
          if (successfulRunCommandSummaries.length > 3) successfulRunCommandSummaries.shift()
        }
        if (summary) pushMemoryEvidenceFact(`执行验证：${summary}`)
      }
      if (result.fileChange?.filePath) {
        changedFiles.add(result.fileChange.filePath)
        const fileChangeFact = buildFileChangeFact(result.fileChange)
        if (fileChangeFact) pushMemoryEvidenceFact(fileChangeFact)
      }
      if (result.fileChange?.oldContent) {
        for (const id of extractIdentifiers(result.fileChange.oldContent)) touchedIdentifiers.add(id)
      }
      if (result.fileChange?.newContent) {
        for (const id of extractIdentifiers(result.fileChange.newContent)) touchedIdentifiers.add(id)
      }
      if (result.success) {
        const toolInput = toolInputContextByToolCallId.get(result.tool_call_id)
        if (result.name === 'read_file') {
          const fact = buildReadFileFact(result.content, toolInput?.path)
          if (fact) pushMemoryEvidenceFact(fact)
        } else if (result.name === 'codebase_search') {
          const refs = collectSearchMatchRefs(result.content, 4)
          if (refs.length > 0) {
            const query = shortMemoryFactText(toolInput?.query || '代码搜索')
            pushMemoryEvidenceFact(`搜索 ${query} 命中 ${refs.join('、')}`)
          }
        } else if (result.name === 'find_file') {
          const refs = collectFindResultPaths(result.content, 4)
          if (refs.length > 0) {
            const label = toolInput?.type === 'directory' ? '定位目录' : '定位文件'
            const pattern = shortMemoryFactText(toolInput?.pattern || '目标路径')
            pushMemoryEvidenceFact(`${label} ${pattern}：${refs.join('、')}`)
          }
        } else if (result.name === 'list_dir' && toolInput?.path) {
          pushMemoryEvidenceFact(`查看目录 ${toWorkspaceRelativeFactPath(toolInput.path)}`)
        }
      }
      if (!result.success && failureLogs.length < 12) {
        failureLogs.push(`${result.name}: ${compactLine(result.content, 320)}`)
      }
    }
  }

  function isVerificationPlanStep(text: string): boolean {
    const lower = String(text ?? '').trim().toLowerCase()
    if (!lower) return false
    return /(验证|测试|构建|编译|lint|typecheck|校验|检查通过|编译通过|构建通过|test|build|compile|verify|validation)/i.test(lower)
  }

  async function persistTaskCoreLog(
    finalSummary: string,
    outcome: 'success' | 'aborted' | 'error' = 'success',
  ): Promise<void> {
    if ((!workspace || !workspace.trim()) && (!projectId || !projectId.trim())) return
    const decision = shouldPersistTaskCoreLog()
    if (!decision.persist) {
      log('TASK_CORE_NOTE_SKIPPED', {
        reason: decision.reason,
        goal: lastUserGoal,
      }, logScope)
      return
    }
    const tools = [...toolUsageCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `${name} x${count}`)
    const modifiedFiles = changedFiles.size > 0 ? [...changedFiles] : [...touchedFiles]
    try {
      let intentType = latestRecallMeta?.intentType || ''
      let intentSummary = latestRecallMeta?.intentSummary || ''
      let intentGoal = latestRecallMeta?.intentGoal || ''
      let intentSource = latestRecallMeta?.intentSource || 'heuristic'

      if (!intentType || intentType === 'other') {
        try {
          const inferred = await inferIntentFromBackground(
            workspace,
            plainUserQuery || lastUserGoal,
            projectId,
            {
              usageTotalTokens: lastUsageTotalTokens,
              maxTokens,
              signal,
              logScope,
            },
          )
          intentType = inferred.intentType || intentType
          intentSummary = inferred.intentSummary || intentSummary
          intentGoal = inferred.intentGoal || intentGoal
          intentSource = inferred.intentSource || intentSource
        } catch (err) {
          log('TASK_MEMORY_INTENT_INFER_FAIL', { error: err instanceof Error ? err.message : String(err) }, logScope)
        }
      }

      const finalIntentType = intentType || inferIntentTypeFromQuery(plainUserQuery || lastUserGoal)
      const finalIntentSummary = intentSummary || plainUserQuery || lastUserGoal
      const finalIntentGoal = intentGoal || plainUserQuery || lastUserGoal
      await recordTaskLog(
        workspace,
        {
          goal: plainUserQuery || lastUserGoal,
          userQuery: plainUserQuery || lastUserGoal,
          ...(userAssetsBlock ? { userAssetsBlock } : {}),
          intentType: finalIntentType,
          intentSummary: finalIntentSummary,
          intentGoal: finalIntentGoal,
          summary: finalSummary,
          outcome,
          tools,
          changedFiles: modifiedFiles.slice(0, 80),
          identifiers: [...touchedIdentifiers].slice(0, 80),
          evidenceFacts: [...memoryEvidenceFacts],
          failures: failureLogs.slice(0, 12),
          sourceRef: {
            ...(normalizedMemorySessionId ? { sessionId: normalizedMemorySessionId } : {}),
            ...(normalizedSourceUserMessageId ? { userMessageId: normalizedSourceUserMessageId } : {}),
            ...(normalizedSourceAssistantMessageId ? { assistantMessageId: normalizedSourceAssistantMessageId } : {}),
          },
        },
        projectId,
      )
      try {
        await maintainTaskMemoriesByAI(workspace, projectId, {
          provider,
          overrides,
          usageTotalTokens: lastUsageTotalTokens,
          maxTokens,
          signal,
          logScope,
        })
      } catch (err) {
        log('TASK_MEMORY_MAINTAIN_FAIL', { error: err instanceof Error ? err.message : String(err) }, logScope)
      }
      log('TASK_CORE_NOTE_SAVED', {
        reason: decision.reason,
        intentType: finalIntentType,
        intentSource,
        toolKinds: tools.length,
        fileCount: modifiedFiles.length,
        identifierCount: touchedIdentifiers.size,
      }, logScope)
    } catch (err) {
      log('TASK_CORE_NOTE_SAVE_FAIL', { error: err instanceof Error ? err.message : String(err) }, logScope)
    }
  }

  /** 工具结果中如果包含文件变更，标记 hasFileChanges */
  function trackFileChanges(results: ToolResult[]) {
    for (const r of results) {
      if (r.fileChange) { hasFileChanges = true; break }
    }
  }

  /** 在 agent 结束前尝试自动 git commit */
  async function autoCommit() {
    if (!isGitAutoOpsEnabled()) return
    if (!hasFileChanges) return
    try {
      // 从消息历史中提取最后一条用户消息作为提交摘要
      const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')
      const plainUserSummary = extractUserQueryText(lastUserMsg?.content || '')
      const summary = plainUserSummary
        ? plainUserSummary.replace(/[\n\r]+/g, ' ').slice(0, 60)
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
  let lastUsageTotalTokens: number | undefined
  let contextRetries = 0
  let lastAssistantText = ''
  let completionRejectCount = 0
  let pseudoToolCallRejectCount = 0
  let enforceStandardToolCall = false
  let completionValidationHint = ''

  function cleanupAssistantText(text: string): string {
    return stripPseudoToolCallArtifacts(
      stripInternalContextTags(String(text ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '')),
    ).trim()
  }

  async function persistTaskCoreLogWithOutcome(
    summaryText: string,
    outcome: 'success' | 'aborted' | 'error',
    errorMessage?: string,
  ): Promise<void> {
    await autoCommit()
    const cleanedSummary = cleanupAssistantText(summaryText)
    const finalSummary = (errorMessage
      ? [cleanedSummary, `错误信息: ${errorMessage}`].filter(Boolean).join('\n')
      : cleanedSummary
    ) || (outcome === 'aborted' ? '(任务中止，未产出最终文本)' : '(无最终文本)')
    await persistTaskCoreLog(finalSummary, outcome)

    try {
      const toolCalls = [...toolUsageCount.values()].reduce((sum, count) => sum + count, 0)
      const scored = await applyRewardScore({
        channel: 'agent',
        outcome,
        workspace,
        projectId,
        requestId: `${projectId || workspace || 'global'}:${Date.now()}`,
        toolCalls,
        changedFiles: changedFiles.size,
        failures: failureLogs.length + (errorMessage ? 1 : 0),
        elapsedMs: Math.max(0, Date.now() - taskStartedAt),
      })
      log('REWARD_SCORE_APPLIED', {
        channel: 'agent',
        outcome,
        delta: scored.delta,
        points: scored.state.points,
        debtUsd: scored.state.debtUsd,
        breakdown: scored.entry.breakdown,
      }, logScope)
    } catch (err) {
      log('REWARD_SCORE_APPLY_FAIL', { error: err instanceof Error ? err.message : String(err) }, logScope)
    }
  }

  async function finalizeAndDone(summaryText: string, outcome: 'success' | 'aborted' = 'success'): Promise<void> {
    await persistTaskCoreLogWithOutcome(summaryText, outcome)
    onEvent?.({ type: 'done' })
  }

  while (round < MAX_TOOL_ROUNDS) {
    // ── 检查是否被中断 ──
    if (signal?.aborted) {
      log('AGENT_ABORTED', { round, reason: 'signal aborted before round start' }, logScope)
      await finalizeAndDone(lastAssistantText, 'aborted')
      return
    }

    round++

    // ── 每轮 LLM 请求前检查并压缩上下文（含首轮） ──
    try {
      const compressed = await compressAgentContext(
        workingMessages,
        tokenBudget,
        provider,
        overrides,
        workspace,
        lastUserGoal,
        projectId,
        recallDebug,
        currentTaskStartIndex,
        {
          round,
          goal: lastUserGoal,
          toolUsageCount,
          changedFiles,
          touchedFiles,
          touchedIdentifiers,
          failures: failureLogs,
          completionValidationHint,
          currentPlan,
        },
        lastUsageTotalTokens,
        signal,
        logScope,
        onEvent,
        (meta) => { latestRecallMeta = meta },
      )
      currentTaskStartIndex = compressed.nextCurrentTaskStartIndex
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) {
        log('AGENT_ABORTED', { round, reason: 'signal aborted during context compress' }, logScope)
        await finalizeAndDone(lastAssistantText, 'aborted')
        return
      }
      const msg = err instanceof Error ? err.message : String(err)
      await persistTaskCoreLogWithOutcome(lastAssistantText, 'error', msg)
      onEvent?.({ type: 'error', message: msg })
      return
    }

    syncRuntimeToolPrompt(buildAllowedToolNamesForRequest(activatedSkillIds))

    const requestMessages = buildAgentRequestMessages(workingMessages, {
      round,
      goal: lastUserGoal,
      toolUsageCount,
      changedFiles,
      touchedFiles,
      touchedIdentifiers,
      failures: failureLogs,
      completionValidationHint,
      currentPlan,
      enforceStandardToolCall,
    })

    log('AGENT', { round, messageCount: requestMessages.length }, logScope)
    const allowedToolNames = buildAllowedToolNamesForRequest(activatedSkillIds)

    let textContent = ''
    let rawTextContent = ''
    let emittedSanitizedText = ''
    let rawReasoningContent = ''
    let emittedSanitizedReasoning = ''
    let assistantContextContent = ''
    let toolCallThinking = ''
    let toolCalls: ToolCall[] = []
    let invalidToolCallNames: string[] = []

    try {
      for await (const event of requestStreamWithTools(
        provider,
        requestMessages,
        overrides,
        { tools: getFilteredToolDefinitions(allowedToolNames), toolChoice: 'auto' },
        signal,
        logScope,
      )) {
        // 每收到一个 chunk 就检查是否被中断
        if (signal?.aborted) {
          log('AGENT_ABORTED', { round, reason: 'signal aborted during stream' }, logScope)
          await finalizeAndDone(textContent || lastAssistantText, 'aborted')
          return
        }
        if (event.type === 'text') {
          rawTextContent += event.content
          const sanitizedFull = sanitizeUserFacingText(rawTextContent)
          const safeLen = Math.max(0, sanitizedFull.length - STREAM_SANITIZE_HOLD_BACK)
          const visibleText = sanitizedFull.slice(0, safeLen)
          const delta = visibleText.slice(emittedSanitizedText.length)
          emittedSanitizedText = visibleText
          textContent = visibleText
          lastAssistantText = textContent
          if (delta) onEvent?.({ type: 'text', content: delta })
        } else if (event.type === 'reasoning') {
          rawReasoningContent += event.content
          const sanitizedReasoning = sanitizeContextArtifacts(rawReasoningContent)
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

      const finalSanitizedText = sanitizeUserFacingText(rawTextContent)
      const tailDelta = finalSanitizedText.slice(emittedSanitizedText.length)
      if (tailDelta) onEvent?.({ type: 'text', content: tailDelta })
      const finalSanitizedReasoning = sanitizeContextArtifacts(rawReasoningContent)
      const reasoningTailDelta = finalSanitizedReasoning.slice(emittedSanitizedReasoning.length)
      if (reasoningTailDelta) onEvent?.({ type: 'reasoning', content: reasoningTailDelta })
      textContent = finalSanitizedText
      assistantContextContent = buildAssistantContextContent(rawTextContent, finalSanitizedText, rawReasoningContent)
      toolCallThinking =
        sanitizeContextArtifacts(rawReasoningContent).trim() ||
        extractThinkingFromAssistantRawText(rawTextContent) ||
        sanitizeReplayRawText(rawTextContent)
      lastAssistantText = assistantContextContent || textContent || lastAssistantText
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) {
        log('AGENT_ABORTED', { round, reason: 'signal aborted during stream request' }, logScope)
        await finalizeAndDone(textContent || lastAssistantText, 'aborted')
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
        const dropped = await compressAgentContext(
          workingMessages,
          Math.floor(tokenBudget * 0.5),
          provider,
          overrides,
          workspace,
          lastUserGoal,
          projectId,
          recallDebug,
          currentTaskStartIndex,
          {
            round,
            goal: lastUserGoal,
            toolUsageCount,
            changedFiles,
            touchedFiles,
            touchedIdentifiers,
            failures: failureLogs,
            completionValidationHint,
            currentPlan,
          },
          lastUsageTotalTokens,
          signal,
          logScope,
          onEvent,
          (meta) => { latestRecallMeta = meta },
        )
        currentTaskStartIndex = dropped.nextCurrentTaskStartIndex
        if (dropped.compressed > 0) {
          log('AGENT_CONTEXT_RETRY', { dropped, newMsgCount: workingMessages.length }, logScope)
          round-- // 不消耗轮次，重试当前步骤
          continue
        }
      }

      await persistTaskCoreLogWithOutcome(textContent || lastAssistantText, 'error', msg)
      onEvent?.({ type: 'error', message: msg })
      return
    }

    // 如果没有 tool_calls → 纯文本回复，循环结束
    if (toolCalls.length === 0) {
      const hasPseudoToolCallText = containsPseudoToolCallSyntax(rawTextContent)
      if (hasPseudoToolCallText) {
        pseudoToolCallRejectCount++
        enforceStandardToolCall = true
        log('AGENT_STANDARD_TOOL_CALL_REJECTED', {
          round,
          rejectCount: pseudoToolCallRejectCount,
          hasPseudoToolCallText,
          invalidToolCallNames,
          rawPreview: rawTextContent.slice(0, 800),
        }, logScope)
        if (pseudoToolCallRejectCount >= 6) {
          const reason = `检测到 [TOOL_CALL] 文本但没有标准 tool_calls，连续出现已达上限(${pseudoToolCallRejectCount})`
          await persistTaskCoreLogWithOutcome(textContent || lastAssistantText, 'error', reason)
          onEvent?.({ type: 'error', message: reason })
          return
        }
        round-- // 按请求失败处理，不消耗本轮
        continue
      }

      if (invalidToolCallNames.length > 0) {
        pseudoToolCallRejectCount++
        enforceStandardToolCall = true
        log('AGENT_STANDARD_TOOL_CALL_REJECTED', {
          round,
          rejectCount: pseudoToolCallRejectCount,
          hasPseudoToolCallText: false,
          invalidToolCallNames,
          rawPreview: rawTextContent.slice(0, 800),
        }, logScope)
        if (pseudoToolCallRejectCount >= 6) {
          const reason = `非标准工具调用连续出现已达上限(${pseudoToolCallRejectCount})，非法工具名: ${invalidToolCallNames.join(', ')}`
          await persistTaskCoreLogWithOutcome(textContent || lastAssistantText, 'error', reason)
          onEvent?.({ type: 'error', message: reason })
          return
        }
        round-- // 按请求失败处理，不消耗本轮
        continue
      }
      pseudoToolCallRejectCount = 0
      enforceStandardToolCall = false

      const finalPlan = currentPlan
      const unfinishedPlanSteps = finalPlan
        ? finalPlan.steps
            .map((step, index) => ({ step, index }))
            .filter(({ step }) => step.status === 'pending' || step.status === 'in_progress')
        : []
      if (finalPlan && unfinishedPlanSteps.length > 0) {
        // 先将遗留步骤落为 failed，避免完成校验因“仍有未完成步骤”进入死循环。
        for (const { index, step } of unfinishedPlanSteps) {
          const autoDone = isVerificationPlanStep(step.text) && successfulRunCommandCount > 0
          const status: PlanStepStatus = autoDone ? 'done' : 'failed'
          const evidenceText = successfulRunCommandSummaries.length > 0
            ? `；证据命令: ${successfulRunCommandSummaries.join('、')}`
            : ''
          const note = autoDone
            ? `本轮结束前未显式更新该步骤状态；检测到成功的 run_command 验证证据，系统自动补记为 done（原状态: ${step.status}）${evidenceText}`
            : `本轮结束前未更新该步骤状态，系统自动标记为 failed（原状态: ${step.status}）`
          finalPlan.steps[index].status = status
          finalPlan.steps[index].note = note
          onEvent?.({ type: 'plan_progress', stepIndex: index, status, note })
        }
      }

      const completionValidation = validateCompletionClaim(textContent, {
        round,
        goal: lastUserGoal,
        toolUsageCount,
        changedFiles,
        touchedFiles,
        touchedIdentifiers,
        failures: failureLogs,
        currentPlan,
      })
      if (!completionValidation.pass) {
        completionRejectCount++
        completionValidationHint = completionValidation.reason
        log('AGENT_COMPLETION_REJECTED', {
          round,
          rejectCount: completionRejectCount,
          reason: completionValidation.reason,
        }, logScope)
        workingMessages.push({
          role: 'assistant',
          content: assistantContextContent || textContent || '',
        })
        if (completionRejectCount >= 10) {
          await persistTaskCoreLogWithOutcome(textContent || lastAssistantText, 'error', `完成校验连续未通过已达上限(${completionRejectCount})`)
          onEvent?.({ type: 'error', message: `完成校验连续未通过已达上限(${completionRejectCount})：${completionValidation.reason}` })
          return
        }
        continue
      }
      completionRejectCount = 0
      completionValidationHint = ''

      await finalizeAndDone(assistantContextContent || textContent)
      return
    }

    // ── 有 tool_calls：检查 propose_plan / 风险评估 → 可能需要确认 → 执行工具 ──
    pseudoToolCallRejectCount = 0
    enforceStandardToolCall = false
    completionValidationHint = ''

    // 追加 assistant 消息（含 tool_calls）
    workingMessages.push({
      role: 'assistant',
      content: assistantContextContent || textContent || '',
      tool_calls: toolCalls,
    })

    // 通知前端：AI 要调用工具了
    onEvent?.({ type: 'tool_calls', toolCalls, ...(toolCallThinking ? { thinking: toolCallThinking } : {}) })

    // ── 笔记工具优先执行（不经过任何确认流程）──
    const NOTE_TOOLS = new Set(['save_note', 'delete_note'])
    const noteToolCalls = toolCalls.filter((tc) => NOTE_TOOLS.has(tc.function.name))
    if (noteToolCalls.length > 0) {
      const noteResults = await executeToolCalls(noteToolCalls, workspace, signal, logScope, projectId)
      if (signal?.aborted) {
        log('AGENT_ABORTED', { round, reason: 'signal aborted during note tools' }, logScope)
        await finalizeAndDone(lastAssistantText, 'aborted')
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
        await finalizeAndDone(lastAssistantText, 'aborted')
        return
      }

      if (!approved) {
        currentPlan = null
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

      // 如果同时有其他工具调用：禁止在“计划确认回合”直接执行，防止跳过用户许可
      const otherToolCalls = toolCalls.filter((tc) => tc.function.name !== 'propose_plan')
      const deferredResults: ToolResult[] = otherToolCalls.map((tc) => ({
        tool_call_id: tc.id,
        name: tc.function.name,
        content: '该操作未执行：执行计划刚被确认，请在下一轮基于已确认计划重新发起工具调用。',
        success: false,
      }))
      const allResults = [planResult, ...deferredResults]
      onEvent?.({ type: 'tool_results', results: allResults })

      workingMessages.push({
        role: 'tool',
        content: planResult.content,
        tool_call_id: planResult.tool_call_id,
      })
      for (const result of deferredResults) {
        workingMessages.push({
          role: 'tool',
          content: result.content,
          tool_call_id: result.tool_call_id,
        })
      }
      continue
    }

    // ── 风险评估（非 propose_plan 的普通工具调用）──
    const risks = assessToolCallsRisk(toolCalls, workspace)

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
        await finalizeAndDone(lastAssistantText, 'aborted')
        return
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

        // 用户拒绝 → 将拒绝信息作为工具结果反馈给 LLM
        const deniedResults: ToolResult[] = toolCalls.map((tc) => ({
          tool_call_id: tc.id,
          name: tc.function.name,
          content: '用户拒绝了此操作。请先重新评估方案，说明替代做法或再次请求许可；在用户明确同意前不要直接执行。',
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
      const hasDesktopRisk = risks.some((r) => r.toolName.startsWith('desktop_'))
      if (hasDesktopRisk) {
        setDesktopAutoApproved(true)
        log('DESKTOP_AUTO_APPROVED', { msg: '用户已确认桌面操作，后续自动放行' }, logScope)
      }
    }

    // ── 检查是否被中断（在执行工具之前）──
    if (signal?.aborted) {
      log('AGENT_ABORTED', { round, reason: 'signal aborted before tool execution' }, logScope)
      await finalizeAndDone(lastAssistantText, 'aborted')
      return
    }

    // ── 执行工具（限制在 workspace 内，异步不阻塞主进程）──
    trackToolCallsInputs(toolCalls)
    const results = await executeToolCalls(toolCalls, workspace, signal, logScope, projectId, {
      allowedToolNames,
      activatedSkillIds,
    })
    if (signal?.aborted) {
      log('AGENT_ABORTED', { round, reason: 'signal aborted during tool execution' }, logScope)
      await finalizeAndDone(lastAssistantText, 'aborted')
      return
    }
    trackFileChanges(results)
    trackToolResultsCore(results)

    // 通知前端：工具执行结果
    onEvent?.({ type: 'tool_results', results })

    // 追加 tool 结果消息（对超长结果进行截断以避免上下文膨胀）
    for (const result of results) {
      workingMessages.push({
        role: 'tool',
        content: truncateToolResultForContext(result),
        tool_call_id: result.tool_call_id,
      })
    }

    // 继续循环，让 LLM 处理工具结果
  }

  // 超出最大轮次
  await persistTaskCoreLogWithOutcome(lastAssistantText, 'error', `Agent exceeded max tool rounds (${MAX_TOOL_ROUNDS})`)
  onEvent?.({ type: 'error', message: `Agent exceeded max tool rounds (${MAX_TOOL_ROUNDS})` })
  } finally {
    restoreSkillEnv()
  }
}
