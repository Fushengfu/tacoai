import type { McpServerInfo } from '../../../shared/ipc'

type McpSettingsPanelProps = {
  mcpEditing: Partial<McpServerInfo> | null
  mcpSaving: boolean
  mcpLoading: boolean
  mcpServers: McpServerInfo[]
  onMcpEditingChange: (value: Partial<McpServerInfo> | null) => void
  onSaveMcp: () => void
  onToggleMcp: (id: string, enabled: boolean) => void
  onRemoveMcp: (id: string) => void
}

export function McpSettingsPanel({
  mcpEditing,
  mcpSaving,
  mcpLoading,
  mcpServers,
  onMcpEditingChange,
  onSaveMcp,
  onToggleMcp,
  onRemoveMcp,
}: McpSettingsPanelProps) {
  return (
    <div className="mcp-panel">
      <div className="mcp-desc">
        MCP (Model Context Protocol) 让 AI 能够连接外部工具服务，如图片理解、网络搜索等。
      </div>

      {/* 新增/编辑 MCP 服务器表单 */}
      {mcpEditing ? (
        <div className="mcp-form">
          <div className="mcp-form-title">
            {mcpEditing.id ? '编辑 MCP 服务器' : '添加 MCP 服务器'}
          </div>
          <label className="settings-field">
            <span>名称</span>
            <input
              value={mcpEditing.name ?? ''}
              onChange={(e) => onMcpEditingChange({ ...mcpEditing, name: e.target.value })}
              placeholder="如: MiniMax"
            />
          </label>
          <label className="settings-field">
            <span>描述（可选）</span>
            <input
              value={mcpEditing.description ?? ''}
              onChange={(e) => onMcpEditingChange({ ...mcpEditing, description: e.target.value })}
              placeholder="简要描述"
            />
          </label>
          <label className="settings-field">
            <span>启动命令</span>
            <input
              value={mcpEditing.command ?? ''}
              onChange={(e) => onMcpEditingChange({ ...mcpEditing, command: e.target.value })}
              placeholder="如: uvx, npx, node"
            />
          </label>
          <label className="settings-field">
            <span>命令参数（每行一个）</span>
            <textarea
              className="mcp-textarea"
              value={(mcpEditing.args ?? []).join('\n')}
              onChange={(e) => onMcpEditingChange({
                ...mcpEditing,
                args: e.target.value.split('\n').filter(Boolean)
              })}
              placeholder="minimax-coding-plan-mcp&#10;-y"
              rows={3}
            />
          </label>
          <label className="settings-field">
            <span>环境变量（KEY=VALUE，每行一个）</span>
            <textarea
              className="mcp-textarea"
              value={Object.entries(mcpEditing.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n')}
              onChange={(e) => {
                const env: Record<string, string> = {}
                e.target.value.split('\n').forEach((line) => {
                  const idx = line.indexOf('=')
                  if (idx > 0) env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
                })
                onMcpEditingChange({ ...mcpEditing, env })
              }}
              placeholder="MINIMAX_API_KEY=your-api-key&#10;MINIMAX_API_HOST=https://api.minimaxi.com"
              rows={4}
            />
          </label>
          <div className="mcp-form-actions">
            <button
              type="button"
              className="note-form-btn save"
              onClick={onSaveMcp}
              disabled={mcpSaving || !mcpEditing.name?.trim() || !mcpEditing.command?.trim()}
            >
              {mcpSaving ? '保存中...' : '保存并启用'}
            </button>
            <button
              type="button"
              className="note-form-btn cancel"
              onClick={() => onMcpEditingChange(null)}
            >
              取消
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="notes-add-btn"
          onClick={() => onMcpEditingChange({ enabled: true })}
        >
          + 添加 MCP 服务器
        </button>
      )}

      {/* 已安装 MCP 列表 */}
      {mcpLoading ? (
        <div className="notes-loading">加载中...</div>
      ) : mcpServers.length === 0 ? (
        <div className="notes-empty">暂无 MCP 服务器。</div>
      ) : (
        <div className="mcp-list">
          {mcpServers.map((server) => (
            <div key={server.id} className={`mcp-card ${server.status}`}>
              <div className="mcp-card-header">
                <div className="mcp-card-info">
                  <span className="mcp-card-name">
                    {server.name}
                    {server.builtin && <span className="mcp-badge builtin">内置</span>}
                  </span>
                  <span className="mcp-card-meta">
                    <span className={`mcp-status ${server.status}`}>
                      {server.status === 'running' ? '● 运行中' :
                       server.status === 'starting' ? '◌ 启动中...' :
                       server.status === 'error' ? '✕ 错误' : '○ 已停止'}
                    </span>
                    {server.toolCount > 0 && <span className="mcp-tool-count">{server.toolCount} 个工具</span>}
                  </span>
                  {server.description && <span className="mcp-card-desc">{server.description}</span>}
                  {/* 检查是否有未配置的 API Key */}
                  {!server.enabled && server.env && Object.entries(server.env).some(([k, v]) => k.toLowerCase().includes('api_key') && !v) && (
                    <span className="mcp-card-hint">⚠ 请先点击「编辑」配置 API Key，再启用</span>
                  )}
                  {server.error && <span className="mcp-card-error">{server.error}</span>}
                </div>
                <div className="mcp-card-actions">
                  <input
                    type="checkbox"
                    className="settings-toggle"
                    checked={server.enabled}
                    onChange={(e) => onToggleMcp(server.id, e.target.checked)}
                    title={server.enabled ? '禁用' : '启用'}
                  />
                  <button
                    type="button"
                    className="note-card-btn edit"
                    onClick={() => onMcpEditingChange(server)}
                    title="编辑"
                  >
                    编辑
                  </button>
                  {!server.builtin && (
                    <button
                      type="button"
                      className="note-card-btn delete"
                      onClick={() => onRemoveMcp(server.id)}
                      title="删除"
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
