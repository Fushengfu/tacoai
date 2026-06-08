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

function estimateReplayBudgetChars(contextLength?: number, replayMode: 'full' | 'compact' = 'full'): number {
  const defaultBudget = replayMode === 'compact' ? 9000 : 18000
  if (typeof contextLength !== 'number' || !Number.isFinite(contextLength) || contextLength <= 0) {
    return defaultBudget
  }
  const ratio = replayMode === 'compact' ? 0.12 : 0.2
  const approxChars = Math.floor(contextLength * 3.4 * ratio)
  const min = replayMode === 'compact' ? 5000 : 12000
  const max = replayMode === 'compact' ? 32000 : 64000
  return Math.max(min, Math.min(max, approxChars))
}

function extractReplayAssistantResult(item: TaskMemoryEntry): string {
  // 直接使用AI完整回复,不再从摘要提取
  const assistantResult = String(item.assistantResult || '').trim()
  return `[HISTORICAL_TASK_RESULT]\n${assistantResult}\n[/HISTORICAL_TASK_RESULT]`
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
  replayedTaskMemories: TaskMemoryEntry[]
  droppedReplayCount: number
  droppedReplayByLimitCount: number
  droppedReplayByBudgetCount: number
  recallMeta: RecallMeta
  recallDebug: RecallDebugCandidate[]
}> {
  let normalizedQuery = ''
  // 保留原始 content 数组中的图片/视频/音频 URL，避免被记忆回放替换后丢失
  const mediaParts: Array<
    | { type: 'image_url'; image_url: { url: string } }
    | { type: 'video_url'; video_url: { url: string } }
    | { type: 'audio_url'; audio_url: { url: string } }
  > = []
  if (typeof userQuery === 'string') {
    normalizedQuery = userQuery
  } else if (Array.isArray(userQuery)) {
    normalizedQuery = (userQuery as Array<{type?: string; text?: string}>)
      .filter((part) => part.type === 'text')
      .map((part) => part.text || '')
      .join('\n')
    // 提取媒体类型部分（image_url / video_url / audio_url）
    for (const part of userQuery as Array<{type?: string; image_url?: {url?: string}; video_url?: {url?: string}; audio_url?: {url?: string}}>) {
      if (part.type === 'image_url' && part.image_url?.url) {
        mediaParts.push({ type: 'image_url', image_url: { url: part.image_url.url } })
      } else if (part.type === 'video_url' && part.video_url?.url) {
        mediaParts.push({ type: 'video_url', video_url: { url: part.video_url.url } })
      } else if (part.type === 'audio_url' && part.audio_url?.url) {
        mediaParts.push({ type: 'audio_url', audio_url: { url: part.audio_url.url } })
      }
    }
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
  const replayBudgetChars = estimateReplayBudgetChars(options?.contextLength, replayMode)
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
    
    // 历史用户提问（按 role=user 注入）
    messages.push({
      role: 'user',
      content: userText,
    })
    // 历史处理总结（按 role=assistant 注入，用 [HISTORICAL_TASK_RESULT] 标签包裹）
    messages.push({
      role: 'assistant',
      content: assistantText,
    })
  }
  // 构建最后一条用户消息：如果有媒体附件，使用数组格式保留 image_url 等内容
  const wrappedText = wrapUserQueryText(normalizedQuery)
  if (mediaParts.length > 0) {
    const contentParts: ChatMessage['content'] = [
      { type: 'text', text: wrappedText },
      ...mediaParts,
    ]
    messages.push({ role: 'user', content: contentParts })
  } else {
    messages.push({ role: 'user', content: wrappedText })
  }

  return {
    messages,
    noteMessages,
    notes: recalled.notes,
    recalled: recalled.recalled,
    replayedTaskMemories,
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
