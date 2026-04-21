import { app } from 'electron'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type {
  AppStateProviderForm,
  AppStateProviderForms,
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
const APP_STATE_VERSION = 1
const PROVIDER_IDS: readonly AppStateProviderId[] = ['deepseek', 'kimi', 'minimax', 'glm']

type StoredStateRecord<T> = {
  version: number
  updatedAt?: string
  data: T
}

function defaultProviderForm(): AppStateProviderForm {
  return {
    baseUrl: '',
    apiKey: '',
    model: '',
    maxTokens: '',
  }
}

function defaultProviderForms(): AppStateProviderForms {
  return {
    deepseek: defaultProviderForm(),
    kimi: defaultProviderForm(),
    minimax: defaultProviderForm(),
    glm: defaultProviderForm(),
  }
}

function defaultThreadsState(): AppStateThreadsPayload {
  return {
    threads: [],
    activeThreadId: '',
  }
}

function defaultProvidersState(): AppStateProvidersPayload {
  return {
    providerForms: defaultProviderForms(),
    activeProvider: 'deepseek',
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asOptionalString(value: unknown): string | undefined {
  const text = asString(value).trim()
  return text || undefined
}

function asTimestamp(value: unknown): number {
  const num = Number(value)
  if (!Number.isFinite(num)) return Date.now()
  return Math.max(0, Math.trunc(num))
}

function sanitizeProviderId(value: unknown, fallback: AppStateProviderId = 'deepseek'): AppStateProviderId {
  const text = asString(value).trim() as AppStateProviderId
  return PROVIDER_IDS.includes(text) ? text : fallback
}

function sanitizeProviderForm(raw: unknown): AppStateProviderForm {
  const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  return {
    baseUrl: asString(obj.baseUrl).trim(),
    apiKey: asString(obj.apiKey).trim(),
    model: asString(obj.model).trim(),
    maxTokens: asString(obj.maxTokens).trim(),
  }
}

function sanitizeProviderForms(raw: unknown): AppStateProviderForms {
  const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  return {
    deepseek: sanitizeProviderForm(obj.deepseek),
    kimi: sanitizeProviderForm(obj.kimi),
    minimax: sanitizeProviderForm(obj.minimax),
    glm: sanitizeProviderForm(obj.glm),
  }
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
  return {
    id,
    title: asString(obj.title).trim() || '新项目',
    titleLocked: Boolean(obj.titleLocked),
    updatedAt: asTimestamp(obj.updatedAt),
    provider: asOptionalString(obj.provider) ? sanitizeProviderId(obj.provider) : undefined,
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
  return {
    providerForms: sanitizeProviderForms(obj.providerForms),
    activeProvider: sanitizeProviderId(obj.activeProvider, 'deepseek'),
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

async function writeStateFile<T>(filePath: string, data: T): Promise<StoredStateRecord<T>> {
  await ensureStateDir()
  const next: StoredStateRecord<T> = {
    version: APP_STATE_VERSION,
    updatedAt: new Date().toISOString(),
    data,
  }
  await fs.writeFile(filePath, JSON.stringify(next, null, 2), 'utf-8')
  return next
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
  const hasProvidersInDb = Boolean(
    providersDbEntry.data &&
    (
      Object.values(providersDbEntry.data.providerForms ?? {}).some((form) =>
        Boolean(form?.baseUrl || form?.apiKey || form?.model || form?.maxTokens),
      ) ||
      providersDbEntry.data.activeProvider
    ),
  )
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
        const hasCombined = combinedProviders && (
          Object.values(combinedProviders.providerForms).some((form) =>
            Boolean(form.baseUrl || form.apiKey || form.model || form.maxTokens),
          ) || combinedProviders.activeProvider
        )
        if (hasCombined) return combinedProviders
        const hasLegacy = Object.values(legacyProviders.data.providerForms).some((form) =>
          Boolean(form.baseUrl || form.apiKey || form.model || form.maxTokens),
        )
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
