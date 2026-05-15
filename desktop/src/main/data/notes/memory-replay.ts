/**
 * 对话回放构建
 *
 * 负责将历史记忆回放为对话消息，构建背景上下文。
 */

import type { ProjectNote } from '../../../shared/ipc'
import type { ChatMessage } from '../../ai/llm'
import { extractUserAssetsBlock, extractUserQueryText } from '../../../shared/user-assets'
import { shortText } from './memory-utils'
import type { TaskMemoryEntry } from './memory-normalize'
import type { MemorySnapshotEntry } from './memory-snapshot'
import { memorySnapshotTimestamp } from './memory-snapshot'
import { recallBackgroundContext } from './memory-recall'
import type { RecalledItem, RecallMeta, RecallDebugCandidate, BuildBackgroundContextOptions } from './memory-recall'

/* ------------------------------------------------------------------ */
/*  类型                                                                 */
/* ------------------------------------------------------------------ */

export type BuildBackgroundContextConversationOptions = BuildBackgroundContextOptions & {
  replayMode?: 'full' | 'compact'
}

/* ------------------------------------------------------------------ */
/*  工具函数                                                             */
/* ------------------------------------------------------------------ */

function stripControlChars(input: string): string {
  return String(input ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
}

export function wrapUserQueryText(input: string, assetsOverride?: string): string {
  const plain = extractUserQueryText(input)
  const inferredAssets = extractUserAssetsBlock(input)
  const assetsBlock = stripControlChars(String(assetsOverride ?? inferredAssets)).trim()
  if (!assetsBlock) return `[USER_QUERY]\n${plain}\n[/USER_QUERY]`
  return [
    '[USER_QUERY]',
    plain,
    '[/USER_QUERY]',
    '',
    '[USER_ASSETS]',
    assetsBlock,
    '[/USER_ASSETS]',
  ].join('\n')
}

function taskMemoryTimestamp(item: TaskMemoryEntry): number {
  const created = Date.parse(item.createdAt || '')
  if (Number.isFinite(created)) return created
  const updated = Date.parse(item.updatedAt || '')
  if (Number.isFinite(updated)) return updated
  return 0
}

function sortTaskMemoriesAsc(items: TaskMemoryEntry[]): TaskMemoryEntry[] {
  return [...items].sort((a, b) => {
    const ta = taskMemoryTimestamp(a)
    const tb = taskMemoryTimestamp(b)
    if (ta !== tb) return ta - tb
    return String(a.id).localeCompare(String(b.id))
  })
}

function estimateReplayBudgetChars(maxTokens?: number, replayMode: 'full' | 'compact' = 'full'): number {
  const defaultBudget = replayMode === 'compact' ? 9000 : 18000
  if (typeof maxTokens !== 'number' || !Number.isFinite(maxTokens) || maxTokens <= 0) {
    return defaultBudget
  }
  const ratio = replayMode === 'compact' ? 0.12 : 0.2
  const approxChars = Math.floor(maxTokens * 3.4 * ratio)
  const min = replayMode === 'compact' ? 5000 : 12000
  const max = replayMode === 'compact' ? 32000 : 64000
  return Math.max(min, Math.min(max, approxChars))
}

function extractReplayAssistantResult(item: TaskMemoryEntry): string {
  // 直接使用AI完整回复,不再从摘要提取
  const assistantResult = String(item.assistantResult || '').trim()
  return assistantResult
}

/* ------------------------------------------------------------------ */
/*  回放构建                                                              */
/* ------------------------------------------------------------------ */

export async function buildBackgroundContextConversationMessages(
  workspace: string,
  userQuery: string | unknown,
  projectId?: string,
  options?: BuildBackgroundContextConversationOptions,
): Promise<{
  messages: ChatMessage[]
  noteMessages: ChatMessage[]
  notes: ProjectNote[]
  recalled: RecalledItem[]
  replayedSnapshots: MemorySnapshotEntry[]
  replayedTaskMemories: TaskMemoryEntry[]
  droppedSnapshotReplayCount: number
  droppedReplayCount: number
  droppedReplayByLimitCount: number
  droppedReplayByBudgetCount: number
  recallMeta: RecallMeta
  recallDebug: RecallDebugCandidate[]
}> {
  let normalizedQuery = ''
  if (typeof userQuery === 'string') {
    normalizedQuery = userQuery
  } else if (Array.isArray(userQuery)) {
    normalizedQuery = (userQuery as Array<{type?: string; text?: string}>)
      .filter((part) => part.type === 'text')
      .map((part) => part.text || '')
      .join('\n')
  } else {
    normalizedQuery = String(userQuery ?? '')
  }
  
  if (normalizedQuery.includes('[USER_QUERY]')) {
    const match = normalizedQuery.match(/\[USER_QUERY\]([\s\S]*?)\[\/USER_QUERY\]/i)
    if (match && match[1]) {
      normalizedQuery = match[1].trim()
    }
  }
  
  const recalled = await recallBackgroundContext(workspace, projectId, normalizedQuery, options)
  const replayMode = options?.replayMode ?? (options?.reason === 'post_compress' ? 'compact' : 'full')
  const replayBudgetChars = estimateReplayBudgetChars(options?.maxTokens, replayMode)
  const safeUserQuery = extractUserQueryText(normalizedQuery)
  const userAssetsBlock = extractUserAssetsBlock(normalizedQuery)

  const orderedTaskMemories = sortTaskMemoriesAsc(recalled.taskMemories)
  const taskLimit = replayMode === 'compact' ? 12 : 30
  const taskCandidatesRaw = orderedTaskMemories.slice(-taskLimit)

  const seenContentKeys = new Set<string>()
  const taskCandidates: TaskMemoryEntry[] = []
  for (let i = taskCandidatesRaw.length - 1; i >= 0; i--) {
    const item = taskCandidatesRaw[i]
    const userText = String(item.userQuery || '').trim()
    const contentKey = userText.toLowerCase().replace(/\s+/g, ' ')
    if (seenContentKeys.has(contentKey)) continue
    seenContentKeys.add(contentKey)
    taskCandidates.unshift(item)
  }

  const replayedSnapshots: MemorySnapshotEntry[] = []

  let usedChars = safeUserQuery.length + (userAssetsBlock ? userAssetsBlock.length + 32 : 0)

  const selectedFromEnd: TaskMemoryEntry[] = []
  let droppedReplayByLimitCount = 0
  let droppedReplayByBudgetCount = 0

  for (let i = taskCandidates.length - 1; i >= 0; i--) {
    if (selectedFromEnd.length >= taskLimit) {
      droppedReplayByLimitCount++
      continue
    }
    const item = taskCandidates[i]
    const userText = String(item.userQuery || '').trim()
    const userAssets = String(item.userAssetsBlock || '').trim()
    const assistantText = extractReplayAssistantResult(item)
    
    const hasUserMessage = Boolean(userText || userAssets)
    const hasAssistantMessage = Boolean(assistantText)
    if (!hasUserMessage || !hasAssistantMessage) continue
    
    if (!userText && !assistantText && !userAssets) continue
    const pairSize = userText.length + assistantText.length + userAssets.length + 48
    if (usedChars + pairSize > replayBudgetChars && selectedFromEnd.length > 0) {
      droppedReplayByBudgetCount++
      continue
    }
    selectedFromEnd.push(item)
    usedChars += pairSize
  }

  const droppedReplayCount = droppedReplayByLimitCount + droppedReplayByBudgetCount
  const replayedTaskMemories = selectedFromEnd.reverse()

  const noteMessages: ChatMessage[] = []
  const recalledNoteIds = new Set(recalled.recalled.filter((item) => item.source === 'note').map((item) => item.id))
  const recalledNotes = recalled.notes.filter((item) => recalledNoteIds.has(item.id))
  for (const note of recalledNotes) {
    const noteContent = `[项目笔记]\n标题: ${note.title}\n分类: ${note.category || '未分类'}\n内容: ${note.content}\n[/项目笔记]`
    noteMessages.push({
      role: 'user',
      content: `[系统注入] 以下是相关的项目背景知识：\n\n${noteContent}`,
    })
  }

  const messages: ChatMessage[] = []
  for (const item of replayedTaskMemories) {
    const userText = String(item.userQuery || '').trim()
    const userAssets = String(item.userAssetsBlock || '').trim()
    const assistantText = extractReplayAssistantResult(item)
    
    const hasUserMessage = Boolean(userText || userAssets)
    const hasAssistantMessage = Boolean(assistantText)
    
    if (!hasUserMessage || !hasAssistantMessage) {
      continue
    }
    
    // 按照设计方案: 使用[历史任务]标注,而非直接回放原始对话
    messages.push({
      role: 'user',
      content: `[历史任务] 用户提问:\n${userText}`,
    })
    messages.push({
      role: 'assistant',
      content: `[历史任务] AI回复:\n${assistantText}`,
    })
  }
  messages.push({ role: 'user', content: wrapUserQueryText(normalizedQuery) })

  return {
    messages,
    noteMessages,
    notes: recalled.notes,
    recalled: recalled.recalled,
    replayedSnapshots,
    replayedTaskMemories,
    droppedSnapshotReplayCount: 0,
    droppedReplayCount,
    droppedReplayByLimitCount,
    droppedReplayByBudgetCount,
    recallMeta: recalled.meta,
    recallDebug: recalled.debugCandidates,
  }
}

export async function inferIntentFromBackground(
  workspace: string,
  userQuery: string,
  projectId?: string,
  options?: BuildBackgroundContextOptions,
): Promise<Pick<RecallMeta, 'intentSource' | 'intentType' | 'intentSummary' | 'intentGoal'>> {
  const recalled = await recallBackgroundContext(workspace, projectId, userQuery, options)
  return {
    intentSource: recalled.meta.intentSource,
    intentType: recalled.meta.intentType,
    intentSummary: recalled.meta.intentSummary,
    intentGoal: recalled.meta.intentGoal,
  }
}
