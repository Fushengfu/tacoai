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
import { createHash } from 'node:crypto'
import type { ChatMessage, ProviderOverrides, TokenUsage } from '../../ai/llm'
import type { ProviderKey } from '../../ai/llm'
import { requestChatCompletion, requestStreamWithTools } from '../../ai/llm'
import { getFilteredToolDefinitions, buildAllowedToolNamesForRequest, executeToolCalls, assessToolCallsRisk, setBrowserAutoApproved, setDesktopAutoApproved, getWorkspaceTree, getToolDesignPromptBlock, getAutoApproveCategories } from '../../tools'
import type { ToolCall, ToolResult, RiskInfo } from '../../tools'
import { log } from '../../system/logger'
import { gitCommit, gitEnsureRepo } from '../../project/git'
import { refreshSkills, buildActiveSkillsCatalogBlock, getActiveSkillEnv, applySkillEnvironment } from '../../project/skills'
import { buildBackgroundContextConversationMessages, inferIntentFromBackground, maintainTaskMemoriesByAI, recordTaskLog } from '../../data/notes'
import type { RecallMeta } from '../../data/notes'
import { buildCurrentTaskCompressionStateCard, validateCompletionClaim } from './context-builder'
import type { ContextBuildState } from './context-builder'
import { applyRewardScore } from './reward-score'
import {
  USER_ASSETS_BLOCK_REGEX,
  extractUserQueryText,
  extractUserAssetsBlock,
  parseUserAssetEntries,
  inferAssetKind,
  collectUserMediaRefsFromContent,
  collectUserMediaRefsFromMessages,
  appendMediaRefsToSummary,
} from '../../../shared/user-assets'
import type { UserAssetEntry } from '../../../shared/user-assets'
import {
  stripInternalContextTags,
  stripPseudoToolCallArtifacts,
  sanitizeUserFacingText,
  sanitizeContextArtifacts,
  sanitizeReasoningForContext,
  sanitizeReplayRawText,
  containsPseudoToolCallSyntax,
  stripReasoningArtifacts,
} from '../../../shared/sanitize'
import { inferIntentTypeFromQuery } from '../../../shared/intent'
import { extractTextFromContent } from '../../provider/message-adapter'
import type { PlanStepStatus } from '../../../shared/ipc'
import type { AgentEvent } from './agent-types'

/* ------------------------------------------------------------------ */
/*  Agent 事件                                                         */
/* ------------------------------------------------------------------ */

export type { AgentEvent } from './agent-types'

/* ------------------------------------------------------------------ */
/*  确认等待机制 (从 error-handler.ts 导入)                              */
/* ------------------------------------------------------------------ */

import { isAbortError, waitForConfirm, waitForRetry } from './error-handler'
export { resolveConfirm, resolveRetry, isAbortError } from './error-handler'

function safeParseObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    return null
  } catch {
    return null
  }
}

const STREAM_SANITIZE_HOLD_BACK = 24

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
  const reasoning = sanitizeReasoningForContext(rawReasoning).trim()
  const primaryText = replayRawText || visibleText

  if (primaryText && reasoning) {
    if (/<think\b/i.test(primaryText)) return primaryText
    return `<think>\n${reasoning}\n</think>\n\n${primaryText}`.trim()
  }
  if (primaryText) return primaryText
  if (reasoning) return `思考：${reasoning}`
  return ''
}

 /* 工具函数 (从 context-compressor.ts 导入) */

import { compactLine, maskSensitiveText, summarizeRunCommand, extractIdentifiers, truncateToolResultForContext } from './context-compressor'

/* ------------------------------------------------------------------ */
/*  Agent 运行                                                         */
/* ------------------------------------------------------------------ */

const MAX_TOOL_ROUNDS = 1000 // 防止无限循环 
const AGENT_LOOP_TIMEOUT_MS = 24 * 60 * 60 * 1000 // 24小时超时
let confirmCounter = 0

/* ------------------------------------------------------------------ */
/*  AI 摘要压缩                                                        */
/* ------------------------------------------------------------------ */

/* 上下文压缩 (从 context-compressor.ts 导入) */
import {
  summarizeMessages,
  summarizeCurrentTaskProgress,
  compressAgentContext,
} from './context-compressor'

/**
 * 调用 LLM 为一组早期消息生成摘要。
 * @param onEvent      事件回调，每次有新事件时调用
 * @param contextLength 上下文窗口大小（token 数），用于自动压缩
 * @param signal       AbortSignal，外部可通过它终止 agent 循环
 */
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
): Promise<void> {
  const taskStartedAt = Date.now()
  const isGitAutoOpsEnabled = () => getAutoApproveCategories().includes('git_ops')
  
  // 超时保护
  const loopTimeoutTimer = setTimeout(() => {
    log('AGENT_TIMEOUT_WARNING', { 
      timeout: AGENT_LOOP_TIMEOUT_MS,
      message: 'Agent 运行时间过长,可能存在无限循环'
    }, logScope)
  }, AGENT_LOOP_TIMEOUT_MS)
  
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

  // 构建 user_id：基于 API key + 项目 ID 的哈希，用于 KVCache 缓存隔离
  const resolvedApiKey = (overrides?.[provider] as any)?.apiKey ?? ''
  const userIdSource = `${resolvedApiKey}:${projectId ?? workspace}`
  const userId = createHash('sha256').update(userIdSource).digest('hex').slice(0, 32)

  const workingMessages = [...messages]
  const activatedSkillIds = new Set<string>()
  // 提取用户目标文本（支持 content 为数组格式）
  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')
  const lastUserGoal = lastUserMsg ? extractTextFromContent(lastUserMsg.content).trim() : ''
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
    const current = typeof workingMessages[0].content === 'string' 
      ? workingMessages[0].content 
      : extractTextFromContent(workingMessages[0].content)
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
      // 提取用户原始查询文本,支持 content 为字符串或数组类型
      const userMessage = workingMessages[lastUserIdx]
      const userContent: unknown = userMessage.content
      let rawUserQuery = ''
      
      if (typeof userContent === 'string') {
        rawUserQuery = userContent
      } else if (Array.isArray(userContent)) {
        // content 是数组时,提取所有 text 类型的部分
        rawUserQuery = (userContent as Array<{type?: string; text?: string}>)
          .filter((part) => part.type === 'text')
          .map((part) => part.text || '')
          .join('\n')
        
        // 如果 content 是数组且包含图片,需要将图片信息附加到查询中
        const imageParts = (userContent as Array<{type?: string; image_url?: {url?: string}}>)
          .filter((part) => part.type === 'image_url')
          .map((part) => part.image_url?.url)
          .filter(Boolean)
        
        if (imageParts.length > 0) {
          // 将图片 URL 转换为 [USER_ASSETS] 格式
          const assetsBlock = `[USER_ASSETS]\n${imageParts.map((url) => `- type: image\n  path: ${url}`).join('\n')}\n[/USER_ASSETS]`
          rawUserQuery = rawUserQuery ? `${rawUserQuery}\n\n${assetsBlock}` : assetsBlock
        }
      } else {
        rawUserQuery = String(userContent ?? '')
      }
      
      // 处理 message.images 字段中的图片(data URL 或 URL)
      const messageImages = userMessage.images
      if (messageImages && messageImages.length > 0) {
        const assetsBlock = `[USER_ASSETS]\n${messageImages.map((url) => `- type: image\n  path: ${url}`).join('\n')}\n[/USER_ASSETS]`
        rawUserQuery = rawUserQuery ? `${rawUserQuery}\n\n${assetsBlock}` : assetsBlock
      }
      
      // 如果已经被包装过,提取原始内容,避免重复包装
      if (rawUserQuery.includes('[USER_QUERY]')) {
        const match = rawUserQuery.match(/\[USER_QUERY\]([\s\S]*?)\[\/USER_QUERY\]/i)
        if (match && match[1]) {
          rawUserQuery = match[1].trim()
        }
      }
      
      const injected = await buildBackgroundContextConversationMessages(
        workspace,
        userContent,
        projectId,
        {
          contextLength,
          reason: 'initial',
          replayMode: 'full',
          provider,
          overrides,
          signal,
          logScope,
        },
      )

      // 项目笔记注入：紧接系统提示之后（索引 1），在任务记忆回放之前
      if (injected.noteMessages.length > 0) {
        const insertIdx = workingMessages.length > 0 && workingMessages[0].role === 'system' ? 1 : 0
        workingMessages.splice(insertIdx, 0, ...injected.noteMessages)
      }

      // 任务记忆回放：替换system之后的所有消息(避免与当前会话历史重复)
      const systemMsgCount = workingMessages.filter(m => m.role === 'system').length
      const historyStartIdx = systemMsgCount > 0 ? systemMsgCount : 0
      workingMessages.splice(historyStartIdx, workingMessages.length - historyStartIdx, ...injected.messages)
      currentTaskStartIndex = historyStartIdx + injected.messages.length - 1

      latestRecallMeta = {
        intentSource: injected.recallMeta.intentSource,
        intentType: injected.recallMeta.intentType,
        intentSummary: injected.recallMeta.intentSummary,
        intentGoal: injected.recallMeta.intentGoal,
      }
      log('BACKGROUND_CONTEXT_REPLAY_INJECTED', {
        lastUserIndex: lastUserIdx,
        replayedTurns: injected.replayedTaskMemories.length,
        droppedReplayCount: injected.droppedReplayCount,
        droppedReplayByLimitCount: injected.droppedReplayByLimitCount,
        droppedReplayByBudgetCount: injected.droppedReplayByBudgetCount,
        notesCount: injected.notes.length,
        noteMessagesCount: injected.noteMessages.length,
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
      const tree = await getWorkspaceTree(workspace, { maxDepth: 10 })
      if (tree && tree.text) {
        extraPrompt += '\n\n# 当前工作空间目录结构\n以下是项目目录树（自动生成，无需再次调用 list_dir 查看根目录结构）：\n```\n' + tree.text + '\n```\n注意：此目录树在对话开始时生成。如果你在执行过程中创建了新文件，目录树不会实时更新，可按需调用 list_dir 查看最新状态。'
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
      const currentContent = typeof workingMessages[0].content === 'string' 
        ? workingMessages[0].content 
        : extractTextFromContent(workingMessages[0].content)
      workingMessages[0] = { ...workingMessages[0], content: currentContent + extraPrompt }
    }
  }
  let round = 0
  let hasFileChanges = false // 跟踪整个 agent 运行期间是否有文件变更

  // 当前活跃的执行计划（用于跟踪步骤进度）
  let currentPlan: { summary: string; reasoning?: string; steps: Array<{ index: number; title: string; content: string; status: PlanStepStatus; note?: string }> } | null = null
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
    // 调试日志:检查记忆保存条件
    log('TASK_PERSIST_CHECK', {
      workspace: workspace ? `[${workspace}]` : '(empty)',
      projectId: projectId ? `[${projectId}]` : '(empty)',
      outcome,
      summaryLength: finalSummary?.length || 0,
    }, logScope)
    
    if ((!workspace || !workspace.trim()) && (!projectId || !projectId.trim())) {
      log('TASK_PERSIST_SKIPPED_NO_SCOPE', {
        workspace,
        projectId,
      }, logScope)
      return
    }
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
      const userMediaRefs = collectUserMediaRefsFromContent(lastUserGoal)
      const summaryWithMediaRefs = appendMediaRefsToSummary(finalSummary, userMediaRefs)
      
      const savedTaskMemory = await recordTaskLog(
        workspace,
        {
          userQuery: plainUserQuery || lastUserGoal,  // 用户原始提问
          ...(userAssetsBlock ? { userAssetsBlock } : {}),
          assistantResult: summaryWithMediaRefs,  // AI完整回复
          outcome,
          tools,
          changedFiles: modifiedFiles.slice(0, 80),
          fileDiffs: [],  // TODO: 后续添加文件diff收集逻辑
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
      const contentText = lastUserMsg 
        ? (typeof lastUserMsg.content === 'string' ? lastUserMsg.content : extractTextFromContent(lastUserMsg.content))
        : ''
      const plainUserSummary = extractUserQueryText(contentText)
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

  const tokenBudget = contextLength ?? 131072
  let lastUsageTotalTokens: number | undefined
  let contextRetries = 0
  let lastAssistantText = ''
  let completionRejectCount = 0
  let pseudoToolCallRejectCount = 0
  let enforceStandardToolCall = false
  let completionValidationHint = ''
  let autoNetworkRetryCount = 0
  let autoEmptyRetryCount = 0

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
        outcome,
        workspace,
        projectId,
        requestId: `${projectId || workspace || 'global'}:${Date.now()}`,
        toolCalls,
        changedFiles: changedFiles.size,
        failures: failureLogs.length + (errorMessage ? 1 : 0),
        elapsedMs: Math.max(0, Date.now() - taskStartedAt),
      })
    } catch (err) {
      log('REWARD_SCORE_APPLY_FAIL', { error: err instanceof Error ? err.message : String(err) }, logScope)
    }
  }

  async function finalizeAndDone(
    summaryText: string,
    outcome: 'success' | 'aborted' = 'success',
    finalText?: string,
  ): Promise<void> {
    await persistTaskCoreLogWithOutcome(summaryText, outcome)
    onEvent?.({ type: 'done', finalText: outcome === 'success' ? finalText : undefined })
  }

  function finalizePendingPlanStepsIfNeeded() {
    const finalPlan = currentPlan
    const unfinishedPlanSteps = finalPlan
      ? finalPlan.steps
          .filter((step) => step.status === 'pending' || step.status === 'in_progress')
      : []
    if (!finalPlan || unfinishedPlanSteps.length === 0) return

    // 先将遗留步骤落为 failed，避免完成校验因“仍有未完成步骤”进入死循环。
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

  function pushAssistantMessageIfNew(content: string): boolean {
    const normalized = String(content ?? '').trim()
    if (!normalized) return false
    const lastMessage = workingMessages[workingMessages.length - 1]
    const lastContent = lastMessage 
      ? (typeof lastMessage.content === 'string' ? lastMessage.content : extractTextFromContent(lastMessage.content))
      : ''
    if (lastMessage?.role === 'assistant' && String(lastContent ?? '').trim() === normalized) {
      return false
    }
    workingMessages.push({
      role: 'assistant',
      content: normalized,
    })
    return true
  }

  function getExecutionEvidenceCount(): number {
    return (
      Array.from(toolUsageCount.values()).reduce((sum, count) => sum + count, 0) +
      changedFiles.size +
      failureLogs.length
    )
  }

  function shouldTryFinalizeDirectTextReply(finalText: string): boolean {
    return Boolean(String(finalText ?? '').trim())
  }

  async function tryFinalizeReply(finalText: string): Promise<boolean> {
    finalizePendingPlanStepsIfNeeded()

    const completionValidation = validateCompletionClaim(finalText, {
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
      pushAssistantMessageIfNew(finalText)
      if (completionRejectCount >= 10) {
        await persistTaskCoreLogWithOutcome(finalText || lastAssistantText, 'error', `完成校验连续未通过已达上限(${completionRejectCount})`)
        onEvent?.({ type: 'error', message: `完成校验连续未通过已达上限(${completionRejectCount})：${completionValidation.reason}` })
        return true
      }
      return false
    }

    completionRejectCount = 0
    completionValidationHint = ''
    lastAssistantText = finalText
    await finalizeAndDone(finalText, 'success', finalText)
    return true
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
        userId,
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

    const requestMessages = workingMessages

    log('AGENT', { round, messageCount: requestMessages.length }, logScope)
    const allowedToolNames = buildAllowedToolNamesForRequest(activatedSkillIds)

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
        provider,
        requestMessages,
        overrides,
        { tools: getFilteredToolDefinitions(allowedToolNames), toolChoice: 'auto' },
        signal,
        logScope,
        userId,
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
          // 防回退：若 sanitized 因标签剥离而变短，重置已发送指针
          if (sanitizedFull.length < emittedSanitizedText.length) {
            emittedSanitizedText = sanitizedFull
          }
          // 基于 raw 文本做安全裁剪：避免 sanitize 结果长度波动破坏 delta 连续性
          const safeRawLen = Math.max(0, rawTextContent.length - STREAM_SANITIZE_HOLD_BACK)
          const safeRaw = rawTextContent.slice(0, safeRawLen)
          const sanitizedSafe = sanitizeUserFacingText(safeRaw)
          const delta = sanitizedSafe.slice(emittedSanitizedText.length)
          emittedSanitizedText = sanitizedSafe
          // 上下文仍用完整 sanitized 文本（不回退）
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

      const finalSanitizedText = sanitizeUserFacingText(rawTextContent)
      // 防回退后重新对齐：发送 emitted 指针之后且在 final 范围内的任意剩余文本
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
          userId,
        )
        currentTaskStartIndex = dropped.nextCurrentTaskStartIndex
        if (dropped.compressed > 0) {
          log('AGENT_CONTEXT_RETRY', { dropped, newMsgCount: workingMessages.length }, logScope)
          round-- // 不消耗轮次，重试当前步骤
          continue
        }
      }

      // 可恢复错误分类：网络超时、连接失败等
      const isRecoverableNetworkError = (
        msg.includes('ETIMEDOUT') ||
        msg.includes('timeout') ||
        msg.includes('ECONNRESET') ||
        msg.includes('ECONNREFUSED') ||
        msg.includes('fetch failed') ||
        msg.includes('socket hang up') ||
        msg.includes('network') ||
        msg.includes('Request failed') ||
        msg.includes('连接') ||
        msg.includes('超时')
      )

      // 可恢复错误：先自动重试 5 次，失败后再弹出重试按钮让用户确认
      if (isRecoverableNetworkError) {
        const errorType = (msg.includes('timeout') || msg.includes('超时') || msg.includes('ETIMEDOUT'))
          ? 'timeout' as const
          : 'network' as const

        autoNetworkRetryCount++

        if (autoNetworkRetryCount <= 5) {
          log('AGENT_AUTO_RETRY', { round, autoRetryCount: autoNetworkRetryCount, maxRetries: 5, errorType, error: msg }, logScope)
          round-- // 不消耗轮次
          continue // 自动重试
        }

        // 自动重试 5 次后仍失败，弹出重试按钮
        const retryId = `retry-${Date.now()}-${++confirmCounter}`
        log('AGENT_RETRYABLE_ERROR', { round, retryId, errorType, error: msg, autoRetriesExhausted: true }, logScope)

        onEvent?.({
          type: 'retry_confirm',
          retryId,
          errorType,
          errorMessage: `自动重试 ${autoNetworkRetryCount} 次后仍失败：${msg}`,
          round,
        })

        const shouldRetry = await waitForRetry(retryId, signal)
        log('AGENT_RETRY_DECISION', { retryId, shouldRetry }, logScope)

        if (signal?.aborted) {
          log('AGENT_ABORTED', { round, reason: 'signal aborted during retry confirm' }, logScope)
          await finalizeAndDone(lastAssistantText, 'aborted')
          return
        }

        if (shouldRetry) {
          autoNetworkRetryCount = 0 // 重置计数器
          round-- // 不消耗轮次
          continue // 重新发起相同的 LLM 请求
        }

        // 用户选择不重试 → 正常终止
        await persistTaskCoreLogWithOutcome(textContent || lastAssistantText, 'error', msg)
        onEvent?.({ type: 'error', message: `用户取消重试：${msg}` })
        return
      }

      // 不可恢复错误：直接终止
      await persistTaskCoreLogWithOutcome(textContent || lastAssistantText, 'error', msg)
      onEvent?.({ type: 'error', message: msg })
      return
    }

    // 没有 tool_calls 时，优先把普通文本当作正常答复处理
    if (toolCalls.length === 0) {
      const directReplyText = textContent.trim()
      if (shouldTryFinalizeDirectTextReply(directReplyText)) {
        pseudoToolCallRejectCount = 0
        log('AGENT_DIRECT_TEXT_REPLY_ATTEMPT', {
          round,
          intentType: inferIntentTypeFromQuery(lastUserGoal),
          evidenceCount: getExecutionEvidenceCount(),
          rawPreview: rawTextContent.slice(0, 800),
        }, logScope)
        if (await tryFinalizeReply(directReplyText)) return
        round--
        continue
      }

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

      const reason = '模型未返回可用文本或标准工具调用。'
      {
        autoEmptyRetryCount++

        if (autoEmptyRetryCount <= 5) {
          log('AGENT_AUTO_RETRY_EMPTY', { round, autoRetryCount: autoEmptyRetryCount, maxRetries: 5, rawPreview: rawTextContent.slice(0, 200) }, logScope)
          round-- // 不消耗轮次
          continue // 自动重试
        }

        // 自动重试 5 次后仍失败，弹出重试按钮
        const retryId = `retry-${Date.now()}-${++confirmCounter}`
        log('AGENT_EMPTY_RESPONSE', { round, retryId, rawPreview: rawTextContent.slice(0, 200), autoRetriesExhausted: true }, logScope)

        onEvent?.({
          type: 'retry_confirm',
          retryId,
          errorType: 'empty_response',
          errorMessage: `自动重试 ${autoEmptyRetryCount} 次后仍失败：${reason}`,
          round,
        })

        const shouldRetry = await waitForRetry(retryId, signal)
        log('AGENT_RETRY_DECISION', { retryId, shouldRetry }, logScope)

        if (signal?.aborted) {
          log('AGENT_ABORTED', { round, reason: 'signal aborted during retry confirm' }, logScope)
          await finalizeAndDone(lastAssistantText, 'aborted')
          return
        }

        if (shouldRetry) {
          autoEmptyRetryCount = 0 // 重置计数器
          round-- // 不消耗轮次
          continue // 重新发起相同的 LLM 请求
        }

        // 用户选择不重试 → 正常终止
        await persistTaskCoreLogWithOutcome(textContent || lastAssistantText, 'error', reason)
        onEvent?.({ type: 'error', message: `用户取消重试：${reason}` })
        return
      }
    }

    // ── 有 tool_calls：检查 propose_plan / 风险评估 → 可能需要确认 → 执行工具 ──
    pseudoToolCallRejectCount = 0
    enforceStandardToolCall = false
    completionValidationHint = ''

    // 追加 assistant 消息（含 tool_calls）。
    // 这里不要把本轮“思考/计划/开始执行”的自然语言正文继续喂回下一轮，
    // 否则部分兼容模型会被自己上一轮的计划文本反复诱导，持续重复同一工具调用。
    // 兼容推理模型：assistant+tool_calls 统一带 reasoning_content，content 仍保持空字符串。
    // 是否支持 reasoning_content 由模型配置决定，不再硬编码 provider。
    const sanitizedReasoningForToolCall = sanitizeReasoningForContext(rawReasoningContent).trim()
    const reasoningForToolCall =
      sanitizedReasoningForToolCall
      || sanitizeReasoningForContext(toolCallThinking).trim()
    const assistantToolCallContent = ''
    const assistantToolCallMessage: ChatMessage & { reasoning_content?: string } = {
      role: 'assistant',
      content: assistantToolCallContent,
      tool_calls: toolCalls
    }
    const modelSupportsReasoning = overrides?.[provider]?.supportsReasoning ?? true
    if (modelSupportsReasoning) {
      assistantToolCallMessage.reasoning_content = reasoningForToolCall || '继续'
    }
    workingMessages.push(assistantToolCallMessage)

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
          const stepIndex = args.stepIndex as number
          const status = args.status as PlanStepStatus
          const note = args.note as string | undefined

          // 更新本地计划状态：按 index 字段查找步骤（不是数组下标）
          if (currentPlan) {
            const step = currentPlan.steps.find((s) => s.index === stepIndex)
            if (step) {
              step.status = status
              if (note) step.note = note
            }
          }

          // 发射进度事件到前端
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
        currentPlan = {
          summary: planArgs.summary || '',
          reasoning: planArgs.reasoning,
          steps: steps.map((s) => ({ ...s, status: 'pending' as PlanStepStatus })),
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
  onEvent?.({ type: 'error', message: `Agent 循环次数过多(${MAX_TOOL_ROUNDS}次),已自动终止,请检查任务是否合理` })
  
  // 清理超时定时器
  clearTimeout(loopTimeoutTimer)
} finally {
    restoreSkillEnv()
    // 确保清理超时定时器
    clearTimeout(loopTimeoutTimer)
  }
}
