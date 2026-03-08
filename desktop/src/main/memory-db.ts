import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { app } from 'electron'
import type { ProjectNote, ProjectTaskMemory } from '../shared/ipc'

export type TaskMemoryEntry = ProjectTaskMemory
export type ProjectNoteEntry = ProjectNote

export type MemorySnapshotEntry = {
  id: string
  summary: string
  sourceMessageCount: number
  usageTotalTokens?: number
  maxTokens?: number
  createdAt: string
  updatedAt: string
}

type MemoryTier = 'active' | 'archive'

type MemoryScope = {
  workspace: string
  projectId?: string
}

function resolveHomeDir(): string {
  try {
    const electronHome = app.getPath('home')
    if (electronHome && electronHome.trim()) return electronHome.trim()
  } catch {
    // ignore: fallback to env/os
  }
  const envHome = (process.env.HOME || process.env.USERPROFILE || '').trim()
  if (envHome) return envHome
  const osHome = (os.homedir() || '').trim()
  if (osHome) return osHome
  return process.cwd()
}

const TACO_HOME = path.join(resolveHomeDir(), '.taco')
const STATE_DIR = path.join(TACO_HOME, 'state')
const MEMORY_DB_PATH = path.join(STATE_DIR, 'memory.db')

let db: DatabaseSync | null = null

function normalizeScope(scope: MemoryScope): { workspace: string; projectId: string } {
  return {
    workspace: path.resolve(String(scope.workspace || '').trim()),
    projectId: String(scope.projectId || '').trim(),
  }
}

function ensureDb(): DatabaseSync {
  if (db) return db
  fs.mkdirSync(STATE_DIR, { recursive: true })
  const next = new DatabaseSync(MEMORY_DB_PATH)
  next.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA temp_store = MEMORY;

    CREATE TABLE IF NOT EXISTS task_memories (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      project_id TEXT NOT NULL DEFAULT '',
      storage_tier TEXT NOT NULL DEFAULT 'active',
      user_query TEXT NOT NULL DEFAULT '',
      user_assets_block TEXT NOT NULL DEFAULT '',
      goal TEXT NOT NULL DEFAULT '',
      intent_type TEXT NOT NULL DEFAULT '',
      intent_summary TEXT NOT NULL DEFAULT '',
      intent_goal TEXT NOT NULL DEFAULT '',
      assistant_result TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      outcome TEXT NOT NULL DEFAULT 'success',
      tools_json TEXT NOT NULL DEFAULT '[]',
      changed_files_json TEXT NOT NULL DEFAULT '[]',
      identifiers_json TEXT NOT NULL DEFAULT '[]',
      failures_json TEXT NOT NULL DEFAULT '[]',
      deleted_at TEXT,
      deleted_reason TEXT NOT NULL DEFAULT '',
      merged_into_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_task_memories_scope_tier_updated
    ON task_memories(workspace, project_id, storage_tier, updated_at DESC, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_task_memories_scope_deleted
    ON task_memories(workspace, project_id, deleted_at);

    CREATE TABLE IF NOT EXISTS project_notes (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      project_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'other',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_project_notes_scope_updated
    ON project_notes(workspace, project_id, updated_at DESC, created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS memory_snapshots (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      project_id TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL,
      source_message_count INTEGER NOT NULL DEFAULT 0,
      usage_total_tokens INTEGER,
      max_tokens INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_snapshots_scope_updated
    ON memory_snapshots(workspace, project_id, updated_at DESC, created_at DESC);

    CREATE TABLE IF NOT EXISTS memory_maintain_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace TEXT NOT NULL,
      project_id TEXT NOT NULL DEFAULT '',
      usage_total_tokens INTEGER,
      max_tokens INTEGER,
      pressure_ratio REAL,
      total_candidates INTEGER NOT NULL DEFAULT 0,
      merged_count INTEGER NOT NULL DEFAULT 0,
      dropped_count INTEGER NOT NULL DEFAULT 0,
      reason TEXT NOT NULL DEFAULT '',
      decision_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
  `)
  db = next
  return next
}

function stringifyStringArray(value: string[] | undefined): string {
  return JSON.stringify(Array.isArray(value) ? value : [])
}

function parseStringArray(raw: unknown): string[] {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(parsed) ? parsed.map((item) => String(item ?? '').trim()).filter(Boolean) : []
  } catch {
    return []
  }
}

function rowToTaskMemoryEntry(row: Record<string, unknown>): TaskMemoryEntry {
  return {
    id: String(row.id || ''),
    ...(String(row.user_query || '').trim() ? { userQuery: String(row.user_query || '') } : {}),
    ...(String(row.user_assets_block || '').trim() ? { userAssetsBlock: String(row.user_assets_block || '') } : {}),
    goal: String(row.goal || ''),
    ...(String(row.intent_type || '').trim() ? { intentType: String(row.intent_type || '') } : {}),
    ...(String(row.intent_summary || '').trim() ? { intentSummary: String(row.intent_summary || '') } : {}),
    ...(String(row.intent_goal || '').trim() ? { intentGoal: String(row.intent_goal || '') } : {}),
    ...(String(row.assistant_result || '').trim() ? { assistantResult: String(row.assistant_result || '') } : {}),
    summary: String(row.summary || ''),
    outcome: (String(row.outcome || 'success') as 'success' | 'aborted' | 'error'),
    tools: parseStringArray(row.tools_json),
    changedFiles: parseStringArray(row.changed_files_json),
    identifiers: parseStringArray(row.identifiers_json),
    failures: parseStringArray(row.failures_json),
    ...(String(row.deleted_at || '').trim() ? { deletedAt: String(row.deleted_at || '') } : {}),
    ...(String(row.deleted_reason || '').trim() ? { deletedReason: String(row.deleted_reason || '') } : {}),
    ...(String(row.merged_into_id || '').trim() ? { mergedIntoId: String(row.merged_into_id || '') } : {}),
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || ''),
  }
}

function rowToSnapshotEntry(row: Record<string, unknown>): MemorySnapshotEntry {
  return {
    id: String(row.id || ''),
    summary: String(row.summary || ''),
    sourceMessageCount: Number(row.source_message_count || 0),
    ...(Number.isFinite(Number(row.usage_total_tokens)) ? { usageTotalTokens: Number(row.usage_total_tokens) } : {}),
    ...(Number.isFinite(Number(row.max_tokens)) ? { maxTokens: Number(row.max_tokens) } : {}),
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || ''),
  }
}

function rowToProjectNoteEntry(row: Record<string, unknown>): ProjectNoteEntry {
  return {
    id: String(row.id || ''),
    title: String(row.title || ''),
    content: String(row.content || ''),
    category: (String(row.category || 'other') as ProjectNoteEntry['category']),
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || ''),
  }
}

function upsertTaskMemoryRows(scope: MemoryScope, items: TaskMemoryEntry[], tier: MemoryTier): void {
  const database = ensureDb()
  const normalized = normalizeScope(scope)
  const stmt = database.prepare(`
    INSERT INTO task_memories (
      id, workspace, project_id, storage_tier,
      user_query, user_assets_block, goal,
      intent_type, intent_summary, intent_goal,
      assistant_result, summary, outcome,
      tools_json, changed_files_json, identifiers_json, failures_json,
      deleted_at, deleted_reason, merged_into_id,
      created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?
    )
    ON CONFLICT(id) DO UPDATE SET
      workspace=excluded.workspace,
      project_id=excluded.project_id,
      storage_tier=excluded.storage_tier,
      user_query=excluded.user_query,
      user_assets_block=excluded.user_assets_block,
      goal=excluded.goal,
      intent_type=excluded.intent_type,
      intent_summary=excluded.intent_summary,
      intent_goal=excluded.intent_goal,
      assistant_result=excluded.assistant_result,
      summary=excluded.summary,
      outcome=excluded.outcome,
      tools_json=excluded.tools_json,
      changed_files_json=excluded.changed_files_json,
      identifiers_json=excluded.identifiers_json,
      failures_json=excluded.failures_json,
      deleted_at=excluded.deleted_at,
      deleted_reason=excluded.deleted_reason,
      merged_into_id=excluded.merged_into_id,
      created_at=excluded.created_at,
      updated_at=excluded.updated_at
  `)
  const tx = database.transaction((rows: TaskMemoryEntry[]) => {
    for (const item of rows) {
      stmt.run(
        item.id,
        normalized.workspace,
        normalized.projectId,
        tier,
        String(item.userQuery || ''),
        String(item.userAssetsBlock || ''),
        String(item.goal || ''),
        String(item.intentType || ''),
        String(item.intentSummary || ''),
        String(item.intentGoal || ''),
        String(item.assistantResult || ''),
        String(item.summary || ''),
        String(item.outcome || 'success'),
        stringifyStringArray(item.tools),
        stringifyStringArray(item.changedFiles),
        stringifyStringArray(item.identifiers),
        stringifyStringArray(item.failures),
        item.deletedAt ?? null,
        String(item.deletedReason || ''),
        String(item.mergedIntoId || ''),
        String(item.createdAt || ''),
        String(item.updatedAt || ''),
      )
    }
  })
  tx(items)
}

function upsertProjectNoteRows(scope: MemoryScope, items: ProjectNoteEntry[]): void {
  const database = ensureDb()
  const normalized = normalizeScope(scope)
  const stmt = database.prepare(`
    INSERT INTO project_notes (
      id, workspace, project_id, title, content, category, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      workspace=excluded.workspace,
      project_id=excluded.project_id,
      title=excluded.title,
      content=excluded.content,
      category=excluded.category,
      created_at=excluded.created_at,
      updated_at=excluded.updated_at
  `)
  const tx = database.transaction((rows: ProjectNoteEntry[]) => {
    for (const item of rows) {
      stmt.run(
        item.id,
        normalized.workspace,
        normalized.projectId,
        String(item.title || ''),
        String(item.content || ''),
        String(item.category || 'other'),
        String(item.createdAt || ''),
        String(item.updatedAt || ''),
      )
    }
  })
  tx(items)
}

export function hasAnyProjectNotes(scope: MemoryScope): boolean {
  const database = ensureDb()
  const normalized = normalizeScope(scope)
  const row = database.prepare(`
    SELECT COUNT(1) AS count
    FROM project_notes
    WHERE workspace = ? AND project_id = ?
  `).get(normalized.workspace, normalized.projectId) as Record<string, unknown> | undefined
  return Number(row?.count || 0) > 0
}

export function listProjectNotesForScope(scope: MemoryScope): ProjectNoteEntry[] {
  const database = ensureDb()
  const normalized = normalizeScope(scope)
  const rows = database.prepare(`
    SELECT *
    FROM project_notes
    WHERE workspace = ? AND project_id = ?
    ORDER BY updated_at ASC, created_at ASC, id ASC
  `).all(normalized.workspace, normalized.projectId) as Array<Record<string, unknown>>
  return rows.map(rowToProjectNoteEntry)
}

export function replaceProjectNotes(scope: MemoryScope, items: ProjectNoteEntry[]): void {
  const database = ensureDb()
  const normalized = normalizeScope(scope)
  const tx = database.transaction((rows: ProjectNoteEntry[]) => {
    database.prepare(`
      DELETE FROM project_notes
      WHERE workspace = ? AND project_id = ?
    `).run(normalized.workspace, normalized.projectId)
    upsertProjectNoteRows(scope, rows)
  })
  tx(items)
}

export function importProjectNotes(scope: MemoryScope, items: ProjectNoteEntry[]): void {
  if (!Array.isArray(items) || items.length <= 0) return
  upsertProjectNoteRows(scope, items)
}

export function hasAnyTaskMemories(scope: MemoryScope): boolean {
  const database = ensureDb()
  const normalized = normalizeScope(scope)
  const row = database.prepare(`
    SELECT COUNT(1) AS count
    FROM task_memories
    WHERE workspace = ? AND project_id = ?
  `).get(normalized.workspace, normalized.projectId) as Record<string, unknown> | undefined
  return Number(row?.count || 0) > 0
}

export function listTaskMemoriesByTier(scope: MemoryScope, tier: MemoryTier): TaskMemoryEntry[] {
  const database = ensureDb()
  const normalized = normalizeScope(scope)
  const rows = database.prepare(`
    SELECT *
    FROM task_memories
    WHERE workspace = ? AND project_id = ? AND storage_tier = ?
    ORDER BY updated_at ASC, created_at ASC, id ASC
  `).all(normalized.workspace, normalized.projectId, tier) as Array<Record<string, unknown>>
  return rows.map(rowToTaskMemoryEntry)
}

export function replaceTaskMemoriesByTier(scope: MemoryScope, items: TaskMemoryEntry[], tier: MemoryTier): void {
  const database = ensureDb()
  const normalized = normalizeScope(scope)
  const tx = database.transaction((rows: TaskMemoryEntry[]) => {
    database.prepare(`
      DELETE FROM task_memories
      WHERE workspace = ? AND project_id = ? AND storage_tier = ?
    `).run(normalized.workspace, normalized.projectId, tier)
    upsertTaskMemoryRows(scope, rows, tier)
  })
  tx(items)
}

export function importTaskMemoriesByTier(scope: MemoryScope, items: TaskMemoryEntry[], tier: MemoryTier): void {
  if (!Array.isArray(items) || items.length <= 0) return
  upsertTaskMemoryRows(scope, items, tier)
}

function upsertSnapshotRows(scope: MemoryScope, items: MemorySnapshotEntry[]): void {
  const database = ensureDb()
  const normalized = normalizeScope(scope)
  const stmt = database.prepare(`
    INSERT INTO memory_snapshots (
      id, workspace, project_id, summary,
      source_message_count, usage_total_tokens, max_tokens,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      workspace=excluded.workspace,
      project_id=excluded.project_id,
      summary=excluded.summary,
      source_message_count=excluded.source_message_count,
      usage_total_tokens=excluded.usage_total_tokens,
      max_tokens=excluded.max_tokens,
      created_at=excluded.created_at,
      updated_at=excluded.updated_at
  `)
  const tx = database.transaction((rows: MemorySnapshotEntry[]) => {
    for (const item of rows) {
      stmt.run(
        item.id,
        normalized.workspace,
        normalized.projectId,
        String(item.summary || ''),
        Number(item.sourceMessageCount || 0),
        Number.isFinite(Number(item.usageTotalTokens)) ? Number(item.usageTotalTokens) : null,
        Number.isFinite(Number(item.maxTokens)) ? Number(item.maxTokens) : null,
        String(item.createdAt || ''),
        String(item.updatedAt || ''),
      )
    }
  })
  tx(items)
}

export function hasAnyMemorySnapshots(scope: MemoryScope): boolean {
  const database = ensureDb()
  const normalized = normalizeScope(scope)
  const row = database.prepare(`
    SELECT COUNT(1) AS count
    FROM memory_snapshots
    WHERE workspace = ? AND project_id = ?
  `).get(normalized.workspace, normalized.projectId) as Record<string, unknown> | undefined
  return Number(row?.count || 0) > 0
}

export function listMemorySnapshotsForScope(scope: MemoryScope): MemorySnapshotEntry[] {
  const database = ensureDb()
  const normalized = normalizeScope(scope)
  const rows = database.prepare(`
    SELECT *
    FROM memory_snapshots
    WHERE workspace = ? AND project_id = ?
    ORDER BY updated_at ASC, created_at ASC, id ASC
  `).all(normalized.workspace, normalized.projectId) as Array<Record<string, unknown>>
  return rows.map(rowToSnapshotEntry)
}

export function replaceMemorySnapshots(scope: MemoryScope, items: MemorySnapshotEntry[]): void {
  const database = ensureDb()
  const normalized = normalizeScope(scope)
  const tx = database.transaction((rows: MemorySnapshotEntry[]) => {
    database.prepare(`
      DELETE FROM memory_snapshots
      WHERE workspace = ? AND project_id = ?
    `).run(normalized.workspace, normalized.projectId)
    upsertSnapshotRows(scope, rows)
  })
  tx(items)
}

export function importMemorySnapshots(scope: MemoryScope, items: MemorySnapshotEntry[]): void {
  if (!Array.isArray(items) || items.length <= 0) return
  upsertSnapshotRows(scope, items)
}

export function insertMemoryMaintainRun(scope: MemoryScope, input: {
  usageTotalTokens?: number
  maxTokens?: number
  pressureRatio?: number
  totalCandidates: number
  mergedCount: number
  droppedCount: number
  reason: string
  decisionJson: string
  createdAt?: string
}): void {
  const database = ensureDb()
  const normalized = normalizeScope(scope)
  database.prepare(`
    INSERT INTO memory_maintain_runs (
      workspace, project_id, usage_total_tokens, max_tokens, pressure_ratio,
      total_candidates, merged_count, dropped_count, reason, decision_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    normalized.workspace,
    normalized.projectId,
    Number.isFinite(Number(input.usageTotalTokens)) ? Number(input.usageTotalTokens) : null,
    Number.isFinite(Number(input.maxTokens)) ? Number(input.maxTokens) : null,
    Number.isFinite(Number(input.pressureRatio)) ? Number(input.pressureRatio) : null,
    Number(input.totalCandidates || 0),
    Number(input.mergedCount || 0),
    Number(input.droppedCount || 0),
    String(input.reason || ''),
    String(input.decisionJson || '{}'),
    String(input.createdAt || new Date().toISOString()),
  )
}

export function countMemoryMaintainRuns(scope: MemoryScope): number {
  const database = ensureDb()
  const normalized = normalizeScope(scope)
  const row = database.prepare(`
    SELECT COUNT(1) AS count
    FROM memory_maintain_runs
    WHERE workspace = ? AND project_id = ?
  `).get(normalized.workspace, normalized.projectId) as Record<string, unknown> | undefined
  return Number(row?.count || 0)
}

export function getMemoryDbInfo(): { dbPath: string; dbSizeBytes: number } {
  const dbPath = MEMORY_DB_PATH
  const walPath = `${dbPath}-wal`
  const dbSize = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0
  const walSize = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0
  return {
    dbPath,
    dbSizeBytes: dbSize + walSize,
  }
}

export function getMemoryDbPath(): string {
  return MEMORY_DB_PATH
}

export function initMemoryDb(): void {
  ensureDb()
}
