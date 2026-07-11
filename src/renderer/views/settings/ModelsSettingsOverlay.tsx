import { useState, useEffect, useCallback, useMemo } from 'react'
import type { ModelConfig } from '../../types'
import { PROVIDER_DEFAULT_BASE_URLS } from '../../constants'
import { ModelsSettingsPanel } from './ModelsSettingsPanel'

type ModelConfigDraft = Pick<ModelConfig, 'provider' | 'baseUrl' | 'apiKey' | 'model' | 'contextLength' | 'temperature' | 'supportsVision' | 'supportsReasoning'>

function toModelDraft(model: ModelConfig): ModelConfigDraft {
  return {
    provider: model.provider,
    baseUrl: model.baseUrl,
    apiKey: model.apiKey,
    model: model.model,
    contextLength: model.contextLength,
    temperature: model.temperature ?? '',
    supportsVision: Boolean(model.supportsVision),
    supportsReasoning: Boolean(model.supportsReasoning),
  }
}

type ModelsSettingsOverlayProps = {
  onClose: () => void
  modelConfigs: ModelConfig[]
  activeModelConfigId: string
  onSetActiveModelConfigId: (id: string) => void
  onAddModelConfig: (initial?: Partial<ModelConfig>) => string
  onUpdateModelConfig: (id: string, patch: Partial<Omit<ModelConfig, 'id'>>) => void
  onRemoveModelConfig: (id: string) => void
}

export function ModelsSettingsOverlay({
  onClose,
  modelConfigs,
  activeModelConfigId,
  onSetActiveModelConfigId,
  onAddModelConfig,
  onUpdateModelConfig,
  onRemoveModelConfig,
}: Readonly<ModelsSettingsOverlayProps>) {
  const [revealApiKey, setRevealApiKey] = useState<Record<string, boolean>>({})
  const [editingModelId, setEditingModelId] = useState<string | null>(null)
  const [modelDraftForId, setModelDraftForId] = useState('')
  const [modelDraftDirty, setModelDraftDirty] = useState(false)
  const [modelDraft, setModelDraft] = useState<ModelConfigDraft | null>(null)
  const [pendingModelIds, setPendingModelIds] = useState<Set<string>>(new Set())
  const [pendingModelDrafts, setPendingModelDrafts] = useState<Map<string, ModelConfig>>(new Map())

  useEffect(() => {
    if (modelConfigs.length <= 0 && pendingModelDrafts.size === 0) {
      setEditingModelId(null)
      setModelDraft(null)
      setModelDraftForId('')
      setModelDraftDirty(false)
      return
    }

    const hasEditing = editingModelId && (
      modelConfigs.some((item) => item.id === editingModelId)
      || pendingModelDrafts.has(editingModelId)
    )
    if (hasEditing) return

    const active = modelConfigs.find((item) => item.id === activeModelConfigId)
    setEditingModelId(active?.id ?? modelConfigs[0].id)
  }, [activeModelConfigId, editingModelId, modelConfigs, pendingModelDrafts])

  useEffect(() => {
    if (!editingModelId) {
      setModelDraft(null)
      setModelDraftForId('')
      setModelDraftDirty(false)
      return
    }
    const selected = modelConfigs.find((item) => item.id === editingModelId)
      ?? pendingModelDrafts.get(editingModelId)
    if (!selected) return

    if (modelDraftForId !== selected.id || !modelDraftDirty) {
      setModelDraft(toModelDraft(selected))
      setModelDraftForId(selected.id)
      setModelDraftDirty(false)
    }
  }, [editingModelId, modelConfigs, pendingModelDrafts, modelDraftDirty, modelDraftForId])

  const selectedModel = editingModelId
    ? (modelConfigs.find((item) => item.id === editingModelId)
      ?? pendingModelDrafts.get(editingModelId)
      ?? null)
    : null

  const allModelConfigs = useMemo(
    () => [...modelConfigs, ...pendingModelDrafts.values()],
    [modelConfigs, pendingModelDrafts],
  )

  const modelHasChanges = Boolean(
    selectedModel
    && modelDraft
    && (
      selectedModel.provider !== modelDraft.provider
      || selectedModel.baseUrl !== modelDraft.baseUrl
      || selectedModel.apiKey !== modelDraft.apiKey
      || selectedModel.model !== modelDraft.model
      || selectedModel.contextLength !== modelDraft.contextLength
      || (selectedModel.temperature ?? '') !== modelDraft.temperature
      || Boolean(selectedModel.supportsVision) !== Boolean(modelDraft.supportsVision)
      || Boolean(selectedModel.supportsReasoning) !== Boolean(modelDraft.supportsReasoning)
    ),
  )

  const updateDraftField = <K extends keyof ModelConfigDraft>(key: K, value: ModelConfigDraft[K]) => {
    setModelDraft((prev) => {
      if (!prev) return prev
      const next: ModelConfigDraft = { ...prev, [key]: value }
      if (key === 'provider') {
        const newProvider = value as string
        const defaultUrl = PROVIDER_DEFAULT_BASE_URLS[newProvider as keyof typeof PROVIDER_DEFAULT_BASE_URLS]
        if (defaultUrl) next.baseUrl = defaultUrl
      }
      return next
    })
    setModelDraftDirty(true)
  }

  const handleSaveModelDraft = () => {
    if (!selectedModel || !modelDraft) return
    if (pendingModelIds.has(selectedModel.id)) {
      onAddModelConfig({ ...modelDraft, id: selectedModel.id } as Partial<ModelConfig>)
      setPendingModelIds((prev) => {
        const next = new Set(prev)
        next.delete(selectedModel.id)
        return next
      })
      setPendingModelDrafts((prev) => {
        const next = new Map(prev)
        next.delete(selectedModel.id)
        return next
      })
    } else {
      onUpdateModelConfig(selectedModel.id, modelDraft)
    }
    setModelDraftDirty(false)
  }

  const flushModelDraft = useCallback(() => {
    if (!modelDraftDirty || !modelDraftForId || !modelDraft) return false
    onUpdateModelConfig(modelDraftForId, modelDraft)
    setModelDraftDirty(false)
    return true
  }, [modelDraftDirty, modelDraftForId, modelDraft, onUpdateModelConfig])

  const handleSelectModel = useCallback((id: string) => {
    if (!id || id === editingModelId) return
    flushModelDraft()
    const prevId = editingModelId
    if (prevId) {
      setPendingModelIds((prev) => {
        const next = new Set(prev)
        next.delete(prevId)
        return next
      })
      setPendingModelDrafts((prev) => {
        const next = new Map(prev)
        next.delete(prevId)
        return next
      })
    }
    setEditingModelId(id)
  }, [editingModelId, flushModelDraft])

  const handleAddModel = useCallback(() => {
    flushModelDraft()
    const ts = Date.now()
    const id = `pending-${ts}-${Math.random().toString(36).slice(2, 8)}`
    const defaultProvider = 'deepseek'
    const newModel: ModelConfig = {
      id,
      provider: defaultProvider,
      name: '',
      baseUrl: PROVIDER_DEFAULT_BASE_URLS[defaultProvider],
      apiKey: '',
      model: '',
      contextLength: '',
      temperature: '',
      supportsVision: false,
      supportsReasoning: false,
      createdAt: ts,
      updatedAt: ts,
    }
    setPendingModelIds((prev) => new Set(prev).add(id))
    setPendingModelDrafts((prev) => new Map(prev).set(id, newModel))
    setModelDraft(toModelDraft(newModel))
    setModelDraftForId(id)
    setModelDraftDirty(false)
    setEditingModelId(id)
  }, [flushModelDraft])

  const handleRemoveModelWithConfirm = useCallback((id: string, displayName: string) => {
    const targetId = String(id || '').trim()
    if (!targetId) return
    const confirmed = window.confirm(`确认删除模型「${displayName || targetId}」？此操作不可恢复。`)
    if (!confirmed) return

    if (pendingModelIds.has(targetId)) {
      setPendingModelIds((prev) => {
        const next = new Set(prev)
        next.delete(targetId)
        return next
      })
      setPendingModelDrafts((prev) => {
        const next = new Map(prev)
        next.delete(targetId)
        return next
      })
      if (editingModelId === targetId) setEditingModelId(null)
      return
    }

    if (editingModelId === targetId) setEditingModelId(null)
    onRemoveModelConfig(targetId)
  }, [editingModelId, onRemoveModelConfig, pendingModelIds])

  const handleClose = () => {
    flushModelDraft()
    onClose()
  }

  return (
    <main className="settings-page">
      <header className="settings-header">
        <button className="settings-back-btn" type="button" onClick={handleClose} title="返回">
          <svg className="settings-back-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M14.75 6.5L9.25 12L14.75 17.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M10 12H20" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
          </svg>
          <span>返回</span>
        </button>
        <div className="settings-title">模型配置</div>
      </header>
      <div className="settings-body is-models">
        <ModelsSettingsPanel
          modelConfigs={allModelConfigs}
          activeModelConfigId={activeModelConfigId}
          editingModelId={editingModelId}
          selectedModel={selectedModel}
          modelDraft={modelDraft}
          modelHasChanges={modelHasChanges}
          editingIsPending={pendingModelIds.has(editingModelId || '')}
          revealApiKey={revealApiKey}
          onAddModel={handleAddModel}
          onSelectModel={handleSelectModel}
          onRemoveModelWithConfirm={handleRemoveModelWithConfirm}
          onSetActiveModelConfigId={onSetActiveModelConfigId}
          onModelDraftFieldChange={updateDraftField}
          onSaveModelDraft={handleSaveModelDraft}
          onToggleApiKeyReveal={(id: string) => setRevealApiKey((prev) => ({ ...prev, [id]: !(prev[id] ?? false) }))}
        />
      </div>
    </main>
  )
}
