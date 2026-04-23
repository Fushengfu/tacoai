import { useEffect, useMemo, useState } from 'react'
import type { AppStateModelConfig, AppStateProvidersPayload } from '../../shared/ipc'
import type { ModelConfig, ProviderForms, ProviderId } from '../types'
import { providers, resolveModelConfigDisplayLabel } from '../constants'
import { loadJson } from '../lib/storage'

const LEGACY_PROVIDER_KEY = 'taco.providers'
const VALID_PROVIDER_IDS: readonly ProviderId[] = ['deepseek', 'kimi', 'minimax', 'glm', 'qwen']

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
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

function asProviderId(value: unknown, fallback: ProviderId = 'deepseek'): ProviderId {
  const text = asText(value) as ProviderId
  return VALID_PROVIDER_IDS.includes(text) ? text : fallback
}

function nowTs(): number {
  return Date.now()
}

function hasLegacyProviderState(forms: ProviderForms): boolean {
  return providers.some((provider) => {
    const form = forms[provider.id]
    return Boolean(form?.baseUrl || form?.apiKey || form?.model || form?.maxTokens || form?.temperature)
  })
}

function fromLegacyProviderForms(forms: ProviderForms): ModelConfig[] {
  const createdAt = nowTs()
  return providers
    .map((item, index) => {
      const form = forms[item.id]
      const hasAnyValue = Boolean(form?.baseUrl || form?.apiKey || form?.model || form?.maxTokens || form?.temperature)
      if (!hasAnyValue) return null
      const fallbackName = form?.model?.trim() || item.label
      return {
        id: `legacy-${item.id}-${index}`,
        provider: item.id,
        name: fallbackName,
        baseUrl: asText(form?.baseUrl),
        apiKey: asText(form?.apiKey),
        model: asText(form?.model),
        maxTokens: asText(form?.maxTokens),
        temperature: asText(form?.temperature),
        supportsVision: false,
        createdAt,
        updatedAt: createdAt,
      } as ModelConfig
    })
    .filter((item): item is ModelConfig => Boolean(item))
}

function normalizeModelConfig(raw: unknown, index: number): ModelConfig | null {
  const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null
  if (!obj) return null
  const id = asText(obj.id) || `model-${nowTs()}-${index}`
  const provider = asProviderId(obj.provider, 'deepseek')
  const model = asText(obj.model)
  const name = asText(obj.name) || model || providers.find((p) => p.id === provider)?.label || provider
  const createdAt = Number(obj.createdAt)
  const updatedAt = Number(obj.updatedAt)
  return {
    id,
    provider,
    name,
    baseUrl: asText(obj.baseUrl),
    apiKey: asText(obj.apiKey),
    model,
    maxTokens: asText(obj.maxTokens),
    temperature: asText(obj.temperature),
    supportsVision: asBoolean(obj.supportsVision),
    ...(Number.isFinite(createdAt) ? { createdAt: Math.max(0, Math.floor(createdAt)) } : {}),
    ...(Number.isFinite(updatedAt) ? { updatedAt: Math.max(0, Math.floor(updatedAt)) } : {}),
  }
}

function normalizeModelConfigs(raw: unknown): ModelConfig[] {
  if (!Array.isArray(raw)) return []
  const normalized = raw
    .map((item, index) => normalizeModelConfig(item, index))
    .filter((item): item is ModelConfig => Boolean(item))
  const dedup = new Map<string, ModelConfig>()
  for (const item of normalized) {
    dedup.set(item.id, item)
  }
  return [...dedup.values()]
}

function resolveActiveModelConfigId(activeId: string, configs: ModelConfig[]): string {
  const normalizedActive = asText(activeId)
  if (normalizedActive && configs.some((item) => item.id === normalizedActive)) return normalizedActive
  const configured = configs.find((item) => Boolean(item.apiKey && item.model))
  if (configured) return configured.id
  return configs[0]?.id ?? ''
}

function toPersistPayload(configs: ModelConfig[], activeModelConfigId: string): AppStateProvidersPayload {
  const normalized = configs.map((item) => ({
    id: item.id,
    provider: item.provider,
    name: item.name,
    baseUrl: item.baseUrl,
    apiKey: item.apiKey,
    model: item.model,
    maxTokens: item.maxTokens,
    temperature: asText(item.temperature),
    supportsVision: Boolean(item.supportsVision),
    ...(typeof item.createdAt === 'number' ? { createdAt: item.createdAt } : {}),
    ...(typeof item.updatedAt === 'number' ? { updatedAt: item.updatedAt } : {}),
  })) as AppStateModelConfig[]
  return {
    modelConfigs: normalized,
    activeModelConfigId: resolveActiveModelConfigId(activeModelConfigId, normalized as ModelConfig[]),
  }
}

export function useProviderSettings() {
  const [modelConfigs, setModelConfigs] = useState<ModelConfig[]>([])
  const [activeModelConfigId, setActiveModelConfigIdState] = useState('')
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    let cancelled = false

    const hydrate = async () => {
      try {
        const stored = await window.taco.appState.get()
        if (cancelled) return

        let nextConfigs = normalizeModelConfigs(stored.providersState.modelConfigs)
        let nextActiveModelConfigId = resolveActiveModelConfigId(
          stored.providersState.activeModelConfigId,
          nextConfigs,
        )

        if (nextConfigs.length <= 0) {
          const legacyForms = loadJson<ProviderForms>(LEGACY_PROVIDER_KEY, {} as ProviderForms)
          if (hasLegacyProviderState(legacyForms)) {
            nextConfigs = fromLegacyProviderForms(legacyForms)
            nextActiveModelConfigId = resolveActiveModelConfigId(nextActiveModelConfigId, nextConfigs)
            const saved = await window.taco.appState.saveProviders(toPersistPayload(nextConfigs, nextActiveModelConfigId))
            if (cancelled) return
            nextConfigs = normalizeModelConfigs(saved.modelConfigs)
            nextActiveModelConfigId = resolveActiveModelConfigId(saved.activeModelConfigId, nextConfigs)
            localStorage.removeItem(LEGACY_PROVIDER_KEY)
          }
        }

        setModelConfigs(nextConfigs)
        setActiveModelConfigIdState(nextActiveModelConfigId)
      } catch (err) {
        console.error('[app-state] 加载模型配置失败:', err)
      } finally {
        if (!cancelled) setHydrated(true)
      }
    }

    void hydrate()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!hydrated) return
    const payload = toPersistPayload(modelConfigs, activeModelConfigId)
    void window.taco.appState.saveProviders(payload).catch((err) => {
      console.error('[app-state] 保存模型配置失败:', err)
    })
  }, [modelConfigs, activeModelConfigId, hydrated])

  const configuredModels = useMemo(
    () => modelConfigs
      .filter((item) => Boolean(item.apiKey && item.model))
      .map((item) => ({
        id: item.id,
        provider: item.provider,
        label: resolveModelConfigDisplayLabel(item),
      })),
    [modelConfigs],
  )

  useEffect(() => {
    if (modelConfigs.length <= 0) {
      if (activeModelConfigId) setActiveModelConfigIdState('')
      return
    }
    if (!modelConfigs.some((item) => item.id === activeModelConfigId)) {
      setActiveModelConfigIdState(resolveActiveModelConfigId('', modelConfigs))
    }
  }, [modelConfigs, activeModelConfigId])

  const modelConfigMap = useMemo(
    () => new Map(modelConfigs.map((item) => [item.id, item])),
    [modelConfigs],
  )

  function addModelConfig(initial?: Partial<ModelConfig>): string {
    const provider = asProviderId(initial?.provider, 'deepseek')
    const ts = nowTs()
    const id = asText(initial?.id) || `model-${ts}-${Math.random().toString(36).slice(2, 8)}`
    const next: ModelConfig = {
      id,
      provider,
      name: asText(initial?.name) || '',
      baseUrl: asText(initial?.baseUrl),
      apiKey: asText(initial?.apiKey),
      model: asText(initial?.model),
      maxTokens: asText(initial?.maxTokens),
      temperature: asText(initial?.temperature),
      supportsVision: Boolean(initial?.supportsVision),
      createdAt: ts,
      updatedAt: ts,
    }
    setModelConfigs((prev) => [...prev, next])
    if (!activeModelConfigId) setActiveModelConfigIdState(id)
    return id
  }

  function updateModelConfig(id: string, patch: Partial<Omit<ModelConfig, 'id'>>) {
    const targetId = asText(id)
    if (!targetId) return
    setModelConfigs((prev) => prev.map((item) => {
      if (item.id !== targetId) return item
      const nextProvider = patch.provider ? asProviderId(patch.provider, item.provider) : item.provider
      const next: ModelConfig = {
        ...item,
        ...patch,
        provider: nextProvider,
        name: typeof patch.name === 'string' ? patch.name : item.name,
        baseUrl: typeof patch.baseUrl === 'string' ? patch.baseUrl : item.baseUrl,
        apiKey: typeof patch.apiKey === 'string' ? patch.apiKey : item.apiKey,
        model: typeof patch.model === 'string' ? patch.model : item.model,
        maxTokens: typeof patch.maxTokens === 'string' ? patch.maxTokens : item.maxTokens,
        temperature: typeof patch.temperature === 'string' ? patch.temperature : item.temperature,
        supportsVision: typeof patch.supportsVision === 'boolean' ? patch.supportsVision : item.supportsVision,
        updatedAt: nowTs(),
      }
      return next
    }))
  }

  function removeModelConfig(id: string) {
    const targetId = asText(id)
    if (!targetId) return
    setModelConfigs((prev) => prev.filter((item) => item.id !== targetId))
    if (activeModelConfigId === targetId) {
      const remaining = modelConfigs.filter((item) => item.id !== targetId)
      setActiveModelConfigIdState(resolveActiveModelConfigId('', remaining))
    }
  }

  function setActiveModelConfigId(id: string) {
    const next = resolveActiveModelConfigId(id, modelConfigs)
    setActiveModelConfigIdState(next)
  }

  return {
    modelConfigs,
    configuredModels,
    activeModelConfigId,
    setActiveModelConfigId,
    addModelConfig,
    updateModelConfig,
    removeModelConfig,
    getModelConfig: (id: string) => modelConfigMap.get(id),
  }
}
