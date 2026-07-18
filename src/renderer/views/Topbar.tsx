/**
 * 顶部栏组件
 * 职责：渲染应用顶部栏，包含窗口控件、项目标题、功能按钮（主题/终端/桥接/下载/报表）
 */
import { type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react'
import type { ThemeMode } from '../types'
import { WorkspaceTree } from '../components/WorkspaceTree'
import type { WorkspaceTreeHandle } from '../components/WorkspaceTree'

interface UpdateStatus {
  success: boolean
  hasUpdate: boolean
  latestVersion?: string
}

interface TopbarProps {
  showWindowControls: boolean
  hasMacTrafficLights: boolean
  onMouseDown: (e: React.MouseEvent) => void
  didMoveRef: MutableRefObject<boolean>
  sidebarVisible: boolean
  onToggleSidebar: () => void
  activeThreadTitle: string
  updateStatus?: UpdateStatus | null
  updateChecking: boolean
  onOpenUpdateDialog: () => void
  themeMode: ThemeMode
  onToggleTheme: () => void
  messagesCount: number
  onClearChat: () => void
  terminalOpen: boolean
  onToggleTerminal: () => void
  showBridgePanel: boolean
  setShowBridgePanel: Dispatch<SetStateAction<boolean>>
  showMobileDownloadPanel: boolean
  setShowMobileDownloadPanel: Dispatch<SetStateAction<boolean>>
  showWorkspaceTree: boolean
  setShowWorkspaceTree: (v: boolean) => void
  activeOverlay: string | null
  setActiveOverlay: (v: string | null) => void
  currentWorkspace: string
  workspaceTreeRef: RefObject<WorkspaceTreeHandle>
}

export function Topbar({
  showWindowControls,
  hasMacTrafficLights,
  onMouseDown,
  didMoveRef,
  sidebarVisible,
  onToggleSidebar,
  activeThreadTitle,
  updateStatus,
  updateChecking,
  onOpenUpdateDialog,
  themeMode,
  onToggleTheme,
  messagesCount,
  onClearChat,
  terminalOpen,
  onToggleTerminal,
  showBridgePanel,
  setShowBridgePanel,
  showMobileDownloadPanel,
  setShowMobileDownloadPanel,
  showWorkspaceTree,
  setShowWorkspaceTree,
  activeOverlay,
  setActiveOverlay,
  currentWorkspace,
  workspaceTreeRef,
}: TopbarProps) {
  return (
    <header
      className={`topbar app-topbar draggable ${hasMacTrafficLights ? 'has-native-traffic-lights' : ''}`}
      style={{ gridColumn: '1 / 4', gridRow: '1 / 2' }}
      onMouseDown={onMouseDown}
      onDoubleClick={(e) => {
        if (didMoveRef.current) return
        const target = e.target as HTMLElement
        if (target.closest('.no-drag')) return
        globalThis.window.taco.window.toggleMaximize()
      }}
    >
      <div className="app-topbar-left">
        {showWindowControls && (
          <div className="window-controls window-controls-left no-drag">
            <button
              type="button"
              className="window-control-btn"
              onClick={() => globalThis.window.taco.window.close()}
              title="关闭"
              aria-label="关闭"
            >
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
            <button
              type="button"
              className="window-control-btn"
              onClick={() => globalThis.window.taco.window.minimize()}
              title="最小化"
              aria-label="最小化"
            >
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                <path d="M3 8.5h10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
            <button
              type="button"
              className="window-control-btn"
              onClick={() => globalThis.window.taco.window.toggleMaximize()}
              title="最大化/还原"
              aria-label="最大化"
            >
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                <path d="M9 3.5h3.5V7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M12.5 3.5 8.5 7.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <path d="M7 12.5H3.5V9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M3.5 12.5l4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        )}
        <button
          type="button"
          className="sidebar-fixed-toggle no-drag"
          onClick={onToggleSidebar}
          title={sidebarVisible ? '隐藏左侧项目栏' : '显示左侧项目栏'}
          aria-label={sidebarVisible ? '隐藏左侧项目栏' : '显示左侧项目栏'}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <rect x="2.25" y="2.25" width="11.5" height="11.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M6 3.2v9.6" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            {sidebarVisible ? (
              <path d="M8 6.4 6.6 8 8 9.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            ) : (
              <path d="M7.2 6.4 8.6 8 7.2 9.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            )}
          </svg>
        </button>
        <div className="topbar-title app-topbar-title" title={activeThreadTitle}>
          {activeThreadTitle}
        </div>
      </div>

      <div className="topbar-actions app-topbar-right">
        <div className="topbar-main-actions no-drag">
          {updateStatus?.success && updateStatus.hasUpdate && (
            <button
              className="pill update-pill"
              type="button"
              onClick={() => onOpenUpdateDialog()}
              disabled={updateChecking}
              title="点击查看并升级新版本"
            >
              {updateChecking ? '检查更新中...' : `新版本 v${updateStatus.latestVersion || ''}`}
            </button>
          )}
          <button
            className={`pill theme-toggle ${themeMode === 'light' ? 'active' : ''}`}
            type="button"
            onClick={onToggleTheme}
            title={themeMode === 'dark' ? '切换为浅色模式' : '切换为深色模式'}
          >
            {themeMode === 'dark' ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="5" />
                <line x1="12" y1="1" x2="12" y2="3" />
                <line x1="12" y1="21" x2="12" y2="23" />
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                <line x1="1" y1="12" x2="3" y2="12" />
                <line x1="21" y1="12" x2="23" y2="12" />
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
          </button>
          {messagesCount > 0 && (
            <button
              className="pill"
              type="button"
              onClick={() => {
                setShowBridgePanel(false)
                setShowMobileDownloadPanel(false)
                setShowWorkspaceTree(false)
                setActiveOverlay(null)
                onClearChat()
              }}
            >
              清空会话记录
            </button>
          )}
          <button
            className={`pill terminal-toggle ${terminalOpen ? 'active' : ''}`}
            type="button"
            onClick={onToggleTerminal}
            title={terminalOpen ? '关闭终端' : '打开终端'}
          >
            {'>'}_
          </button>
          <button
            className={`pill bridge-toggle ${showBridgePanel ? 'active' : ''}`}
            type="button"
            onClick={() => {
              setShowMobileDownloadPanel(false)
              setShowWorkspaceTree(false)
              setActiveOverlay(null)
              setShowBridgePanel((v) => !v)
            }}
            title="跨端桥接"
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M8 2.5a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 8 2.5Z" fill="currentColor" opacity=".4" />
              <path d="M8 10.5a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 8 10.5Z" fill="currentColor" opacity=".4" />
              <path d="M5 5.5a.75.75 0 0 1 .75-.75h1.5a.75.75 0 0 1 0 1.5h-1.5A.75.75 0 0 1 5 5.5Z" fill="currentColor" opacity=".4" />
              <path d="M11 9.5a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1 0-1.5h1.5a.75.75 0 0 1 .75.75Z" fill="currentColor" opacity=".4" />
              <path d="M3.5 4.25a.75.75 0 0 1 1.06-.06L6.4 5.93a1.41 1.41 0 0 0 2.19-.22l1.21-2.02a.75.75 0 1 1 1.28.76L9.87 6.47a2.91 2.91 0 0 1-4.53.44L3.56 5.31a.75.75 0 0 1-.06-1.06Z" fill="currentColor" />
              <path d="M12.5 11.75a.75.75 0 0 1-1.06.06L9.6 10.07a1.41 1.41 0 0 0-2.19.22l-1.21 2.02a.75.75 0 1 1-1.28-.76L6.13 9.53a2.91 2.91 0 0 1 4.53-.44l1.78 1.6a.75.75 0 0 1 .06 1.06Z" fill="currentColor" />
            </svg>
          </button>
          <button
            className={`pill mobile-download-toggle ${showMobileDownloadPanel ? 'active' : ''}`}
            type="button"
            onClick={() => {
              setShowBridgePanel(false)
              setShowWorkspaceTree(false)
              setActiveOverlay(null)
              setShowMobileDownloadPanel((v) => !v)
            }}
            title="下载手机端"
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <rect x="3.5" y="0.5" width="9" height="13" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
              <circle cx="8" cy="11.5" r="0.9" fill="currentColor" />
              <path d="M6.5 3h3" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
            </svg>
          </button>
          <button
            className={`pill token-report-toggle ${activeOverlay === 'tokenReport' ? 'active' : ''}`}
            type="button"
            onClick={() => {
              setShowBridgePanel(false)
              setShowMobileDownloadPanel(false)
              setShowWorkspaceTree(false)
              setActiveOverlay(activeOverlay === 'tokenReport' ? null : 'tokenReport')
            }}
            title="Token使用报表"
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <rect x="2" y="2" width="12" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <rect x="4.5" y="9" width="1.5" height="3" rx="0.3" fill="currentColor" />
              <rect x="7.25" y="6.5" width="1.5" height="5.5" rx="0.3" fill="currentColor" />
              <rect x="10" y="4" width="1.5" height="8" rx="0.3" fill="currentColor" />
            </svg>
          </button>
          {currentWorkspace && (
            <WorkspaceTree
              ref={workspaceTreeRef}
              workspace={currentWorkspace}
              isOpen={showWorkspaceTree}
              onOpenChange={(open) => {
                if (open) {
                  setShowBridgePanel(false)
                  setShowMobileDownloadPanel(false)
                  setActiveOverlay(null)
                }
                setShowWorkspaceTree(open)
              }}
            />
          )}
        </div>
      </div>
    </header>
  )
}
