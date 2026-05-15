import type { ProjectNoteEntry, MemoryScope } from './schema'
import { buildScopeWhere, runInTransaction, getDb } from './schema'
import { normalizeScope } from './schema'
import { rowToProjectNoteEntry } from './utils'

/* ------------------------------------------------------------------ */
/*  ProjectNotes CRUD                                                  */
/* ------------------------------------------------------------------ */

function upsertProjectNoteRows(scope: MemoryScope, items: ProjectNoteEntry[]): void {
  const database = getDb()
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
  const database = getDb()
  const selector = buildScopeWhere(scope)
  const row = database.prepare(`
    SELECT COUNT(1) AS count
    FROM project_notes
    WHERE ${selector.sql}
  `).get(...selector.params) as Record<string, unknown> | undefined
  return Number(row?.count || 0) > 0
}

export function listProjectNotesForScope(scope: MemoryScope): ProjectNoteEntry[] {
  const database = getDb()
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
  const database = getDb()
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
