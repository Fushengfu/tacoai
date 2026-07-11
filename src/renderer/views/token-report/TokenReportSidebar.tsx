/**
 * TokenReportSidebar — Token 报表面板（从顶部滑下 overlay）
 *
 * 与设置页面一致：遮罩层 + 从顶部滑下覆盖整个主区域。
 * 外层容器（backdrop + panel）由 App.tsx 提供，本组件只负责面板内容。
 */

import type { ProjectTokenStats } from '../../hooks/useChat'
import TokenReportPanel from './TokenReportPanel'

type TokenReportSidebarProps = {
  onClose: () => void
  projectTokenStats: Record<string, ProjectTokenStats>
  threadTitles: Record<string, string>
  threadModels: Record<string, { model: string; provider: string }>
}

export function TokenReportSidebar({
  onClose,
  projectTokenStats,
  threadTitles,
  threadModels,
}: Readonly<TokenReportSidebarProps>) {
  return (
    <div className="settings-page">
      {/* 面板头部 */}
      <div className="settings-header">
        <div className="settings-title">
          <svg viewBox="0 0 16 16" width="16" height="16" className="settings-title-icon">
            <rect x="2" y="2" width="12" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" opacity="0.7"/>
            <rect x="4.5" y="9" width="1.5" height="3" rx="0.3" fill="currentColor" opacity="0.9"/>
            <rect x="7.25" y="6.5" width="1.5" height="5.5" rx="0.3" fill="currentColor" opacity="0.9"/>
            <rect x="10" y="4" width="1.5" height="8" rx="0.3" fill="currentColor" opacity="0.9"/>
          </svg>
          <span>Token使用报表</span>
        </div>
        <button className="settings-back-btn" type="button" onClick={onClose} title="关闭" aria-label="关闭Token报表">
          <svg viewBox="0 0 16 16" width="16" height="16">
            <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* 面板主体：占满剩余空间 */}
      <TokenReportPanel
        projectTokenStats={projectTokenStats}
        threadTitles={threadTitles}
        threadModels={threadModels}
      />
    </div>
  )
}
