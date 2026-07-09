/**
 * 回忆工具 — recallMemoriesByKeywords
 *
 * Agent 对话中途主动搜索历史任务记忆。
 * 纯关键词匹配，零 LLM 调用，与 recallBackgroundContext（对话开始时自动注入）互为补充。
 */

import type { DatabaseService } from '../services'
import type { TaskMemoryEntry } from './memory-normalize'
import { normalizeTaskMemoryEntry, isSoftDeletedMemory } from './memory-normalize'
import { shortText, compactJoin } from './memory-utils'

/* ------------------------------------------------------------------ */
/*  常量                                                               */
/* ------------------------------------------------------------------ */

const MAX_LIMIT = 20
const DEFAULT_LIMIT = 5

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

function formatMemoryOutput(memories: TaskMemoryEntry[], totalFound: number, query: string): string {
  const header = totalFound > 0
    ? `找到 ${totalFound} 条与"${shortText(query, 60)}"相关的记忆：`
    : `未找到与"${shortText(query, 60)}"相关的记忆。`

  const lines = [header, '']

  for (let i = 0; i < memories.length; i++) {
    const m = memories[i]
    const title = shortText(m.userQuery, 120) || '(无标题)'
    const timestamp = m.updatedAt || m.createdAt || ''
    const date = timestamp ? timestamp.slice(0, 10) : '(未知时间)'
    const files = compactJoin(m.changedFiles ?? [], 6)
    const tools = compactJoin(m.tools ?? [], 6)
    const summary = shortText(m.assistantResult || '', 200)
    const outcomeLabel = m.outcome === 'success' ? '成功' : m.outcome === 'aborted' ? '中止' : '失败'

    lines.push(`${i + 1}. [${outcomeLabel}] ${title}`)
    lines.push(`   时间: ${date}`)
    if (files) lines.push(`   涉及: ${files}`)
    if (tools) lines.push(`   工具: ${tools}`)
    if (summary) lines.push(`   摘要: ${summary}`)
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
): Promise<string> {
  const safeLimit = Math.max(1, Math.min(Math.floor(limit) || DEFAULT_LIMIT, MAX_LIMIT))

  // 1. 加载全部记忆
  const activeRaw = database.listTaskMemoriesByTier(workspace, 'active', projectId)
  const archiveRaw = database.listTaskMemoriesByTier(workspace, 'archive', projectId)

  const active = activeRaw.map((item, idx) => normalizeTaskMemoryEntry(item as Partial<TaskMemoryEntry>, idx))
  const archive = archiveRaw.map((item, idx) => normalizeTaskMemoryEntry(item as Partial<TaskMemoryEntry>, idx))

  // 2. 合并去重 + 过滤软删除
  const seen = new Set<string>()
  const merged: TaskMemoryEntry[] = []

  for (const items of [archive, active]) {
    for (const item of items) {
      if (isSoftDeletedMemory(item)) continue
      const key = String(item.id || '').trim()
      if (!key || seen.has(key)) continue
      seen.add(key)
      merged.push(item)
    }
  }

  if (merged.length === 0) {
    return `未找到任何任务记忆。`
  }

  // 3. 分词 + 评分
  const tokens = tokenize(query)
  if (tokens.length === 0) {
    // 无有效关键词：返回最近 N 条
    const sorted = [...merged].sort((a, b) => {
      const ta = Date.parse(a.updatedAt || a.createdAt || '')
      const tb = Date.parse(b.updatedAt || b.createdAt || '')
      return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0)
    })
    return formatMemoryOutput(sorted.slice(0, safeLimit), merged.length, query)
  }

  // 4. 排序：分数降序，同分按时间降序
  const scored = merged.map((m) => ({
    memory: m,
    score: scoreMemory(m, tokens),
  }))

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    const ta = Date.parse(a.memory.updatedAt || a.memory.createdAt || '')
    const tb = Date.parse(b.memory.updatedAt || b.memory.createdAt || '')
    return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0)
  })

  // 5. 取 top N（过滤掉 0 分的除非总数不够）
  const matched = scored.filter((s) => s.score > 0)
  const top = matched.length > 0 ? matched : scored
  const results = top.slice(0, safeLimit).map((s) => s.memory)

  return formatMemoryOutput(results, merged.length, query)
}
