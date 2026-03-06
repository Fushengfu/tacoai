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

import type { ChatMessage, ProviderOverrides, TokenUsage } from './llm'
import type { ProviderKey } from './llm'
import { requestChatCompletion, requestStreamWithTools } from './llm'
import { getAllToolDefinitions, executeToolCalls, assessToolCallsRisk, setBrowserAutoApproved, setDesktopAutoApproved, getWorkspaceTree, getToolDesignPromptBlock } from './tools'
import type { ToolCall, ToolResult, RiskInfo } from './tools'
import { log } from './logger'
import { gitCommit, gitEnsureRepo } from './git'
import { getActiveSkillInstructions } from './skills'
import { buildBackgroundContextConversationMessages, inferIntentFromBackground, recordMemorySnapshot, recordTaskLog } from './notes'
import type { RecallMeta } from './notes'
import { buildAgentRequestMessages, validateCompletionClaim } from './context-builder'
import { applyRewardScore } from './reward-score'

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

function sanitizeUserFacingText(input: string): string {
  let output = String(input ?? '')
  for (const rule of USER_VISIBLE_SOURCE_PHRASE_RULES) {
    output = output.replace(rule.pattern, rule.replacement)
  }
  return output
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

/**
 * Agent 循环内的上下文 AI 摘要压缩。
 *
 * 策略：
 * 1. 仅使用 usage.total_tokens 判断是否需要压缩
 * 2. 触发压缩时，保留 system prompt，其余全部历史做 AI 压缩替换
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
  usageTotalTokensHint?: number,
  signal?: AbortSignal,
  logScope?: string,
  onRecallMeta?: (meta: RecallMeta) => void,
): Promise<number> {
  const threshold = Math.floor(tokenBudget * 0.80) // 留 20% 给回复

  // 仅接受 usage.total_tokens 作为压缩触发依据
  if (!(typeof usageTotalTokensHint === 'number' && Number.isFinite(usageTotalTokensHint) && usageTotalTokensHint > 0)) {
    return 0
  }
  const total = usageTotalTokensHint
  if (total <= threshold) return 0

  // 保留 system 消息，压缩其余全部历史
  if (msgs.length <= 1) return 0
  const toCompress = msgs.slice(1)
  const compressCount = toCompress.length
  if (compressCount <= 0) return 0

  log('AGENT_CONTEXT_SUMMARIZE_START', {
    sourceTotalTokens: usageTotalTokensHint,
    totalTokens: total,
    budget: tokenBudget,
    compressCount,
    keepSystemOnly: true,
  }, logScope)

  // ── 第四步：调用 AI 生成摘要 ──
  const summary = await summarizeMessages(provider, overrides, toCompress, signal, logScope)

  // ── 第五步：用摘要替换旧消息 ──
  const summaryMsg: ChatMessage = {
    role: 'assistant',
    content: `[全量历史压缩记录 — 以下是之前 ${compressCount} 条消息的压缩上下文，不代表任务已完成]\n\n${summary}\n\n[压缩记录结束 — 请基于以上记录和后续最新消息继续执行任务]`,
  }

  // 替换 system 之后的全部历史为摘要
  msgs.splice(1, compressCount, summaryMsg)

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

  // ── 第六步：压缩后按需召回项目上下文，并重新放入最新用户目标 ──
  try {
    const injected = await buildBackgroundContextConversationMessages(
      workspace,
      userQuery,
      projectId,
      {
        usageTotalTokens: usageTotalTokensHint,
        maxTokens: tokenBudget,
        reason: 'post_compress',
        replayMode: 'compact',
        provider,
        overrides,
        signal,
        logScope,
      },
    )
    msgs.push(...injected.messages)
    onRecallMeta?.(injected.recallMeta)
    log('AGENT_BACKGROUND_CONTEXT_RECALLED_AFTER_COMPRESS', {
      replayedSnapshots: injected.replayedSnapshots.length,
      droppedSnapshotReplayCount: injected.droppedSnapshotReplayCount,
      replayedTurns: injected.replayedTaskMemories.length,
      droppedReplayCount: injected.droppedReplayCount,
      recalledCount: injected.recalled.length,
      recallMeta: injected.recallMeta,
      recalled: injected.recalled,
      ...(recallDebug ? { recallDebug: injected.recallDebug } : {}),
    }, logScope)
  } catch (err) {
    log('AGENT_BACKGROUND_CONTEXT_RECALL_AFTER_COMPRESS_FAIL', { error: err instanceof Error ? err.message : String(err) }, logScope)
    msgs.push({
      role: 'user',
      content: userQuery,
    })
  }

  log('AGENT_CONTEXT_SUMMARIZE_DONE', {
    compressed: compressCount,
    beforeTokens: total,
    afterTokens: undefined,
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
  recallDebug = false,
): Promise<void> {
  const taskStartedAt = Date.now()
  // 确保工作空间是 git 仓库
  try {
    await gitEnsureRepo(workspace)
  } catch (err) {
    log('GIT_INIT_FAIL', { error: err instanceof Error ? err.message : String(err) }, logScope)
  }

  // 将启用的 skills 指令注入 system prompt
  const skillInstructions = getActiveSkillInstructions()
  const workingMessages = [...messages]
  const lastUserGoal = [...messages].reverse().find((m) => m.role === 'user')?.content?.trim() || ''
  const plainUserQuery = extractUserQueryText(lastUserGoal)
  const userAssetsBlock = extractUserAssetsBlock(lastUserGoal)
  let latestRecallMeta: Pick<RecallMeta, 'intentSource' | 'intentType' | 'intentSummary' | 'intentGoal'> | null = null

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

    // Skills 注入
    if (skillInstructions.length > 0) {
      extraPrompt += '\n\n# 已启用的 Skills\n以下是你应当遵循的额外能力指令：\n\n' + skillInstructions.join('\n\n---\n\n')
    }

    // 工作空间目录结构注入（让 AI 从一开始就了解项目全貌，减少重复 list_dir 调用）
    try {
      const tree = await getWorkspaceTree(workspace, 6, true)
      if (tree) {
        extraPrompt += '\n\n# 当前工作空间目录结构\n以下是项目目录树（自动生成，无需再次调用 list_dir 查看根目录结构）：\n```\n' + tree + '\n```\n注意：此目录树在对话开始时生成。如果你在执行过程中创建了新文件，目录树不会实时更新，可按需调用 list_dir 查看最新状态。'
      }
    } catch (err) {
      log('WORKSPACE_TREE_FAIL', { error: err instanceof Error ? err.message : String(err) }, logScope)
    }

    // 工具设计清单注入（与后端工具 schema 同步）
    try {
      extraPrompt += `\n\n${getToolDesignPromptBlock()}`
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
      if (result.fileChange?.filePath) changedFiles.add(result.fileChange.filePath)
      if (result.fileChange?.oldContent) {
        for (const id of extractIdentifiers(result.fileChange.oldContent)) touchedIdentifiers.add(id)
      }
      if (result.fileChange?.newContent) {
        for (const id of extractIdentifiers(result.fileChange.newContent)) touchedIdentifiers.add(id)
      }
      if (!result.success && failureLogs.length < 12) {
        failureLogs.push(`${result.name}: ${compactLine(result.content, 320)}`)
      }
    }
  }

  async function persistTaskCoreLog(
    finalSummary: string,
    outcome: 'success' | 'aborted' | 'error' = 'success',
  ): Promise<void> {
    if (!workspace || !workspace.trim()) return
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
          failures: failureLogs.slice(0, 12),
        },
        projectId,
      )
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

  function cleanupAssistantText(text: string): string {
    return String(text ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
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
      await compressAgentContext(
        workingMessages,
        tokenBudget,
        provider,
        overrides,
        workspace,
        lastUserGoal,
        projectId,
        recallDebug,
        lastUsageTotalTokens,
        signal,
        logScope,
        (meta) => { latestRecallMeta = meta },
      )
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

    const requestMessages = buildAgentRequestMessages(workingMessages, {
      round,
      goal: lastUserGoal,
      toolUsageCount,
      changedFiles,
      touchedFiles,
      touchedIdentifiers,
      failures: failureLogs,
      currentPlan,
    })

    log('AGENT', { round, messageCount: requestMessages.length }, logScope)

    let textContent = ''
    let rawTextContent = ''
    let emittedSanitizedText = ''
    let toolCalls: ToolCall[] = []

    try {
      for await (const event of requestStreamWithTools(
        provider,
        requestMessages,
        overrides,
        { tools: getAllToolDefinitions(), toolChoice: 'auto' },
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
        } else if (event.type === 'usage') {
          if (typeof event.usage.totalTokens === 'number' && Number.isFinite(event.usage.totalTokens)) {
            lastUsageTotalTokens = event.usage.totalTokens
          }
          onEvent?.({ type: 'usage', usage: event.usage })
        } else if (event.type === 'tool_calls') {
          toolCalls = event.toolCalls
        }
      }

      const finalSanitizedText = sanitizeUserFacingText(rawTextContent)
      const tailDelta = finalSanitizedText.slice(emittedSanitizedText.length)
      if (tailDelta) onEvent?.({ type: 'text', content: tailDelta })
      textContent = finalSanitizedText
      lastAssistantText = textContent
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
          lastUsageTotalTokens,
          signal,
          logScope,
          (meta) => { latestRecallMeta = meta },
        )
        if (dropped > 0) {
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
        log('AGENT_COMPLETION_REJECTED', {
          round,
          rejectCount: completionRejectCount,
          reason: completionValidation.reason,
        }, logScope)
        workingMessages.push({
          role: 'assistant',
          content: textContent || '',
        })
        workingMessages.push({
          role: 'system',
          content: `完成校验未通过：${completionValidation.reason}。你必须继续执行并给出可验证证据（工具调用结果、文件变更、命令输出或页面状态），禁止直接输出“已完成”。`,
        })
        if (completionRejectCount >= 10) {
          await persistTaskCoreLogWithOutcome(textContent || lastAssistantText, 'error', `完成校验连续未通过已达上限(${completionRejectCount})`)
          onEvent?.({ type: 'error', message: `完成校验连续未通过已达上限(${completionRejectCount})：${completionValidation.reason}` })
          return
        }
        continue
      }
      completionRejectCount = 0

      const finalPlan = currentPlan
      const unfinishedPlanSteps = finalPlan
        ? finalPlan.steps
            .map((step, index) => ({ step, index }))
            .filter(({ step }) => step.status === 'pending' || step.status === 'in_progress')
        : []
      if (finalPlan && unfinishedPlanSteps.length > 0) {
        // 兜底：避免前端显示“计划未完成”但模型已经结束时完全无标识
        for (const { index, step } of unfinishedPlanSteps) {
          const status: PlanStepStatus = 'failed'
          const note = `模型结束前未更新该步骤状态（原状态: ${step.status}）`
          finalPlan.steps[index].status = status
          finalPlan.steps[index].note = note
          onEvent?.({ type: 'plan_progress', stepIndex: index, status, note })
        }
      }

      await finalizeAndDone(textContent)
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
    const results = await executeToolCalls(toolCalls, workspace, signal, logScope, projectId)
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
}
