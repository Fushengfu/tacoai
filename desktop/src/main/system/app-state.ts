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

const TACO_DIR = path.join(app.getPath('home'), '.taco')
const APP_STATE_FILE = path.join(TACO_DIR, 'app-state.json')
const APP_STATE_VERSION = 1
const PROVIDER_IDS: readonly AppStateProviderId[] = ['deepseek', 'kimi', 'minimax', 'glm']

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

function defaultState(): AppStateSnapshot {
  return {
    version: APP_STATE_VERSION,
    threadsState: defaultThreadsState(),
    providersState: defaultProvidersState(),
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

function sanitizeSnapshot(raw: unknown): AppStateSnapshot {
  const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const versionRaw = Number(obj.version)
  return {
    version: Number.isFinite(versionRaw) && versionRaw > 0 ? Math.floor(versionRaw) : APP_STATE_VERSION,
    updatedAt: asOptionalString(obj.updatedAt),
    threadsState: sanitizeThreadsState(obj.threadsState),
    providersState: sanitizeProvidersState(obj.providersState),
  }
}

async function ensureStateDir(): Promise<void> {
  await fs.mkdir(TACO_DIR, { recursive: true })
}

async function writeState(state: AppStateSnapshot): Promise<void> {
  await ensureStateDir()
  const next: AppStateSnapshot = {
    ...state,
    version: APP_STATE_VERSION,
    updatedAt: new Date().toISOString(),
  }
  await fs.writeFile(APP_STATE_FILE, JSON.stringify(next, null, 2), 'utf-8')
}

async function readState(): Promise<AppStateSnapshot> {
  try {
    const raw = await fs.readFile(APP_STATE_FILE, 'utf-8')
    return sanitizeSnapshot(JSON.parse(raw))
  } catch {
    const initial = defaultState()
    await writeState(initial)
    return { ...initial, updatedAt: new Date().toISOString() }
  }
}

export async function getAppState(): Promise<AppStateSnapshot> {
  return await readState()
}

export async function saveAppThreadsState(payload: AppStateThreadsPayload): Promise<AppStateThreadsPayload> {
  const current = await readState()
  const next: AppStateSnapshot = {
    ...current,
    threadsState: sanitizeThreadsState(payload),
  }
  await writeState(next)
  return next.threadsState
}

export async function saveAppProvidersState(payload: AppStateProvidersPayload): Promise<AppStateProvidersPayload> {
  const current = await readState()
  const next: AppStateSnapshot = {
    ...current,
    providersState: sanitizeProvidersState(payload),
  }
  await writeState(next)
  return next.providersState
}
