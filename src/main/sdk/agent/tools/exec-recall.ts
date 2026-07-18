/**
 * 工具执行器 - 记忆回想（recall_memories）
 */

import { recallMemoriesByKeywords } from '../memory/recall-tool'
import type { ExecResult, ToolRuntimeContext } from './exec-utils'

/* ------------------------------------------------------------------ */
/*  时间范围解析                                                        */
/* ------------------------------------------------------------------ */

/**
 * 将 AI 自由描述的时间范围解析为 ISO 时间戳区间。
 * 支持："昨天"、"上周"、"上个月"、"最近N天"、"YYYY年M月" 等。
 * 不传或不识别则返回 undefined。
 */
export function parseTimeRange(timeRange?: string): { timeFrom?: string; timeTo?: string } | undefined {
  const s = String(timeRange ?? '').trim()
  if (!s) return undefined

  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())

  // 昨天
  if (/^昨/.test(s)) {
    const d = new Date(today.getTime() - 86400000)
    return { timeFrom: d.toISOString().slice(0, 10), timeTo: today.toISOString().slice(0, 10) }
  }

  // 最近N天
  const recentDays = s.match(/最近(\d+)\s*天/)
  if (recentDays) {
    const n = parseInt(recentDays[1], 10)
    const d = new Date(today.getTime() - n * 86400000)
    return { timeFrom: d.toISOString().slice(0, 10) }
  }

  // 今天
  if (/^今/.test(s)) {
    return { timeFrom: today.toISOString().slice(0, 10) }
  }

  // 本周
  if (/本\s*周/.test(s)) {
    const day = today.getDay()
    const monday = new Date(today.getTime() - (day === 0 ? 6 : day - 1) * 86400000)
    return { timeFrom: monday.toISOString().slice(0, 10) }
  }

  // 上周
  if (/上周/.test(s)) {
    const day = today.getDay()
    const thisMonday = new Date(today.getTime() - (day === 0 ? 6 : day - 1) * 86400000)
    const lastMonday = new Date(thisMonday.getTime() - 7 * 86400000)
    return { timeFrom: lastMonday.toISOString().slice(0, 10), timeTo: thisMonday.toISOString().slice(0, 10) }
  }

  // 本月
  if (/本\s*月/.test(s)) {
    return { timeFrom: new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10) }
  }

  // 上个月
  if (/上\s*个?\s*月/.test(s)) {
    const thisMonthFirst = new Date(now.getFullYear(), now.getMonth(), 1)
    const lastMonthFirst = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    return { timeFrom: lastMonthFirst.toISOString().slice(0, 10), timeTo: thisMonthFirst.toISOString().slice(0, 10) }
  }

  // 最近N个月
  const recentMonths = s.match(/最近(\d+)\s*个?\s*月/)
  if (recentMonths) {
    const n = parseInt(recentMonths[1], 10)
    const d = new Date(now.getFullYear(), now.getMonth() - n, 1)
    return { timeFrom: d.toISOString().slice(0, 10) }
  }

  // YYYY年M月 或 YYYY年
  const yearMonth = s.match(/(\d{4})\s*年(?:\s*(\d{1,2})\s*月)?/)
  if (yearMonth) {
    const y = parseInt(yearMonth[1], 10)
    const m = yearMonth[2] ? parseInt(yearMonth[2], 10) - 1 : 0
    const from = new Date(y, m, 1)
    const to = yearMonth[2] ? new Date(y, m + 1, 1) : new Date(y + 1, 0, 1)
    return { timeFrom: from.toISOString().slice(0, 10), timeTo: to.toISOString().slice(0, 10) }
  }

  // 去年
  if (/去\s*年/.test(s)) {
    const thisYearFirst = new Date(now.getFullYear(), 0, 1)
    const lastYearFirst = new Date(now.getFullYear() - 1, 0, 1)
    return { timeFrom: lastYearFirst.toISOString().slice(0, 10), timeTo: thisYearFirst.toISOString().slice(0, 10) }
  }

  // 无法识别 → 不限时间
  return undefined
}

/* ------------------------------------------------------------------ */
/*  recall_memories                                                    */
/* ------------------------------------------------------------------ */

export async function execRecallMemories(
  args: Record<string, unknown>,
  workspace: string,
  projectId?: string,
  runtimeContext?: ToolRuntimeContext,
): Promise<ExecResult> {
  const query = String(args.query ?? '').trim()
  if (!query) return { content: 'Error: query is required', success: false }

  const rawLimit = Number(args.limit)
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 5

  const timeRange = String(args.timeRange ?? '').trim() || undefined
  const parsed = parseTimeRange(timeRange)

  const db = runtimeContext?.services?.database
  if (!db) return { content: 'Error: database service not available', success: false }

  try {
    const content = await recallMemoriesByKeywords(db, workspace, projectId, query, limit, parsed?.timeFrom, parsed?.timeTo)
    return { content, success: true }
  } catch (err) {
    return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, success: false }
  }
}
