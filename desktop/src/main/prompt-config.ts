import { app } from 'electron'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { PromptConfig, PromptLayerConfig } from '../shared/ipc'

const TACO_DIR = path.join(app.getPath('home'), '.taco')
const PROMPT_CONFIG_FILE = path.join(TACO_DIR, 'prompt-config.json')

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
  const fallback: PromptConfig = { version: 1 }
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

async function ensureDir() {
  await fs.mkdir(TACO_DIR, { recursive: true })
}

export async function getPromptConfig(): Promise<PromptConfig> {
  try {
    const raw = await fs.readFile(PROMPT_CONFIG_FILE, 'utf-8')
    return sanitizePromptConfig(JSON.parse(raw))
  } catch {
    return { version: 1 }
  }
}

export async function savePromptConfig(config: PromptConfig): Promise<PromptConfig> {
  await ensureDir()
  const sanitized = sanitizePromptConfig(config)
  sanitized.updatedAt = new Date().toISOString()
  await fs.writeFile(PROMPT_CONFIG_FILE, JSON.stringify(sanitized, null, 2), 'utf-8')
  return sanitized
}
