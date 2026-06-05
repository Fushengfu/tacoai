/**
 * 记忆标准化与归一化
 *
 * 负责 TaskMemoryEntry 的标准化、摘要构建、证据提取等。
 */

import { createHash } from 'node:crypto'
import type { ProjectTaskMemory } from '../../../shared/ipc'
import {
  stripUserAssetsBlock,
  extractUserAssetsBlock,
  extractUserQueryText,
} from '../../../shared/user-assets'
import {
  stripInternalContextTags,
  stripPseudoToolCallArtifacts,
} from '../../../shared/sanitize'
import {
  shortText,
  normalizeIso,
  normalizeOutcome,
  normalizeStringList,
  compactJoin,
} from './memory-utils'

/* ------------------------------------------------------------------ */
/*  类型                                                                 */
/* ------------------------------------------------------------------ */

export type TaskMemoryEntry = ProjectTaskMemory

const TASK_MEMORY_SUMMARY_MAX_CHARS = 1200
const TASK_MEMORY_CORE_MAX_CHARS = 560
const TASK_MEMORY_ASSISTANT_RESULT_MAX_CHARS = 4200
const TASK_MEMORY_USER_ASSETS_MAX_CHARS = 3000
const MEMORY_META_PREFIX = /^(用户问题|用户意图|意图来源|意图目标|意图|结果|动作|文件|异常)[:：]/u

/* ------------------------------------------------------------------ */
/*  文本清理                                                             */
/* ------------------------------------------------------------------ */

function stripMemoryMetaLines(text: string): string {
  const lines = String(text ?? '').replace(/\r/g, '').split('\n')
  const out: string[] = []
  let inCodeFence = false

  for (const rawLine of lines) {
    const trimmed = rawLine.trim()
    if (trimmed.startsWith('```')) {
      inCodeFence = !inCodeFence
      out.push(rawLine.trimEnd())
      continue
    }

    if (!inCodeFence) {
      if (!trimmed) {
        out.push('')
        continue
      }
      if (/^处理[:：]/u.test(trimmed)) {
        const payload = trimmed.replace(/^处理[:：]\s*/u, '').trim()
        if (payload) out.push(payload)
        continue
      }
      if (MEMORY_META_PREFIX.test(trimmed)) {
        continue
      }
    }

    out.push(rawLine.trimEnd())
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function extractCoreSummary(summary: string): string {
  const raw = stripPseudoToolCallArtifacts(
    stripInternalContextTags(String(summary ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '')),
  ).trim()
  if (!raw) return ''

  const marker = '处理总结:'
  const base = raw.includes(marker) ? raw.slice(raw.indexOf(marker) + marker.length) : raw
  const lines = base
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^用户问题[:：]/.test(line))
    .filter((line) => !/^用户意图[:：]/.test(line))
    .filter((line) => !/^意图来源[:：]/.test(line))
    .filter((line) => !/^意图目标[:：]/.test(line))

  if (lines.length === 0) return shortText(base, TASK_MEMORY_CORE_MAX_CHARS)
  return shortText(lines.slice(0, 8).join('；'), TASK_MEMORY_CORE_MAX_CHARS)
}

function normalizeEvidenceFacts(items: string[] | undefined, limit = 12): string[] {
  const cleaned = [...new Set((items ?? [])
    .map((item) => stripControlChars(String(item ?? '').replace(/\r/g, '').trim()))
    .filter(Boolean))]
  return cleaned.slice(0, limit)
}

function stripControlChars(input: string): string {
  return String(input ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
}

function extractStructuredFactLines(summary: string): string[] {
  const cleaned = stripPseudoToolCallArtifacts(stripInternalContextTags(String(summary ?? '')))
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/\r/g, '')
    .trim()
  if (!cleaned) return []

  const lines = cleaned.split('\n').map((line) => line.trim())
  const facts: string[] = []
  let inFacts = false

  for (const line of lines) {
    if (!line) {
      if (inFacts) break
      continue
    }

    if (/^关键事实[:：]\s*$/u.test(line)) {
      inFacts = true
      continue
    }

    if (/^关键事实[:：]/u.test(line)) {
      inFacts = true
      const inlineFact = line.replace(/^关键事实[:：]\s*/u, '').replace(/^[-*•]\s*/, '').trim()
      if (inlineFact) facts.push(inlineFact)
      continue
    }

    if (!inFacts) continue

    if (/^(?:[-*•]\s+|\d+\.\s+)/.test(line)) {
      facts.push(line.replace(/^(?:[-*•]\s+|\d+\.\s+)/, '').trim())
      continue
    }

    if (/^[\u4e00-\u9fa5A-Za-z][^:：]{0,30}[:：]\s*/.test(line)) break
    facts.push(line)
  }

  return normalizeEvidenceFacts(facts, 12)
}

/* ------------------------------------------------------------------ */
/*  标准化                                                               */
/* ------------------------------------------------------------------ */

export function normalizeTaskMemoryEntry(raw: Partial<TaskMemoryEntry>, index: number): TaskMemoryEntry {
  const now = new Date().toISOString()
  const userQuery = shortText(extractUserQueryText(String(raw.userQuery || '')), 8000)
  const userAssetsBlock = shortText(
    stripControlChars(String(raw.userAssetsBlock || '')),
    TASK_MEMORY_USER_ASSETS_MAX_CHARS,
  )
  const assistantResult = shortText(String(raw.assistantResult || ''), 12000)
  const sourceSessionId = shortText(String((raw as Record<string, unknown>).sourceSessionId || ''), 120)
  const sourceUserMessageId = shortText(String((raw as Record<string, unknown>).sourceUserMessageId || ''), 180)
  const sourceAssistantMessageId = shortText(String((raw as Record<string, unknown>).sourceAssistantMessageId || ''), 180)
  const sourceMessageIds = normalizeStringList((raw as Record<string, unknown>).sourceMessageIds, 200)
  const sourceStartSeqNum = Number((raw as Record<string, unknown>).sourceStartSeq)
  const sourceEndSeqNum = Number((raw as Record<string, unknown>).sourceEndSeq)
  const sourceStartSeq = Number.isFinite(sourceStartSeqNum) ? Math.floor(sourceStartSeqNum) : undefined
  const sourceEndSeq = Number.isFinite(sourceEndSeqNum) ? Math.floor(sourceEndSeqNum) : undefined

  const createdAtRaw = normalizeIso(raw.createdAt)
  const updatedAtRaw = normalizeIso(raw.updatedAt)
  const createdAt = createdAtRaw || updatedAtRaw || now
  const updatedAt = updatedAtRaw || createdAt

  const rawId = String(raw.id || '').trim()
  const stableId = rawId || `task-legacy-${createHash('sha1').update(`${userQuery}|${createdAt}|${index}`).digest('hex').slice(0, 12)}`

  return {
    id: stableId,
    userQuery,
    ...(userAssetsBlock ? { userAssetsBlock } : {}),
    assistantResult,
    outcome: normalizeOutcome(raw.outcome),
    tools: normalizeStringList(raw.tools, 120),
    changedFiles: normalizeStringList(raw.changedFiles, 160),
    fileDiffs: [],
    ...(sourceSessionId ? { sourceSessionId } : {}),
    ...(sourceUserMessageId ? { sourceUserMessageId } : {}),
    ...(sourceAssistantMessageId ? { sourceAssistantMessageId } : {}),
    ...(sourceMessageIds.length > 0 ? { sourceMessageIds } : {}),
    ...(typeof sourceStartSeq === 'number' ? { sourceStartSeq } : {}),
    ...(typeof sourceEndSeq === 'number' ? { sourceEndSeq } : {}),
    failures: normalizeStringList(raw.failures, 32),
    ...(normalizeIso((raw as Record<string, unknown>).deletedAt) ? { deletedAt: normalizeIso((raw as Record<string, unknown>).deletedAt) } : {}),
    ...(shortText(String((raw as Record<string, unknown>).deletedReason || ''), 220) ? { deletedReason: shortText(String((raw as Record<string, unknown>).deletedReason || ''), 220) } : {}),
    ...(shortText(String((raw as Record<string, unknown>).mergedIntoId || ''), 80) ? { mergedIntoId: shortText(String((raw as Record<string, unknown>).mergedIntoId || ''), 80) } : {}),
    createdAt,
    updatedAt,
  }
}

export function isSoftDeletedMemory(item: TaskMemoryEntry): boolean {
  const ts = Date.parse(String((item as Record<string, unknown>).deletedAt || ''))
  return Number.isFinite(ts) && ts > 0
}

/* ------------------------------------------------------------------ */
/*  摘要构建                                                             */
/* ------------------------------------------------------------------ */

export function buildAssistantResultBody(summary: string, evidenceFacts?: string[]): string {
  const cleaned = stripPseudoToolCallArtifacts(stripInternalContextTags(String(summary ?? '')))
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/\r/g, '')
    .trim()
  if (!cleaned) return ''

  const marker = '处理总结:'
  const base = cleaned.includes(marker) ? cleaned.slice(cleaned.indexOf(marker) + marker.length).trim() : cleaned

  const compact = stripMemoryMetaLines(base)
  const normalizedFacts = normalizeEvidenceFacts(evidenceFacts, 12)
  const factLines = normalizedFacts.filter((fact) => !(compact || base).includes(fact))
  const factBlock = factLines.length > 0
    ? `\n\n关键事实:\n${factLines.map((fact) => `- ${fact}`).join('\n')}`
    : ''

  return shortText(`${compact || base}${factBlock}`.trim(), TASK_MEMORY_ASSISTANT_RESULT_MAX_CHARS)
}

export function buildCompactMemorySummary(input: {
  intentType?: string
  intentSummary?: string
  summary: string
  outcome: 'success' | 'aborted' | 'error'
  tools?: string[]
  changedFiles?: string[]
  evidenceFacts?: string[]
  failures?: string[]
}): string {
  const intentType = shortText(input.intentType || '', 48) || 'other'
  const intentSummary = shortText(input.intentSummary || '', 160)
  const core = extractCoreSummary(input.summary)
  const toolText = compactJoin(input.tools ?? [], 4)
  const fileText = compactJoin(input.changedFiles ?? [], 4)
  const factText = compactJoin(normalizeEvidenceFacts(input.evidenceFacts, 6), 3)
  const failureText = compactJoin((input.failures ?? []).slice(0, 3), 2)
  const outcomeText = input.outcome === 'success'
    ? '成功'
    : input.outcome === 'aborted'
      ? '中止'
      : '失败'

  const lines = [
    `意图: ${intentType}${intentSummary ? ` | ${intentSummary}` : ''}`,
    `结果: ${outcomeText}`,
    core ? `处理: ${core}` : '',
    toolText ? `动作: ${toolText}` : '',
    fileText ? `文件: ${fileText}` : '',
    factText ? `关键事实: ${factText}` : '',
    failureText ? `异常: ${failureText}` : '',
  ].filter(Boolean)

  return shortText(lines.join('\n'), TASK_MEMORY_SUMMARY_MAX_CHARS)
}
