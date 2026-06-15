import path from 'node:path'
import fs from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type {
  AppStateModelConfig,
  AppStateProviderId,
  AppStateSession,
  AppStateThread,
  AppStateProvidersPayload,
  AppStateThreadsPayload,
  ProjectNote,
  ProjectTaskMemory,
} from '../../../shared/ipc-types'
import { TACO_HOME, workspaceHash, projectScope } from '../../../shared/paths'

/* ------------------------------------------------------------------ */
/*  Type exports                                                       */
/* ------------------------------------------------------------------ */

export type TaskMemoryEntry = ProjectTaskMemory & {
  // 废弃字段(保留兼容性)
  goal?: string
  intentType?: string
  intentSummary?: string
  intentGoal?: string
  summary?: string
  identifiers?: string[]
  evidenceFacts?: string[]
}
export type ProjectNoteEntry = ProjectNote

export type ChatStoreSessionEntry = {
  projectId: string
  sessionId: string
  workspace?: string
  updatedAt: number
  messages: unknown[]
}

export type ChatStoreSessionSummaryEntry = {
  projectId: string
  sessionId: string
  workspace?: string
  updatedAt: number
  messageCount: number
}

export type ChatStoreSessionPageEntry = {
  projectId: string
  sessionId: string
  workspace?: string
  updatedAt: number
  totalCount: number
  startSeq?: number
  endSeq?: number
  messages: unknown[]
}

export type ChatStoreSessionPatchEntry = {
  projectId: string
  sessionId: string
  workspace?: string
  updatedAt: number
  fromSeq: number
  messages: unknown[]
}

export type MemorySnapshotEntry = {
  id: string
  summary: string
  sourceMessageCount: number
  usageTotalTokens?: number
  contextLength?: number
  createdAt: string
  updatedAt: string
}

export type AppStateStoreEntry<T> = {
  data: T
  updatedAt?: string
}

export type ChatStoreMessageSeqRange = {
  resolvedMessageIds: string[]
  startSeq?: number
  endSeq?: number
}

export type BridgeSettingKey = 'pairingCodeMode'
export type BridgeSettingValue = 'permanent' | 'auto-refresh'

export type UploadConfigDbEntry = {
  provider: string
  config: Record<string, unknown>
  updatedAt: string
}

export type MemoryTier = 'active' | 'archive'

export type MemoryScope = {
  workspace: string
  projectId?: string
  scopeKey?: string
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

export const APP_PROVIDER_IDS: readonly AppStateProviderId[] = ['deepseek', 'kimi', 'minimax', 'glm', 'qwen', 'mimo']
export const APP_PROVIDER_LABELS: Readonly<Record<AppStateProviderId, string>> = {
  deepseek: 'DeepSeek',
  kimi: 'Kimi',
  minimax: 'MiniMax',
  glm: 'GLM',
  qwen: 'Qwen',
  mimo: 'MiMo',
}

const STATE_DIR = path.join(TACO_HOME, 'state')
export const MEMORY_DB_PATH = path.join(STATE_DIR, 'memory.db')

/* ------------------------------------------------------------------ */
/*  Database singleton                                                 */
/* ------------------------------------------------------------------ */

let db: DatabaseSync | null = null

/* ------------------------------------------------------------------ */
/*  Scope helpers                                                      */
/* ------------------------------------------------------------------ */

function resolveScopeKey(workspace: string, projectId?: string): string {
  if (projectId && projectId.trim()) return projectScope(projectId.trim())
  if (workspace && workspace.trim()) return workspaceHash(workspace)
  return 'global'
}

export function normalizeScope(scope: MemoryScope): { workspace: string; projectId: string; scopeKey: string } {
  const rawWorkspace = String(scope.workspace || '').trim()
  const projectId = String(scope.projectId || '').trim()
  const scopeKey = String(scope.scopeKey || '').trim() || resolveScopeKey(rawWorkspace, projectId)
  return {
    workspace: rawWorkspace ? path.resolve(rawWorkspace) : '',
    projectId,
    scopeKey,
  }
}

export function buildScopeWhere(scope: MemoryScope): {
  sql: string
  params: SQLInputValue[]
  normalized: { workspace: string; projectId: string; scopeKey: string }
} {
  const normalized = normalizeScope(scope)
  return {
    sql: 'scope_key = ?',
    params: [normalized.scopeKey],
    normalized,
  }
}

/* ------------------------------------------------------------------ */
/*  Schema utilities                                                   */
/* ------------------------------------------------------------------ */

function tableColumns(database: DatabaseSync, tableName: string): Set<string> {
  const rows = database.prepare(`PRAGMA table_info(${tableName})`).all() as Array<Record<string, unknown>>
  return new Set(rows.map((row) => String(row.name || '').trim()).filter(Boolean))
}

export function ensureColumn(database: DatabaseSync, tableName: string, columnName: string, definition: string): void {
  const columns = tableColumns(database, tableName)
  if (columns.has(columnName)) return
  database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`)
}

export function runInTransaction<T>(database: DatabaseSync, fn: () => T): T {
  database.exec('BEGIN')
  try {
    const result = fn()
    database.exec('COMMIT')
    return result
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch {
      // ignore rollback failure
    }
    throw error
  }
}

function backfillScopeKey(database: DatabaseSync, tableName: string): void {
  const rows = database.prepare(`
    SELECT rowid, workspace, project_id, scope_key
    FROM ${tableName}
    WHERE COALESCE(scope_key, '') = ''
  `).all() as Array<Record<string, unknown>>
  if (rows.length <= 0) return
  const stmt = database.prepare(`UPDATE ${tableName} SET scope_key = ? WHERE rowid = ?`)
  runInTransaction(database, () => {
    for (const row of rows) {
      const workspace = String(row.workspace || '').trim()
      const projectId = String(row.project_id || '').trim()
      const scopeKey = resolveScopeKey(workspace, projectId)
      stmt.run(scopeKey, Number(row.rowid))
    }
  })
}

/* ------------------------------------------------------------------ */
/*  Chat session migration                                             */
/* ------------------------------------------------------------------ */

function normalizeChatStoreSeq(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.floor(n)
}

function parseUnknownArray(raw: unknown): unknown[] {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function migrateLegacyChatSessionSnapshots(database: DatabaseSync): void {
  ensureColumn(database, 'chat_sessions', 'snapshot_migrated', 'INTEGER NOT NULL DEFAULT 0')

  const rows = database.prepare(`
    SELECT session_id, messages_json, updated_at, snapshot_migrated
    FROM chat_sessions
    WHERE COALESCE(snapshot_migrated, 0) = 0
  `).all() as Array<Record<string, unknown>>
  if (rows.length <= 0) return

  const existingCountsStmt = database.prepare(`
    SELECT COUNT(1) AS count
    FROM chat_messages
    WHERE session_id = ?
  `)
  const insertMessageStmt = database.prepare(`
    INSERT INTO chat_messages (
      session_id, seq, message_id, role, message_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, seq) DO UPDATE SET
      message_id=excluded.message_id,
      role=excluded.role,
      message_json=excluded.message_json,
      updated_at=excluded.updated_at
  `)
  const finalizeStmt = database.prepare(`
    UPDATE chat_sessions
    SET messages_json = '[]', snapshot_migrated = 1
    WHERE session_id = ?
  `)

  runInTransaction(database, () => {
    for (const row of rows) {
      const sessionId = String(row.session_id || '').trim()
      if (!sessionId) continue

      const existingCountRow = existingCountsStmt.get(sessionId) as Record<string, unknown> | undefined
      const hasNormalizedMessages = Number(existingCountRow?.count || 0) > 0
      if (!hasNormalizedMessages) {
        const legacyMessages = parseUnknownArray(row.messages_json)
        const updatedAt = Number.isFinite(Number(row.updated_at)) ? Number(row.updated_at) : Date.now()
        for (let index = 0; index < legacyMessages.length; index++) {
          const message = legacyMessages[index]
          const record = message && typeof message === 'object' ? message as Record<string, unknown> : {}
          const messageId = String(record.id || `${sessionId}:legacy:${index}`).trim() || `${sessionId}:legacy:${index}`
          const role = String(record.role || 'assistant').trim() || 'assistant'
          insertMessageStmt.run(
            sessionId,
            index,
            messageId,
            role,
            JSON.stringify(message ?? null),
            updatedAt,
          )
        }
      }

      finalizeStmt.run(sessionId)
    }
  })
}

/* ------------------------------------------------------------------ */
/*  Database initialization                                            */
/* ------------------------------------------------------------------ */

function ensureDb(): DatabaseSync {
  if (db) return db
  fs.mkdirSync(STATE_DIR, { recursive: true })
  const next = new DatabaseSync(MEMORY_DB_PATH)
  next.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = ${process.platform === 'win32' ? 'FULL' : 'NORMAL'};
    PRAGMA foreign_keys = ON;
    PRAGMA temp_store = MEMORY;

    CREATE TABLE IF NOT EXISTS task_memories (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      project_id TEXT NOT NULL DEFAULT '',
      scope_key TEXT NOT NULL DEFAULT '',
      storage_tier TEXT NOT NULL DEFAULT 'active',
      user_query TEXT NOT NULL DEFAULT '',
      user_assets_block TEXT NOT NULL DEFAULT '',
      assistant_result TEXT NOT NULL DEFAULT '',
      outcome TEXT NOT NULL DEFAULT 'success',
      tools_json TEXT NOT NULL DEFAULT '[]',
      changed_files_json TEXT NOT NULL DEFAULT '[]',
      file_diffs_json TEXT NOT NULL DEFAULT '[]',
      source_session_id TEXT NOT NULL DEFAULT '',
      source_user_message_id TEXT NOT NULL DEFAULT '',
      source_assistant_message_id TEXT NOT NULL DEFAULT '',
      source_message_ids_json TEXT NOT NULL DEFAULT '[]',
      source_start_seq INTEGER,
      source_end_seq INTEGER,
      failures_json TEXT NOT NULL DEFAULT '[]',
      deleted_at TEXT,
      deleted_reason TEXT NOT NULL DEFAULT '',
      merged_into_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      -- 废弃字段(保留兼容性,不再使用)
      goal TEXT NOT NULL DEFAULT '',
      intent_type TEXT NOT NULL DEFAULT '',
      intent_summary TEXT NOT NULL DEFAULT '',
      intent_goal TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      identifiers_json TEXT NOT NULL DEFAULT '[]',
      evidence_facts_json TEXT NOT NULL DEFAULT '[]'
    );

    CREATE INDEX IF NOT EXISTS idx_task_memories_scope_tier_updated
    ON task_memories(workspace, project_id, storage_tier, updated_at DESC, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_task_memories_scope_deleted
    ON task_memories(workspace, project_id, deleted_at);

    CREATE INDEX IF NOT EXISTS idx_task_memories_scope_key_tier_updated
    ON task_memories(scope_key, storage_tier, updated_at DESC, created_at DESC);

    CREATE TABLE IF NOT EXISTS project_notes (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      project_id TEXT NOT NULL DEFAULT '',
      scope_key TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'other',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_project_notes_scope_updated
    ON project_notes(workspace, project_id, updated_at DESC, created_at DESC, id DESC);

    CREATE INDEX IF NOT EXISTS idx_project_notes_scope_key_updated
    ON project_notes(scope_key, updated_at DESC, created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS memory_snapshots (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      project_id TEXT NOT NULL DEFAULT '',
      scope_key TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL,
      source_message_count INTEGER NOT NULL DEFAULT 0,
      usage_total_tokens INTEGER,
      max_tokens INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memory_snapshots_scope_updated
    ON memory_snapshots(workspace, project_id, updated_at DESC, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_memory_snapshots_scope_key_updated
    ON memory_snapshots(scope_key, updated_at DESC, created_at DESC);

    CREATE TABLE IF NOT EXISTS memory_maintain_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace TEXT NOT NULL,
      project_id TEXT NOT NULL DEFAULT '',
      scope_key TEXT NOT NULL DEFAULT '',
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

    CREATE TABLE IF NOT EXISTS chat_sessions (
      session_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL DEFAULT '',
      workspace TEXT NOT NULL DEFAULT '',
      messages_json TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL DEFAULT 0,
      snapshot_migrated INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_chat_sessions_project_updated
    ON chat_sessions(project_id, updated_at DESC, session_id ASC);

    CREATE TABLE IF NOT EXISTS chat_messages (
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      message_id TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'assistant',
      message_json TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (session_id, seq),
      FOREIGN KEY (session_id) REFERENCES chat_sessions(session_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_chat_messages_session_seq
    ON chat_messages(session_id, seq ASC);

    CREATE TABLE IF NOT EXISTS app_project_configs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      title_locked INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0,
      model_config_id TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL DEFAULT '',
      workspace TEXT NOT NULL DEFAULT '',
      project_rules TEXT NOT NULL DEFAULT '',
      active_session_id TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_app_project_configs_updated
    ON app_project_configs(updated_at DESC, id ASC);

    CREATE TABLE IF NOT EXISTS app_project_sessions (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (thread_id) REFERENCES app_project_configs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_app_project_sessions_thread_sort
    ON app_project_sessions(thread_id, sort_order ASC, created_at ASC, id ASC);

    CREATE TABLE IF NOT EXISTS app_model_configs (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL DEFAULT 'deepseek',
      name TEXT NOT NULL DEFAULT '',
      base_url TEXT NOT NULL DEFAULT '',
      api_key TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      max_tokens TEXT NOT NULL DEFAULT '',
      temperature TEXT NOT NULL DEFAULT '',
      supports_vision INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER,
      updated_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_app_model_configs_updated
    ON app_model_configs(updated_at DESC, created_at DESC, id ASC);

    CREATE TABLE IF NOT EXISTS app_state_meta (
      meta_key TEXT PRIMARY KEY,
      meta_value TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_state_entries (
      state_key TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bridge_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      setting_key TEXT UNIQUE NOT NULL,
      setting_value TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS upload_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL DEFAULT 'none',
      config_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    );
  `)

  // Column migrations
  ensureColumn(next, 'task_memories', 'scope_key', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(next, 'task_memories', 'evidence_facts_json', "TEXT NOT NULL DEFAULT '[]'")
  ensureColumn(next, 'task_memories', 'source_session_id', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(next, 'task_memories', 'source_user_message_id', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(next, 'task_memories', 'source_assistant_message_id', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(next, 'task_memories', 'source_message_ids_json', "TEXT NOT NULL DEFAULT '[]'")
  ensureColumn(next, 'task_memories', 'source_start_seq', 'INTEGER')
  ensureColumn(next, 'task_memories', 'source_end_seq', 'INTEGER')
  // 废弃字段兼容旧数据库缺少这些列的情况
  ensureColumn(next, 'task_memories', 'goal', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(next, 'task_memories', 'intent_type', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(next, 'task_memories', 'intent_summary', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(next, 'task_memories', 'intent_goal', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(next, 'task_memories', 'summary', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(next, 'task_memories', 'identifiers_json', "TEXT NOT NULL DEFAULT '[]'")
  ensureColumn(next, 'task_memories', 'file_diffs_json', "TEXT NOT NULL DEFAULT '[]'")
  ensureColumn(next, 'project_notes', 'scope_key', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(next, 'memory_snapshots', 'scope_key', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(next, 'memory_maintain_runs', 'scope_key', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(next, 'chat_sessions', 'snapshot_migrated', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(next, 'app_project_configs', 'model_config_id', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(next, 'app_project_configs', 'provider', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(next, 'app_project_configs', 'mode', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(next, 'app_project_configs', 'workspace', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(next, 'app_project_configs', 'project_rules', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(next, 'app_project_configs', 'active_session_id', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(next, 'app_model_configs', 'name', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(next, 'app_model_configs', 'temperature', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(next, 'app_model_configs', 'supports_vision', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(next, 'app_model_configs', 'created_at', 'INTEGER')
  ensureColumn(next, 'app_model_configs', 'updated_at', 'INTEGER')

  backfillScopeKey(next, 'task_memories')
  backfillScopeKey(next, 'project_notes')
  backfillScopeKey(next, 'memory_snapshots')
  backfillScopeKey(next, 'memory_maintain_runs')

  // Compatible with old DB: ensure columns before creating indexes that depend on them.
  next.exec(`
    CREATE INDEX IF NOT EXISTS idx_task_memories_source_session_updated
    ON task_memories(source_session_id, updated_at DESC, created_at DESC);
  `)

  migrateLegacyChatSessionSnapshots(next)
  db = next
  return next
}

/* ------------------------------------------------------------------ */
/*  Public init/info helpers                                           */
/* ------------------------------------------------------------------ */

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

export function isMemoryDbEmpty(): boolean {
  const database = ensureDb()
  const tables = ['task_memories', 'project_notes', 'memory_snapshots']
  for (const tableName of tables) {
    const row = database.prepare(`SELECT COUNT(1) AS count FROM ${tableName}`).get() as Record<string, unknown> | undefined
    if (Number(row?.count || 0) > 0) return false
  }
  return true
}

export function initMemoryDb(): void {
  ensureDb()
}

export function getDb(): DatabaseSync {
  return ensureDb()
}
