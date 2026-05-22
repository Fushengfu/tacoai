import type {
  AppStateModelConfig,
  AppStateProviderId,
  AppStateSession,
  AppStateThread,
  ProjectNote,
  ProjectTaskMemory,
} from '../../../shared/ipc'
import type {
  TaskMemoryEntry,
  ProjectNoteEntry,
  ChatStoreSessionEntry,
  ChatStoreSessionSummaryEntry,
  ChatStoreSessionPageEntry,
  ChatStoreSessionPatchEntry,
  MemorySnapshotEntry,
} from './schema'
import { APP_PROVIDER_IDS, APP_PROVIDER_LABELS } from './schema'

/* ------------------------------------------------------------------ */
/*  JSON serialization / deserialization                               */
/* ------------------------------------------------------------------ */

export function stringifyStringArray(value: string[] | undefined): string {
  return JSON.stringify(Array.isArray(value) ? value : [])
}

export function parseStringArray(raw: unknown): string[] {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(parsed) ? parsed.map((item) => String(item ?? '').trim()).filter(Boolean) : []
  } catch {
    return []
  }
}

export function parseOptionalInteger(raw: unknown): number | undefined {
  const value = Number(raw)
  if (!Number.isFinite(value)) return undefined
  return Math.floor(value)
}

export function parseUnknownArray(raw: unknown): unknown[] {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function parseUnknownObject(raw: unknown): Record<string, unknown> {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

/* ------------------------------------------------------------------ */
/*  Normalize helpers                                                  */
/* ------------------------------------------------------------------ */

export function normalizeChatStoreSeq(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.floor(n)
}

export function parseOptionalTimestamp(raw: unknown): number | undefined {
  const value = Number(raw)
  if (!Number.isFinite(value)) return undefined
  const normalized = Math.trunc(value)
  return normalized >= 0 ? normalized : undefined
}

export function parseFileDiffsArray(raw: unknown): Array<{path: string, oldContent: string | null, newContent: string | null}> {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item) => item && typeof item === 'object' && 'path' in item)
      .map((item) => ({
        path: String(item.path || ''),
        oldContent: item.oldContent !== undefined ? String(item.oldContent) : null,
        newContent: item.newContent !== undefined ? String(item.newContent) : null,
      }))
  } catch {
    return []
  }
}

export function asTrimmedString(value: unknown): string {
  return String(value ?? '').trim()
}

export function asOptionalTrimmedString(value: unknown): string | undefined {
  const text = asTrimmedString(value)
  return text || undefined
}

export function asBooleanFlag(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value > 0
  const text = asTrimmedString(value).toLowerCase()
  if (!text) return false
  return text === '1' || text === 'true' || text === 'yes'
}

export function normalizeProviderId(value: unknown, fallback: AppStateProviderId = 'deepseek'): AppStateProviderId {
  const text = asTrimmedString(value) as AppStateProviderId
  return APP_PROVIDER_IDS.includes(text) ? text : fallback
}

export function normalizeMode(value: unknown): 'agent' | undefined {
  const text = asTrimmedString(value)
  if (text === 'agent') return text
  return undefined
}

export function resolveLatestIsoTimestamp(values: Array<string | undefined>): string | undefined {
  let latest = 0
  for (const item of values) {
    const ts = Date.parse(String(item || ''))
    if (Number.isFinite(ts) && ts > latest) latest = ts
  }
  return latest > 0 ? new Date(latest).toISOString() : undefined
}

/* ------------------------------------------------------------------ */
/*  Row-to-entry converters                                            */
/* ------------------------------------------------------------------ */

export function rowToTaskMemoryEntry(row: Record<string, unknown>): TaskMemoryEntry {
  const sourceMessageIds = parseStringArray(row.source_message_ids_json)
  const sourceStartSeq = parseOptionalInteger(row.source_start_seq)
  const sourceEndSeq = parseOptionalInteger(row.source_end_seq)
  
  // 解析fileDiffs
  let fileDiffs: Array<{path: string, oldContent: string | null, newContent: string | null}> = []
  try {
    const raw = row.file_diffs_json
    if (typeof raw === 'string' && raw.trim()) {
      fileDiffs = JSON.parse(raw)
    }
  } catch {
    fileDiffs = []
  }
  
  return {
    id: String(row.id || ''),
    userQuery: String(row.user_query || ''),
    ...(String(row.user_assets_block || '').trim() ? { userAssetsBlock: String(row.user_assets_block || '') } : {}),
    assistantResult: String(row.assistant_result || ''),
    outcome: (String(row.outcome || 'success') as 'success' | 'aborted' | 'error'),
    tools: parseStringArray(row.tools_json),
    changedFiles: parseStringArray(row.changed_files_json),
    fileDiffs,
    failures: parseStringArray(row.failures_json),
    ...(String(row.source_session_id || '').trim() ? { sourceSessionId: String(row.source_session_id || '').trim() } : {}),
    ...(String(row.source_user_message_id || '').trim() ? { sourceUserMessageId: String(row.source_user_message_id || '').trim() } : {}),
    ...(String(row.source_assistant_message_id || '').trim() ? { sourceAssistantMessageId: String(row.source_assistant_message_id || '').trim() } : {}),
    ...(sourceMessageIds.length > 0 ? { sourceMessageIds } : {}),
    ...(typeof sourceStartSeq === 'number' ? { sourceStartSeq } : {}),
    ...(typeof sourceEndSeq === 'number' ? { sourceEndSeq } : {}),
    ...(String(row.deleted_at || '').trim() ? { deletedAt: String(row.deleted_at || '') } : {}),
    ...(String(row.deleted_reason || '').trim() ? { deletedReason: String(row.deleted_reason || '') } : {}),
    ...(String(row.merged_into_id || '').trim() ? { mergedIntoId: String(row.merged_into_id || '') } : {}),
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || ''),
    // 废弃字段(保留兼容性)
    ...(String(row.goal || '').trim() ? { goal: String(row.goal || '') } : {}),
    ...(String(row.intent_type || '').trim() ? { intentType: String(row.intent_type || '') } : {}),
    ...(String(row.intent_summary || '').trim() ? { intentSummary: String(row.intent_summary || '') } : {}),
    ...(String(row.intent_goal || '').trim() ? { intentGoal: String(row.intent_goal || '') } : {}),
    ...(String(row.summary || '').trim() ? { summary: String(row.summary || '') } : {}),
    identifiers: parseStringArray(row.identifiers_json),
    evidenceFacts: parseStringArray(row.evidence_facts_json),
  }
}

export function rowToSnapshotEntry(row: Record<string, unknown>): MemorySnapshotEntry {
  return {
    id: String(row.id || ''),
    summary: String(row.summary || ''),
    sourceMessageCount: Number(row.source_message_count || 0),
    ...(Number.isFinite(Number(row.usage_total_tokens)) ? { usageTotalTokens: Number(row.usage_total_tokens) } : {}),
    ...(Number.isFinite(Number(row.max_tokens)) ? { contextLength: Number(row.max_tokens) } : {}),
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || ''),
  }
}

export function rowToProjectNoteEntry(row: Record<string, unknown>): ProjectNoteEntry {
  return {
    id: String(row.id || ''),
    title: String(row.title || ''),
    content: String(row.content || ''),
    category: (String(row.category || 'other') as ProjectNoteEntry['category']),
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || ''),
  }
}

export function rowToChatStoreSessionEntry(row: Record<string, unknown>): ChatStoreSessionEntry {
  return {
    projectId: String(row.project_id || ''),
    sessionId: String(row.session_id || ''),
    ...(String(row.workspace || '').trim() ? { workspace: String(row.workspace || '') } : {}),
    updatedAt: Number(row.updated_at || 0),
    messages: parseUnknownArray(row.messages_json),
  }
}

export function rowToChatStoreSessionSummaryEntry(row: Record<string, unknown>): ChatStoreSessionSummaryEntry {
  return {
    projectId: String(row.project_id || ''),
    sessionId: String(row.session_id || ''),
    ...(String(row.workspace || '').trim() ? { workspace: String(row.workspace || '') } : {}),
    updatedAt: Number(row.updated_at || 0),
    messageCount: normalizeChatStoreSeq(row.message_count),
  }
}

/* ------------------------------------------------------------------ */
/*  AppState normalize helpers                                         */
/* ------------------------------------------------------------------ */

export function normalizeSessionForStorage(raw: unknown, index: number, nowTs: number): AppStateSession | null {
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

export function normalizeThreadForStorage(raw: unknown, index: number, nowTs: number): AppStateThread | null {
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

export function normalizeModelConfigForStorage(raw: unknown, index: number, nowTs: number): AppStateModelConfig | null {
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
    contextLength: asTrimmedString(item.contextLength),
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

export function normalizeLegacyProviderFormsForStorage(raw: unknown, nowTs: number): AppStateModelConfig[] {
  const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const configs: AppStateModelConfig[] = []
  APP_PROVIDER_IDS.forEach((provider, index) => {
    const form = obj[provider]
    const formObj = form && typeof form === 'object' ? form as Record<string, unknown> : {}
    const baseUrl = asTrimmedString(formObj.baseUrl)
    const apiKey = asTrimmedString(formObj.apiKey)
    const model = asTrimmedString(formObj.model)
    const contextLength = asTrimmedString(formObj.contextLength)
    const temperature = asTrimmedString(formObj.temperature)
    if (!baseUrl && !apiKey && !model && !contextLength && !temperature) return
    configs.push({
      id: `legacy-${provider}-0`,
      provider,
      name: model || provider,
      baseUrl,
      apiKey,
      model,
      contextLength,
      temperature,
      supportsVision: false,
      createdAt: nowTs + index,
      updatedAt: nowTs + index,
    })
  })
  return configs
}
