/**
 * 回忆工具 — recallMemoriesByKeywords
 *
 * Agent 对话中途主动搜索历史任务记忆。
 * SQL 层 LIKE 粗筛 + 内存精排，不再全量加载。
 * 支持分页 + LLM 总结（由调用方 orchestrate）。
 */

import type { DatabaseService } from '../services'
import type { TaskMemoryEntry } from './memory-normalize'
import { normalizeTaskMemoryEntry } from './memory-normalize'
import { shortText } from './memory-utils'

/* ------------------------------------------------------------------ */
/*  类型                                                               */
/* ------------------------------------------------------------------ */

export type RecallResult = {
  /** 格式化后的文本（用于直接返回给 agent） */
  text: string
  /** 原始候选记忆列表（调用方用于 LLM 总结） */
  candidates: TaskMemoryEntry[]
  /** 当前页的记忆列表 */
  pageItems: TaskMemoryEntry[]
  /** 候选记忆总数 */
  totalCandidates: number
  /** 当前页码（1-based） */
  page: number
  /** 总页数 */
  totalPages: number
}

/* ------------------------------------------------------------------ */
/*  常量                                                               */
/* ------------------------------------------------------------------ */

const MAX_LIMIT = 200
const DEFAULT_LIMIT = 5
const CANDIDATE_LIMIT = 200
const PER_PAGE = 50

/* ------------------------------------------------------------------ */
/*  分词                                                               */
/* ------------------------------------------------------------------ */

function tokenize(text: string): string[] {
  const lower = String(text ?? '').toLowerCase()
  const set = new Set<string>()
  // 英文词：>=2 字符的字母数字组合
  const en = lower.match(/[a-z0-9_./:-]{2,}/g) ?? []
  en.forEach((token) => set.add(token))
  // 中文词：>=2 字符的 CJK 片段（简单 bigram）
  const zh = lower.match(/[\u4e00-\u9fff]{2,}/g) ?? []
  zh.forEach((token) => set.add(token))
  // 单个中文字也保留
  const zhSingle = lower.match(/[\u4e00-\u9fff]/g) ?? []
  zhSingle.forEach((token) => set.add(token))
  return Array.from(set).slice(0, 80)
}

/* ------------------------------------------------------------------ */
/*  评分                                                               */
/* ------------------------------------------------------------------ */

/**
 * 计算一条记忆与查询关键词的相关性分数。
 *
 * 权重策略：
 * - 标题命中（userQuery 摘要）：2x
 * - 涉及文件名命中：1.5x
 * - 回复内容命中：1x
 * - 工具名命中：0.5x
 */
function scoreMemory(memory: TaskMemoryEntry, tokens: string[]): number {
  if (tokens.length === 0) return 0

  const title = (memory.userQuery || '').toLowerCase()
  const result = (memory.assistantResult || '').toLowerCase()
  const files = (memory.changedFiles ?? []).join(' ').toLowerCase()
  const tools = (memory.tools ?? []).join(' ').toLowerCase()

  let score = 0

  for (const token of tokens) {
    if (title.includes(token)) score += 2
    if (files.includes(token)) score += 1.5
    if (result.includes(token)) score += 1
    if (tools.includes(token)) score += 0.5
  }

  return score
}

/* ------------------------------------------------------------------ */
/*  格式化                                                             */
/* ------------------------------------------------------------------ */

function formatMemoryOutput(
  memories: TaskMemoryEntry[],
  totalCandidateCount: number,
  query: string = '',
  truncated: boolean,
  timeRangeLabel?: string,
): string {
  const timeHint = timeRangeLabel ? ` (${timeRangeLabel})` : ''
  const queryPart = query ? `与"${shortText(query, 60)}"相关的` : ''
  const header = totalCandidateCount > 0
    ? `找到 ${totalCandidateCount} 条${queryPart}记忆${timeHint}：`
    : query
      ? `未找到与"${shortText(query, 60)}"相关的记忆${timeHint}。`
      : `未${timeHint ? `在 ${timeRangeLabel} 内` : ''}找到任何记忆。`

  const lines = [header]

  if (truncated && memories.length < totalCandidateCount) {
    lines.push(`⚠️ 仅展示最相关的 ${memories.length} 条，还有 ${totalCandidateCount - memories.length} 条未显示。`)
  }

  lines.push('')

  for (let i = 0; i < memories.length; i++) {
    const m = memories[i]
    const timestamp = m.updatedAt || m.createdAt || ''
    const date = timestamp ? timestamp.slice(0, 10) : '(未知时间)'
    const problem = shortText(m.userQuery, 200) || '(无标题)'
    const result = shortText(m.assistantResult || '', 300) || '(无总结)'
    const outcomeLabel = m.outcome === 'success' ? '✓' : m.outcome === 'aborted' ? '⊘' : '✗'

    lines.push(`${i + 1}. ${outcomeLabel} ${date}`)
    lines.push(`   问题: ${problem}`)
    lines.push(`   结果: ${result}`)
    lines.push('')
  }

  return lines.join('\n').trim()
}

/* ------------------------------------------------------------------ */
/*  主函数                                                             */
/* ------------------------------------------------------------------ */

export async function recallMemoriesByKeywords(
  database: DatabaseService,
  workspace: string,
  projectId: string | undefined,
  query: string,
  limit: number = DEFAULT_LIMIT,
  timeFrom?: string,
  timeTo?: string,
  page: number = 1,
  perPage: number = PER_PAGE,
): Promise<RecallResult> {
  const safeLimit = Math.max(1, Math.min(Math.floor(limit) || DEFAULT_LIMIT, MAX_LIMIT))
  const safePage = Math.max(1, Math.floor(page) || 1)
  const safePerPage = Math.max(1, Math.min(Math.floor(perPage) || PER_PAGE, MAX_LIMIT))

  // 1. 分词
  const tokens = tokenize(query)

  // 2. SQL 层粗筛（不再全量加载到内存）
  const rawCandidates = database.searchTaskMemories(workspace, tokens, timeFrom, timeTo, CANDIDATE_LIMIT, projectId) as Array<Partial<TaskMemoryEntry>>
  const candidates = rawCandidates.map((item, idx) => normalizeTaskMemoryEntry(item, idx))

  const totalCandidates = candidates.length

  if (totalCandidates === 0) {
    const timeHint = timeFrom || timeTo ? '在指定时间范围内 ' : ''
    return {
      text: `未${timeHint}找到任何任务记忆。`,
      candidates: [],
      pageItems: [],
      totalCandidates: 0,
      page: 1,
      totalPages: 0,
    }
  }

  // 3. 内存精排
  let sorted: TaskMemoryEntry[]

  if (tokens.length === 0) {
    sorted = [...candidates].sort((a, b) => {
      const ta = Date.parse(a.updatedAt || a.createdAt || '')
      const tb = Date.parse(b.updatedAt || b.createdAt || '')
      return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0)
    })
  } else {
    const scored = candidates.map((m) => ({
      memory: m,
      score: scoreMemory(m, tokens),
    }))

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      const ta = Date.parse(a.memory.updatedAt || a.memory.createdAt || '')
      const tb = Date.parse(b.memory.updatedAt || b.memory.createdAt || '')
      return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0)
    })

    const matched = scored.filter((s) => s.score > 0)
    sorted = (matched.length > 0 ? matched : scored).map((s) => s.memory)
  }

  // 4. 分页
  const totalPages = Math.ceil(sorted.length / safePerPage)
  const actualPage = Math.min(safePage, totalPages)
  const startIdx = (actualPage - 1) * safePerPage
  const pageItems = sorted.slice(startIdx, startIdx + safePerPage)

  // 5. 格式化（无总结时使用）
  const topResults = sorted.slice(0, safeLimit)

  // 构建时间范围标签
  let timeRangeLabel: string | undefined
  if (timeFrom || timeTo) {
    const from = timeFrom ? timeFrom.slice(0, 10) : ''
    const to = timeTo ? timeTo.slice(0, 10) : ''
    if (from && to) timeRangeLabel = `${from} ~ ${to}`
    else if (from) timeRangeLabel = `${from} 至今`
    else timeRangeLabel = `截止 ${to}`
  }

  const text = formatMemoryOutput(topResults, totalCandidates, query, candidates.length > safeLimit, timeRangeLabel)

  return { text, candidates: sorted, pageItems, totalCandidates, page: actualPage, totalPages }
}
