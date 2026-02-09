import { useEffect, useMemo, useState } from 'react'
import type { ProviderId, ProviderForm, ProviderForms } from '../types'
import { providers, defaultProviderForms } from '../constants'
import { loadJson, saveJson } from '../lib/storage'

export function useProviderSettings() {
  const [providerForms, setProviderForms] = useState<ProviderForms>(() =>
    loadJson('taco.providers', defaultProviderForms())
  )
  const [activeProvider, setActiveProvider] = useState<ProviderId>('deepseek')

  // 持久化
  useEffect(() => {
    saveJson('taco.providers', providerForms)
  }, [providerForms])

  // 已配置的 provider 列表
  const configuredProviders = useMemo(
    () =>
      providers.filter((p) => {
        const c = providerForms[p.id]
        return Boolean(c?.apiKey && c?.model)
      }),
    [providerForms]
  )

  // 当前 provider 失效时自动切换
  useEffect(() => {
    if (configuredProviders.length === 0) return
    if (!configuredProviders.some((p) => p.id === activeProvider)) {
      setActiveProvider(configuredProviders[0].id)
    }
  }, [configuredProviders, activeProvider])

  /** 更新某个 provider 的某个字段 */
  function updateField(id: ProviderId, field: keyof ProviderForm, value: string) {
    setProviderForms((prev) => ({
      ...prev,
      [id]: { ...prev[id], [field]: value }
    }))
  }

  return {
    providerForms,
    activeProvider,
    setActiveProvider,
    configuredProviders,
    updateField,
  }
}
