/**
 * AI 记忆整理
 *
 * 负责在高上下文压力下触发 AI 判定记忆合并/淘汰。
 */

import path from 'node:path'
import type { ProviderKey, ProviderOverrides } from '../../ai/llm'
import { requestChatCompletion } from '../../ai/llm'
import type { ChatMessage } from '../../ai/llm'
import { log } from '../../system/logger'
import { shortText, normalizeStringArray, safeParseObjectFromText } from './memory-utils'
import type { TaskMemoryEntry } from './memory-normalize'
import { isSoftDeletedMemory, buildAssistantResultBody } from './memory-normalize'
import { sortTaskMemoriesByTimeAsc, mergeTaskMemoryById, loadTaskMemoriesForRecall } from './memory-crud'

/* ------------------------------------------------------------------ */
/*  常量 & 类型                                                          */
/* ------------------------------------------------------------------ */

const TASK_MEMORY_MAX_ENTRIES = 400
const TASK_MEMORY_ARCHIVE_MAX_ENTRIES = 6000
const TASK_MEMORY_TOTAL_MAX_ENTRIES = TASK_MEMORY_MAX_ENTRIES + TASK_MEMORY_ARCHIVE_MAX_ENTRIES
const TASK_MEMORY_SUMMARY_MAX_CHARS = 1200
const MEMORY_MAINTAIN_RATIO = 0.8
const MEMORY_MAINTAIN_MIN_INTERVAL_MS = 90 * 1000

export type MemoryMaintainOptions = {
  provider?: ProviderKey
  overrides?: ProviderOverrides
  usageTotalTokens?: number
  contextLength?: number
  signal?: AbortSignal
  logScope?: string
}

type MemoryConsolidationPatch = {
  goal?: string
  intentType?: string
  intentSummary?: string
  intentGoal?: string
  summary?: string
  assistantResult?: string
  outcome?: 'success' | 'aborted' | 'error'
  tools?: string[]
  changedFiles?: string[]
  identifiers?: string[]
  failures?: string[]
}

type MemoryConsolidationAction = {
  target_id?: string
  source_ids?: string[]
  merged_record?: MemoryConsolidationPatch
}

type MemoryConsolidationDecision = {
  merge_actions: MemoryConsolidationAction[]
  drop_ids: string[]
  keep_ids: string[]
}

/* ------------------------------------------------------------------ */
/*  状态管理                                                             */
/* ------------------------------------------------------------------ */

const memoryMaintainLastRunAtByScope = new Map<string, number>()
const memoryMaintainInFlightByScope = new Set<string>()

/* ------------------------------------------------------------------ */
/*  标准化                                                               */
/* ------------------------------------------------------------------ */

function normalizeConsolidationDecision(value: unknown): MemoryConsolidationDecision | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const obj = value as Record<string, unknown>
  const mergeRaw = Array.isArray(obj.merge_actions) ? obj.merge_actions : []
  const mergeActions: MemoryConsolidationAction[] = mergeRaw
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    .map((item) => item as MemoryConsolidationAction)
    .slice(0, 200)
  const dropIds = normalizeStringArray(obj.drop_ids, 1200)
  const keepIds = normalizeStringArray(obj.keep_ids, 1200)
  return {
    merge_actions: mergeActions,
    drop_ids: dropIds,
    keep_ids: keepIds,
  }
}

function applyConsolidationPatch(base: TaskMemoryEntry, patch: MemoryConsolidationPatch | undefined, now: string): TaskMemoryEntry {
  if (!patch || typeof patch !== 'object') return { ...base, updatedAt: now }
  const next: TaskMemoryEntry = { ...base, updatedAt: now }
  const assistantResultRaw = String(patch.assistantResult || '').trim()
  if (assistantResultRaw) next.assistantResult = buildAssistantResultBody(assistantResultRaw)
  if (patch.outcome === 'success' || patch.outcome === 'aborted' || patch.outcome === 'error') {
    next.outcome = patch.outcome
  }
  if (Array.isArray(patch.tools)) next.tools = normalizeStringList(patch.tools, 120)
  if (Array.isArray(patch.changedFiles)) next.changedFiles = normalizeStringList(patch.changedFiles, 160)
  if (Array.isArray(patch.failures)) next.failures = normalizeStringList(patch.failures, 32)
  delete (next as Record<string, unknown>).deletedAt
  delete (next as Record<string, unknown>).deletedReason
  delete (next as Record<string, unknown>).mergedIntoId
  return next
}

function normalizeStringList(value: unknown, max = 120): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((x) => String(x ?? '').trim()).filter(Boolean))].slice(0, max)
}

/* ------------------------------------------------------------------ */
/*  分区管理                                                             */
/* ------------------------------------------------------------------ */

export function repartitionTaskMemories(items: TaskMemoryEntry[]): { active: TaskMemoryEntry[]; archive: TaskMemoryEntry[] } {
  let all = sortTaskMemoriesByTimeAsc(items)
  if (all.length > TASK_MEMORY_TOTAL_MAX_ENTRIES) {
    let overflow = all.length - TASK_MEMORY_TOTAL_MAX_ENTRIES
    const kept: TaskMemoryEntry[] = []
    for (const item of all) {
      if (overflow > 0 && isSoftDeletedMemory(item)) {
        overflow--
        continue
      }
      kept.push(item)
    }
    if (overflow > 0) {
      all = kept.slice(overflow)
    } else {
      all = kept
    }
  }

  if (all.length <= TASK_MEMORY_MAX_ENTRIES) {
    return { active: all, archive: [] }
  }

  const active = all.slice(-TASK_MEMORY_MAX_ENTRIES)
  const archiveRaw = all.slice(0, -TASK_MEMORY_MAX_ENTRIES)
  const archive = archiveRaw.length > TASK_MEMORY_ARCHIVE_MAX_ENTRIES
    ? archiveRaw.slice(-TASK_MEMORY_ARCHIVE_MAX_ENTRIES)
    : archiveRaw
  return { active, archive }
}

/* ------------------------------------------------------------------ */
/*  门控                                                                 */
/* ------------------------------------------------------------------ */

function shouldRunMemoryMaintain(scope: string, options?: MemoryMaintainOptions): { run: boolean; reason: string } {
  const usage = typeof options?.usageTotalTokens === 'number' && Number.isFinite(options.usageTotalTokens) && options.usageTotalTokens > 0
    ? options.usageTotalTokens
    : undefined
  const max = typeof options?.contextLength === 'number' && Number.isFinite(options.contextLength) && options.contextLength > 0
    ? options.contextLength
    : undefined
  if (!usage || !max) return { run: false, reason: 'missing_usage_or_budget' }
  const ratio = usage / max
  if (ratio < MEMORY_MAINTAIN_RATIO) return { run: false, reason: `ratio_lt_${MEMORY_MAINTAIN_RATIO}` }
  if (memoryMaintainInFlightByScope.has(scope)) return { run: false, reason: 'in_flight' }
  const now = Date.now()
  const last = memoryMaintainLastRunAtByScope.get(scope) ?? 0
  if (now - last < MEMORY_MAINTAIN_MIN_INTERVAL_MS) return { run: false, reason: 'cooldown' }
  return { run: true, reason: `ratio_${ratio.toFixed(3)}` }
}

/* ------------------------------------------------------------------ */
/*  CRUD 依赖（动态导入避免循环）                                          */
/* ------------------------------------------------------------------ */

async function loadTaskMemories(workspace: string, projectId?: string): Promise<TaskMemoryEntry[]> {
  const { loadTaskMemoriesForRecall } = await import('./memory-crud')
  return loadTaskMemoriesForRecall(workspace, projectId)
}

async function loadTaskMemoryArchive(workspace: string, projectId?: string): Promise<TaskMemoryEntry[]> {
  const { loadTaskMemoryArchive } = await import('./memory-crud')
  return loadTaskMemoryArchive(workspace, projectId)
}

async function saveTaskMemories(workspace: string, items: TaskMemoryEntry[], projectId?: string): Promise<void> {
  const { saveTaskMemories } = await import('./memory-crud')
  return saveTaskMemories(workspace, items, projectId)
}

async function saveTaskMemoryArchive(workspace: string, items: TaskMemoryEntry[], projectId?: string): Promise<void> {
  const { saveTaskMemoryArchive } = await import('./memory-crud')
  return saveTaskMemoryArchive(workspace, items, projectId)
}

/* ------------------------------------------------------------------ */
/*  AI 整理                                                              */
/* ------------------------------------------------------------------ */

export async function maintainTaskMemoriesByAI(
  workspace: string,
  projectId: string | undefined,
  options?: MemoryMaintainOptions,
): Promise<{ applied: boolean; merged: number; dropped: number; total: number; reason: string }> {
  const provider = options?.provider
  if (!workspace || !workspace.trim()) return { applied: false, merged: 0, dropped: 0, total: 0, reason: 'empty_workspace' }
  if (!provider) return { applied: false, merged: 0, dropped: 0, total: 0, reason: 'missing_provider' }

  const { resolveScope } = await import('./memory-migration')
  const scope = resolveScope(workspace, projectId)
  const gate = shouldRunMemoryMaintain(scope, options)
  if (!gate.run) return { applied: false, merged: 0, dropped: 0, total: 0, reason: gate.reason }
  memoryMaintainInFlightByScope.add(scope)
  try {
    const [active, archive] = await Promise.all([
      loadTaskMemories(workspace, projectId),
      loadTaskMemoryArchive(workspace, projectId),
    ])
    const all = mergeTaskMemoryById([...archive, ...active])
    const candidates = all.filter((item) => !isSoftDeletedMemory(item))
    if (candidates.length <= 1) {
      return { applied: false, merged: 0, dropped: 0, total: candidates.length, reason: 'insufficient_candidates' }
    }
    const protectedRecentIds = new Set(
      sortTaskMemoriesByTimeAsc(candidates)
        .slice(-Math.min(3, candidates.length))
        .map((item) => item.id),
    )

    const payload = {
      workspace: path.resolve(workspace),
      project_id: (projectId ?? '').trim(),
      rules: [
        '你必须基于全量记忆进行判定，不要省略。',
        '只能使用 memories 里已存在的 id，禁止虚构 id。',
        'merge_actions 表示 source_ids 合并进 target_id，target_id 必须保留。',
        'drop_ids 表示可淘汰记忆 id。',
        'keep_ids 表示保留不动记忆 id。',
        '同一个 id 不能同时出现在 merge/drop/keep 的冲突位置。',
        '禁止删除最近的连续上下文记忆；最新的 3 条记忆必须保留。',
        '输出必须是 JSON 对象，不要输出解释文本。',
      ],
      output_schema: {
        merge_actions: [{ target_id: 'string', source_ids: ['string'], merged_record: { summary: 'string', assistantResult: 'string' } }],
        drop_ids: ['string'],
        keep_ids: ['string'],
      },
      memories: candidates.map((item) => ({
        id: item.id,
        userQuery: item.userQuery || '',
        userAssetsBlock: item.userAssetsBlock || '',
        assistantResult: item.assistantResult || '',
        outcome: item.outcome,
        tools: item.tools,
        changedFiles: item.changedFiles,
        failures: item.failures,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      })),
    }

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: '你是记忆整理器。请根据输入记忆输出严格 JSON：merge_actions/drop_ids/keep_ids。禁止输出 JSON 之外内容。',
      },
      {
        role: 'user',
        content: JSON.stringify(payload),
      },
    ]

    let parsedDecision: MemoryConsolidationDecision | null = null
    try {
      const raw = await requestChatCompletion(provider, messages, options?.overrides, options?.signal, options?.logScope)
      const parsed = safeParseObjectFromText(raw)
      parsedDecision = normalizeConsolidationDecision(parsed)
      if (!parsedDecision) {
        log('TASK_MEMORY_MAINTAIN_PARSE_FAIL', { reason: 'invalid_json', raw: shortText(raw, 1200) }, options?.logScope)
        return { applied: false, merged: 0, dropped: 0, total: candidates.length, reason: 'invalid_json' }
      }
    } catch (err) {
      log('TASK_MEMORY_MAINTAIN_AI_FAIL', { error: err instanceof Error ? err.message : String(err) }, options?.logScope)
      return { applied: false, merged: 0, dropped: 0, total: candidates.length, reason: 'ai_fail' }
    }

    const byId = new Map<string, TaskMemoryEntry>()
    for (const item of all) byId.set(item.id, item)
    const now = new Date().toISOString()
    const mergedSources = new Set<string>()
    const keptTargets = new Set<string>()
    const explicitKeepIds = new Set(normalizeStringArray(parsedDecision.keep_ids, 1200))
    let mergedCount = 0
    let droppedCount = 0

    for (const action of parsedDecision.merge_actions) {
      const targetId = String(action.target_id || '').trim()
      if (!targetId) continue
      const target = byId.get(targetId)
      if (!target || isSoftDeletedMemory(target)) continue
      const sourceIds = normalizeStringArray(action.source_ids, 240)
        .filter((id) => id !== targetId)
        .filter((id) => !mergedSources.has(id))
        .filter((id) => !protectedRecentIds.has(id))
        .filter((id) => {
          const item = byId.get(id)
          return Boolean(item && !isSoftDeletedMemory(item))
        })
      if (sourceIds.length === 0) continue

      const nextTarget = applyConsolidationPatch(target, action.merged_record, now)
      byId.set(targetId, nextTarget)
      keptTargets.add(targetId)
      for (const sid of sourceIds) {
        const src = byId.get(sid)
        if (!src || isSoftDeletedMemory(src)) continue
        byId.set(sid, {
          ...src,
          deletedAt: now,
          deletedReason: `ai_merge_into:${targetId}`,
          mergedIntoId: targetId,
          updatedAt: now,
        })
        mergedSources.add(sid)
        mergedCount++
      }
    }

    const dropIds = new Set(normalizeStringArray(parsedDecision.drop_ids, 1200))
    for (const id of dropIds) {
      if (mergedSources.has(id) || keptTargets.has(id) || explicitKeepIds.has(id) || protectedRecentIds.has(id)) continue
      const item = byId.get(id)
      if (!item || isSoftDeletedMemory(item)) continue
      byId.set(id, {
        ...item,
        deletedAt: now,
        deletedReason: 'ai_drop',
        updatedAt: now,
      })
      droppedCount++
    }

    const remaining = Array.from(byId.values()).filter((item) => !isSoftDeletedMemory(item))
    if (remaining.length <= 0) {
      log('TASK_MEMORY_MAINTAIN_ABORT_ALL_DELETED', {
        total: candidates.length,
        mergeActions: parsedDecision.merge_actions.length,
        dropIds: parsedDecision.drop_ids.length,
        keepIds: parsedDecision.keep_ids.length,
      }, options?.logScope)
      return { applied: false, merged: 0, dropped: 0, total: candidates.length, reason: 'guard_all_deleted' }
    }

    if (mergedCount <= 0 && droppedCount <= 0) {
      memoryMaintainLastRunAtByScope.set(scope, Date.now())
      return { applied: false, merged: 0, dropped: 0, total: candidates.length, reason: 'no_changes' }
    }

    const repartitioned = repartitionTaskMemories(Array.from(byId.values()))
    await Promise.all([
      saveTaskMemories(workspace, repartitioned.active, projectId),
      saveTaskMemoryArchive(workspace, repartitioned.archive, projectId),
    ])

    const { insertMemoryMaintainRun } = await import('../../data/memory-db')
    insertMemoryMaintainRun(
      { workspace, projectId },
      {
        usageTotalTokens: options?.usageTotalTokens,
        contextLength: options?.contextLength,
        pressureRatio: (typeof options?.usageTotalTokens === 'number' && typeof options?.contextLength === 'number' && options.contextLength > 0)
          ? options.usageTotalTokens / options.contextLength
          : undefined,
        totalCandidates: candidates.length,
        mergedCount,
        droppedCount,
        reason: gate.reason,
        decisionJson: JSON.stringify(parsedDecision),
      },
    )
    memoryMaintainLastRunAtByScope.set(scope, Date.now())
    log('TASK_MEMORY_MAINTAIN_APPLIED', {
      total: candidates.length,
      mergeActions: parsedDecision.merge_actions.length,
      mergedCount,
      droppedCount,
      keepIds: parsedDecision.keep_ids.length,
      protectedRecentIds: [...protectedRecentIds],
      repartitionActive: repartitioned.active.length,
      repartitionArchive: repartitioned.archive.length,
    }, options?.logScope)
    return { applied: true, merged: mergedCount, dropped: droppedCount, total: candidates.length, reason: gate.reason }
  } finally {
    memoryMaintainInFlightByScope.delete(scope)
  }
}
