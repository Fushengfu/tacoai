import type {
  ChatStoreSessionSummaryEntry,
  ChatStoreSessionPageEntry,
  ChatStoreSessionPatchEntry,
  ChatStoreMessageSeqRange,
} from './schema'
import { getDb, runInTransaction } from './schema'
import { normalizeChatStoreSeq, parseOptionalInteger, rowToChatStoreSessionSummaryEntry } from './utils'

/* ------------------------------------------------------------------ */
/*  ChatStore session/message operations                               */
/* ------------------------------------------------------------------ */

export function resolveChatStoreMessageSeqRange(sessionId: string, messageIds: string[]): ChatStoreMessageSeqRange {
  const database = getDb()
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
  const database = getDb()
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
  const database = getDb()
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
  const database = getDb()
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
  const database = getDb()
  const normalized = String(sessionId || '').trim()
  if (!normalized) return
  database.prepare(`
    DELETE FROM chat_sessions
    WHERE session_id = ?
  `).run(normalized)
}

/**
 * 按消息 ID 加载单条消息（用于移动端按需展开 agentSteps 详情）。
 * 返回消息 JSON 对象，未找到时返回 null。
 */
export function loadChatStoreMessageById(sessionId: string, messageId: string): Record<string, unknown> | null {
  const database = getDb()
  const normalizedSessionId = String(sessionId || '').trim()
  const normalizedMessageId = String(messageId || '').trim()
  if (!normalizedSessionId || !normalizedMessageId) return null

  const row = database.prepare(`
    SELECT message_json
    FROM chat_messages
    WHERE session_id = ? AND message_id = ?
    LIMIT 1
  `).get(normalizedSessionId, normalizedMessageId) as Record<string, unknown> | undefined

  if (!row || row.message_json == null) return null

  try {
    return JSON.parse(String(row.message_json))
  } catch {
    return null
  }
}
