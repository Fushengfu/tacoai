/**
 * 遗留数据迁移
 *
 * 负责从旧版 JSON 文件迁移到 SQLite memory-db。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import type { ProjectNote } from '../../../shared/ipc'
import type { TaskMemoryEntry } from './memory-normalize'
import type { MemorySnapshotEntry } from './memory-snapshot'

type MemoryScope = {
  workspace: string
  projectId?: string
  scopeKey?: string
}

import {
  initMemoryDb,
  isMemoryDbEmpty,
  importProjectNotes,
  importTaskMemoriesByTier,
  importMemorySnapshots,
} from '../../data/memory-db'
import { log } from '../../system/logger'
import { TACO_HOME } from '../../../shared/paths'
import { readJsonArray } from './memory-utils'
import { normalizeTaskMemoryEntry } from './memory-normalize'
import { normalizeMemorySnapshotEntry } from './memory-snapshot'
import { normalizeProjectNoteEntry } from '../notes/notes-crud'

/* ------------------------------------------------------------------ */
/*  常量                                                                 */
/* ------------------------------------------------------------------ */

const NOTES_DIR = path.join(TACO_HOME, 'notes')
const MEMORY_DIR = path.join(TACO_HOME, 'memory')
const MEMORY_ARCHIVE_DIR = path.join(TACO_HOME, 'memory-archive')
const SNAPSHOT_DIR = path.join(TACO_HOME, 'memory-snapshots')

/* ------------------------------------------------------------------ */
/*  遗留扫描                                                             */
/* ------------------------------------------------------------------ */

function legacyScopeKeyFromFilePath(filePath: string): string {
  return path.basename(filePath, path.extname(filePath))
}

function legacyDbScope(scopeKey: string): MemoryScope {
  return {
    workspace: '',
    scopeKey,
  }
}

async function listLegacyScopeKeys(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => path.join(dirPath, entry.name))
      .map(legacyScopeKeyFromFilePath)
  } catch {
    return []
  }
}

/* ------------------------------------------------------------------ */
/*  全局引导                                                             */
/* ------------------------------------------------------------------ */

let legacyMemoryDbBootstrapDone = false
let legacyMemoryDbBootstrapPromise: Promise<void> | null = null

export async function ensureLegacyMemoryDbBootstrap(): Promise<void> {
  if (legacyMemoryDbBootstrapDone) return
  if (legacyMemoryDbBootstrapPromise) {
    await legacyMemoryDbBootstrapPromise
    return
  }

  legacyMemoryDbBootstrapPromise = (async () => {
    initMemoryDb()
    if (!isMemoryDbEmpty()) {
      legacyMemoryDbBootstrapDone = true
      return
    }

    const scopeKeys = new Set<string>([
      ...(await listLegacyScopeKeys(NOTES_DIR)),
      ...(await listLegacyScopeKeys(MEMORY_DIR)),
      ...(await listLegacyScopeKeys(MEMORY_ARCHIVE_DIR)),
      ...(await listLegacyScopeKeys(SNAPSHOT_DIR)),
    ])

    if (scopeKeys.size <= 0) {
      legacyMemoryDbBootstrapDone = true
      return
    }

    let importedNoteCount = 0
    let importedActiveCount = 0
    let importedArchiveCount = 0
    let importedSnapshotCount = 0

    for (const scopeKey of Array.from(scopeKeys).sort()) {
      const scopeRef = legacyDbScope(scopeKey)
      const [legacyNotes, legacyActive, legacyArchive, legacySnapshots] = await Promise.all([
        readJsonArray<ProjectNote>(path.join(NOTES_DIR, `${scopeKey}.json`)),
        readJsonArray<TaskMemoryEntry>(path.join(MEMORY_DIR, `${scopeKey}.json`)),
        readJsonArray<TaskMemoryEntry>(path.join(MEMORY_ARCHIVE_DIR, `${scopeKey}.json`)),
        readJsonArray<MemorySnapshotEntry>(path.join(SNAPSHOT_DIR, `${scopeKey}.json`)),
      ])

      const normalizedNotes = legacyNotes.map((item, index) => normalizeProjectNoteEntry(item, index))
      const normalizedActive = legacyActive.map((item, index) => normalizeTaskMemoryEntry(item, index))
      const normalizedArchive = legacyArchive.map((item, index) => normalizeTaskMemoryEntry(item, index))
      const normalizedSnapshots = legacySnapshots.map((item, index) => normalizeMemorySnapshotEntry(item, index))

      if (normalizedNotes.length > 0) {
        importProjectNotes(scopeRef, normalizedNotes)
        importedNoteCount += normalizedNotes.length
      }
      if (normalizedActive.length > 0) {
        importTaskMemoriesByTier(scopeRef, normalizedActive, 'active')
        importedActiveCount += normalizedActive.length
      }
      if (normalizedArchive.length > 0) {
        importTaskMemoriesByTier(scopeRef, normalizedArchive, 'archive')
        importedArchiveCount += normalizedArchive.length
      }
      if (normalizedSnapshots.length > 0) {
        importMemorySnapshots(scopeRef, normalizedSnapshots)
        importedSnapshotCount += normalizedSnapshots.length
      }
    }

    log('LEGACY_MEMORY_DB_BOOTSTRAP_DONE', {
      scopeCount: scopeKeys.size,
      importedNoteCount,
      importedActiveCount,
      importedArchiveCount,
      importedSnapshotCount,
    })
    legacyMemoryDbBootstrapDone = true
  })().finally(() => {
    legacyMemoryDbBootstrapPromise = null
  })

  await legacyMemoryDbBootstrapPromise
}

/* ------------------------------------------------------------------ */
/*  作用域级迁移                                                          */
/* ------------------------------------------------------------------ */

const noteScopeReadyByScope = new Set<string>()
const taskMemoryScopeReadyByScope = new Set<string>()
const snapshotScopeReadyByScope = new Set<string>()

export async function ensureNoteScopeReady(workspace: string, projectId?: string): Promise<void> {
  const scope = resolveScope(workspace, projectId)
  if (noteScopeReadyByScope.has(scope)) return
  await ensureLegacyMemoryDbBootstrap()
  initMemoryDb()

  const { loadLegacyNotes, importLegacyNotesIfEmpty } = await import('../notes/notes-crud')
  const legacyNotes = await loadLegacyNotes(workspace, projectId)
  if (legacyNotes.length > 0) {
    importLegacyNotesIfEmpty({ workspace, projectId }, legacyNotes)
    log('PROJECT_NOTES_DB_SCOPE_MIGRATED', {
      scope,
      noteCount: legacyNotes.length,
    })
  }

  noteScopeReadyByScope.add(scope)
}

export async function ensureTaskMemoryScopeReady(workspace: string, projectId?: string): Promise<void> {
  const scope = resolveScope(workspace, projectId)
  if (taskMemoryScopeReadyByScope.has(scope)) return
  await ensureLegacyMemoryDbBootstrap()
  initMemoryDb()

  const { loadLegacyTaskMemories, importLegacyTaskMemoriesIfEmpty } = await import('./memory-crud')
  const [legacyActive, legacyArchive] = await Promise.all([
    loadLegacyTaskMemories(workspace, projectId, 'active'),
    loadLegacyTaskMemories(workspace, projectId, 'archive'),
  ])

  if (legacyActive.length > 0 || legacyArchive.length > 0) {
    importLegacyTaskMemoriesIfEmpty({ workspace, projectId }, legacyActive, legacyArchive)
    log('TASK_MEMORY_DB_SCOPE_MIGRATED', {
      scope,
      activeCount: legacyActive.length,
      archiveCount: legacyArchive.length,
    })
  }

  taskMemoryScopeReadyByScope.add(scope)
}

export async function ensureSnapshotScopeReady(workspace: string, projectId?: string): Promise<void> {
  const scope = resolveScope(workspace, projectId)
  if (snapshotScopeReadyByScope.has(scope)) return
  await ensureLegacyMemoryDbBootstrap()
  initMemoryDb()

  const { loadLegacySnapshots, importLegacySnapshotsIfEmpty } = await import('./memory-snapshot')
  const legacySnapshots = await loadLegacySnapshots(workspace, projectId)

  if (legacySnapshots.length > 0) {
    importLegacySnapshotsIfEmpty({ workspace, projectId }, legacySnapshots)
    log('MEMORY_SNAPSHOT_DB_SCOPE_MIGRATED', {
      scope,
      snapshotCount: legacySnapshots.length,
    })
  }

  snapshotScopeReadyByScope.add(scope)
}

export function resolveScope(workspace: string, projectId?: string): string {
  const { projectScope, workspaceHash } = require('../../../shared/paths')
  if (projectId && projectId.trim()) return projectScope(projectId.trim())
  if (workspace && workspace.trim()) return workspaceHash(workspace)
  return 'global'
}
