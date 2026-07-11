import { useState, useEffect, useCallback } from 'react'
import type { McpServerInfo } from '../../../shared/ipc'
import { McpSettingsPanel } from './McpSettingsPanel'

type McpSettingsOverlayProps = {
  onClose: () => void
}

export function McpSettingsOverlay({ onClose }: Readonly<McpSettingsOverlayProps>) {
  const [mcpServers, setMcpServers] = useState<McpServerInfo[]>([])
  const [mcpLoading, setMcpLoading] = useState(false)
  const [mcpEditing, setMcpEditing] = useState<Partial<McpServerInfo> | null>(null)
  const [mcpSaving, setMcpSaving] = useState(false)

  const loadMcpServers = useCallback(async () => {
    setMcpLoading(true)
    try {
      const list = await window.taco.mcp.list()
      setMcpServers(list)
    } catch (err) {
      console.error('加载 MCP 服务器失败:', err)
    } finally {
      setMcpLoading(false)
    }
  }, [])

  useEffect(() => { loadMcpServers() }, [loadMcpServers])

  const handleToggleMcp = async (id: string, enabled: boolean) => {
    try {
      await window.taco.mcp.toggle(id, enabled)
      setMcpServers((prev) => prev.map((s) => s.id === id ? { ...s, enabled, status: enabled ? 'starting' : 'stopped' } : s))
      setTimeout(loadMcpServers, 3000)
    } catch (err) {
      console.error('切换 MCP 状态失败:', err)
    }
  }

  const handleRemoveMcp = async (id: string) => {
    try {
      await window.taco.mcp.remove(id)
      setMcpServers((prev) => prev.filter((s) => s.id !== id))
    } catch (err) {
      console.error('删除 MCP 服务器失败:', err)
    }
  }

  const handleSaveMcp = async () => {
    if (!mcpEditing) return
    setMcpSaving(true)
    try {
      const server: McpServerInfo = {
        id: mcpEditing.id || mcpEditing.name?.toLowerCase().replace(/\s+/g, '-') || `mcp-${Date.now()}`,
        name: mcpEditing.name || '',
        description: mcpEditing.description || '',
        command: mcpEditing.command || '',
        args: mcpEditing.args || [],
        env: mcpEditing.env || {},
        enabled: mcpEditing.enabled ?? false,
        builtin: mcpEditing.builtin ?? false,
        status: 'stopped',
        toolCount: 0,
      }
      await window.taco.mcp.save(server)
      setMcpEditing(null)
      await loadMcpServers()
    } catch (err) {
      console.error('保存 MCP 服务器失败:', err)
    } finally {
      setMcpSaving(false)
    }
  }

  return (
    <main className="settings-page">
      <header className="settings-header">
        <button className="settings-back-btn" type="button" onClick={onClose} title="返回">
          <svg className="settings-back-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M14.75 6.5L9.25 12L14.75 17.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M10 12H20" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
          </svg>
          <span>返回</span>
        </button>
        <div className="settings-title">MCP 配置</div>
      </header>
      <div className="settings-body">
        <McpSettingsPanel
          mcpEditing={mcpEditing}
          mcpSaving={mcpSaving}
          mcpLoading={mcpLoading}
          mcpServers={mcpServers}
          onMcpEditingChange={setMcpEditing}
          onSaveMcp={handleSaveMcp}
          onToggleMcp={handleToggleMcp}
          onRemoveMcp={handleRemoveMcp}
        />
      </div>
    </main>
  )
}
