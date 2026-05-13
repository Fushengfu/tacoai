import type { GuiPlusForm } from '../../types'

type GuiPlusSettingsPanelProps = {
  guiPlusForm: GuiPlusForm
  onUpdateGuiPlusField: <K extends keyof GuiPlusForm>(key: K, value: GuiPlusForm[K]) => void
  revealGuiPlusKey: boolean
  onToggleGuiPlusKey: () => void
}

export function GuiPlusSettingsPanel({
  guiPlusForm,
  onUpdateGuiPlusField,
  revealGuiPlusKey,
  onToggleGuiPlusKey,
}: Readonly<GuiPlusSettingsPanelProps>) {
  return (
    <div className="gui-plus-panel">
      <div className="mcp-desc">
        GUI-Plus 用于桌面截图识别与结构化视觉理解，不参与聊天模型选择。
      </div>
      <div className="settings-card">
        <div className="settings-card-title">GUI-Plus（桌面识别工具）</div>
        <div className="settings-grid">
          <label className="settings-field">
            <span>Base URL</span>
            <input
              value={guiPlusForm.baseUrl}
              onChange={(e) => onUpdateGuiPlusField('baseUrl', e.target.value)}
              placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"
            />
          </label>
          <label className="settings-field">
            <span>API Key</span>
            <div className="api-key-row">
              <input
                type={revealGuiPlusKey ? 'text' : 'password'}
                value={guiPlusForm.apiKey}
                onChange={(e) => onUpdateGuiPlusField('apiKey', e.target.value)}
                placeholder="sk-..."
                aria-label="GUI-Plus API Key"
              />
              <button
                type="button"
                className="reveal-btn"
                title={revealGuiPlusKey ? '隐藏 API Key' : '显示 API Key'}
                onClick={onToggleGuiPlusKey}
              >
                {revealGuiPlusKey ? '隐藏' : '显示'}
              </button>
            </div>
          </label>
          <label className="settings-field">
            <span>Model</span>
            <input
              value={guiPlusForm.model}
              onChange={(e) => onUpdateGuiPlusField('model', e.target.value)}
              placeholder="gui-plus"
            />
          </label>
          <label className="settings-field">
            <span>Min Pixels</span>
            <input
              type="number"
              value={guiPlusForm.minPixels}
              onChange={(e) => onUpdateGuiPlusField('minPixels', e.target.value)}
              placeholder="3136"
            />
          </label>
          <label className="settings-field">
            <span>Max Pixels</span>
            <input
              type="number"
              value={guiPlusForm.maxPixels}
              onChange={(e) => onUpdateGuiPlusField('maxPixels', e.target.value)}
              placeholder="1003520"
            />
          </label>
          <label className="settings-field">
            <span>高清图像模式</span>
            <div className="settings-toggle-row">
              <span className="settings-toggle-label">
                <strong>{guiPlusForm.highResolution ? '已开启' : '已关闭'}</strong>
                <small>开启后截图会按更高分辨率发送给 GUI-Plus，细节更清晰，但请求更慢、消耗更多 token。</small>
              </span>
              <input
                className="settings-toggle"
                type="checkbox"
                checked={guiPlusForm.highResolution}
                onChange={(e) => onUpdateGuiPlusField('highResolution', e.target.checked)}
              />
            </div>
          </label>
          <label className="settings-field">
            <span>返回 Token 用量</span>
            <div className="settings-toggle-row">
              <span className="settings-toggle-label">
                <strong>{guiPlusForm.includeUsage ? '已开启' : '已关闭'}</strong>
                <small>开启后会在响应中包含 token 用量统计（输入/输出/总量），便于在面板中做消耗追踪。</small>
              </span>
              <input
                className="settings-toggle"
                type="checkbox"
                checked={guiPlusForm.includeUsage}
                onChange={(e) => onUpdateGuiPlusField('includeUsage', e.target.checked)}
              />
            </div>
          </label>
        </div>
      </div>
    </div>
  )
}
