import { useEffect, useMemo, useRef, useState } from 'react'
import type { GuiPlusForm } from '../types'
import type { GuiPlusConfig } from '../../shared/ipc'

const DEFAULT_FORM: GuiPlusForm = {
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKey: '',
  model: 'gui-plus',
  minPixels: '',
  maxPixels: '',
  highResolution: false,
  includeUsage: false,
}

function fromConfig(config: GuiPlusConfig): GuiPlusForm {
  return {
    baseUrl: config.baseUrl ?? DEFAULT_FORM.baseUrl,
    apiKey: config.apiKey ?? '',
    model: config.model ?? DEFAULT_FORM.model,
    minPixels: config.minPixels !== undefined ? String(config.minPixels) : '',
    maxPixels: config.maxPixels !== undefined ? String(config.maxPixels) : '',
    highResolution: Boolean(config.highResolution),
    includeUsage: Boolean(config.includeUsage),
  }
}

function toConfig(form: GuiPlusForm): GuiPlusConfig {
  const minPixels = form.minPixels.trim()
  const maxPixels = form.maxPixels.trim()
  return {
    baseUrl: form.baseUrl.trim(),
    apiKey: form.apiKey.trim(),
    model: form.model.trim(),
    minPixels: minPixels ? Number(minPixels) : undefined,
    maxPixels: maxPixels ? Number(maxPixels) : undefined,
    highResolution: form.highResolution,
    includeUsage: form.includeUsage,
  }
}

export function useGuiPlusSettings() {
  const [form, setForm] = useState<GuiPlusForm>(DEFAULT_FORM)
  const initialized = useRef(false)

  useEffect(() => {
    let cancelled = false
    window.taco.guiPlus.getConfig()
      .then((config) => {
        if (cancelled) return
        setForm(fromConfig(config))
        initialized.current = true
      })
      .catch(() => {
        initialized.current = true
      })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!initialized.current) return
    window.taco.guiPlus.saveConfig(toConfig(form))
  }, [form])

  const updateField = useMemo(() => {
    return <K extends keyof GuiPlusForm>(key: K, value: GuiPlusForm[K]) => {
      setForm((prev) => ({ ...prev, [key]: value }))
    }
  }, [])

  return {
    guiPlusForm: form,
    updateGuiPlusField: updateField,
  }
}
