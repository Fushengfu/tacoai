import type { ModelConfig } from '../../types'
import { providers } from '../../constants'

type ModelsSettingsPanelProps = {
  modelConfigs: ModelConfig[]
  activeModelConfigId: string
  editingModelId: string | null
  selectedModel: ModelConfig | null
  modelDraft: Partial<ModelConfig> | null
  modelHasChanges: boolean
  revealApiKey: Record<string, boolean>
  onAddModel: () => void
  onSelectModel: (id: string) => void
  onRemoveModelWithConfirm: (id: string, title: string) => void
  onSetActiveModelConfigId: (id: string) => void
  onModelDraftFieldChange: <K extends keyof Partial<ModelConfig>>(key: K, value: Partial<ModelConfig>[K]) => void
  onSaveModelDraft: () => void
  onToggleApiKeyReveal: (id: string) => void
}

export function ModelsSettingsPanel({
  modelConfigs,
  activeModelConfigId,
  editingModelId,
  selectedModel,
  modelDraft,
  modelHasChanges,
  revealApiKey,
  onAddModel,
  onSelectModel,
  onRemoveModelWithConfirm,
  onSetActiveModelConfigId,
  onModelDraftFieldChange,
  onSaveModelDraft,
  onToggleApiKeyReveal,
}: ModelsSettingsPanelProps) {
  return (
    <>
      <div className="settings-models-add-wrap">
        <button
          type="button"
          className="notes-add-btn settings-models-add-btn"
          onClick={onAddModel}
        >
          + 添加模型
        </button>
      </div>

      {modelConfigs.length <= 0 ? (
        <div className="settings-card">
          <div className="settings-card-desc">暂无模型配置，点击上方"添加模型"开始。</div>
        </div>
      ) : (
        <div className="settings-models-layout">
          <div className="settings-models-list-wrap">
            <div className="settings-models-list">
              {modelConfigs.map((item) => {
                const isSelected = editingModelId === item.id
                const providerLabel = providers.find((p) => p.id === item.provider)?.label ?? item.provider
                const cardTitle = item.model.trim() || `${providerLabel} 模型`
                return (
                  <div
                    key={item.id}
                    className={`settings-model-card ${isSelected ? 'active' : ''}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => onSelectModel(item.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onSelectModel(item.id)
                      }
                    }}
                  >
                    <div className="settings-model-card-top">
                      <div className="settings-model-card-title">{cardTitle}</div>
                      <div className="settings-model-card-top-actions">
                        {activeModelConfigId === item.id && (
                          <span className="settings-model-badge">默认</span>
                        )}
                        <button
                          type="button"
                          className="settings-model-card-delete"
                          onClick={(e) => {
                            e.stopPropagation()
                            onRemoveModelWithConfirm(item.id, cardTitle)
                          }}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                    <div className="settings-model-card-meta-row">
                      <span className="settings-model-card-meta">{providerLabel}</span>
                      <span className={`settings-model-mini-tag ${item.apiKey.trim() ? 'ok' : ''}`}>
                        {item.apiKey.trim() ? 'API Key 已配置' : '缺少 API Key'}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          <div className="settings-card settings-models-editor">
            {selectedModel && modelDraft ? (
              <>
                <div className="settings-action-row">
                  <div className="settings-action-info">
                    <strong>编辑模型：{selectedModel.model.trim() || selectedModel.id}</strong>
                    <small>{selectedModel.id}</small>
                  </div>
                  <div className="settings-model-editor-actions">
                    <button
                      type="button"
                      className="settings-action-btn"
                      disabled={activeModelConfigId === selectedModel.id}
                      onClick={() => onSetActiveModelConfigId(selectedModel.id)}
                    >
                      {activeModelConfigId === selectedModel.id ? '默认模型' : '设为默认'}
                    </button>
                  </div>
                </div>
                <div className="settings-grid settings-model-editor-grid">
                  <label className="settings-field">
                    <span>Provider</span>
                    <select
                      value={modelDraft.provider}
                      onChange={(e) => onModelDraftFieldChange('provider', e.target.value as ModelConfig['provider'])}
                    >
                      {providers.map((provider) => (
                        <option key={provider.id} value={provider.id}>{provider.label}</option>
                      ))}
                    </select>
                  </label>
                  <label className="settings-field">
                    <span>Base URL</span>
                    <input
                      value={modelDraft.baseUrl}
                      onChange={(e) => onModelDraftFieldChange('baseUrl', e.target.value)}
                      placeholder="https://api.example.com/v1"
                    />
                  </label>
                  <label className="settings-field">
                    <span>API Key</span>
                    <div className="api-key-row">
                      <input
                        type={revealApiKey[selectedModel.id] ? 'text' : 'password'}
                        value={modelDraft.apiKey}
                        onChange={(e) => onModelDraftFieldChange('apiKey', e.target.value)}
                        placeholder="sk-..."
                        aria-label={`${selectedModel.id} API Key`}
                      />
                      <button
                        type="button"
                        className="reveal-btn"
                        title={revealApiKey[selectedModel.id] ? '隐藏 API Key' : '显示 API Key'}
                        onClick={() => onToggleApiKeyReveal(selectedModel.id)}
                      >
                        {revealApiKey[selectedModel.id] ? '隐藏' : '显示'}
                      </button>
                    </div>
                  </label>
                  <label className="settings-field">
                    <span>Model</span>
                    <input
                      value={modelDraft.model}
                      onChange={(e) => onModelDraftFieldChange('model', e.target.value)}
                      placeholder="填写官方模型 ID（以控制台为准）"
                    />
                  </label>
                  <label className="settings-field">
                    <span>上下文长度</span>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={modelDraft.contextLength}
                      onChange={(e) => onModelDraftFieldChange('contextLength', e.target.value)}
                      placeholder="131072（示例）"
                    />
                  </label>
                  <label className="settings-field">
                    <span>Temperature（可选）</span>
                    <input
                      type="number"
                      min={0}
                      max={2}
                      step={0.1}
                      value={modelDraft.temperature}
                      onChange={(e) => onModelDraftFieldChange('temperature', e.target.value)}
                      placeholder="留空则使用默认值"
                    />
                  </label>
                  <label className="settings-field">
                    <span>视觉理解能力</span>
                    <div className="settings-toggle-row">
                      <span className="settings-toggle-label">
                        <strong>{modelDraft.supportsVision ? '支持视觉理解' : '不支持视觉理解'}</strong>
                        <small>
                          启用后，系统提示词会允许模型直接理解用户图片，不再强制要求必须通过 MCP 图片分析。
                        </small>
                      </span>
                      <input
                        type="checkbox"
                        className="settings-toggle"
                        checked={Boolean(modelDraft.supportsVision)}
                        onChange={(e) => onModelDraftFieldChange('supportsVision', e.target.checked)}
                      />
                    </div>
                  </label>
                </div>
                <div className="settings-action-row">
                  <div className="settings-action-info">
                    <strong>{modelHasChanges ? '有未保存修改' : '已保存'}</strong>
                    <small>点击保存后，配置会立即写入本地。</small>
                  </div>
                  <button
                    type="button"
                    className="settings-action-btn"
                    disabled={!modelHasChanges}
                    onClick={onSaveModelDraft}
                  >
                    保存模型配置
                  </button>
                </div>
              </>
            ) : (
              <div className="settings-card-desc">请选择左侧模型后进行编辑。</div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
