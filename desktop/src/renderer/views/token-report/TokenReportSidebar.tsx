/**
 * TokenReportSidebar — Token 报表全屏面板
 *
 * 与目录面板一致：遮罩层 + 顶部栏下方占满整个主区域（宽度100%）。
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
    <>
      {/* 遮罩层 */}
      <div className="wst-backdrop" onClick={onClose} />

      {/* 全屏面板：顶部栏下方占满 */}
      <div className="wst-panel wst-panel-open">
        {/* 面板头部 */}
        <div className="wst-panel-header">
          <div className="wst-panel-title">
            <svg viewBox="0 0 16 16" width="16" height="16" className="wst-panel-title-icon">
              <rect x="2" y="2" width="12" height="12" rx="2" fill="none" stroke="#6b8cff" strokeWidth="1.4"/>
              <rect x="4.5" y="9" width="1.5" height="3" rx="0.3" fill="#6b8cff"/>
              <rect x="7.25" y="6.5" width="1.5" height="5.5" rx="0.3" fill="#6b8cff"/>
              <rect x="10" y="4" width="1.5" height="8" rx="0.3" fill="#6b8cff"/>
            </svg>
            <span className="wst-panel-title-text">Token使用报表</span>
          </div>
          <button className="wst-panel-close" type="button" onClick={onClose} title="关闭" aria-label="关闭Token报表">
            <svg viewBox="0 0 16 16" width="14" height="14">
              <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
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
    </>
  )
}
