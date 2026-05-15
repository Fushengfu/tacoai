import type { MemorySnapshotEntry, MemoryScope } from './schema'
import { buildScopeWhere, runInTransaction, getDb } from './schema'
import { normalizeScope } from './schema'
import { rowToSnapshotEntry } from './utils'

/* ------------------------------------------------------------------ */
/*  MemorySnapshots CRUD                                               */
/* ------------------------------------------------------------------ */

function upsertSnapshotRows(scope: MemoryScope, items: MemorySnapshotEntry[]): void {
  const database = getDb()
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
  const database = getDb()
  const selector = buildScopeWhere(scope)
  const row = database.prepare(`
    SELECT COUNT(1) AS count
    FROM memory_snapshots
    WHERE ${selector.sql}
  `).get(...selector.params) as Record<string, unknown> | undefined
  return Number(row?.count || 0) > 0
}

export function listMemorySnapshotsForScope(scope: MemoryScope): MemorySnapshotEntry[] {
  const database = getDb()
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
  const database = getDb()
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
