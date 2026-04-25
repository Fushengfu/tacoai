import { useEffect, useRef } from 'react'
import type { ProjectTokenStats } from '../hooks/useChat'

type ChatStatusOverlayProps = {
  open: boolean
  onClose: () => void
  providerLabel?: string
  contextPercent: number
  usedTokens: number
  maxTokens: number
  projectTokenStats?: ProjectTokenStats
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

export function ChatStatusOverlay({
  open,
  onClose,
  providerLabel,
  contextPercent,
  usedTokens,
  maxTokens,
  projectTokenStats,
}: ChatStatusOverlayProps) {
  const panelRef = useRef<HTMLDivElement>(null)

  // 点击外部关闭
  useEffect(() => {
    if (!open) return

    const handleClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose()
      }
    }

    // 延迟绑定避免触发本次打开事件
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClick)
    }, 0)

    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', handleClick)
    }
  }, [open, onClose])

  // Escape 键关闭
  useEffect(() => {
    if (!open) return

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="chat-status-overlay">
      <div className="chat-status-backdrop" />
      <div ref={panelRef} className="chat-status-panel">
        <div className="chat-status-header">
          <span className="chat-status-title">用量</span>
          <button
            type="button"
            className="chat-status-close"
            onClick={onClose}
            aria-label="关闭用量面板"
          >
            ✕
          </button>
        </div>

        <div className="chat-status-body">
          {providerLabel && (
            <div className="chat-status-provider">当前模型: {providerLabel}</div>
          )}

          <div className="context-bar-label" style={{ marginTop: 8 }}>
            <span>上下文 ~{formatTokens(usedTokens)}/{formatTokens(maxTokens)}</span>
            <span>{contextPercent}%</span>
          </div>
          <div className="context-bar-track" style={{ marginBottom: 4 }}>
            <div
              className={`context-bar-fill${contextPercent > 80 ? ' warn' : ''}`}
              style={{ width: `${contextPercent}%` }}
            />
          </div>

          <div className="chat-status-token-stats">
            <div className="chat-status-token-stats-title">项目累计 Token</div>
            <div className="chat-status-token-stats-grid">
              <span>累计输入</span>
              <span>{formatTokens(projectTokenStats?.inputTokens ?? 0)}</span>
              <span>累计输出</span>
              <span>{formatTokens(projectTokenStats?.outputTokens ?? 0)}</span>
              <span>命中</span>
              <span>{formatTokens(projectTokenStats?.hitTokens ?? 0)}</span>
              <span>未命中</span>
              <span>{formatTokens(projectTokenStats?.missTokens ?? 0)}</span>
              <span>总计</span>
              <span>{formatTokens(projectTokenStats?.totalTokens ?? 0)}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
