import { DatabaseSync } from 'node:sqlite'
import type {
  AppStateModelConfig,
  AppStateProviderId,
  AppStateSession,
  AppStateThread,
  AppStateProvidersPayload,
  AppStateThreadsPayload,
} from '../../../shared/ipc-types'
import type { AppStateStoreEntry } from './schema'
import { getDb, runInTransaction } from './schema'
import {
  asTrimmedString,
  asOptionalTrimmedString,
  asBooleanFlag,
  normalizeProviderId,
  normalizeMode,
  parseOptionalTimestamp,
  resolveLatestIsoTimestamp,
  normalizeSessionForStorage,
  normalizeThreadForStorage,
  normalizeModelConfigForStorage,
  normalizeLegacyProviderFormsForStorage,
  parseUnknownObject,
} from './utils'

/* ------------------------------------------------------------------ */
/*  AppState meta helpers                                              */
/* ------------------------------------------------------------------ */

function readAppStateMetaRaw(
  metaKey: string,
  database: DatabaseSync = getDb(),
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
  database: DatabaseSync = getDb(),
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

function readAppStateEntryRaw(
  stateKey: string,
  database: DatabaseSync = getDb(),
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

function deleteAppStateEntryRaw(stateKey: string, database: DatabaseSync = getDb()): void {
  const normalizedKey = asTrimmedString(stateKey)
  if (!normalizedKey) return
  database.prepare(`DELETE FROM app_state_entries WHERE state_key = ?`).run(normalizedKey)
}

function countTableRows(database: DatabaseSync, tableName: string): number {
  const row = database.prepare(`SELECT COUNT(1) AS count FROM ${tableName}`).get() as Record<string, unknown> | undefined
  return Number(row?.count || 0)
}

/* ------------------------------------------------------------------ */
/*  Legacy migration                                                   */
/* ------------------------------------------------------------------ */

let appStateRecordMigrationChecked = false

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
          id, provider, name, base_url, api_key, model, max_tokens, temperature, supports_vision, supports_reasoning, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const model of normalizedModels) {
        insertModelStmt.run(
          model.id,
          model.provider,
          model.name,
          model.baseUrl ?? null,
          model.apiKey ?? null,
          model.model ?? null,
          model.contextLength ?? null,
          model.temperature ?? null,
          model.supportsVision ? 1 : 0,
          model.supportsReasoning ? 1 : 0,
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

/* ------------------------------------------------------------------ */
/*  AppThreads                                                         */
/* ------------------------------------------------------------------ */

export function loadAppThreadsStateFromDb(): AppStateStoreEntry<AppStateThreadsPayload | null> {
  const database = getDb()
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
    let sessions = sessionsByThread.get(threadId) ?? []
    /* 没有 session 的 thread 不再静默丢弃，自动补一个默认会话 */
    if (sessions.length <= 0) {
      sessions = [{ id: threadId, title: '会话', createdAt: parseOptionalTimestamp(row.updated_at) ?? Date.now() }]
    }
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
  const database = getDb()
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

  /* 安全防护：如果传入的 threads 为空，检查数据库是否有数据 */
  if (threads.length <= 0) {
    const current = loadAppThreadsStateFromDb()
    if (current.data && current.data.threads.length > 0) {
      console.warn('[app-state] 拒绝用空数据覆盖已有项目列表，保留数据库当前状态')
      return { data: current.data, updatedAt: current.updatedAt || updatedAt }
    }
    /* 数据库也为空（首次启动），无需任何操作 */
    return { data: { threads: [], activeThreadId: '' }, updatedAt }
  }

  runInTransaction(database, () => {
    /* UPSERT 所有 thread 和 session（非破坏性写入，不会先删再插） */
    const upsertThreadStmt = database.prepare(`
      INSERT INTO app_project_configs (
        id, title, title_locked, updated_at, model_config_id, provider, mode, workspace, project_rules, active_session_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title=excluded.title,
        title_locked=excluded.title_locked,
        updated_at=excluded.updated_at,
        model_config_id=excluded.model_config_id,
        provider=excluded.provider,
        mode=excluded.mode,
        workspace=excluded.workspace,
        project_rules=excluded.project_rules,
        active_session_id=excluded.active_session_id
    `)
    const upsertSessionStmt = database.prepare(`
      INSERT INTO app_project_sessions (
        id, thread_id, title, created_at, sort_order
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        thread_id=excluded.thread_id,
        title=excluded.title,
        created_at=excluded.created_at,
        sort_order=excluded.sort_order
    `)

    const threadIds: string[] = []
    for (const thread of threads) {
      threadIds.push(thread.id)
      upsertThreadStmt.run(
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
      for (let sessionIndex = 0; sessionIndex < thread.sessions.length; sessionIndex++) {
        const session = thread.sessions[sessionIndex]
        upsertSessionStmt.run(session.id, thread.id, session.title, session.createdAt, sessionIndex)
      }
    }

    /* 清理不在当前列表中的旧记录（保留已 UPSERT 的数据，只删多余的） */
    if (threadIds.length > 0) {
      const threadPlaceholders = threadIds.map(() => '?').join(', ')
      database.prepare(`DELETE FROM app_project_sessions WHERE thread_id NOT IN (${threadPlaceholders})`).run(...threadIds)
      database.prepare(`DELETE FROM app_project_configs WHERE id NOT IN (${threadPlaceholders})`).run(...threadIds)
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

/* ------------------------------------------------------------------ */
/*  AppProviders                                                       */
/* ------------------------------------------------------------------ */

export function loadAppProvidersStateFromDb(): AppStateStoreEntry<AppStateProvidersPayload | null> {
  const database = getDb()
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
      supports_reasoning,
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
      contextLength: row.max_tokens,
      temperature: row.temperature,
      supportsVision: Number(row.supports_vision || 0) > 0,
      supportsReasoning: Number(row.supports_reasoning || 0) > 0,
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
  const database = getDb()
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

  /* 安全防护：如果传入的 modelConfigs 为空，检查数据库是否有数据 */
  if (modelConfigs.length <= 0) {
    const current = loadAppProvidersStateFromDb()
    if (current.data && current.data.modelConfigs.length > 0) {
      console.warn('[app-state] 拒绝用空数据覆盖已有模型配置，保留数据库当前状态')
      return { data: current.data, updatedAt: current.updatedAt || updatedAt }
    }
    /* 数据库也为空（首次启动），无需任何操作 */
    return { data: { modelConfigs: [], activeModelConfigId: '' }, updatedAt }
  }

  runInTransaction(database, () => {
    /* UPSERT（非破坏性写入，不会先删再插） */
    const upsertStmt = database.prepare(`
      INSERT INTO app_model_configs (
        id, provider, name, base_url, api_key, model, max_tokens, temperature, supports_vision, supports_reasoning, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        provider=excluded.provider,
        name=excluded.name,
        base_url=excluded.base_url,
        api_key=excluded.api_key,
        model=excluded.model,
        max_tokens=excluded.max_tokens,
        temperature=excluded.temperature,
        supports_vision=excluded.supports_vision,
        supports_reasoning=excluded.supports_reasoning,
        created_at=excluded.created_at,
        updated_at=excluded.updated_at
    `)

    const modelIds: string[] = []
    for (const model of modelConfigs) {
      modelIds.push(model.id)
      upsertStmt.run(
        model.id,
        model.provider,
        model.name,
        model.baseUrl ?? null,
        model.apiKey ?? null,
        model.model ?? null,
        model.contextLength ?? null,
        model.temperature ?? null,
        model.supportsVision ? 1 : 0,
        model.supportsReasoning ? 1 : 0,
        parseOptionalTimestamp(model.createdAt) ?? null,
        parseOptionalTimestamp(model.updatedAt) ?? null,
      )
    }

    /* 清理不在当前列表中的旧记录 */
    if (modelIds.length > 0) {
      const placeholders = modelIds.map(() => '?').join(', ')
      database.prepare(`DELETE FROM app_model_configs WHERE id NOT IN (${placeholders})`).run(...modelIds)
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
