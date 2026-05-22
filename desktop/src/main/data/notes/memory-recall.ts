/**
 * 记忆召回
 *
 * 负责基于用户查询召回相关笔记、任务记忆和快照。
 */

import type { ProjectNote } from '../../../shared/ipc'
import type { ProviderKey, ProviderOverrides } from '../../ai/llm'
import type { ChatMessage } from '../../ai/llm'
import { requestStreamWithTools } from '../../ai/llm'
import type { ToolDefinition } from '../../tools'
import { log } from '../../system/logger'
import { extractUserAssetsBlock, extractUserQueryText } from '../../../shared/user-assets'
import { shortText, normalizeStringArray, safeParseObject, toText } from './memory-utils'
import type { TaskMemoryEntry } from './memory-normalize'
import type { MemorySnapshotEntry } from './memory-snapshot'
import { memorySnapshotTimestamp } from './memory-snapshot'
import { listNotes } from './notes-crud'
import { loadTaskMemoriesForRecall } from './memory-crud'
import { loadMemorySnapshots } from './memory-snapshot'

/* ------------------------------------------------------------------ */
/*  类型                                                                 */
/* ------------------------------------------------------------------ */

type RecallSource = 'note' | 'task' | 'snapshot'

type RecallCandidate = {
  source: RecallSource
  id: string
  title: string
  text: string
  timestamp: number
  data: ProjectNote | TaskMemoryEntry | MemorySnapshotEntry
  score: number
  reason: string[]
}

export type RecalledItem = {
  source: RecallSource
  id: string
  title: string
  score: number
  reason: string[]
  data: Record<string, unknown>
}

export type RecallMeta = {
  mode: 'normal' | 'high_pressure'
  usageTotalTokens?: number
  contextLength?: number
  pressureRatio?: number
  intentSource?: 'llm' | 'heuristic'
  intentType?: string
  intentSummary?: string
  intentGoal?: string
  candidateCount: number
  selectedCount: number
  budgetChars: number
  droppedByBudget: number
  selectionMethod?: 'tool_call' | 'heuristic'
  toolSelectionReason?: string
  toolSelectedCount?: number
}

export type RecallDebugCandidate = {
  key: string
  source: RecallSource
  id: string
  title: string
  score: number
  reason: string[]
  selected: boolean
  droppedByBudget: boolean
}

export type BuildBackgroundContextOptions = {
  usageTotalTokens?: number
  contextLength?: number
  reason?: 'initial' | 'post_compress'
  provider?: ProviderKey
  overrides?: ProviderOverrides
  recallSelectionMode?: 'heuristic' | 'tool_call'
  signal?: AbortSignal
  logScope?: string
}

type RecallSelectionIndexItem = {
  key: string
  source: RecallSource
  title: string
  digest: string
  updatedAt: string
  scoreHint: number
}

/* ------------------------------------------------------------------ */
/*  常量                                                                 */
/* ------------------------------------------------------------------ */

const RECALL_SELECTION_TOOL_NAME = 'select_background_memory'
const recallSelectionTools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: RECALL_SELECTION_TOOL_NAME,
      description: '从记忆索引中选择与当前用户问题最相关的背景记忆条目 key 列表（严格结构化返回）。',
      parameters: {
        type: 'object',
        properties: {
          selected_item_keys: {
            type: 'array',
            items: { type: 'string' },
            description: '按优先级排序的记忆条目 key 列表（格式: source:id）',
          },
          reason: {
            type: 'string',
            description: '简要说明选择依据（可选）',
          },
        },
        required: ['selected_item_keys'],
      },
    },
  },
]

/* ------------------------------------------------------------------ */
/*  工具函数                                                             */
/* ------------------------------------------------------------------ */

function stripControlChars(input: string): string {
  return String(input ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
}

function tokenize(text: string): string[] {
  const lower = String(text ?? '').toLowerCase()
  const set = new Set<string>()
  const en = lower.match(/[a-z0-9_./:-]{2,}/g) ?? []
  en.forEach((token) => set.add(token))
  const zh = lower.match(/[\u4e00-\u9fff]{2,}/g) ?? []
  zh.forEach((token) => set.add(token))
  return Array.from(set).slice(0, 120)
}

function estimateBudgetChars(contextLength?: number, usageTotalTokens?: number): { budgetChars: number; mode: 'normal' | 'high_pressure'; ratio?: number } {
  if (typeof contextLength !== 'number' || !Number.isFinite(contextLength) || contextLength <= 0) {
    return { budgetChars: 12000, mode: 'normal' }
  }
  const usage = (typeof usageTotalTokens === 'number' && Number.isFinite(usageTotalTokens) && usageTotalTokens > 0)
    ? usageTotalTokens
    : undefined
  if (!usage) return { budgetChars: 12000, mode: 'normal' }
  const ratio = usage / contextLength
  if (ratio >= 0.8) return { budgetChars: 8000, mode: 'high_pressure', ratio }
  if (ratio >= 0.6) return { budgetChars: 12000, mode: 'normal', ratio }
  return { budgetChars: 18000, mode: 'normal', ratio }
}

function toCandidateKey(source: RecallSource, id: string): string {
  return `${source}:${id}`
}

function inferIntentTypeByQuery(query: string): string {
  const text = String(query ?? '').trim().toLowerCase()
  if (!text) return 'other'
  const patterns: Array<{ type: string; words: string[] }> = [
    { type: 'debug', words: ['报错', '错误', '异常', '排查', '调试', 'debug', 'error', 'bug', '失败', 'trace', '崩溃'] },
    { type: 'implement', words: ['实现', '新增', '开发', '编写', '添加', 'create', 'implement', 'build', '完成功能'] },
    { type: 'refactor', words: ['重构', '优化', '整理', '抽离', 'refactor', 'optimize', 'cleanup', '性能'] },
    { type: 'ops', words: ['删除', '重命名', '移动', '部署', '发布', '配置', '运行', '执行', '删除文件', 'remove', 'delete', 'rm ', 'mv ', 'deploy'] },
    { type: 'qa', words: ['是什么', '为什么', '怎么', '如何', '请解释', '是否', '吗', '?', '？', 'what', 'why', 'how', 'can you'] },
  ]
  for (const row of patterns) {
    if (row.words.some((word) => text.includes(word))) return row.type
  }
  return 'other'
}

function isLikelyFollowUpQuery(query: string): boolean {
  const text = String(query ?? '').trim()
  if (!text) return false
  if (text.length > 64) return false
  const inferred = inferIntentTypeByQuery(text)
  if (inferred === 'other') return true
  return text.length <= 20 && inferred !== 'qa'
}

function toRecalledItem(candidate: RecallCandidate): RecalledItem {
  if (candidate.source === 'note') {
    const note = candidate.data as ProjectNote
    return {
      source: 'note',
      id: note.id,
      title: note.title,
      score: candidate.score,
      reason: candidate.reason,
      data: {
        category: note.category,
        content: note.content,
        updatedAt: note.updatedAt,
      },
    }
  }
  if (candidate.source === 'snapshot') {
    const snapshot = candidate.data as MemorySnapshotEntry
    return {
      source: 'snapshot',
      id: snapshot.id,
      title: '上下文压缩快照',
      score: candidate.score,
      reason: candidate.reason,
      data: {
        summary: snapshot.summary,
        sourceMessageCount: snapshot.sourceMessageCount,
        usageTotalTokens: snapshot.usageTotalTokens ?? null,
        contextLength: snapshot.contextLength ?? null,
        createdAt: snapshot.createdAt,
        updatedAt: snapshot.updatedAt,
      },
    }
  }
  const task = candidate.data as TaskMemoryEntry
  return {
    source: 'task',
    id: task.id,
    title: shortText(task.userQuery, 120) || '任务记忆',
    score: candidate.score,
    reason: candidate.reason,
    data: {
      userQuery: task.userQuery,
      userAssetsBlock: task.userAssetsBlock || '',
      assistantResult: task.assistantResult || '',
      outcome: task.outcome,
      tools: task.tools,
      changedFiles: task.changedFiles,
      failures: task.failures,
      updatedAt: task.updatedAt,
    },
  }
}

function recalledItemTimestamp(item: RecalledItem): number {
  const data = item.data as Record<string, unknown>
  const updatedAt = toText(data.updatedAt) || toText(data.createdAt)
  const ts = Date.parse(updatedAt)
  return Number.isFinite(ts) ? ts : 0
}

/* ------------------------------------------------------------------ */
/*  Tool Call 选择                                                       */
/* ------------------------------------------------------------------ */

async function selectRecallCandidatesByTool(
  userQuery: string,
  indexItems: RecallSelectionIndexItem[],
  options?: BuildBackgroundContextOptions,
): Promise<{ selectedKeys: string[]; reason?: string } | null> {
  const provider = options?.provider
  if (!provider || indexItems.length === 0) return null

  const safeUserQuery = extractUserQueryText(userQuery)
  const payload = {
    user_query: safeUserQuery,
    memory_index: indexItems,
    rules: [
      '仅返回与当前用户问题强相关的 key',
      '如果无相关项也必须调用工具，selected_item_keys 可为空数组',
      '优先保留能够补全上下文链路的最近条目',
      '禁止返回不存在的 key',
    ],
  }
  const promptMessages: ChatMessage[] = [
    {
      role: 'system',
      content: [
        '你是记忆召回选择器。',
        `你必须调用工具 ${RECALL_SELECTION_TOOL_NAME} 返回结构化结果。`,
        '不要输出任何普通文本答案。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify(payload, null, 2),
    },
  ]

  let seenToolCall = false
  let selectedKeys: string[] = []
  let selectedReason = ''

  try {
    for await (const event of requestStreamWithTools(
      provider,
      promptMessages,
      options?.overrides,
      { tools: recallSelectionTools, toolChoice: 'required' },
      options?.signal,
      options?.logScope,
    )) {
      if (event.type !== 'tool_calls') continue
      const target = event.toolCalls.find((call) => call.function.name === RECALL_SELECTION_TOOL_NAME)
      if (!target) continue
      seenToolCall = true
      const parsed = safeParseObject(target.function.arguments)
      if (!parsed) continue
      selectedKeys = normalizeStringArray(parsed.selected_item_keys ?? parsed.selectedItemKeys, 24)
      selectedReason = shortText(String(parsed.reason ?? ''), 260)
      break
    }
  } catch (err) {
    log('BACKGROUND_CONTEXT_TOOL_SELECTION_FAIL', { error: err instanceof Error ? err.message : String(err) }, options?.logScope)
    return null
  }

  if (!seenToolCall) return null
  return { selectedKeys, ...(selectedReason ? { reason: selectedReason } : {}) }
}

/* ------------------------------------------------------------------ */
/*  召回主逻辑                                                            */
/* ------------------------------------------------------------------ */

export async function recallBackgroundContext(
  workspace: string,
  projectId: string | undefined,
  userQuery: string,
  options?: BuildBackgroundContextOptions,
): Promise<{ notes: ProjectNote[]; taskMemories: TaskMemoryEntry[]; snapshots: MemorySnapshotEntry[]; recalled: RecalledItem[]; meta: RecallMeta; debugCandidates: RecallDebugCandidate[] }> {
  const manualNotes = (await listNotes(workspace, projectId))
    .map((note) => ({
      ...note,
      title: stripControlChars(note.title),
      content: stripControlChars(note.content),
    }))
  const taskMemories = (await loadTaskMemoriesForRecall(workspace, projectId))
    .map((task) => ({
      ...task,
      userQuery: stripControlChars(task.userQuery || ''),
      userAssetsBlock: stripControlChars(task.userAssetsBlock || ''),
      assistantResult: stripControlChars(task.assistantResult || ''),
      tools: (task.tools ?? []).map((x) => stripControlChars(x)),
      changedFiles: (task.changedFiles ?? []).map((x) => stripControlChars(x)),
      failures: (task.failures ?? []).map((x) => stripControlChars(x)),
    }))
  const snapshots = (await loadMemorySnapshots(workspace, projectId))
    .map((snapshot) => ({
      ...snapshot,
      summary: stripControlChars(snapshot.summary),
    }))

  const query = extractUserQueryText(userQuery)
  const queryTokens = tokenize(query)

  const candidates: RecallCandidate[] = []
  const allCandidates = new Map<string, RecallCandidate>()
  let intentSource: 'llm' | 'heuristic' = 'heuristic'
  let intentType = inferIntentTypeByQuery(query)
  let intentSummary = shortText(query, 220)
  let intentGoal = shortText(query, 220)

  // 笔记
  for (const note of manualNotes) {
    const noteText = `${note.title}\n${note.content}\n${note.category}`.toLowerCase()
    const timestamp = Date.parse(note.updatedAt || note.createdAt || '')
    const candidate: RecallCandidate = {
      source: 'note',
      id: note.id,
      title: note.title,
      text: noteText,
      timestamp,
      data: note,
      score: 0,
      reason: ['项目笔记'],
    }
    allCandidates.set(toCandidateKey(candidate.source, candidate.id), candidate)
    candidates.push(candidate)
  }

  // 任务记忆
  for (const task of taskMemories) {
    const taskText = `${task.userQuery || ''}\n${task.userAssetsBlock || ''}\n${task.assistantResult || ''}\n${(task.tools ?? []).join('\n')}\n${(task.changedFiles ?? []).join('\n')}\n${(task.failures ?? []).join('\n')}`.toLowerCase()
    const timestamp = Date.parse(task.updatedAt || task.createdAt || '')
    const candidate: RecallCandidate = {
      source: 'task',
      id: task.id,
      title: shortText(task.userQuery, 120),
      text: taskText,
      timestamp,
      data: task,
      score: 0,
      reason: ['任务记忆'],
    }
    allCandidates.set(toCandidateKey(candidate.source, candidate.id), candidate)
    candidates.push(candidate)
  }

  // 快照
  for (const snapshot of snapshots) {
    const snapshotText = `${snapshot.summary}`.toLowerCase()
    const timestamp = Date.parse(snapshot.updatedAt || snapshot.createdAt || '')
    const candidate: RecallCandidate = {
      source: 'snapshot',
      id: snapshot.id,
      title: '上下文压缩快照',
      text: snapshotText,
      timestamp,
      data: snapshot,
      score: 0,
      reason: ['上下文压缩快照'],
    }
    allCandidates.set(toCandidateKey(candidate.source, candidate.id), candidate)
    candidates.push(candidate)
  }

  // 意图继承
  const shouldCarryFromHistory = isLikelyFollowUpQuery(query) || intentType === 'other'
  if (shouldCarryFromHistory && taskMemories.length > 0) {
    const recent = [...taskMemories]
      .sort((a, b) => {
        const ta = Date.parse(a.updatedAt || a.createdAt || '')
        const tb = Date.parse(b.updatedAt || b.createdAt || '')
        return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0)
      })
      .find((task) => task.userQuery)

    // 不再继承旧意图,直接使用当前查询
  }

  // 去重
  const dedupedCandidateMap = new Map<string, RecallCandidate>()
  for (const candidate of candidates) {
    const key = toCandidateKey(candidate.source, candidate.id)
    const prev = dedupedCandidateMap.get(key)
    if (!prev || candidate.score > prev.score || (candidate.score === prev.score && candidate.timestamp > prev.timestamp)) {
      dedupedCandidateMap.set(key, candidate)
    }
  }
  candidates.length = 0
  candidates.push(...dedupedCandidateMap.values())

  // 排序
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return (Number.isFinite(b.timestamp) ? b.timestamp : 0) - (Number.isFinite(a.timestamp) ? a.timestamp : 0)
  })

  let selectionMethod: 'tool_call' | 'heuristic' = 'heuristic'
  let toolSelectionReason = ''
  let toolSelectedCount = 0

  const shouldUseToolSelection = options?.recallSelectionMode === 'tool_call'

  if (candidates.length > 0 && shouldUseToolSelection && options?.provider) {
    const topForSelection = candidates.slice(0, 80)
    const selectionIndex: RecallSelectionIndexItem[] = topForSelection.map((candidate) => {
      const key = toCandidateKey(candidate.source, candidate.id)
      const data = candidate.data as Record<string, unknown>
      const digest = candidate.source === 'note'
        ? shortText(`${toText(data.category)} ${toText(data.content)}`, 220)
        : candidate.source === 'snapshot'
          ? shortText(toText(data.summary), 220)
          : shortText(`${toText(data.goal)} ${toText(data.summary)} ${toText((data.changedFiles as string[] | undefined)?.join('、') || '')}`, 240)
      return {
        key,
        source: candidate.source,
        title: shortText(candidate.title, 80) || '记忆条目',
        digest,
        updatedAt: toText(data.updatedAt) || toText(data.createdAt),
        scoreHint: candidate.score,
      }
    })

    const toolSelection = await selectRecallCandidatesByTool(query, selectionIndex, options)
    if (toolSelection) {
      const selectedByTool = normalizeStringArray(toolSelection.selectedKeys, 24)
      const selectedSet = new Set(selectedByTool)
      const candidateMap = new Map<string, RecallCandidate>(
        candidates.map((candidate) => [toCandidateKey(candidate.source, candidate.id), candidate]),
      )
      const reordered: RecallCandidate[] = []
      for (const key of selectedByTool) {
        const item = candidateMap.get(key)
        if (item) reordered.push(item)
      }
      if (reordered.length > 0) {
        const rest = candidates.filter((candidate) => !selectedSet.has(toCandidateKey(candidate.source, candidate.id)))
        candidates.length = 0
        candidates.push(...reordered, ...rest)
        selectionMethod = 'tool_call'
        toolSelectedCount = reordered.length
        toolSelectionReason = toolSelection.reason || ''
      } else if (selectedByTool.length === 0) {
        candidates.length = 0
        selectionMethod = 'tool_call'
        toolSelectedCount = 0
        toolSelectionReason = toolSelection.reason || ''
      }
    }
  }

  // 预算裁剪
  const pressure = estimateBudgetChars(options?.contextLength, options?.usageTotalTokens)
  const selected: RecalledItem[] = []
  const selectedKeys = new Set<string>()
  const droppedByBudgetKeys = new Set<string>()
  let usedChars = 0
  let droppedByBudget = 0

  for (const candidate of candidates) {
    const key = `${candidate.source}:${candidate.id}`
    const item = toRecalledItem(candidate)
    const size = JSON.stringify(item).length
    const fits = usedChars + size <= pressure.budgetChars
    if (!fits && selected.length > 0) {
      droppedByBudget++
      droppedByBudgetKeys.add(key)
      continue
    }
    selected.push(item)
    selectedKeys.add(key)
    usedChars += size
    if (selected.length >= 24) break
  }

  // 按时间正序
  selected.sort((a, b) => {
    const ta = recalledItemTimestamp(a)
    const tb = recalledItemTimestamp(b)
    if (ta !== tb) return ta - tb
    const ka = `${a.source}:${a.id}`
    const kb = `${b.source}:${b.id}`
    return ka.localeCompare(kb)
  })

  const recalledNoteIds = new Set(selected.filter((item) => item.source === 'note').map((item) => item.id))
  const recalledNotes = manualNotes.filter((item) => recalledNoteIds.has(item.id))
  const debugCandidates: RecallDebugCandidate[] = candidates.slice(0, 120).map((candidate) => {
    const key = `${candidate.source}:${candidate.id}`
    return {
      key,
      source: candidate.source,
      id: candidate.id,
      title: candidate.title,
      score: candidate.score,
      reason: candidate.reason,
      selected: selectedKeys.has(key),
      droppedByBudget: droppedByBudgetKeys.has(key),
    }
  })

  return {
    notes: recalledNotes,
    taskMemories,
    snapshots,
    recalled: selected,
    debugCandidates,
    meta: {
      mode: pressure.mode,
      usageTotalTokens: options?.usageTotalTokens,
      contextLength: options?.contextLength,
      pressureRatio: pressure.ratio,
      intentSource,
      intentType,
      intentSummary,
      intentGoal,
      candidateCount: candidates.length,
      selectedCount: selected.length,
      budgetChars: pressure.budgetChars,
      droppedByBudget,
      selectionMethod,
      ...(selectionMethod === 'tool_call' ? { toolSelectionReason } : {}),
      ...(selectionMethod === 'tool_call' ? { toolSelectedCount } : {}),
    },
  }
}
