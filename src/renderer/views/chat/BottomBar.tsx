import { useRef, useEffect, useState } from 'react'
import type { ProjectTokenStats, RunTokenStats } from '../../hooks/useChat'
import { FlagCN, FlagUS } from '../FlagIcons'
import { formatTokenCount } from './PlanTracker'

/* ------------------------------------------------------------------ */
/*  BottomBar — 底部状态栏（语言 / 工作空间 / Token 统计 / 版本号）       */
/* ------------------------------------------------------------------ */

interface BottomBarProps {
  language: string
  toggleLanguage: () => void
  t: (key: string) => string
  workspace: string
  onSelectWorkspace: (defaultPath?: string) => void
  runTokenStats?: RunTokenStats
  projectTokenStats?: ProjectTokenStats
}

export function BottomBar({
  language,
  toggleLanguage,
  t,
  workspace,
  onSelectWorkspace,
  runTokenStats,
  projectTokenStats,
}: BottomBarProps) {
  const [langDropdownOpen, setLangDropdownOpen] = useState(false)
  const langDropdownRef = useRef<HTMLDivElement>(null)

  // 点击外部关闭
  useEffect(() => {
    if (!langDropdownOpen) return
    const handleClick = (e: MouseEvent) => {
      if (langDropdownRef.current && !langDropdownRef.current.contains(e.target as Node)) {
        setLangDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [langDropdownOpen])

  return (
    <div className="composer-bottom-bar">
      <div className="composer-bottom-left">
        {/* 语言切换下拉框 */}
        <div className="bottom-bar-lang" ref={langDropdownRef}>
          <button
            className="bottom-bar-lang-btn"
            onClick={() => setLangDropdownOpen(!langDropdownOpen)}
            aria-label="切换语言"
            aria-expanded={langDropdownOpen}
          >
            {language === 'zh-CN' ? (
              <FlagCN className="lang-flag-icon" />
            ) : (
              <FlagUS className="lang-flag-icon" />
            )}
            <span>{language === 'zh-CN' ? '中文' : 'English'}</span>
            <svg className="lang-arrow" viewBox="0 0 12 7" aria-hidden="true">
              <path d="M1 1l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          {langDropdownOpen && (
            <div className="bottom-bar-lang-menu">
              <div
                className={`bottom-bar-lang-item${language === 'zh-CN' ? ' active' : ''}`}
                onClick={() => { if (language !== 'zh-CN') toggleLanguage(); setLangDropdownOpen(false) }}
              >
                <FlagCN className="lang-flag-icon" />
                <span>中文</span>
              </div>
              <div
                className={`bottom-bar-lang-item${language === 'en-US' ? ' active' : ''}`}
                onClick={() => { if (language !== 'en-US') toggleLanguage(); setLangDropdownOpen(false) }}
              >
                <FlagUS className="lang-flag-icon" />
                <span>English</span>
              </div>
            </div>
          )}
        </div>

        {/* 项目目录 */}
        <div className="bottom-bar-item workspace-item" onClick={() => onSelectWorkspace(workspace || undefined)} title={workspace ? `点击更换工作空间: ${workspace}` : '选择工作空间'}>
          <svg className="workspace-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3.5 8.5A2.5 2.5 0 0 1 6 6h4l2 2h6A2.5 2.5 0 0 1 20.5 10.5v7A2.5 2.5 0 0 1 18 20H6a2.5 2.5 0 0 1-2.5-2.5z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
          </svg>
          <span>{workspace ? workspace.split('/').pop() || workspace : '选择工作空间'}</span>
        </div>

        {/* Token 统计 */}
        {runTokenStats && (
          <>
            <span className="token-stat-group-label">{t('stats.thisRun')}</span>
            <div className="bottom-bar-token-stats" style={{ marginRight: '6px' }}>
              <span className="token-stat-item" title={`${t('stats.input')} tokens（${t('stats.thisRun')}）`}>
                <span className="token-stat-label">{t('stats.input')}</span>
                {formatTokenCount(runTokenStats.inputTokens)}
              </span>
              <span className="token-stat-item" title={`${t('stats.cacheHit')} tokens（${t('stats.thisRun')}）`}>
                <span className="token-stat-label">{t('stats.cacheHit')}</span>
                {formatTokenCount(runTokenStats.hitTokens)}
              </span>
              <span className="token-stat-item" title={`${t('stats.output')} tokens（${t('stats.thisRun')}）`}>
                <span className="token-stat-label">{t('stats.output')}</span>
                {formatTokenCount(runTokenStats.outputTokens)}
              </span>
            </div>
          </>
        )}
        {projectTokenStats && (projectTokenStats.inputTokens > 0 || projectTokenStats.outputTokens > 0) && (
          <>
            <span className="token-stat-group-label">{t('stats.total')}</span>
            <div className="bottom-bar-token-stats">
              <span className="token-stat-item" title={`${t('stats.input')} tokens`}>
                <span className="token-stat-label">{t('stats.input')}</span>
                {formatTokenCount(projectTokenStats.inputTokens)}
              </span>
              <span className="token-stat-item" title={`${t('stats.output')} tokens`}>
                <span className="token-stat-label">{t('stats.output')}</span>
                {formatTokenCount(projectTokenStats.outputTokens)}
              </span>
              <span className="token-stat-item token-stat-total" title={`${projectTokenStats.turns} ${t('stats.turns')}`}>
                <span className="token-stat-label">{t('stats.turns')}</span>
                {projectTokenStats.turns}
              </span>
            </div>
          </>
        )}
      </div>

      {/* 版本号 */}
      <div className="composer-bottom-right">
        <span className="composer-footer-version">v{window.taco.version}</span>
      </div>
    </div>
  )
}
