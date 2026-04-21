import { app } from 'electron'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { PromptConfig, PromptLayerConfig } from '../../shared/ipc'
import { DEFAULT_MODEL_PROMPT_LAYER_MAP, DEFAULT_PROVIDER_PROMPT_LAYER_MAP } from '../../shared/prompt-defaults'
import { DEFAULT_BALANCED_CHAT_EXTRA, DEFAULT_STRICT_AGENT_EXTRA } from '../../shared/prompt-profile-texts'

const TACO_DIR = path.join(app.getPath('home'), '.taco')
const PROMPT_CONFIG_FILE = path.join(TACO_DIR, 'prompt-config.json')
const PROMPT_CONFIG_VERSION = 3
const DEFAULT_PROMPT_CONFIG: PromptConfig = {
  version: PROMPT_CONFIG_VERSION,
  common: {
    chatExtra: DEFAULT_BALANCED_CHAT_EXTRA,
    agentExtra: DEFAULT_STRICT_AGENT_EXTRA,
  },
  provider: { ...DEFAULT_PROVIDER_PROMPT_LAYER_MAP },
  model: { ...DEFAULT_MODEL_PROMPT_LAYER_MAP },
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function sanitizeLayer(raw: unknown): PromptLayerConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const obj = raw as Record<string, unknown>
  const layer: PromptLayerConfig = {}

  const allExtra = asString(obj.allExtra)
  const chatExtra = asString(obj.chatExtra)
  const agentExtra = asString(obj.agentExtra)
  const chatOverride = asString(obj.chatOverride)
  const agentOverride = asString(obj.agentOverride)

  if (allExtra) layer.allExtra = allExtra
  if (chatExtra) layer.chatExtra = chatExtra
  if (agentExtra) layer.agentExtra = agentExtra
  if (chatOverride) layer.chatOverride = chatOverride
  if (agentOverride) layer.agentOverride = agentOverride

  return Object.keys(layer).length > 0 ? layer : undefined
}

function sanitizeLayerMap(raw: unknown): Record<string, PromptLayerConfig> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: Record<string, PromptLayerConfig> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const normalizedKey = key.trim().toLowerCase()
    if (!normalizedKey) continue
    const layer = sanitizeLayer(value)
    if (layer) out[normalizedKey] = layer
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function sanitizePromptConfig(raw: unknown): PromptConfig {
  const fallback: PromptConfig = { ...DEFAULT_PROMPT_CONFIG }
  if (!raw || typeof raw !== 'object') return fallback

  const obj = raw as Record<string, unknown>
  const versionRaw = Number(obj.version)
  const version = Number.isFinite(versionRaw) && versionRaw > 0 ? Math.floor(versionRaw) : 1

  const config: PromptConfig = {
    version,
    common: sanitizeLayer(obj.common),
    provider: sanitizeLayerMap(obj.provider),
    model: sanitizeLayerMap(obj.model),
  }

  const updatedAt = asString(obj.updatedAt)
  if (updatedAt) config.updatedAt = updatedAt

  return config
}

function migratePromptConfig(config: PromptConfig): PromptConfig {
  const migrated: PromptConfig = { ...config }
  if ((migrated.version ?? 1) < PROMPT_CONFIG_VERSION) {
    migrated.version = PROMPT_CONFIG_VERSION
    migrated.common = {
      ...(migrated.common ?? {}),
      // 升级到新版时强制刷新 agent 规范，避免旧配置继续覆盖默认执行规范。
      agentExtra: DEFAULT_PROMPT_CONFIG.common?.agentExtra,
    }
  }
  return migrated
}

function mergeWithDefaults(config: PromptConfig): PromptConfig {
  const defaultCommon = DEFAULT_PROMPT_CONFIG.common ?? {}
  const defaultProvider = DEFAULT_PROMPT_CONFIG.provider ?? {}
  const defaultModel = DEFAULT_PROMPT_CONFIG.model ?? {}
  const mergedCommon = { ...defaultCommon, ...(config.common ?? {}) }
  const mergedProvider = { ...defaultProvider, ...(config.provider ?? {}) }
  const mergedModel = { ...defaultModel, ...(config.model ?? {}) }

  return {
    version: Number.isFinite(Number(config.version)) && Number(config.version) > 0
      ? Math.floor(Number(config.version))
      : DEFAULT_PROMPT_CONFIG.version,
    common: mergedCommon,
    provider: mergedProvider,
    model: mergedModel,
    ...(config.updatedAt ? { updatedAt: config.updatedAt } : {}),
  }
}

function stableConfigShape(config: PromptConfig): string {
  return JSON.stringify({
    version: Number.isFinite(Number(config.version)) && Number(config.version) > 0
      ? Math.floor(Number(config.version))
      : 1,
    common: config.common ?? {},
    provider: config.provider ?? {},
    model: config.model ?? {},
  })
}

async function ensureDir() {
  await fs.mkdir(TACO_DIR, { recursive: true })
}

export async function ensurePromptConfigInitialized(): Promise<PromptConfig> {
  await ensureDir()
  try {
    const raw = await fs.readFile(PROMPT_CONFIG_FILE, 'utf-8')
    const sanitized = sanitizePromptConfig(JSON.parse(raw))
    const migrated = migratePromptConfig(sanitized)
    const merged = mergeWithDefaults(migrated)
    const needsRewrite = stableConfigShape(sanitized) !== stableConfigShape(merged)

    if (needsRewrite) {
      const normalized: PromptConfig = { ...merged, updatedAt: new Date().toISOString() }
      await fs.writeFile(PROMPT_CONFIG_FILE, JSON.stringify(normalized, null, 2), 'utf-8')
      return normalized
    }
    return merged
  } catch {
    const initial: PromptConfig = { ...DEFAULT_PROMPT_CONFIG, updatedAt: new Date().toISOString() }
    await fs.writeFile(PROMPT_CONFIG_FILE, JSON.stringify(initial, null, 2), 'utf-8')
    return initial
  }
}

export async function getPromptConfig(): Promise<PromptConfig> {
  return await ensurePromptConfigInitialized()
}

export async function savePromptConfig(config: PromptConfig): Promise<PromptConfig> {
  await ensureDir()
  const sanitized = sanitizePromptConfig(config)
  const migrated = migratePromptConfig(sanitized)
  const merged = mergeWithDefaults(migrated)
  const next: PromptConfig = { ...merged, updatedAt: new Date().toISOString() }
  await fs.writeFile(PROMPT_CONFIG_FILE, JSON.stringify(next, null, 2), 'utf-8')
  return next
}
