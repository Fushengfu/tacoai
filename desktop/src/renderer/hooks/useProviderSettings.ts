import { useEffect, useMemo, useState } from 'react'
import type { AppStateProvidersPayload } from '../../shared/ipc'
import type { ProviderId, ProviderForm, ProviderForms } from '../types'
import { providers, defaultProviderForms, resolveProviderDisplayLabel } from '../constants'
import { loadJson } from '../lib/storage'

const LEGACY_PROVIDER_KEY = 'taco.providers'

function mergeProviderForms(saved?: Partial<ProviderForms>): ProviderForms {
  const defaults = defaultProviderForms()
  return {
    deepseek: { ...defaults.deepseek, ...(saved?.deepseek ?? {}) },
    kimi: { ...defaults.kimi, ...(saved?.kimi ?? {}) },
    minimax: { ...defaults.minimax, ...(saved?.minimax ?? {}) },
    glm: { ...defaults.glm, ...(saved?.glm ?? {}) },
  }
}

function hasProviderState(forms: ProviderForms): boolean {
  return providers.some((provider) => {
    const form = forms[provider.id]
    return Boolean(form.baseUrl || form.apiKey || form.model || form.maxTokens)
  })
}

function sanitizeActiveProvider(
  provider: ProviderId,
  providerForms: ProviderForms,
): ProviderId {
  if (providers.some((item) => item.id === provider)) return provider
  const configured = providers.find((item) => {
    const form = providerForms[item.id]
    return Boolean(form.apiKey && form.model)
  })
  return configured?.id ?? 'deepseek'
}

export function useProviderSettings() {
  const [providerForms, setProviderForms] = useState<ProviderForms>(() => defaultProviderForms())
  const [activeProvider, setActiveProviderState] = useState<ProviderId>('deepseek')
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    let cancelled = false

    const hydrate = async () => {
      try {
        const stored = await window.taco.appState.get()
        if (cancelled) return

        let nextForms = mergeProviderForms(stored.providersState.providerForms as Partial<ProviderForms>)
        let nextActiveProvider = sanitizeActiveProvider(
          stored.providersState.activeProvider as ProviderId,
          nextForms,
        )

        if (!hasProviderState(nextForms)) {
          const legacyForms = mergeProviderForms(loadJson<Partial<ProviderForms>>(LEGACY_PROVIDER_KEY, {}))
          if (hasProviderState(legacyForms)) {
            nextForms = legacyForms
            nextActiveProvider = sanitizeActiveProvider(nextActiveProvider, nextForms)
            const saved = await window.taco.appState.saveProviders({
              providerForms: nextForms as AppStateProvidersPayload['providerForms'],
              activeProvider: nextActiveProvider,
            })
            if (cancelled) return
            nextForms = mergeProviderForms(saved.providerForms as Partial<ProviderForms>)
            nextActiveProvider = sanitizeActiveProvider(saved.activeProvider as ProviderId, nextForms)
            localStorage.removeItem(LEGACY_PROVIDER_KEY)
          }
        }

        setProviderForms(nextForms)
        setActiveProviderState(nextActiveProvider)
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
    void window.taco.appState.saveProviders({
      providerForms: providerForms as AppStateProvidersPayload['providerForms'],
      activeProvider,
    }).catch((err) => {
      console.error('[app-state] 保存模型配置失败:', err)
    })
  }, [providerForms, activeProvider, hydrated])

  const configuredProviders = useMemo(() => (
    providers
      .filter((p) => {
        const c = providerForms[p.id]
        return Boolean(c?.apiKey && c?.model)
      })
      .map((p) => ({
        ...p,
        label: resolveProviderDisplayLabel(p.id, providerForms[p.id]),
      }))
  ), [providerForms])

  useEffect(() => {
    if (configuredProviders.length === 0) return
    if (!configuredProviders.some((p) => p.id === activeProvider)) {
      setActiveProviderState(configuredProviders[0].id)
    }
  }, [configuredProviders, activeProvider])

  function updateField(id: ProviderId, field: keyof ProviderForm, value: string) {
    setProviderForms((prev) => ({
      ...prev,
      [id]: { ...prev[id], [field]: value },
    }))
  }

  function setActiveProvider(id: ProviderId) {
    setActiveProviderState(id)
  }

  return {
    providerForms,
    activeProvider,
    setActiveProvider,
    configuredProviders,
    updateField,
  }
}
