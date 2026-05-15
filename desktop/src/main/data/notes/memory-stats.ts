/**
 * 记忆统计与导出
 *
 * 负责作用域统计信息和数据导出。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import type { MemoryScopeStats, MemoryScopeExportResult } from '../../../shared/ipc'
import { getMemoryDbInfo, countMemoryMaintainRuns } from '../memory-db'
import { TACO_HOME, projectScope, workspaceHash } from '../../../shared/paths'
import { latestIso } from './memory-utils'
import { listNotes } from './notes-crud'
import { loadTaskMemories, loadTaskMemoryArchive } from './memory-crud'
import { loadMemorySnapshots } from './memory-snapshot'
import { isSoftDeletedMemory } from './memory-normalize'
import { ensureNoteScopeReady, ensureTaskMemoryScopeReady, ensureSnapshotScopeReady } from './memory-migration'

/* ------------------------------------------------------------------ */
/*  常量                                                                 */
/* ------------------------------------------------------------------ */

const MEMORY_EXPORT_DIR = path.join(TACO_HOME, 'exports')

/* ------------------------------------------------------------------ */
/*  路径解析                                                             */
/* ------------------------------------------------------------------ */

function resolveScope(workspace: string, projectId?: string): string {
  if (projectId && projectId.trim()) return projectScope(projectId.trim())
  if (workspace && workspace.trim()) return workspaceHash(workspace)
  return 'global'
}

/* ------------------------------------------------------------------ */
/*  统计                                                                 */
/* ------------------------------------------------------------------ */

export async function getMemoryScopeStats(workspace: string, projectId?: string): Promise<MemoryScopeStats> {
  await Promise.all([
    ensureNoteScopeReady(workspace, projectId),
    ensureTaskMemoryScopeReady(workspace, projectId),
    ensureSnapshotScopeReady(workspace, projectId),
  ])

  const [notes, activeTaskMemories, archivedTaskMemories, snapshots] = await Promise.all([
    listNotes(workspace, projectId),
    loadTaskMemories(workspace, projectId),
    loadTaskMemoryArchive(workspace, projectId),
    loadMemorySnapshots(workspace, projectId),
  ])
  const dbInfo = getMemoryDbInfo()
  const allTaskMemories = [...activeTaskMemories, ...archivedTaskMemories]
  const visibleActiveTaskMemories = activeTaskMemories.filter((item) => !isSoftDeletedMemory(item))
  const visibleArchivedTaskMemories = archivedTaskMemories.filter((item) => !isSoftDeletedMemory(item))
  const deletedTaskMemories = allTaskMemories.filter(isSoftDeletedMemory).length

  return {
    scope: resolveScope(workspace, projectId),
    dbPath: dbInfo.dbPath,
    dbSizeBytes: dbInfo.dbSizeBytes,
    manualNotes: notes.length,
    activeTaskMemories: visibleActiveTaskMemories.length,
    archivedTaskMemories: visibleArchivedTaskMemories.length,
    deletedTaskMemories,
    snapshots: snapshots.length,
    maintainRuns: countMemoryMaintainRuns({ workspace, projectId }),
    ...(latestIso(notes.map((item) => item.updatedAt || item.createdAt)) ? { latestNoteUpdatedAt: latestIso(notes.map((item) => item.updatedAt || item.createdAt)) } : {}),
    ...(latestIso(allTaskMemories.map((item) => item.updatedAt || item.createdAt)) ? { latestTaskMemoryUpdatedAt: latestIso(allTaskMemories.map((item) => item.updatedAt || item.createdAt)) } : {}),
    ...(latestIso(snapshots.map((item) => item.updatedAt || item.createdAt)) ? { latestSnapshotUpdatedAt: latestIso(snapshots.map((item) => item.updatedAt || item.createdAt)) } : {}),
  }
}

/* ------------------------------------------------------------------ */
/*  导出                                                                 */
/* ------------------------------------------------------------------ */

export async function exportMemoryScope(workspace: string, projectId?: string): Promise<MemoryScopeExportResult> {
  await Promise.all([
    ensureNoteScopeReady(workspace, projectId),
    ensureTaskMemoryScopeReady(workspace, projectId),
    ensureSnapshotScopeReady(workspace, projectId),
  ])

  const [notes, activeTaskMemories, archivedTaskMemories, snapshots, stats] = await Promise.all([
    listNotes(workspace, projectId),
    loadTaskMemories(workspace, projectId),
    loadTaskMemoryArchive(workspace, projectId),
    loadMemorySnapshots(workspace, projectId),
    getMemoryScopeStats(workspace, projectId),
  ])

  await fs.mkdir(MEMORY_EXPORT_DIR, { recursive: true })
  const exportedAt = new Date().toISOString()
  const scope = resolveScope(workspace, projectId)
  const filePath = path.join(MEMORY_EXPORT_DIR, `memory-export-${scope}-${Date.now()}.json`)
  const payload = {
    exportedAt,
    workspace,
    ...(projectId ? { projectId } : {}),
    stats,
    notes,
    activeTaskMemories,
    archivedTaskMemories,
    snapshots,
  }
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8')

  return {
    filePath,
    exportedAt,
    manualNotes: notes.length,
    activeTaskMemories: activeTaskMemories.length,
    archivedTaskMemories: archivedTaskMemories.length,
    snapshots: snapshots.length,
  }
}
