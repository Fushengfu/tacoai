import { app } from 'electron'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type {
  AppStateModelConfig,
  AppStateProviderId,
  AppStateProvidersPayload,
  AppStateSession,
  AppStateSnapshot,
  AppStateThread,
  AppStateThreadsPayload,
} from '../../shared/ipc'
import {
  loadAppProvidersStateFromDb,
  loadAppThreadsStateFromDb,
  saveAppProvidersStateToDb,
  saveAppThreadsStateToDb,
} from '../data/memory-db'

const TACO_DIR = path.join(app.getPath('home'), '.taco')
const LEGACY_APP_STATE_FILE = path.join(TACO_DIR, 'app-state.json')
const THREADS_STATE_FILE = path.join(TACO_DIR, 'threads-state.json')
const PROVIDERS_STATE_FILE = path.join(TACO_DIR, 'providers-state.json')
const APP_STATE_VERSION = 2
const PROVIDER_IDS: readonly AppStateProviderId[] = ['deepseek', 'kimi', 'minimax', 'glm', 'qwen']

type StoredStateRecord<T> = {
  version: number
  updatedAt?: string
  data: T
}

function defaultThreadsState(): AppStateThreadsPayload {
  return {
    threads: [],
    activeThreadId: '',
  }
}

function defaultProvidersState(): AppStateProvidersPayload {
  return {
    modelConfigs: [],
    activeModelConfigId: '',
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asOptionalString(value: unknown): string | undefined {
  const text = asString(value).trim()
  return text || undefined
}

function asBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value > 0
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase()
    return text === '1' || text === 'true' || text === 'yes'
  }
  return false
}

function asTimestamp(value: unknown): number {
  const num = Number(value)
  if (!Number.isFinite(num)) return Date.now()
  return Math.max(0, Math.trunc(num))
}

function asOptionalTimestamp(value: unknown): number | undefined {
  const num = Number(value)
  if (!Number.isFinite(num)) return undefined
  return Math.max(0, Math.trunc(num))
}

function sanitizeProviderId(value: unknown, fallback: AppStateProviderId = 'deepseek'): AppStateProviderId {
  const text = asString(value).trim() as AppStateProviderId
  return PROVIDER_IDS.includes(text) ? text : fallback
}

function normalizeModelConfig(raw: unknown, index: number): AppStateModelConfig | null {
  const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null
  if (!obj) return null
  const provider = sanitizeProviderId(obj.provider, 'deepseek')
  const model = asString(obj.model).trim()
  const id = asString(obj.id).trim() || `model-${Date.now()}-${index}`
  if (!id) return null
  const name = asString(obj.name).trim() || model || provider
  return {
    id,
    provider,
    name,
    baseUrl: asString(obj.baseUrl).trim(),
    apiKey: asString(obj.apiKey).trim(),
    model,
    maxTokens: asString(obj.maxTokens).trim(),
    temperature: asString(obj.temperature).trim(),
    supportsVision: asBoolean(obj.supportsVision),
    ...(typeof asOptionalTimestamp(obj.createdAt) === 'number' ? { createdAt: asOptionalTimestamp(obj.createdAt) } : {}),
    ...(typeof asOptionalTimestamp(obj.updatedAt) === 'number' ? { updatedAt: asOptionalTimestamp(obj.updatedAt) } : {}),
  }
}

function legacyProviderFormsToModelConfigs(raw: unknown): AppStateModelConfig[] {
  const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const now = Date.now()
  const out: AppStateModelConfig[] = []
  for (const provider of PROVIDER_IDS) {
    const form = obj[provider]
    const formObj = form && typeof form === 'object' ? form as Record<string, unknown> : {}
    const baseUrl = asString(formObj.baseUrl).trim()
    const apiKey = asString(formObj.apiKey).trim()
    const model = asString(formObj.model).trim()
    const maxTokens = asString(formObj.maxTokens).trim()
    const temperature = asString(formObj.temperature).trim()
    if (!baseUrl && !apiKey && !model && !maxTokens && !temperature) continue
    out.push({
      id: `legacy-${provider}-0`,
      provider,
      name: model || provider,
      baseUrl,
      apiKey,
      model,
      maxTokens,
      temperature,
      supportsVision: false,
      createdAt: now,
      updatedAt: now,
    })
  }
  return out
}

function sanitizeModelConfigs(raw: unknown): AppStateModelConfig[] {
  if (Array.isArray(raw)) {
    const dedup = new Map<string, AppStateModelConfig>()
    raw.forEach((item, index) => {
      const normalized = normalizeModelConfig(item, index)
      if (normalized) dedup.set(normalized.id, normalized)
    })
    return [...dedup.values()]
  }
  return []
}

function resolveActiveModelConfigId(activeModelConfigId: unknown, modelConfigs: AppStateModelConfig[]): string {
  const activeId = asString(activeModelConfigId).trim()
  if (activeId && modelConfigs.some((item) => item.id === activeId)) return activeId
  const configured = modelConfigs.find((item) => Boolean(item.apiKey && item.model))
  if (configured) return configured.id
  return modelConfigs[0]?.id ?? ''
}

function sanitizeSession(raw: unknown): AppStateSession | null {
  const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null
  if (!obj) return null
  const id = asString(obj.id).trim()
  if (!id) return null
  return {
    id,
    title: asString(obj.title).trim() || '会话',
    createdAt: asTimestamp(obj.createdAt),
  }
}

function sanitizeThread(raw: unknown): AppStateThread | null {
  const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null
  if (!obj) return null
  const id = asString(obj.id).trim()
  if (!id) return null
  const sessions = Array.isArray(obj.sessions)
    ? obj.sessions.map((item) => sanitizeSession(item)).filter((item): item is AppStateSession => Boolean(item))
    : []
  if (sessions.length <= 0) return null
  const activeSessionIdRaw = asString(obj.activeSessionId).trim()
  const activeSessionId = sessions.some((session) => session.id === activeSessionIdRaw)
    ? activeSessionIdRaw
    : sessions[0].id
  const modeRaw = asString(obj.mode).trim()
  const modelConfigId = asOptionalString(obj.modelConfigId)
  const legacyProvider = asOptionalString(obj.provider) ? sanitizeProviderId(obj.provider) : undefined
  return {
    id,
    title: asString(obj.title).trim() || '新项目',
    titleLocked: Boolean(obj.titleLocked),
    updatedAt: asTimestamp(obj.updatedAt),
    ...(modelConfigId ? { modelConfigId } : {}),
    ...(legacyProvider ? { provider: legacyProvider } : {}),
    mode: modeRaw === 'chat' || modeRaw === 'agent' ? modeRaw : undefined,
    workspace: asOptionalString(obj.workspace),
    projectRules: asOptionalString(obj.projectRules),
    sessions,
    activeSessionId,
  }
}

function sanitizeThreads(raw: unknown): AppStateThread[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((item) => sanitizeThread(item))
    .filter((item): item is AppStateThread => Boolean(item))
}

function sanitizeThreadsState(raw: unknown): AppStateThreadsPayload {
  const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const threads = sanitizeThreads(obj.threads)
  const activeThreadIdRaw = asString(obj.activeThreadId).trim()
  const activeThreadId = threads.some((thread) => thread.id === activeThreadIdRaw)
    ? activeThreadIdRaw
    : (threads[0]?.id ?? '')
  return {
    threads,
    activeThreadId,
  }
}

function sanitizeProvidersState(raw: unknown): AppStateProvidersPayload {
  const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const fromNew = sanitizeModelConfigs(obj.modelConfigs)
  const fromLegacy = fromNew.length > 0 ? [] : legacyProviderFormsToModelConfigs(obj.providerForms)
  const modelConfigs = fromNew.length > 0 ? fromNew : fromLegacy
  const activeModelConfigId = resolveActiveModelConfigId(
    obj.activeModelConfigId,
    modelConfigs,
  ) || (() => {
    const legacyActiveProvider = sanitizeProviderId(obj.activeProvider, 'deepseek')
    const matched = modelConfigs.find((item) => item.provider === legacyActiveProvider)
    return matched?.id ?? modelConfigs[0]?.id ?? ''
  })()
  return {
    modelConfigs,
    activeModelConfigId,
  }
}

function sanitizeStoredFile<T>(
  raw: unknown,
  sanitizeData: (value: unknown) => T,
  fallback: T,
): StoredStateRecord<T> {
  const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const versionRaw = Number(obj.version)
  const dataSource = Object.prototype.hasOwnProperty.call(obj, 'data') ? obj.data : raw
  return {
    version: Number.isFinite(versionRaw) && versionRaw > 0 ? Math.floor(versionRaw) : APP_STATE_VERSION,
    updatedAt: asOptionalString(obj.updatedAt),
    data: sanitizeData(dataSource ?? fallback),
  }
}

async function ensureStateDir(): Promise<void> {
  await fs.mkdir(TACO_DIR, { recursive: true })
}

async function readStateFile<T>(
  filePath: string,
  sanitizeData: (value: unknown) => T,
  fallback: T,
): Promise<StoredStateRecord<T>> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    return sanitizeStoredFile(JSON.parse(raw), sanitizeData, fallback)
  } catch {
    return {
      version: APP_STATE_VERSION,
      updatedAt: undefined,
      data: fallback,
    }
  }
}

async function removeLegacyStateFiles(): Promise<void> {
  await Promise.all([
    fs.rm(LEGACY_APP_STATE_FILE, { force: true }),
    fs.rm(THREADS_STATE_FILE, { force: true }),
    fs.rm(PROVIDERS_STATE_FILE, { force: true }),
  ])
}

async function migrateLegacyFileStateToDbIfNeeded(): Promise<void> {
  const [threadsDbEntry, providersDbEntry] = await Promise.all([
    Promise.resolve(loadAppThreadsStateFromDb()),
    Promise.resolve(loadAppProvidersStateFromDb()),
  ])
  const hasThreadsInDb = Array.isArray(threadsDbEntry.data?.threads) && threadsDbEntry.data.threads.length > 0
  const hasProvidersInDb = Array.isArray(providersDbEntry.data?.modelConfigs) && providersDbEntry.data.modelConfigs.length > 0
  if (hasThreadsInDb && hasProvidersInDb) {
    await removeLegacyStateFiles()
    return
  }

  const legacyThreads = await readStateFile(THREADS_STATE_FILE, sanitizeThreadsState, defaultThreadsState())
  const legacyProviders = await readStateFile(PROVIDERS_STATE_FILE, sanitizeProvidersState, defaultProvidersState())

  let combinedThreads: AppStateThreadsPayload | null = null
  let combinedProviders: AppStateProvidersPayload | null = null
  try {
    const raw = await fs.readFile(LEGACY_APP_STATE_FILE, 'utf-8')
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {}
    combinedThreads = sanitizeThreadsState(parsed.threadsState)
    combinedProviders = sanitizeProvidersState(parsed.providersState)
  } catch {
    // ignore missing legacy combined file
  }

  const threadsToPersist = hasThreadsInDb
    ? null
    : (combinedThreads && combinedThreads.threads.length > 0
        ? combinedThreads
        : (legacyThreads.data.threads.length > 0 ? legacyThreads.data : null))

  const providersToPersist = hasProvidersInDb
    ? null
    : (() => {
        const hasCombined = Boolean(combinedProviders?.modelConfigs?.length)
        if (hasCombined) return combinedProviders
        const hasLegacy = Boolean(legacyProviders.data.modelConfigs.length)
        return hasLegacy ? legacyProviders.data : null
      })()

  if (threadsToPersist) saveAppThreadsStateToDb(threadsToPersist)
  if (providersToPersist) saveAppProvidersStateToDb(providersToPersist)

  await removeLegacyStateFiles()
}

async function readThreadsState(): Promise<StoredStateRecord<AppStateThreadsPayload>> {
  await migrateLegacyFileStateToDbIfNeeded()
  const stored = loadAppThreadsStateFromDb()
  return {
    version: APP_STATE_VERSION,
    updatedAt: stored.updatedAt,
    data: sanitizeThreadsState(stored.data ?? defaultThreadsState()),
  }
}

async function readProvidersState(): Promise<StoredStateRecord<AppStateProvidersPayload>> {
  await migrateLegacyFileStateToDbIfNeeded()
  const stored = loadAppProvidersStateFromDb()
  return {
    version: APP_STATE_VERSION,
    updatedAt: stored.updatedAt,
    data: sanitizeProvidersState(stored.data ?? defaultProvidersState()),
  }
}

export async function getAppState(): Promise<AppStateSnapshot> {
  const [threadsFile, providersFile] = await Promise.all([
    readThreadsState(),
    readProvidersState(),
  ])
  return {
    version: APP_STATE_VERSION,
    updatedAt: providersFile.updatedAt || threadsFile.updatedAt,
    threadsState: threadsFile.data,
    providersState: providersFile.data,
  }
}

export async function saveAppThreadsState(payload: AppStateThreadsPayload): Promise<AppStateThreadsPayload> {
  const sanitized = sanitizeThreadsState(payload)
  const saved = saveAppThreadsStateToDb(sanitized)
  return saved.data
}

export async function saveAppProvidersState(payload: AppStateProvidersPayload): Promise<AppStateProvidersPayload> {
  const sanitized = sanitizeProvidersState(payload)
  const saved = saveAppProvidersStateToDb(sanitized)
  return saved.data
}
