/**
 * 工具执行器 - 记忆回想（recall_memories）
 *
 * 支持两种模式：
 * 1. 普通搜索：不传 summaryPrompt → 返回原始记忆列表
 * 2. 总结模式：传 summaryPrompt → 内部调 LLM 分页总结后返回
 */

import { recallMemoriesByKeywords } from '../memory/recall-tool'
import type { RecallResult } from '../memory/recall-tool'
import type { ExecResult, ToolRuntimeContext } from './exec-utils'
import type { ChatMessage } from '../llm/client'
import { requestChatCompletion } from '../llm/client'

/* ------------------------------------------------------------------ */
/*  LLM 总结                                                            */
/* ------------------------------------------------------------------ */

async function summarizePage(
  provider: string,
  userId: string | undefined,
  overrides: any,
  summaryPrompt: string,
  recallResult: RecallResult,
): Promise<string> {
  const memoriesJson = recallResult.pageItems.map((m) => ({
    date: (m.updatedAt || m.createdAt || '').slice(0, 10),
    userQuery: m.userQuery || '(无标题)',
    result: (m.assistantResult || '').slice(0, 500),
    outcome: m.outcome,
    tools: m.tools,
    changedFiles: m.changedFiles,
  }))

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `你是记忆总结器。根据提供的记忆列表，按用户指定的方向进行总结。输出纯文本，不要 JSON。`,
    },
    {
      role: 'user',
      content: `请按以下方向总结这些记忆：\n${summaryPrompt}\n\n第 ${recallResult.page}/${recallResult.totalPages} 页，共 ${recallResult.totalCandidates} 条记忆：\n${JSON.stringify(memoriesJson, null, 2)}`,
    },
  ]

  const raw = await requestChatCompletion(provider, messages, overrides)
  return raw?.trim() || '(总结生成失败)'
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
  const summaryPrompt = String(args.summaryPrompt ?? '').trim() || undefined

  const rawLimit = Number(args.limit)
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 5

  const rawPage = Number(args.page)
  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1

  const timeFrom = String(args.from ?? '').trim() || undefined
  const timeTo = String(args.to ?? '').trim() || undefined

  const db = runtimeContext?.services?.database
  if (!db) return { content: 'Error: database service not available', success: false }

  try {
    const result = await recallMemoriesByKeywords(db, workspace, projectId, query, limit, timeFrom, timeTo, page)

    // 无总结模式：直接返回格式化文本
    if (!summaryPrompt || result.totalCandidates === 0) {
      return { content: result.text, success: true }
    }

    // 总结模式：需要 provider
    const provider = runtimeContext?.provider
    if (!provider) {
      return { content: `${result.text}\n\n⚠️ 无法进行总结：未配置 LLM provider`, success: true }
    }

    const summary = await summarizePage(
      provider,
      runtimeContext?.userId,
      runtimeContext?.overrides,
      summaryPrompt,
      result,
    )

    const paginationHint = result.totalPages > 1
      ? `\n\n📄 第 ${result.page}/${result.totalPages} 页 | 共 ${result.totalCandidates} 条记忆 | 每页 ${result.pageItems.length} 条`
      : `\n\n共 ${result.totalCandidates} 条记忆`

    let content = `${summary}${paginationHint}`

    if (result.totalPages > 1 && result.page < result.totalPages) {
      content += `\n👉 还有更多记忆，传 page: ${result.page + 1} 查看下一页总结`
    }

    return { content, success: true }
  } catch (err) {
    return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, success: false }
  }
}
