/**
 * 任务记忆 CRUD
 *
 * 负责任务记忆的加载、保存、记录、删除、归档管理。
 */

import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { MemorySnapshotEntry } from './memory-snapshot'

type MemoryScope = {
  workspace: string
  projectId?: string
  scopeKey?: string
}

import {
  hasAnyTaskMemories,
  listTaskMemoriesByTier,
  replaceTaskMemoriesByTier,
  importTaskMemoriesByTier,
  resolveChatStoreMessageSeqRange,
} from '../memory-db'
import { TACO_HOME, projectScope, workspaceHash } from '../../../shared/paths'
import {
  extractUserAssetsBlock,
  extractUserQueryText,
} from '../../../shared/user-assets'

function stripControlChars(input: string): string {
  return String(input ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
}
import { shortText, pathExists, readJsonArray } from './memory-utils'
import type { TaskMemoryEntry } from './memory-normalize'
import {
  normalizeTaskMemoryEntry,
  isSoftDeletedMemory,
  buildAssistantResultBody,
  buildCompactMemorySummary,
} from './memory-normalize'

/* ------------------------------------------------------------------ */
/*  常量 & 类型                                                          */
/* ------------------------------------------------------------------ */

const MEMORY_DIR = path.join(TACO_HOME, 'memory')
const MEMORY_ARCHIVE_DIR = path.join(TACO_HOME, 'memory-archive')
const TASK_MEMORY_MAX_ENTRIES = 400
const TASK_MEMORY_ARCHIVE_MAX_ENTRIES = 6000
const TASK_MEMORY_TOTAL_MAX_ENTRIES = TASK_MEMORY_MAX_ENTRIES + TASK_MEMORY_ARCHIVE_MAX_ENTRIES
const TASK_MEMORY_USER_ASSETS_MAX_CHARS = 3000

type TaskLogSourceRefInput = {
  sessionId?: string
  userMessageId?: string
  assistantMessageId?: string
  messageIds?: string[]
}

export type TaskLogInput = {
  userQuery: string  // 用户原始提问(必填)
  userAssetsBlock?: string
  assistantResult: string  // AI完整回复(必填)
  outcome: 'success' | 'aborted' | 'error'
  tools?: string[]
  changedFiles?: string[]
  fileDiffs?: Array<{path: string, oldContent: string | null, newContent: string | null}>
  failures?: string[]
  sourceRef?: TaskLogSourceRefInput
}

/* ------------------------------------------------------------------ */
/*  路径解析                                                             */
/* ------------------------------------------------------------------ */

function resolveScope(workspace: string, projectId?: string): string {
  if (projectId && projectId.trim()) return projectScope(projectId.trim())
  if (workspace && workspace.trim()) return workspaceHash(workspace)
  return 'global'
}

function memoryFilePath(workspace: string, projectId?: string): string {
  return path.join(MEMORY_DIR, `${resolveScope(workspace, projectId)}.json`)
}

function memoryArchiveFilePath(workspace: string, projectId?: string): string {
  return path.join(MEMORY_ARCHIVE_DIR, `${resolveScope(workspace, projectId)}.json`)
}

/* ------------------------------------------------------------------ */
/*  辅助函数                                                             */
/* ------------------------------------------------------------------ */

function normalizeTaskLogSourceRef(value: TaskLogSourceRefInput | undefined): TaskLogSourceRefInput {
  if (!value || typeof value !== 'object') return {}
  const sessionId = shortText(String(value.sessionId || '').trim(), 120)
  const userMessageId = shortText(String(value.userMessageId || '').trim(), 180)
  const assistantMessageId = shortText(String(value.assistantMessageId || '').trim(), 180)
  const messageIds = normalizeStringList(value.messageIds, 200)
  const mergedMessageIds = [...new Set([userMessageId, assistantMessageId, ...messageIds].filter(Boolean))]
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(userMessageId ? { userMessageId } : {}),
    ...(assistantMessageId ? { assistantMessageId } : {}),
    ...(mergedMessageIds.length > 0 ? { messageIds: mergedMessageIds } : {}),
  }
}

function normalizeStringList(value: unknown, max = 120): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((x) => String(x ?? '').trim()).filter(Boolean))].slice(0, max)
}

function taskMemoryTs(item: TaskMemoryEntry): number {
  const created = Date.parse(item.createdAt || '')
  if (Number.isFinite(created)) return created
  const updated = Date.parse(item.updatedAt || '')
  if (Number.isFinite(updated)) return updated
  return 0
}

export function sortTaskMemoriesByTimeAsc(items: TaskMemoryEntry[]): TaskMemoryEntry[] {
  return [...items].sort((a, b) => {
    const ta = taskMemoryTs(a)
    const tb = taskMemoryTs(b)
    if (ta !== tb) return ta - tb
    return String(a.id).localeCompare(String(b.id))
  })
}

export function mergeTaskMemoryById(items: TaskMemoryEntry[]): TaskMemoryEntry[] {
  const byId = new Map<string, TaskMemoryEntry>()
  for (const item of items) {
    const id = String(item.id || '').trim()
    if (!id) continue
    const prev = byId.get(id)
    if (!prev) {
      byId.set(id, item)
      continue
    }
    if (taskMemoryTs(item) >= taskMemoryTs(prev)) byId.set(id, item)
  }
  return sortTaskMemoriesByTimeAsc(Array.from(byId.values()))
}

/* ------------------------------------------------------------------ */
/*  CRUD                                                                 */
/* ------------------------------------------------------------------ */

export async function loadTaskMemories(workspace: string, projectId?: string): Promise<TaskMemoryEntry[]> {
  return listTaskMemoriesByTier({ workspace, projectId }, 'active').map((item, index) => normalizeTaskMemoryEntry(item, index))
}

export async function loadTaskMemoryArchive(workspace: string, projectId?: string): Promise<TaskMemoryEntry[]> {
  return listTaskMemoriesByTier({ workspace, projectId }, 'archive').map((item, index) => normalizeTaskMemoryEntry(item, index))
}

export async function saveTaskMemories(workspace: string, items: TaskMemoryEntry[], projectId?: string): Promise<void> {
  replaceTaskMemoriesByTier({ workspace, projectId }, items, 'active')
}

export async function saveTaskMemoryArchive(workspace: string, items: TaskMemoryEntry[], projectId?: string): Promise<void> {
  replaceTaskMemoriesByTier({ workspace, projectId }, items, 'archive')
}

export async function loadTaskMemoriesForRecall(workspace: string, projectId?: string): Promise<TaskMemoryEntry[]> {
  const [active, archived] = await Promise.all([
    loadTaskMemories(workspace, projectId),
    loadTaskMemoryArchive(workspace, projectId),
  ])
  const merged = archived.length === 0 ? sortTaskMemoriesByTimeAsc(active) : mergeTaskMemoryById([...archived, ...active])
  return merged.filter((item) => !isSoftDeletedMemory(item))
}

/** 列出任务执行记忆（按时间倒序） */
export async function listTaskMemories(workspace: string, projectId?: string): Promise<TaskMemoryEntry[]> {
  const items = await loadTaskMemoriesForRecall(workspace, projectId)
  return [...items].sort((a, b) => {
    const ta = Date.parse(a.updatedAt || a.createdAt || '')
    const tb = Date.parse(b.updatedAt || b.createdAt || '')
    const safeA = Number.isFinite(ta) ? ta : 0
    const safeB = Number.isFinite(tb) ? tb : 0
    if (safeB !== safeA) return safeB - safeA
    return String(a.id).localeCompare(String(b.id))
  })
}

/** 删除任务执行记忆(硬删除) */
export async function deleteTaskMemory(workspace: string, memoryId: string, projectId?: string): Promise<void> {
  const { deleteTaskMemoryById } = await import('../memory-db')
  
  // 直接按ID删除(storage_tier不限,active和archive都会被检查)
  deleteTaskMemoryById({ workspace, projectId }, memoryId)
}

/**
 * 每轮任务结束后写入任务记忆（独立存储，不污染手工笔记列表）。
 * 仅成功任务会进入可召回的任务记忆；失败和中止任务不写入记忆总结。
 */
export async function recordTaskLog(workspace: string, input: TaskLogInput, projectId?: string): Promise<TaskMemoryEntry | null> {
  if (input.outcome !== 'success') return null

  const now = new Date().toISOString()
  const assistantResult = shortText(input.assistantResult, 12000)
  const normalizedUserQuery = shortText(extractUserQueryText(input.userQuery), 8000)
  const normalizedUserAssetsBlock = shortText(
    stripControlChars(String(input.userAssetsBlock || '')),
    TASK_MEMORY_USER_ASSETS_MAX_CHARS,
  )
  const normalizedSourceRef = normalizeTaskLogSourceRef(input.sourceRef)
  let sourceMessageIds = normalizedSourceRef.messageIds ?? []
  let sourceStartSeq: number | undefined
  let sourceEndSeq: number | undefined
  if (normalizedSourceRef.sessionId && sourceMessageIds.length > 0) {
    const resolved = resolveChatStoreMessageSeqRange(normalizedSourceRef.sessionId, sourceMessageIds)
    if (resolved.resolvedMessageIds.length > 0) {
      sourceMessageIds = [...new Set([...sourceMessageIds, ...resolved.resolvedMessageIds])]
    }
    if (typeof resolved.startSeq === 'number') sourceStartSeq = resolved.startSeq
    if (typeof resolved.endSeq === 'number') sourceEndSeq = resolved.endSeq
  }
  const item: TaskMemoryEntry = {
    id: `task-${Date.now()}-${randomUUID().slice(0, 8)}`,
    userQuery: normalizedUserQuery,
    ...(normalizedUserAssetsBlock ? { userAssetsBlock: normalizedUserAssetsBlock } : {}),
    assistantResult,
    outcome: input.outcome,
    tools: [...new Set((input.tools ?? []).map((x) => String(x).trim()).filter(Boolean))],
    changedFiles: [...new Set((input.changedFiles ?? []).map((x) => String(x).trim()).filter(Boolean))],
    fileDiffs: input.fileDiffs ?? [],
    ...(normalizedSourceRef.sessionId ? { sourceSessionId: normalizedSourceRef.sessionId } : {}),
    ...(normalizedSourceRef.userMessageId ? { sourceUserMessageId: normalizedSourceRef.userMessageId } : {}),
    ...(normalizedSourceRef.assistantMessageId ? { sourceAssistantMessageId: normalizedSourceRef.assistantMessageId } : {}),
    ...(sourceMessageIds.length > 0 ? { sourceMessageIds } : {}),
    ...(typeof sourceStartSeq === 'number' ? { sourceStartSeq } : {}),
    ...(typeof sourceEndSeq === 'number' ? { sourceEndSeq } : {}),
    failures: [...new Set((input.failures ?? []).map((x) => String(x).trim()).filter(Boolean))].slice(0, 24),
    createdAt: now,
    updatedAt: now,
  }

  const current = await loadTaskMemories(workspace, projectId)

  // 近似去重：短时间内完全相同提问+回复，视为同一条
  const duplicateIdx = current.findIndex((entry) =>
    !isSoftDeletedMemory(entry) &&
    entry.userQuery === item.userQuery &&
    (entry.userAssetsBlock ?? '') === (item.userAssetsBlock ?? '') &&
    entry.assistantResult === item.assistantResult &&
    entry.outcome === item.outcome &&
    Math.abs(Date.parse(entry.updatedAt || entry.createdAt || '') - Date.now()) <= 10 * 60 * 1000
  )

  if (duplicateIdx >= 0) {
    const duplicate = current[duplicateIdx]
    const mergedSourceMessageIds = [...new Set([...(duplicate.sourceMessageIds ?? []), ...(item.sourceMessageIds ?? [])].filter(Boolean))]
    const mergedSourceStartSeq = [duplicate.sourceStartSeq, item.sourceStartSeq].filter((x) => typeof x === 'number').sort((a, b) => Number(a) - Number(b))[0]
    const mergedSourceEndSeq = [duplicate.sourceEndSeq, item.sourceEndSeq].filter((x) => typeof x === 'number').sort((a, b) => Number(b) - Number(a))[0]
    current[duplicateIdx] = {
      ...duplicate,
      ...item,
      id: duplicate.id,
      createdAt: duplicate.createdAt,
      updatedAt: now,
      ...(mergedSourceMessageIds.length > 0 ? { sourceMessageIds: mergedSourceMessageIds } : {}),
      ...(typeof mergedSourceStartSeq === 'number' ? { sourceStartSeq: mergedSourceStartSeq } : {}),
      ...(typeof mergedSourceEndSeq === 'number' ? { sourceEndSeq: mergedSourceEndSeq } : {}),
      ...(!item.sourceSessionId && duplicate.sourceSessionId ? { sourceSessionId: duplicate.sourceSessionId } : {}),
      ...(!item.sourceUserMessageId && duplicate.sourceUserMessageId ? { sourceUserMessageId: duplicate.sourceUserMessageId } : {}),
      ...(!item.sourceAssistantMessageId && duplicate.sourceAssistantMessageId ? { sourceAssistantMessageId: duplicate.sourceAssistantMessageId } : {}),
    }
    await saveTaskMemories(workspace, current, projectId)
    return current[duplicateIdx]
  }

  const merged = sortTaskMemoriesByTimeAsc([...current, item])

  if (merged.length <= TASK_MEMORY_MAX_ENTRIES) {
    await saveTaskMemories(workspace, merged, projectId)
    return item
  }

  const overflowCount = Math.max(0, merged.length - TASK_MEMORY_MAX_ENTRIES)
  const overflow = merged.slice(0, overflowCount)
  const keepActive = merged.slice(overflowCount)
  const archive = await loadTaskMemoryArchive(workspace, projectId)
  const mergedArchive = mergeTaskMemoryById([...archive, ...overflow])
  const trimmedArchive = mergedArchive.length > TASK_MEMORY_ARCHIVE_MAX_ENTRIES
    ? mergedArchive.slice(-TASK_MEMORY_ARCHIVE_MAX_ENTRIES)
    : mergedArchive

  await Promise.all([
    saveTaskMemories(workspace, keepActive, projectId),
    saveTaskMemoryArchive(workspace, trimmedArchive, projectId),
  ])
  return item
}

function normalizeEvidenceFacts(items: string[] | undefined, limit = 12): string[] {
  const cleaned = [...new Set((items ?? [])
    .map((item) => stripControlChars(String(item ?? '').replace(/\r/g, '').trim()))
    .filter(Boolean))]
  return cleaned.slice(0, limit)
}

/* ------------------------------------------------------------------ */
/*  遗留迁移辅助                                                          */
/* ------------------------------------------------------------------ */

export async function loadLegacyTaskMemories(
  workspace: string,
  projectId: string | undefined,
  tier: 'active' | 'archive',
): Promise<TaskMemoryEntry[]> {
  const filePath = tier === 'active'
    ? memoryFilePath(workspace, projectId)
    : memoryArchiveFilePath(workspace, projectId)
  const exists = await pathExists(filePath)
  if (!exists) return []
  return (await readJsonArray<TaskMemoryEntry>(filePath)).map((item, index) => normalizeTaskMemoryEntry(item, index))
}

export async function importLegacyTaskMemoriesIfEmpty(
  scopeRef: MemoryScope,
  legacyActive: TaskMemoryEntry[],
  legacyArchive: TaskMemoryEntry[],
): Promise<void> {
  if (legacyActive.length > 0 && !hasAnyTaskMemories(scopeRef)) {
    importTaskMemoriesByTier(scopeRef, legacyActive, 'active')
  }
  if (legacyArchive.length > 0 && !hasAnyTaskMemories(scopeRef)) {
    importTaskMemoriesByTier(scopeRef, legacyArchive, 'archive')
  }
}
