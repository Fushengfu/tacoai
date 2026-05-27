import { useMemo } from 'react'
import type { ModelConfig, ProviderId } from '../types'
import type { GatewayModelItem } from '../../shared/ipc'
import { resolveModelConfigDisplayLabel } from '../constants'

type MergedModelItem =
  | {
      id: string
      provider: ProviderId
      label: string
      source: 'custom'
    }
  | {
      id: string
      provider: ProviderId
      label: string
      source: 'system'
      gatewayModel: GatewayModelItem
    }

type ResolvedModelResult = {
  currentModelConfig: ModelConfig | undefined
  currentProvider: ProviderId | undefined
  activeProviderLabel: string
  mergedModels: MergedModelItem[]
}

/**
 * 解析当前模型配置（优先本地自定义，回退到网关模型）
 * 并合并自定义模型与网关模型列表（去重）
 */
export function useResolvedModel(params: {
  currentModelConfigId: string | undefined
  providerSettings: {
    getModelConfig: (id: string) => ModelConfig | undefined
    configuredModels: Array<{ id: string; provider: ProviderId; label: string }>
    activeModelConfigId: string
  }
  gatewayModels: { models: GatewayModelItem[] | undefined }
  memberToken: string | null
}): ResolvedModelResult {
  const { currentModelConfigId, providerSettings, gatewayModels, memberToken } = params

  // 优先从本地自定义模型查找，找不到则从网关模型查找
  const localModelConfig = providerSettings.getModelConfig(currentModelConfigId || '')
  const gatewayModelMatch = !localModelConfig && currentModelConfigId
    ? (gatewayModels.models ?? []).find((m) => m.id === currentModelConfigId)
    : null

  const currentModelConfig: ModelConfig | undefined = localModelConfig ?? (gatewayModelMatch ? {
    id: gatewayModelMatch.id,
    provider: gatewayModelMatch.provider as ProviderId,
    name: gatewayModelMatch.displayName || gatewayModelMatch.name,
    baseUrl: gatewayModelMatch.baseUrl,
    apiKey: gatewayModelMatch.apiKey,
    model: gatewayModelMatch.model,
    contextLength: String(gatewayModelMatch.contextLength ?? ''),
    temperature: gatewayModelMatch.temperature,
    supportsVision: Boolean(gatewayModelMatch.supportsVision),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } : undefined)

  const currentProvider: ProviderId | undefined = currentModelConfig?.provider
  const activeProviderLabel = currentModelConfig ? resolveModelConfigDisplayLabel(currentModelConfig) : ''

  // Merge custom models with gateway models, marking source
  // 未登录时不展示系统内置模型
  const mergedModels = useMemo(() => {
    const customModels = providerSettings.configuredModels.map((m) => ({
      ...m,
      source: 'custom' as const,
    }))
    const gatewayModelsList = memberToken ? (gatewayModels.models ?? []).map((m) => ({
      id: m.id,
      provider: m.provider as ProviderId,
      label: m.displayName || m.name,
      source: 'system' as const,
      gatewayModel: m,
    })) : []
    // 去重：如果自定义模型和系统模型 id 相同，优先使用自定义模型
    const merged = [...customModels, ...gatewayModelsList]
    const deduped = new Map<string, typeof merged[number]>()
    for (const item of merged) {
      if (!deduped.has(item.id)) {
        deduped.set(item.id, item)
      }
    }
    return [...deduped.values()]
  }, [providerSettings.configuredModels, gatewayModels.models, memberToken])

  return {
    currentModelConfig,
    currentProvider,
    activeProviderLabel,
    mergedModels,
  }
}
