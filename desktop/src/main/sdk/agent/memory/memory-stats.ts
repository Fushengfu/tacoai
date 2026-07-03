/**
 * 记忆统计与导出
 *
 * 负责作用域统计信息和数据导出。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import type { MemoryScopeStats, MemoryScopeExportResult } from '../types'
import type { DatabaseService, NotesService } from '../services'
import { TACO_HOME, projectScope, workspaceHash } from '../paths'
import { latestIso } from './memory-utils'
import { loadTaskMemories, loadTaskMemoryArchive } from './store'
import { isSoftDeletedMemory } from './memory-normalize'
import { ensureNoteScopeReady, ensureTaskMemoryScopeReady } from './memory-migration'

/** 模块级服务变量 */
let _db: DatabaseService | null = null
let _notesService: NotesService | null = null

export function setMemoryStatsDatabase(db: DatabaseService) { _db = db }
export function setMemoryStatsNotes(notes: NotesService) { _notesService = notes }

function getDb(): DatabaseService {
  if (!_db) throw new Error('DatabaseService not initialized for memory-stats')
  return _db
}
function getNotes(): NotesService {
  if (!_notesService) throw new Error('NotesService not initialized for memory-stats')
  return _notesService
}

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
  ])

  const [notes, activeTaskMemories, archivedTaskMemories] = await Promise.all([
    getNotes().list(workspace, projectId),
    loadTaskMemories(workspace, projectId),
    loadTaskMemoryArchive(workspace, projectId),
  ])
  const dbInfo = getDb().getMemoryDbInfo()
  const allTaskMemories = [...activeTaskMemories, ...archivedTaskMemories]
  const visibleActiveTaskMemories = activeTaskMemories.filter((item) => !isSoftDeletedMemory(item))
  const visibleArchivedTaskMemories = archivedTaskMemories.filter((item) => !isSoftDeletedMemory(item))
  const deletedTaskMemories = allTaskMemories.filter(isSoftDeletedMemory).length

  return {
    scope: resolveScope(workspace, projectId),
    dbPath: (dbInfo as any).dbPath,
    dbSizeBytes: (dbInfo as any).dbSizeBytes,
    manualNotes: notes.length,
    activeTaskMemories: visibleActiveTaskMemories.length,
    archivedTaskMemories: visibleArchivedTaskMemories.length,
    deletedTaskMemories,
    snapshots: 0,
    maintainRuns: getDb().countMaintainRuns(resolveScope(workspace, projectId)),
    ...(latestIso((notes as any[]).map((item) => item.updatedAt || item.createdAt)) ? { latestNoteUpdatedAt: latestIso((notes as any[]).map((item) => item.updatedAt || item.createdAt)) } : {}),
    ...(latestIso(allTaskMemories.map((item) => item.updatedAt || item.createdAt)) ? { latestTaskMemoryUpdatedAt: latestIso(allTaskMemories.map((item) => item.updatedAt || item.createdAt)) } : {}),
  }
}

/* ------------------------------------------------------------------ */
/*  导出                                                                 */
/* ------------------------------------------------------------------ */

export async function exportMemoryScope(workspace: string, projectId?: string): Promise<MemoryScopeExportResult> {
  await Promise.all([
    ensureNoteScopeReady(workspace, projectId),
    ensureTaskMemoryScopeReady(workspace, projectId),
  ])

  const [notes, activeTaskMemories, archivedTaskMemories, stats] = await Promise.all([
    getNotes().list(workspace, projectId),
    loadTaskMemories(workspace, projectId),
    loadTaskMemoryArchive(workspace, projectId),
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
  }
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8')

  return {
    filePath,
    exportedAt,
    manualNotes: notes.length,
    activeTaskMemories: activeTaskMemories.length,
    archivedTaskMemories: archivedTaskMemories.length,
    snapshots: 0,
  }
}
