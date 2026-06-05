import type { TaskMemoryEntry, MemoryScope, MemoryTier } from './schema'
import { buildScopeWhere, runInTransaction, getDb } from './schema'
import { normalizeScope } from './schema'
import { stringifyStringArray } from './utils'
import { rowToTaskMemoryEntry } from './utils'

/* ------------------------------------------------------------------ */
/*  TaskMemory CRUD                                                    */
/* ------------------------------------------------------------------ */

function upsertTaskMemoryRows(scope: MemoryScope, items: TaskMemoryEntry[], tier: MemoryTier): void {
  const database = getDb()
  const normalized = normalizeScope(scope)
  const stmt = database.prepare(`
    INSERT INTO task_memories (
      id, workspace, project_id, scope_key, storage_tier,
      user_query, user_assets_block, goal,
      intent_type, intent_summary, intent_goal,
      assistant_result, summary, outcome,
      tools_json, changed_files_json, identifiers_json, evidence_facts_json,
      source_session_id, source_user_message_id, source_assistant_message_id, source_message_ids_json, source_start_seq, source_end_seq,
      failures_json,
      deleted_at, deleted_reason, merged_into_id,
      created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
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
      evidence_facts_json=excluded.evidence_facts_json,
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
      stringifyStringArray(item.evidenceFacts),
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

export function hasAnyTaskMemories(scope: MemoryScope): boolean {
  const database = getDb()
  const selector = buildScopeWhere(scope)
  const row = database.prepare(`
    SELECT COUNT(1) AS count
    FROM task_memories
    WHERE ${selector.sql}
  `).get(...selector.params) as Record<string, unknown> | undefined
  return Number(row?.count || 0) > 0
}

export function listTaskMemoriesByTier(scope: MemoryScope, tier: MemoryTier): TaskMemoryEntry[] {
  const database = getDb()
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
  const database = getDb()
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

export function deleteTaskMemoryById(scope: MemoryScope, memoryId: string): void {
  const database = getDb()
  const normalized = normalizeScope(scope)
  database.prepare(`
    DELETE FROM task_memories 
    WHERE id = ? AND workspace = ? AND project_id = ?
  `).run(memoryId, normalized.workspace, normalized.projectId || '')
}
