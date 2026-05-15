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
} from '../../shared/ipc'
import { TACO_HOME, workspaceHash, projectScope } from '../../shared/paths'
import { parseFileDiffsArray } from './memory-db/utils'

export type TaskMemoryEntry = ProjectTaskMemory
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
  maxTokens?: number
  createdAt: string
  updatedAt: string
}

export type AppStateStoreEntry<T> = {
  data: T
  updatedAt?: string
}

type MemoryTier = 'active' | 'archive'

type MemoryScope = {
  workspace: string
  projectId?: string
  scopeKey?: string
}

const APP_PROVIDER_IDS: readonly AppStateProviderId[] = ['deepseek', 'kimi', 'minimax', 'glm', 'qwen', 'mimo']
const APP_PROVIDER_LABELS: Readonly<Record<AppStateProviderId, string>> = {
  deepseek: 'DeepSeek',
  kimi: 'Kimi',
  minimax: 'MiniMax',
  glm: 'GLM',
  qwen: 'Qwen',
  mimo: 'MiMo',
}

const STATE_DIR = path.join(TACO_HOME, 'state')
const MEMORY_DB_PATH = path.join(STATE_DIR, 'memory.db')

let db: DatabaseSync | null = null

function resolveScopeKey(workspace: string, projectId?: string): string {
  if (projectId && projectId.trim()) return projectScope(projectId.trim())
  if (workspace && workspace.trim()) return workspaceHash(workspace)
  return 'global'
}

function normalizeScope(scope: MemoryScope): { workspace: string; projectId: string; scopeKey: string } {
  const rawWorkspace = String(scope.workspace || '').trim()
  const projectId = String(scope.projectId || '').trim()
  const scopeKey = String(scope.scopeKey || '').trim() || resolveScopeKey(rawWorkspace, projectId)
  return {
    workspace: rawWorkspace ? path.resolve(rawWorkspace) : '',
    projectId,
    scopeKey,
  }
}

function buildScopeWhere(scope: MemoryScope): {
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

function tableColumns(database: DatabaseSync, tableName: string): Set<string> {
  const rows = database.prepare(`PRAGMA table_info(${tableName})`).all() as Array<Record<string, unknown>>
  return new Set(rows.map((row) => String(row.name || '').trim()).filter(Boolean))
}

function ensureColumn(database: DatabaseSync, tableName: string, columnName: string, definition: string): void {
  const columns = tableColumns(database, tableName)
  if (columns.has(columnName)) return
  database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`)
}

function runInTransaction<T>(database: DatabaseSync, fn: () => T): T {
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

function normalizeChatStoreSeq(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.floor(n)
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
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_task_memories_scope_tier_updated
    ON task_memories(workspace, project_id, storage_tier, updated_at DESC, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_task_memories_scope_deleted
    ON task_memories(workspace, project_id, deleted_at);

    CREATE INDEX IF NOT EXISTS idx_task_memories_scope_key_tier_updated
    ON task_memories(scope_key, storage_tier, updated_at DESC, created_at DESC);
  `)

  // 数据库迁移:为旧数据库添加file_diffs_json列(捕获已存在列的错误)
  try {
    next.exec(`ALTER TABLE task_memories ADD COLUMN file_diffs_json TEXT NOT NULL DEFAULT '[]'`)
  } catch (e) {
    // 列已存在,忽略错误
  }

  // 数据库迁移:删除废弃字段(SQLite 3.35.0+支持)
  const dropColumns = [
    'goal',
    'intent_type',
    'intent_summary',
    'intent_goal',
    'summary',
    'identifiers_json',
    'evidence_facts_json',
  ]
  for (const col of dropColumns) {
    try {
      next.exec(`ALTER TABLE task_memories DROP COLUMN ${col}`)
    } catch (e) {
      // 列不存在或其他错误,忽略
    }
  }

  next.exec(`
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
  ensureColumn(next, 'task_memories', 'scope_key', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(next, 'task_memories', 'evidence_facts_json', "TEXT NOT NULL DEFAULT '[]'")
  ensureColumn(next, 'task_memories', 'source_session_id', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(next, 'task_memories', 'source_user_message_id', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(next, 'task_memories', 'source_assistant_message_id', "TEXT NOT NULL DEFAULT ''")
  ensureColumn(next, 'task_memories', 'source_message_ids_json', "TEXT NOT NULL DEFAULT '[]'")
  ensureColumn(next, 'task_memories', 'source_start_seq', 'INTEGER')
  ensureColumn(next, 'task_memories', 'source_end_seq', 'INTEGER')
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
  // 兼容旧库：必须先 ensureColumn，再建立依赖新列的索引。
  next.exec(`
    CREATE INDEX IF NOT EXISTS idx_task_memories_source_session_updated
    ON task_memories(source_session_id, updated_at DESC, created_at DESC);
  `)
  migrateLegacyChatSessionSnapshots(next)
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

function parseOptionalInteger(raw: unknown): number | undefined {
  const value = Number(raw)
  if (!Number.isFinite(value)) return undefined
  return Math.floor(value)
}

function parseUnknownArray(raw: unknown): unknown[] {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function parseUnknownObject(raw: unknown): Record<string, unknown> {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function rowToTaskMemoryEntry(row: Record<string, unknown>): TaskMemoryEntry {
  const sourceMessageIds = parseStringArray(row.source_message_ids_json)
  const sourceStartSeq = parseOptionalInteger(row.source_start_seq)
  const sourceEndSeq = parseOptionalInteger(row.source_end_seq)
  return {
    id: String(row.id || ''),
    userQuery: String(row.user_query || ''),
    ...(String(row.user_assets_block || '').trim() ? { userAssetsBlock: String(row.user_assets_block || '') } : {}),
    assistantResult: String(row.assistant_result || ''),
    outcome: (String(row.outcome || 'success') as 'success' | 'aborted' | 'error'),
    tools: parseStringArray(row.tools_json),
    changedFiles: parseStringArray(row.changed_files_json),
    fileDiffs: parseFileDiffsArray(row.file_diffs_json),
    ...(String(row.source_session_id || '').trim() ? { sourceSessionId: String(row.source_session_id || '').trim() } : {}),
    ...(String(row.source_user_message_id || '').trim() ? { sourceUserMessageId: String(row.source_user_message_id || '').trim() } : {}),
    ...(String(row.source_assistant_message_id || '').trim() ? { sourceAssistantMessageId: String(row.source_assistant_message_id || '').trim() } : {}),
    ...(sourceMessageIds.length > 0 ? { sourceMessageIds } : {}),
    ...(typeof sourceStartSeq === 'number' ? { sourceStartSeq } : {}),
    ...(typeof sourceEndSeq === 'number' ? { sourceEndSeq } : {}),
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

function rowToChatStoreSessionEntry(row: Record<string, unknown>): ChatStoreSessionEntry {
  return {
    projectId: String(row.project_id || ''),
    sessionId: String(row.session_id || ''),
    ...(String(row.workspace || '').trim() ? { workspace: String(row.workspace || '') } : {}),
    updatedAt: Number(row.updated_at || 0),
    messages: parseUnknownArray(row.messages_json),
  }
}

function rowToChatStoreSessionSummaryEntry(row: Record<string, unknown>): ChatStoreSessionSummaryEntry {
  return {
    projectId: String(row.project_id || ''),
    sessionId: String(row.session_id || ''),
    ...(String(row.workspace || '').trim() ? { workspace: String(row.workspace || '') } : {}),
    updatedAt: Number(row.updated_at || 0),
    messageCount: normalizeChatStoreSeq(row.message_count),
  }
}

function upsertTaskMemoryRows(scope: MemoryScope, items: TaskMemoryEntry[], tier: MemoryTier): void {
  const database = ensureDb()
  const normalized = normalizeScope(scope)
  const stmt = database.prepare(`
    INSERT INTO task_memories (
      id, workspace, project_id, scope_key, storage_tier,
      user_query, user_assets_block,
      assistant_result, outcome,
      tools_json, changed_files_json, file_diffs_json,
      source_session_id, source_user_message_id, source_assistant_message_id, source_message_ids_json, source_start_seq, source_end_seq,
      failures_json,
      deleted_at, deleted_reason, merged_into_id,
      created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?,
      ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?,
      ?, ?, ?,
      ?, ?
    )
    ON CONFLICT(id) DO UPDATE SET
      workspace=excluded.workspace,
      project_id=excluded.project_id,
      scope_key=excluded.scope_key,
      storage_tier=excluded.storage_tier,
      user_query=excluded.user_query,
      user_assets_block=excluded.user_assets_block,
      assistant_result=excluded.assistant_result,
      outcome=excluded.outcome,
      tools_json=excluded.tools_json,
      changed_files_json=excluded.changed_files_json,
      file_diffs_json=excluded.file_diffs_json,
      source_session_id=excluded.source_session_id,
      source_user_message_id=excluded.source_user_message_id,
      source_assistant_message_id=excluded.source_assistant_message_id,
      source_message_ids_json=excluded.source_message_ids_json,
      source_start_seq=excluded.source_start_seq,
      source_end_seq=excluded.source_end_seq,
      failures_json=excluded.failures_json,
      deleted_at=excluded.deleted_at,
      deleted_reason=excluded.deleted_reason,
      merged_into_id=excluded.merged_into_id,
      created_at=excluded.created_at,
      updated_at=excluded.updated_at
  `)
  for (const item of items) {
    stmt.run(
      item.id,
      normalized.workspace,
      normalized.projectId,
      normalized.scopeKey,
      tier,
      String(item.userQuery || ''),
      String(item.userAssetsBlock || ''),
      String(item.assistantResult || ''),
      String(item.outcome || 'success'),
      stringifyStringArray(item.tools),
      stringifyStringArray(item.changedFiles),
      JSON.stringify(item.fileDiffs || []),
      String(item.sourceSessionId || ''),
      String(item.sourceUserMessageId || ''),
      String(item.sourceAssistantMessageId || ''),
      stringifyStringArray(item.sourceMessageIds),
      Number.isFinite(Number(item.sourceStartSeq)) ? Number(item.sourceStartSeq) : null,
      Number.isFinite(Number(item.sourceEndSeq)) ? Number(item.sourceEndSeq) : null,
      stringifyStringArray(item.failures),
      item.deletedAt ?? null,
      String(item.deletedReason || ''),
      String(item.mergedIntoId || ''),
      String(item.createdAt || ''),
      String(item.updatedAt || ''),
    )
  }
}

function upsertProjectNoteRows(scope: MemoryScope, items: ProjectNoteEntry[]): void {
  const database = ensureDb()
  const normalized = normalizeScope(scope)
  const stmt = database.prepare(`
    INSERT INTO project_notes (
      id, workspace, project_id, scope_key, title, content, category, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      workspace=excluded.workspace,
      project_id=excluded.project_id,
      scope_key=excluded.scope_key,
      title=excluded.title,
      content=excluded.content,
      category=excluded.category,
      created_at=excluded.created_at,
      updated_at=excluded.updated_at
  `)
  for (const item of items) {
    stmt.run(
      item.id,
      normalized.workspace,
      normalized.projectId,
      normalized.scopeKey,
      String(item.title || ''),
      String(item.content || ''),
      String(item.category || 'other'),
      String(item.createdAt || ''),
      String(item.updatedAt || ''),
    )
  }
}

export function hasAnyProjectNotes(scope: MemoryScope): boolean {
  const database = ensureDb()
  const selector = buildScopeWhere(scope)
  const row = database.prepare(`
    SELECT COUNT(1) AS count
    FROM project_notes
    WHERE ${selector.sql}
  `).get(...selector.params) as Record<string, unknown> | undefined
  return Number(row?.count || 0) > 0
}

export function listProjectNotesForScope(scope: MemoryScope): ProjectNoteEntry[] {
  const database = ensureDb()
  const selector = buildScopeWhere(scope)
  const rows = database.prepare(`
    SELECT *
    FROM project_notes
    WHERE ${selector.sql}
    ORDER BY updated_at ASC, created_at ASC, id ASC
  `).all(...selector.params) as Array<Record<string, unknown>>
  return rows.map(rowToProjectNoteEntry)
}

export function replaceProjectNotes(scope: MemoryScope, items: ProjectNoteEntry[]): void {
  const database = ensureDb()
  const selector = buildScopeWhere(scope)
  runInTransaction(database, () => {
    database.prepare(`
      DELETE FROM project_notes
      WHERE ${selector.sql}
    `).run(...selector.params)
    upsertProjectNoteRows(scope, items)
  })
}

export function importProjectNotes(scope: MemoryScope, items: ProjectNoteEntry[]): void {
  if (!Array.isArray(items) || items.length <= 0) return
  upsertProjectNoteRows(scope, items)
}

export function hasAnyTaskMemories(scope: MemoryScope): boolean {
  const database = ensureDb()
  const selector = buildScopeWhere(scope)
  const row = database.prepare(`
    SELECT COUNT(1) AS count
    FROM task_memories
    WHERE ${selector.sql}
  `).get(...selector.params) as Record<string, unknown> | undefined
  return Number(row?.count || 0) > 0
}

export function listTaskMemoriesByTier(scope: MemoryScope, tier: MemoryTier): TaskMemoryEntry[] {
  const database = ensureDb()
  const selector = buildScopeWhere(scope)
  const rows = database.prepare(`
    SELECT *
    FROM task_memories
    WHERE ${selector.sql} AND storage_tier = ?
    ORDER BY updated_at ASC, created_at ASC, id ASC
  `).all(...selector.params, tier) as Array<Record<string, unknown>>
  return rows.map(rowToTaskMemoryEntry)
}

export function replaceTaskMemoriesByTier(scope: MemoryScope, items: TaskMemoryEntry[], tier: MemoryTier): void {
  const database = ensureDb()
  const selector = buildScopeWhere(scope)
  runInTransaction(database, () => {
    database.prepare(`
      DELETE FROM task_memories
      WHERE ${selector.sql} AND storage_tier = ?
    `).run(...selector.params, tier)
    upsertTaskMemoryRows(scope, items, tier)
  })
}

export function importTaskMemoriesByTier(scope: MemoryScope, items: TaskMemoryEntry[], tier: MemoryTier): void {
  if (!Array.isArray(items) || items.length <= 0) return
  upsertTaskMemoryRows(scope, items, tier)
}

/** 硬删除任务记忆 */
export function deleteTaskMemoryById(scope: MemoryScope, memoryId: string): void {
  const database = ensureDb()
  const normalized = normalizeScope(scope)
  database.prepare(`
    DELETE FROM task_memories 
    WHERE id = ? AND workspace = ? AND project_id = ?
  `).run(memoryId, normalized.workspace, normalized.projectId || '')
}

function upsertSnapshotRows(scope: MemoryScope, items: MemorySnapshotEntry[]): void {
  const database = ensureDb()
  const normalized = normalizeScope(scope)
  const stmt = database.prepare(`
    INSERT INTO memory_snapshots (
      id, workspace, project_id, scope_key, summary,
      source_message_count, usage_total_tokens, max_tokens,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      workspace=excluded.workspace,
      project_id=excluded.project_id,
      scope_key=excluded.scope_key,
      summary=excluded.summary,
      source_message_count=excluded.source_message_count,
      usage_total_tokens=excluded.usage_total_tokens,
      max_tokens=excluded.max_tokens,
      created_at=excluded.created_at,
      updated_at=excluded.updated_at
  `)
  for (const item of items) {
    stmt.run(
      item.id,
      normalized.workspace,
      normalized.projectId,
      normalized.scopeKey,
      String(item.summary || ''),
      Number(item.sourceMessageCount || 0),
      Number.isFinite(Number(item.usageTotalTokens)) ? Number(item.usageTotalTokens) : null,
      Number.isFinite(Number(item.maxTokens)) ? Number(item.maxTokens) : null,
      String(item.createdAt || ''),
      String(item.updatedAt || ''),
    )
  }
}

export function hasAnyMemorySnapshots(scope: MemoryScope): boolean {
  const database = ensureDb()
  const selector = buildScopeWhere(scope)
  const row = database.prepare(`
    SELECT COUNT(1) AS count
    FROM memory_snapshots
    WHERE ${selector.sql}
  `).get(...selector.params) as Record<string, unknown> | undefined
  return Number(row?.count || 0) > 0
}

export function listMemorySnapshotsForScope(scope: MemoryScope): MemorySnapshotEntry[] {
  const database = ensureDb()
  const selector = buildScopeWhere(scope)
  const rows = database.prepare(`
    SELECT *
    FROM memory_snapshots
    WHERE ${selector.sql}
    ORDER BY updated_at ASC, created_at ASC, id ASC
  `).all(...selector.params) as Array<Record<string, unknown>>
  return rows.map(rowToSnapshotEntry)
}

export function replaceMemorySnapshots(scope: MemoryScope, items: MemorySnapshotEntry[]): void {
  const database = ensureDb()
  const selector = buildScopeWhere(scope)
  runInTransaction(database, () => {
    database.prepare(`
      DELETE FROM memory_snapshots
      WHERE ${selector.sql}
    `).run(...selector.params)
    upsertSnapshotRows(scope, items)
  })
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
      workspace, project_id, scope_key, usage_total_tokens, max_tokens, pressure_ratio,
      total_candidates, merged_count, dropped_count, reason, decision_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    normalized.workspace,
    normalized.projectId,
    normalized.scopeKey,
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
  const selector = buildScopeWhere(scope)
  const row = database.prepare(`
    SELECT COUNT(1) AS count
    FROM memory_maintain_runs
    WHERE ${selector.sql}
  `).get(...selector.params) as Record<string, unknown> | undefined
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

let appStateRecordMigrationChecked = false

function parseOptionalTimestamp(raw: unknown): number | undefined {
  const value = Number(raw)
  if (!Number.isFinite(value)) return undefined
  const normalized = Math.trunc(value)
  return normalized >= 0 ? normalized : undefined
}

function asTrimmedString(value: unknown): string {
  return String(value ?? '').trim()
}

function asOptionalTrimmedString(value: unknown): string | undefined {
  const text = asTrimmedString(value)
  return text || undefined
}

function asBooleanFlag(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value > 0
  const text = asTrimmedString(value).toLowerCase()
  if (!text) return false
  return text === '1' || text === 'true' || text === 'yes'
}

function normalizeProviderId(value: unknown, fallback: AppStateProviderId = 'deepseek'): AppStateProviderId {
  const text = asTrimmedString(value) as AppStateProviderId
  return APP_PROVIDER_IDS.includes(text) ? text : fallback
}

function normalizeMode(value: unknown): 'chat' | 'agent' | undefined {
  const text = asTrimmedString(value)
  if (text === 'chat' || text === 'agent') return text
  return undefined
}

function resolveLatestIsoTimestamp(values: Array<string | undefined>): string | undefined {
  let latest = 0
  for (const item of values) {
    const ts = Date.parse(String(item || ''))
    if (Number.isFinite(ts) && ts > latest) latest = ts
  }
  return latest > 0 ? new Date(latest).toISOString() : undefined
}

function readAppStateEntryRaw(
  stateKey: string,
  database: DatabaseSync = ensureDb(),
): { payload: Record<string, unknown>; updatedAt?: string } | null {
  const normalizedKey = asTrimmedString(stateKey)
  if (!normalizedKey) return null
  const row = database.prepare(`
    SELECT payload_json, updated_at
    FROM app_state_entries
    WHERE state_key = ?
  `).get(normalizedKey) as Record<string, unknown> | undefined
  if (!row) return null
  return {
    payload: parseUnknownObject(row.payload_json),
    ...(asTrimmedString(row.updated_at) ? { updatedAt: asTrimmedString(row.updated_at) } : {}),
  }
}

function deleteAppStateEntryRaw(stateKey: string, database: DatabaseSync = ensureDb()): void {
  const normalizedKey = asTrimmedString(stateKey)
  if (!normalizedKey) return
  database.prepare(`DELETE FROM app_state_entries WHERE state_key = ?`).run(normalizedKey)
}

function readAppStateMetaRaw(
  metaKey: string,
  database: DatabaseSync = ensureDb(),
): { value: string; updatedAt?: string } | null {
  const normalizedKey = asTrimmedString(metaKey)
  if (!normalizedKey) return null
  const row = database.prepare(`
    SELECT meta_value, updated_at
    FROM app_state_meta
    WHERE meta_key = ?
  `).get(normalizedKey) as Record<string, unknown> | undefined
  if (!row) return null
  return {
    value: asTrimmedString(row.meta_value),
    ...(asTrimmedString(row.updated_at) ? { updatedAt: asTrimmedString(row.updated_at) } : {}),
  }
}

function writeAppStateMetaRaw(
  metaKey: string,
  metaValue: string,
  database: DatabaseSync = ensureDb(),
  updatedAtInput?: string,
): string {
  const normalizedKey = asTrimmedString(metaKey)
  if (!normalizedKey) return new Date().toISOString()
  const updatedAt = asTrimmedString(updatedAtInput) || new Date().toISOString()
  database.prepare(`
    INSERT INTO app_state_meta (
      meta_key, meta_value, updated_at
    ) VALUES (?, ?, ?)
    ON CONFLICT(meta_key) DO UPDATE SET
      meta_value=excluded.meta_value,
      updated_at=excluded.updated_at
  `).run(normalizedKey, asTrimmedString(metaValue), updatedAt)
  return updatedAt
}

function normalizeSessionForStorage(raw: unknown, index: number, nowTs: number): AppStateSession | null {
  const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const id = asTrimmedString(item.id)
  if (!id) return null
  const createdAt = parseOptionalTimestamp(item.createdAt) ?? nowTs + index
  return {
    id,
    title: asTrimmedString(item.title) || '会话',
    createdAt,
  }
}

function normalizeThreadForStorage(raw: unknown, index: number, nowTs: number): AppStateThread | null {
  const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const id = asTrimmedString(item.id)
  if (!id) return null
  const sessionMap = new Map<string, AppStateSession>()
  const sessionList = Array.isArray(item.sessions) ? item.sessions : []
  sessionList.forEach((sessionItem, sessionIndex) => {
    const normalized = normalizeSessionForStorage(sessionItem, sessionIndex, nowTs)
    if (normalized) sessionMap.set(normalized.id, normalized)
  })
  const sessions = [...sessionMap.values()]
  if (sessions.length <= 0) return null
  const activeSessionRaw = asTrimmedString(item.activeSessionId)
  const activeSessionId = sessions.some((session) => session.id === activeSessionRaw)
    ? activeSessionRaw
    : sessions[0].id
  const modelConfigId = asOptionalTrimmedString(item.modelConfigId)
  const providerRaw = asOptionalTrimmedString(item.provider)
  const provider = providerRaw ? normalizeProviderId(providerRaw) : undefined
  const mode = normalizeMode(item.mode)
  const workspace = asOptionalTrimmedString(item.workspace)
  const projectRules = asOptionalTrimmedString(item.projectRules)
  return {
    id,
    title: asTrimmedString(item.title) || '新项目',
    titleLocked: Boolean(item.titleLocked),
    updatedAt: parseOptionalTimestamp(item.updatedAt) ?? (nowTs + index),
    ...(modelConfigId ? { modelConfigId } : {}),
    ...(provider ? { provider } : {}),
    ...(mode ? { mode } : {}),
    ...(workspace ? { workspace } : {}),
    ...(projectRules ? { projectRules } : {}),
    sessions,
    activeSessionId,
  }
}

function normalizeModelConfigForStorage(raw: unknown, index: number, nowTs: number): AppStateModelConfig | null {
  const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const id = asTrimmedString(item.id)
  if (!id) return null
  const provider = normalizeProviderId(item.provider, 'deepseek')
  const model = asTrimmedString(item.model)
  const rawName = asTrimmedString(item.name)
  const isNameKnownProvider = rawName && APP_PROVIDER_IDS.some(
    (pid) => rawName === pid || rawName === APP_PROVIDER_LABELS[pid],
  )
  const name = isNameKnownProvider
    ? (APP_PROVIDER_LABELS[provider] ?? provider)
    : (rawName || model || provider)
  return {
    id,
    provider,
    name,
    baseUrl: asTrimmedString(item.baseUrl),
    apiKey: asTrimmedString(item.apiKey),
    model,
    maxTokens: asTrimmedString(item.maxTokens),
    temperature: asTrimmedString(item.temperature),
    supportsVision: asBooleanFlag(item.supportsVision),
    ...(typeof parseOptionalTimestamp(item.createdAt) === 'number'
      ? { createdAt: parseOptionalTimestamp(item.createdAt) }
      : { createdAt: nowTs + index }),
    ...(typeof parseOptionalTimestamp(item.updatedAt) === 'number'
      ? { updatedAt: parseOptionalTimestamp(item.updatedAt) }
      : { updatedAt: nowTs + index }),
  }
}

function normalizeLegacyProviderFormsForStorage(raw: unknown, nowTs: number): AppStateModelConfig[] {
  const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const configs: AppStateModelConfig[] = []
  APP_PROVIDER_IDS.forEach((provider, index) => {
    const form = obj[provider]
    const formObj = form && typeof form === 'object' ? form as Record<string, unknown> : {}
    const baseUrl = asTrimmedString(formObj.baseUrl)
    const apiKey = asTrimmedString(formObj.apiKey)
    const model = asTrimmedString(formObj.model)
    const maxTokens = asTrimmedString(formObj.maxTokens)
    const temperature = asTrimmedString(formObj.temperature)
    if (!baseUrl && !apiKey && !model && !maxTokens && !temperature) return
    configs.push({
      id: `legacy-${provider}-0`,
      provider,
      name: model || provider,
      baseUrl,
      apiKey,
      model,
      maxTokens,
      temperature,
      supportsVision: false,
      createdAt: nowTs + index,
      updatedAt: nowTs + index,
    })
  })
  return configs
}

function countTableRows(database: DatabaseSync, tableName: string): number {
  const row = database.prepare(`SELECT COUNT(1) AS count FROM ${tableName}`).get() as Record<string, unknown> | undefined
  return Number(row?.count || 0)
}

function ensureAppStateRecordMigration(database: DatabaseSync): void {
  if (appStateRecordMigrationChecked) return
  const threadCount = countTableRows(database, 'app_project_configs')
  const modelCount = countTableRows(database, 'app_model_configs')
  const activeThreadMeta = readAppStateMetaRaw('active_thread_id', database)
  const activeModelMeta = readAppStateMetaRaw('active_model_config_id', database)
  const legacyThreads = readAppStateEntryRaw('threads_state', database)
  const legacyProviders = readAppStateEntryRaw('providers_state', database)
  const hasLegacyThreads = Boolean(legacyThreads)
  const hasLegacyProviders = Boolean(legacyProviders)
  if (!hasLegacyThreads && !hasLegacyProviders) {
    appStateRecordMigrationChecked = true
    return
  }

  const nowTs = Date.now()
  runInTransaction(database, () => {
    if (threadCount <= 0 && legacyThreads) {
      const payload = legacyThreads.payload
      const normalizedThreads = Array.isArray(payload.threads)
        ? payload.threads
          .map((item, index) => normalizeThreadForStorage(item, index, nowTs))
          .filter((item): item is AppStateThread => Boolean(item))
        : []
      const insertThreadStmt = database.prepare(`
        INSERT INTO app_project_configs (
          id, title, title_locked, updated_at, model_config_id, provider, mode, workspace, project_rules, active_session_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      const insertSessionStmt = database.prepare(`
        INSERT INTO app_project_sessions (
          id, thread_id, title, created_at, sort_order
        ) VALUES (?, ?, ?, ?, ?)
      `)
      for (const thread of normalizedThreads) {
        insertThreadStmt.run(
          thread.id,
          thread.title,
          thread.titleLocked ? 1 : 0,
          thread.updatedAt,
          asTrimmedString(thread.modelConfigId),
          asTrimmedString(thread.provider),
          asTrimmedString(thread.mode),
          asTrimmedString(thread.workspace),
          asTrimmedString(thread.projectRules),
          thread.activeSessionId,
        )
        thread.sessions.forEach((session, sessionIndex) => {
          insertSessionStmt.run(session.id, thread.id, session.title, session.createdAt, sessionIndex)
        })
      }
      if (!activeThreadMeta?.value) {
        const activeThreadRaw = asTrimmedString(payload.activeThreadId)
        const resolvedActiveThreadId = normalizedThreads.some((item) => item.id === activeThreadRaw)
          ? activeThreadRaw
          : (normalizedThreads[0]?.id ?? '')
        writeAppStateMetaRaw(
          'active_thread_id',
          resolvedActiveThreadId,
          database,
          legacyThreads.updatedAt,
        )
      }
    }

    if (modelCount <= 0 && legacyProviders) {
      const payload = legacyProviders.payload
      const fromNew = Array.isArray(payload.modelConfigs)
        ? payload.modelConfigs
          .map((item, index) => normalizeModelConfigForStorage(item, index, nowTs))
          .filter((item): item is AppStateModelConfig => Boolean(item))
        : []
      const normalizedModels = fromNew.length > 0
        ? fromNew
        : normalizeLegacyProviderFormsForStorage(payload.providerForms, nowTs)
      const insertModelStmt = database.prepare(`
        INSERT INTO app_model_configs (
          id, provider, name, base_url, api_key, model, max_tokens, temperature, supports_vision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const model of normalizedModels) {
        insertModelStmt.run(
          model.id,
          model.provider,
          model.name,
          model.baseUrl ?? null,
          model.apiKey ?? null,
          model.model ?? null,
          model.maxTokens ?? null,
          model.temperature ?? null,
          model.supportsVision ? 1 : 0,
          parseOptionalTimestamp(model.createdAt) ?? null,
          parseOptionalTimestamp(model.updatedAt) ?? null,
        )
      }
      if (!activeModelMeta?.value) {
        const activeModelRaw = asTrimmedString(payload.activeModelConfigId)
        const byActiveId = normalizedModels.find((item) => item.id === activeModelRaw)
        const legacyActiveProvider = normalizeProviderId(payload.activeProvider, 'deepseek')
        const byProvider = normalizedModels.find((item) => item.provider === legacyActiveProvider)
        const resolvedActiveModelId = byActiveId?.id ?? byProvider?.id ?? normalizedModels[0]?.id ?? ''
        writeAppStateMetaRaw(
          'active_model_config_id',
          resolvedActiveModelId,
          database,
          legacyProviders.updatedAt,
        )
      }
    }
  })

  deleteAppStateEntryRaw('threads_state', database)
  deleteAppStateEntryRaw('providers_state', database)
  appStateRecordMigrationChecked = true
}

export function loadAppThreadsStateFromDb(): AppStateStoreEntry<AppStateThreadsPayload | null> {
  const database = ensureDb()
  ensureAppStateRecordMigration(database)
  const threadRows = database.prepare(`
    SELECT
      id,
      title,
      title_locked,
      updated_at,
      model_config_id,
      provider,
      mode,
      workspace,
      project_rules,
      active_session_id
    FROM app_project_configs
    ORDER BY updated_at DESC, id ASC
  `).all() as Array<Record<string, unknown>>
  const sessionRows = database.prepare(`
    SELECT id, thread_id, title, created_at, sort_order
    FROM app_project_sessions
    ORDER BY thread_id ASC, sort_order ASC, created_at ASC, id ASC
  `).all() as Array<Record<string, unknown>>
  if (threadRows.length <= 0 && sessionRows.length <= 0) return { data: null }

  const sessionsByThread = new Map<string, AppStateSession[]>()
  for (const row of sessionRows) {
    const threadId = asTrimmedString(row.thread_id)
    const sessionId = asTrimmedString(row.id)
    if (!threadId || !sessionId) continue
    const current = sessionsByThread.get(threadId) ?? []
    current.push({
      id: sessionId,
      title: asTrimmedString(row.title) || '会话',
      createdAt: parseOptionalTimestamp(row.created_at) ?? Date.now(),
    })
    sessionsByThread.set(threadId, current)
  }

  const threads: AppStateThread[] = []
  for (const row of threadRows) {
    const threadId = asTrimmedString(row.id)
    if (!threadId) continue
    const sessions = sessionsByThread.get(threadId) ?? []
    if (sessions.length <= 0) continue
    const activeSessionRaw = asTrimmedString(row.active_session_id)
    const activeSessionId = sessions.some((item) => item.id === activeSessionRaw)
      ? activeSessionRaw
      : sessions[0].id
    const mode = normalizeMode(row.mode)
    const modelConfigId = asOptionalTrimmedString(row.model_config_id)
    const providerRaw = asOptionalTrimmedString(row.provider)
    const provider = providerRaw ? normalizeProviderId(providerRaw) : undefined
    const workspace = asOptionalTrimmedString(row.workspace)
    const projectRules = asOptionalTrimmedString(row.project_rules)
    threads.push({
      id: threadId,
      title: asTrimmedString(row.title) || '新项目',
      titleLocked: Number(row.title_locked || 0) > 0,
      updatedAt: parseOptionalTimestamp(row.updated_at) ?? Date.now(),
      ...(modelConfigId ? { modelConfigId } : {}),
      ...(provider ? { provider } : {}),
      ...(mode ? { mode } : {}),
      ...(workspace ? { workspace } : {}),
      ...(projectRules ? { projectRules } : {}),
      sessions,
      activeSessionId,
    })
  }

  const activeMeta = readAppStateMetaRaw('active_thread_id', database)
  const activeIdRaw = asTrimmedString(activeMeta?.value)
  const activeThreadId = threads.some((item) => item.id === activeIdRaw)
    ? activeIdRaw
    : (threads[0]?.id ?? '')
  const maxUpdatedAt = threads.reduce((acc, thread) => Math.max(acc, thread.updatedAt || 0), 0)
  const derivedUpdatedAt = maxUpdatedAt > 0 ? new Date(maxUpdatedAt).toISOString() : undefined
  return {
    data: {
      threads,
      activeThreadId,
    },
    updatedAt: resolveLatestIsoTimestamp([
      activeMeta?.updatedAt,
      derivedUpdatedAt,
    ]),
  }
}

export function saveAppThreadsStateToDb(payload: AppStateThreadsPayload): AppStateStoreEntry<AppStateThreadsPayload> {
  const database = ensureDb()
  ensureAppStateRecordMigration(database)
  const nowTs = Date.now()
  const threadMap = new Map<string, AppStateThread>()
  for (const [index, item] of (payload.threads ?? []).entries()) {
    const normalized = normalizeThreadForStorage(item, index, nowTs)
    if (normalized) threadMap.set(normalized.id, normalized)
  }
  const threads = [...threadMap.values()]
  const activeRaw = asTrimmedString(payload.activeThreadId)
  const activeThreadId = threads.some((item) => item.id === activeRaw)
    ? activeRaw
    : (threads[0]?.id ?? '')
  const updatedAt = new Date().toISOString()

  runInTransaction(database, () => {
    database.prepare(`DELETE FROM app_project_sessions`).run()
    database.prepare(`DELETE FROM app_project_configs`).run()
    const insertThreadStmt = database.prepare(`
      INSERT INTO app_project_configs (
        id, title, title_locked, updated_at, model_config_id, provider, mode, workspace, project_rules, active_session_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insertSessionStmt = database.prepare(`
      INSERT INTO app_project_sessions (
        id, thread_id, title, created_at, sort_order
      ) VALUES (?, ?, ?, ?, ?)
    `)
    for (const thread of threads) {
      insertThreadStmt.run(
        thread.id,
        thread.title,
        thread.titleLocked ? 1 : 0,
        thread.updatedAt,
        asTrimmedString(thread.modelConfigId),
        asTrimmedString(thread.provider),
        asTrimmedString(thread.mode),
        asTrimmedString(thread.workspace),
        asTrimmedString(thread.projectRules),
        thread.activeSessionId,
      )
      thread.sessions.forEach((session, sessionIndex) => {
        insertSessionStmt.run(session.id, thread.id, session.title, session.createdAt, sessionIndex)
      })
    }
    writeAppStateMetaRaw('active_thread_id', activeThreadId, database, updatedAt)
  })

  return {
    data: {
      threads,
      activeThreadId,
    },
    updatedAt,
  }
}

export function loadAppProvidersStateFromDb(): AppStateStoreEntry<AppStateProvidersPayload | null> {
  const database = ensureDb()
  ensureAppStateRecordMigration(database)
  const rows = database.prepare(`
    SELECT
      id,
      provider,
      name,
      base_url,
      api_key,
      model,
      max_tokens,
      temperature,
      supports_vision,
      created_at,
      updated_at
    FROM app_model_configs
    ORDER BY updated_at DESC, created_at DESC, id ASC
  `).all() as Array<Record<string, unknown>>
  if (rows.length <= 0) return { data: null }

  const modelConfigs: AppStateModelConfig[] = rows
    .map((row, index) => normalizeModelConfigForStorage({
      id: asTrimmedString(row.id),
      provider: row.provider,
      name: row.name,
      baseUrl: row.base_url,
      apiKey: row.api_key,
      model: row.model,
      maxTokens: row.max_tokens,
      temperature: row.temperature,
      supportsVision: Number(row.supports_vision || 0) > 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }, index, Date.now()))
    .filter((item): item is AppStateModelConfig => Boolean(item))

  const activeMeta = readAppStateMetaRaw('active_model_config_id', database)
  const activeRaw = asTrimmedString(activeMeta?.value)
  const activeModelConfigId = modelConfigs.some((item) => item.id === activeRaw)
    ? activeRaw
    : (modelConfigs[0]?.id ?? '')
  const maxUpdatedAt = modelConfigs.reduce(
    (acc, item) => Math.max(acc, parseOptionalTimestamp(item.updatedAt) ?? 0),
    0,
  )
  const derivedUpdatedAt = maxUpdatedAt > 0 ? new Date(maxUpdatedAt).toISOString() : undefined
  return {
    data: {
      modelConfigs,
      activeModelConfigId,
    },
    updatedAt: resolveLatestIsoTimestamp([
      activeMeta?.updatedAt,
      derivedUpdatedAt,
    ]),
  }
}

export function saveAppProvidersStateToDb(payload: AppStateProvidersPayload): AppStateStoreEntry<AppStateProvidersPayload> {
  const database = ensureDb()
  ensureAppStateRecordMigration(database)
  const nowTs = Date.now()
  const modelMap = new Map<string, AppStateModelConfig>()
  for (const [index, item] of (payload.modelConfigs ?? []).entries()) {
    const normalized = normalizeModelConfigForStorage(item, index, nowTs)
    if (normalized) modelMap.set(normalized.id, normalized)
  }
  const modelConfigs = [...modelMap.values()]
  const activeRaw = asTrimmedString(payload.activeModelConfigId)
  const activeModelConfigId = modelConfigs.some((item) => item.id === activeRaw)
    ? activeRaw
    : (modelConfigs[0]?.id ?? '')
  const updatedAt = new Date().toISOString()

  runInTransaction(database, () => {
    database.prepare(`DELETE FROM app_model_configs`).run()
    const insertStmt = database.prepare(`
      INSERT INTO app_model_configs (
        id, provider, name, base_url, api_key, model, max_tokens, temperature, supports_vision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const model of modelConfigs) {
      insertStmt.run(
        model.id,
        model.provider,
        model.name,
        model.baseUrl ?? null,
        model.apiKey ?? null,
        model.model ?? null,
        model.maxTokens ?? null,
        model.temperature ?? null,
        model.supportsVision ? 1 : 0,
        parseOptionalTimestamp(model.createdAt) ?? null,
        parseOptionalTimestamp(model.updatedAt) ?? null,
      )
    }
    writeAppStateMetaRaw('active_model_config_id', activeModelConfigId, database, updatedAt)
  })

  return {
    data: {
      modelConfigs,
      activeModelConfigId,
    },
    updatedAt,
  }
}

export type ChatStoreMessageSeqRange = {
  resolvedMessageIds: string[]
  startSeq?: number
  endSeq?: number
}

export function resolveChatStoreMessageSeqRange(sessionId: string, messageIds: string[]): ChatStoreMessageSeqRange {
  const database = ensureDb()
  const normalizedSessionId = String(sessionId || '').trim()
  if (!normalizedSessionId) return { resolvedMessageIds: [] }
  const normalizedMessageIds = [...new Set((messageIds ?? []).map((item) => String(item || '').trim()).filter(Boolean))]
  if (normalizedMessageIds.length <= 0) return { resolvedMessageIds: [] }
  const placeholders = normalizedMessageIds.map(() => '?').join(', ')
  const rows = database.prepare(`
    SELECT message_id, seq
    FROM chat_messages
    WHERE session_id = ? AND message_id IN (${placeholders})
    ORDER BY seq ASC
  `).all(normalizedSessionId, ...normalizedMessageIds) as Array<Record<string, unknown>>
  if (rows.length <= 0) return { resolvedMessageIds: [] }
  const resolvedMessageIds = rows.map((row) => String(row.message_id || '').trim()).filter(Boolean)
  const startSeq = parseOptionalInteger(rows[0]?.seq)
  const endSeq = parseOptionalInteger(rows[rows.length - 1]?.seq)
  return {
    resolvedMessageIds,
    ...(typeof startSeq === 'number' ? { startSeq } : {}),
    ...(typeof endSeq === 'number' ? { endSeq } : {}),
  }
}

export function listChatStoreSessions(): ChatStoreSessionSummaryEntry[] {
  const database = ensureDb()
  const rows = database.prepare(`
    SELECT
      s.session_id,
      s.project_id,
      s.workspace,
      s.updated_at,
      COUNT(m.seq) AS message_count
    FROM chat_sessions s
    LEFT JOIN chat_messages m ON m.session_id = s.session_id
    GROUP BY s.session_id, s.project_id, s.workspace, s.updated_at
    ORDER BY s.updated_at ASC, s.session_id ASC
  `).all() as Array<Record<string, unknown>>
  return rows.map((row) => rowToChatStoreSessionSummaryEntry(row))
}

export function loadChatStoreSessionPage(
  sessionId: string,
  options?: { beforeSeq?: number; limit?: number },
): ChatStoreSessionPageEntry | null {
  const database = ensureDb()
  const normalizedSessionId = String(sessionId || '').trim()
  if (!normalizedSessionId) return null

  const summaryRow = database.prepare(`
    SELECT
      s.session_id,
      s.project_id,
      s.workspace,
      s.updated_at,
      COUNT(m.seq) AS message_count
    FROM chat_sessions s
    LEFT JOIN chat_messages m ON m.session_id = s.session_id
    WHERE s.session_id = ?
    GROUP BY s.session_id, s.project_id, s.workspace, s.updated_at
  `).get(normalizedSessionId) as Record<string, unknown> | undefined
  if (!summaryRow) return null

  const summary = rowToChatStoreSessionSummaryEntry(summaryRow)
  const totalCount = summary.messageCount
  const limit = Math.min(400, Math.max(1, normalizeChatStoreSeq(options?.limit) || 120))
  const beforeSeqRaw = options?.beforeSeq
  const hasBeforeSeq = Number.isFinite(Number(beforeSeqRaw))
  const beforeSeq = hasBeforeSeq ? normalizeChatStoreSeq(beforeSeqRaw) : undefined

  const messageRows = hasBeforeSeq
    ? database.prepare(`
        SELECT seq, message_json
        FROM chat_messages
        WHERE session_id = ? AND seq < ?
        ORDER BY seq DESC
        LIMIT ?
      `).all(normalizedSessionId, beforeSeq!, limit) as Array<Record<string, unknown>>
    : database.prepare(`
        SELECT seq, message_json
        FROM chat_messages
        WHERE session_id = ?
        ORDER BY seq DESC
        LIMIT ?
      `).all(normalizedSessionId, limit) as Array<Record<string, unknown>>

  const ascendingRows = [...messageRows].reverse()
  const messages = ascendingRows.map((row) => {
    try {
      return JSON.parse(String(row.message_json || '{}'))
    } catch {
      return null
    }
  }).filter((item) => item !== null)
  const startSeq = parseOptionalInteger(ascendingRows[0]?.seq)
  const endSeq = parseOptionalInteger(ascendingRows[ascendingRows.length - 1]?.seq)

  return {
    projectId: summary.projectId,
    sessionId: summary.sessionId,
    ...(summary.workspace ? { workspace: summary.workspace } : {}),
    updatedAt: summary.updatedAt,
    totalCount,
    ...(typeof startSeq === 'number' ? { startSeq } : {}),
    ...(typeof endSeq === 'number' ? { endSeq } : {}),
    messages,
  }
}

export function saveChatStoreSessionPatch(entry: ChatStoreSessionPatchEntry): void {
  const database = ensureDb()
  const sessionId = String(entry.sessionId || '').trim()
  if (!sessionId) return
  const updatedAt = Number.isFinite(Number(entry.updatedAt)) ? Number(entry.updatedAt) : Date.now()
  const fromSeq = normalizeChatStoreSeq(entry.fromSeq)
  const messages = Array.isArray(entry.messages) ? entry.messages : []
  const upsertSessionStmt = database.prepare(`
    INSERT INTO chat_sessions (
      session_id, project_id, workspace, messages_json, updated_at, snapshot_migrated
    ) VALUES (?, ?, ?, '[]', ?, 1)
    ON CONFLICT(session_id) DO UPDATE SET
      project_id=excluded.project_id,
      workspace=excluded.workspace,
      messages_json='[]',
      updated_at=excluded.updated_at,
      snapshot_migrated=1
  `)
  const deleteTailStmt = database.prepare(`
    DELETE FROM chat_messages
    WHERE session_id = ? AND seq >= ?
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

  runInTransaction(database, () => {
    upsertSessionStmt.run(
      sessionId,
      String(entry.projectId || ''),
      String(entry.workspace || ''),
      updatedAt,
    )
    deleteTailStmt.run(sessionId, fromSeq)
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index]
      const record = message && typeof message === 'object' ? message as Record<string, unknown> : {}
      const seq = fromSeq + index
      const messageId = String(record.id || `${sessionId}:${seq}`).trim() || `${sessionId}:${seq}`
      const role = String(record.role || 'assistant').trim() || 'assistant'
      insertMessageStmt.run(
        sessionId,
        seq,
        messageId,
        role,
        JSON.stringify(message ?? null),
        updatedAt,
      )
    }
  })
}

export function deleteChatStoreSession(sessionId: string): void {
  const database = ensureDb()
  const normalized = String(sessionId || '').trim()
  if (!normalized) return
  database.prepare(`
    DELETE FROM chat_sessions
    WHERE session_id = ?
  `).run(normalized)
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

/* ------------------------------------------------------------------ */
/*  Bridge Settings — 配对码策略配置                                     */
/* ------------------------------------------------------------------ */

export type BridgeSettingKey = 'pairingCodeMode'
export type BridgeSettingValue = 'permanent' | 'auto-refresh'

export function getBridgeSetting(key: BridgeSettingKey): BridgeSettingValue | null {
  const database = ensureDb()
  const row = database.prepare(
    `SELECT setting_value FROM bridge_settings WHERE setting_key = ?`
  ).get(key) as Record<string, unknown> | undefined
  const val = row?.setting_value as string | undefined
  if (!val) return null
  return val as BridgeSettingValue
}

export function setBridgeSetting(key: BridgeSettingKey, value: BridgeSettingValue): void {
  const database = ensureDb()
  const now = new Date().toISOString()
  database.prepare(`
    INSERT INTO bridge_settings (setting_key, setting_value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(setting_key) DO UPDATE SET
      setting_value=excluded.setting_value,
      updated_at=excluded.updated_at
  `).run(key, value, now)
}

// ── 上传配置 ──

export type UploadConfigDbEntry = {
  provider: string
  config: Record<string, unknown>
  updatedAt: string
}

export function loadUploadConfigFromDb(): UploadConfigDbEntry | null {
  const database = ensureDb()
  const row = database.prepare(
    `SELECT provider, config_json, updated_at FROM upload_config ORDER BY id DESC LIMIT 1`
  ).get() as Record<string, unknown> | undefined
  
  if (!row || !row.provider) return null
  
  try {
    const config = typeof row.config_json === 'string' 
      ? JSON.parse(row.config_json) 
      : {}
    return {
      provider: String(row.provider),
      config,
      updatedAt: String(row.updated_at || ''),
    }
  } catch {
    return null
  }
}

export function saveUploadConfigToDb(provider: string, config: Record<string, unknown>): void {
  const database = ensureDb()
  const now = new Date().toISOString()
  const configJson = JSON.stringify(config)
  
  // 先检查是否有记录
  const count = database.prepare(`SELECT COUNT(1) as count FROM upload_config`).get() as Record<string, unknown>
  
  if (Number(count?.count || 0) > 0) {
    // 有记录则更新
    database.prepare(`
      UPDATE upload_config 
      SET provider = ?, config_json = ?, updated_at = ?
      WHERE id = (SELECT id FROM upload_config ORDER BY id DESC LIMIT 1)
    `).run(provider, configJson, now)
  } else {
    // 没有记录则插入
    database.prepare(`
      INSERT INTO upload_config (provider, config_json, updated_at)
      VALUES (?, ?, ?)
    `).run(provider, configJson, now)
  }
}
