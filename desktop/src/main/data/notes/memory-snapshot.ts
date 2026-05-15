/**
 * 记忆快照 CRUD
 *
 * 负责记忆压缩快照的加载、保存、记录。
 */

import { randomUUID, createHash } from 'node:crypto'
import path from 'node:path'
import {
  listMemorySnapshotsForScope,
  replaceMemorySnapshots,
  importMemorySnapshots,
} from '../memory-db'
import { TACO_HOME, projectScope, workspaceHash } from '../../../shared/paths'
import { shortText, normalizeIso, pathExists, readJsonArray } from './memory-utils'

/* ------------------------------------------------------------------ */
/*  常量 & 类型                                                          */
/* ------------------------------------------------------------------ */

const SNAPSHOT_DIR = path.join(TACO_HOME, 'memory-snapshots')
const MEMORY_SNAPSHOT_MAX_ENTRIES = 120
const MEMORY_SNAPSHOT_SUMMARY_MAX_CHARS = 5600

export type MemorySnapshotEntry = {
  id: string
  summary: string
  sourceMessageCount: number
  usageTotalTokens?: number
  maxTokens?: number
  createdAt: string
  updatedAt: string
}

type MemoryScope = {
  workspace: string
  projectId?: string
  scopeKey?: string
}

type SnapshotLogInput = {
  summary: string
  sourceMessageCount: number
  usageTotalTokens?: number
  maxTokens?: number
}

/* ------------------------------------------------------------------ */
/*  路径解析                                                             */
/* ------------------------------------------------------------------ */

function resolveScope(workspace: string, projectId?: string): string {
  if (projectId && projectId.trim()) return projectScope(projectId.trim())
  if (workspace && workspace.trim()) return workspaceHash(workspace)
  return 'global'
}

function snapshotFilePath(workspace: string, projectId?: string): string {
  return path.join(SNAPSHOT_DIR, `${resolveScope(workspace, projectId)}.json`)
}

/* ------------------------------------------------------------------ */
/*  标准化                                                               */
/* ------------------------------------------------------------------ */

export function normalizeMemorySnapshotEntry(raw: Partial<MemorySnapshotEntry>, index: number): MemorySnapshotEntry {
  const now = new Date().toISOString()
  const createdAtRaw = normalizeIso(raw.createdAt)
  const updatedAtRaw = normalizeIso(raw.updatedAt)
  const createdAt = createdAtRaw || updatedAtRaw || now
  const updatedAt = updatedAtRaw || createdAt
  const summary = shortText(String(raw.summary || '').trim(), MEMORY_SNAPSHOT_SUMMARY_MAX_CHARS)
  const sourceMessageCountRaw = Number(raw.sourceMessageCount)
  const sourceMessageCount = Number.isFinite(sourceMessageCountRaw) && sourceMessageCountRaw >= 0
    ? Math.floor(sourceMessageCountRaw)
    : 0
  const rawId = String(raw.id || '').trim()
  const stableId = rawId || `snapshot-legacy-${createHash('sha1').update(`${summary}|${createdAt}|${index}`).digest('hex').slice(0, 12)}`

  return {
    id: stableId,
    summary,
    sourceMessageCount,
    ...(Number.isFinite(Number(raw.usageTotalTokens)) ? { usageTotalTokens: Number(raw.usageTotalTokens) } : {}),
    ...(Number.isFinite(Number(raw.maxTokens)) ? { maxTokens: Number(raw.maxTokens) } : {}),
    createdAt,
    updatedAt,
  }
}

export function memorySnapshotTimestamp(item: MemorySnapshotEntry): number {
  const updated = Date.parse(item.updatedAt || '')
  if (Number.isFinite(updated)) return updated
  const created = Date.parse(item.createdAt || '')
  if (Number.isFinite(created)) return created
  return 0
}

/* ------------------------------------------------------------------ */
/*  CRUD                                                                 */
/* ------------------------------------------------------------------ */

export async function loadMemorySnapshots(workspace: string, projectId?: string): Promise<MemorySnapshotEntry[]> {
  return listMemorySnapshotsForScope({ workspace, projectId }).map((item, index) => normalizeMemorySnapshotEntry(item, index))
}

export async function saveMemorySnapshots(workspace: string, items: MemorySnapshotEntry[], projectId?: string): Promise<void> {
  replaceMemorySnapshots({ workspace, projectId }, items)
}

export async function recordMemorySnapshot(workspace: string, input: SnapshotLogInput, projectId?: string): Promise<MemorySnapshotEntry> {
  const now = new Date().toISOString()
  const summary = shortText(String(input.summary ?? '').trim(), MEMORY_SNAPSHOT_SUMMARY_MAX_CHARS)
  if (!summary) {
    throw new Error('recordMemorySnapshot requires non-empty summary')
  }
  const sourceMessageCountRaw = Number(input.sourceMessageCount)
  const sourceMessageCount = Number.isFinite(sourceMessageCountRaw) && sourceMessageCountRaw >= 0
    ? Math.floor(sourceMessageCountRaw)
    : 0
  const item: MemorySnapshotEntry = {
    id: `snapshot-${Date.now()}-${randomUUID().slice(0, 8)}`,
    summary,
    sourceMessageCount,
    ...(Number.isFinite(Number(input.usageTotalTokens)) ? { usageTotalTokens: Number(input.usageTotalTokens) } : {}),
    ...(Number.isFinite(Number(input.maxTokens)) ? { maxTokens: Number(input.maxTokens) } : {}),
    createdAt: now,
    updatedAt: now,
  }

  const current = await loadMemorySnapshots(workspace, projectId)
  const merged = [...current, item].slice(-MEMORY_SNAPSHOT_MAX_ENTRIES)
  await saveMemorySnapshots(workspace, merged, projectId)
  return item
}

/* ------------------------------------------------------------------ */
/*  遗留迁移辅助                                                          */
/* ------------------------------------------------------------------ */

export async function loadLegacySnapshots(workspace: string, projectId?: string): Promise<MemorySnapshotEntry[]> {
  const primaryFile = snapshotFilePath(workspace, projectId)
  const primaryExists = await pathExists(primaryFile)
  if (!primaryExists) return []
  return (await readJsonArray<MemorySnapshotEntry>(primaryFile)).map((item, index) => normalizeMemorySnapshotEntry(item, index))
}

export async function importLegacySnapshotsIfEmpty(scopeRef: MemoryScope, legacySnapshots: MemorySnapshotEntry[]): Promise<void> {
  if (legacySnapshots.length > 0) {
    importMemorySnapshots(scopeRef, legacySnapshots)
  }
}
