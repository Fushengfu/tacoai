import type { MemoryScope } from './schema'
import { buildScopeWhere, getDb } from './schema'
import { normalizeScope } from './schema'

/* ------------------------------------------------------------------ */
/*  MemoryMaintainRun operations                                       */
/* ------------------------------------------------------------------ */

export function insertMemoryMaintainRun(scope: MemoryScope, input: {
  usageTotalTokens?: number
  contextLength?: number
  pressureRatio?: number
  totalCandidates: number
  mergedCount: number
  droppedCount: number
  reason: string
  decisionJson: string
  createdAt?: string
}): void {
  const database = getDb()
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
    Number.isFinite(Number(input.contextLength)) ? Number(input.contextLength) : null,
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
  const database = getDb()
  const selector = buildScopeWhere(scope)
  const row = database.prepare(`
    SELECT COUNT(1) AS count
    FROM memory_maintain_runs
    WHERE ${selector.sql}
  `).get(...selector.params) as Record<string, unknown> | undefined
  return Number(row?.count || 0)
}
