import type { SkillInfo, SkillPreview, SkillUpdateInfo, ClawHubSearchResult } from '../../../shared/ipc'

type SkillsSettingsPanelProps = {
  // 搜索
  searchQuery: string
  onSearchQueryChange: (value: string) => void
  onSearch: () => void
  searching: boolean
  searchResults: ClawHubSearchResult[]
  searchError: string
  // 选中 & 预览
  selectedResult: ClawHubSearchResult | null
  onSelectResult: (result: ClawHubSearchResult) => void
  previewResult: SkillPreview | null
  previewing: boolean
  previewError: string
  // SKILL.md 详细内容
  detailContent: string
  detailLoading: boolean
  // 安装（搜索结果）
  installing: boolean
  installError: string
  installingSlug: string | null
  onInstallFromSearch: () => void
  isInstalled: (slug: string) => boolean
  // 已安装
  skillsLoading: boolean
  skills: SkillInfo[]
  onToggleSkill: (id: string, enabled: boolean) => void
  onUninstallSkill: (id: string) => void
  checkingUpdates: Record<string, boolean>
  updateInfo: Record<string, SkillUpdateInfo | null>
  onCheckUpdate: (id: string) => void
}

function formatDownloads(n: number): string {
  if (n >= 10000) return `${(n / 1000).toFixed(1)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

/** 从搜索结果中提取作者展示名 */
function ownerDisplay(result: ClawHubSearchResult): string {
  return result.owner?.displayName || result.ownerHandle || '未知'
}

const SOURCE_LABEL: Record<string, string> = {
  builtin: '内置',
  remote: '远程',
  local: '本地',
}

export function SkillsSettingsPanel({
  searchQuery,
  onSearchQueryChange,
  onSearch,
  searching,
  searchResults,
  searchError,
  selectedResult,
  onSelectResult,
  previewResult,
  previewing,
  previewError,
  detailContent,
  detailLoading,
  installing,
  installError,
  installingSlug,
  onInstallFromSearch,
  isInstalled,
  skillsLoading,
  skills,
  onToggleSkill,
  onUninstallSkill,
  checkingUpdates,
  updateInfo,
  onCheckUpdate,
}: SkillsSettingsPanelProps) {
  return (
    <div className="skills-panel">
      {/* ── 搜索 ── */}
      <div className="skills-install-section">
        <div className="skills-section-title">发现 Skills</div>
        <div className="skills-section-desc">
          从 ClawHub 技能市场搜索并安装技能（{new Intl.NumberFormat().format(69500)}+ 技能）
        </div>
        <div className="skills-install-row">
          <input
            className="skills-install-input"
            value={searchQuery}
            onChange={(e) => onSearchQueryChange(e.target.value)}
            placeholder="搜索技能，如：web search、git、api doc..."
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                if (searchQuery.trim()) onSearch()
              }
            }}
            disabled={searching}
          />
          <button
            type="button"
            className="skills-install-btn"
            onClick={onSearch}
            disabled={searching || !searchQuery.trim()}
          >
            {searching ? '搜索中...' : '搜索'}
          </button>
        </div>
        {searchError && (
          <div className="skills-install-error">{searchError}</div>
        )}

        {/* 搜索结果网格 */}
        {searchResults.length > 0 && (
          <div className="skills-search-results">
            <div className="skills-search-count">{searchResults.length} 个结果</div>
            <div className="skills-preset-grid">
              {searchResults.map((result) => {
                const installed = isInstalled(result.slug)
                const selected = selectedResult?.slug === result.slug
                return (
                  <div
                    key={result.slug}
                    className={`skill-preset-card ${selected ? 'selected' : ''} ${installed ? 'installed' : ''}`}
                    onClick={() => !installed && onSelectResult(result)}
                  >
                    <div className="skill-preset-header">
                      <span className="skill-preset-name">{result.displayName}</span>
                      <span className="skill-preset-version">{result.version ? `v${result.version}` : ''}</span>
                    </div>
                    <div className="skill-preset-desc">{result.summary}</div>
                    <div className="skill-preset-footer">
                      <span className="skill-preset-author">
                        {ownerDisplay(result)} · ↓{formatDownloads(result.downloads)}
                      </span>
                      {installed ? (
                        <span className="skill-preset-install-btn installed">已安装</span>
                      ) : installingSlug === result.slug ? (
                        <span className="skill-preset-install-btn" style={{ opacity: 0.6, cursor: 'wait' }}>安装中...</span>
                      ) : (
                        <span className="skill-preset-install-btn">
                          {selected ? '已选中' : '查看'}
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* 选中结果的预览 + SKILL.md 详情 */}
        {selectedResult && (
          <div className="skills-selected-section">
            <div className="skills-section-title" style={{ fontSize: 13, marginBottom: 8 }}>
              预览: {selectedResult.displayName}
            </div>
            {previewing ? (
              <div className="skills-selected-loading">加载预览中...</div>
            ) : previewError ? (
              <div className="skills-install-error">{previewError}</div>
            ) : previewResult ? (
              <>
                <div className="skill-preview-card">
                  <div className="skill-preview-header">
                    <span className="skill-preview-name">{previewResult.name}</span>
                    <span className="skill-preview-version">{previewResult.version !== '—' ? `v${previewResult.version}` : ''}</span>
                  </div>
                  <div className="skill-preview-desc">{previewResult.description}</div>
                  <div className="skill-preview-meta">
                    <span>作者: {previewResult.author}</span>
                  </div>
                  {(previewResult.tools && previewResult.tools.length > 0) && (
                    <div className="skill-preview-tools">
                      <span className="skill-preview-label">工具:</span>
                      {previewResult.tools.map((tool) => (
                        <code key={tool} className="skill-tool-chip">{tool}</code>
                      ))}
                    </div>
                  )}
                  {previewResult.security && previewResult.security.warnings.length > 0 && (
                    <div className={`skill-preview-security ${previewResult.security.riskLevel}`}>
                      <span className="skill-preview-label">
                        安全审核 ({previewResult.security.riskLevel === 'critical' ? '致命' : previewResult.security.riskLevel === 'high' ? '高风险' : previewResult.security.riskLevel === 'medium' ? '中风险' : '低风险'}):
                      </span>
                      <ul className="skill-security-warnings">
                        {previewResult.security.warnings.map((w, i) => (
                          <li key={i}>{w}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
                <div className="skills-selected-actions">
                  <button
                    type="button"
                    className="skills-install-btn"
                    onClick={onInstallFromSearch}
                    disabled={installing || previewResult.security?.riskLevel === 'critical'}
                  >
                    {installing && installingSlug === selectedResult.slug ? '安装中...' : previewResult.security?.riskLevel === 'critical' ? '安全风险过高，禁止安装' : '安装'}
                  </button>
                </div>
                {installError && (
                  <div className="skills-install-error">{installError}</div>
                )}

                {/* SKILL.md 原文内容 */}
                <div className="skill-detail-section">
                  <div className="skill-detail-header">
                    <span className="skills-section-title" style={{ fontSize: 13 }}>SKILL.md 原文</span>
                    {detailLoading && <span className="skill-detail-loading">加载中...</span>}
                  </div>
                  {detailContent ? (
                    <pre className="skill-detail-content">
                      <code>{detailContent}</code>
                    </pre>
                  ) : !detailLoading ? (
                    <div className="skill-detail-empty">无法加载 SKILL.md 内容</div>
                  ) : null}
                </div>
              </>
            ) : null}
          </div>
        )}
      </div>

      {/* ── 已安装 Skills（卡片网格） ── */}
      <div className="skills-install-section">
        <div className="skills-section-title">已安装 Skills ({skills.length})</div>
        {skillsLoading ? (
          <div className="skills-loading">加载中...</div>
        ) : skills.length === 0 ? (
          <div className="skills-empty">暂无已安装的 Skills，从上方搜索一个安装吧</div>
        ) : (
          <div className="skills-installed-grid">
            {skills.map((skill) => {
              const update = updateInfo[skill.id]
              const checking = checkingUpdates[skill.id]
              return (
                <div key={skill.id} className={`skill-installed-card ${skill.enabled ? '' : 'disabled'}`}>
                  <div className="skill-installed-header">
                    <span className="skill-installed-name">{skill.name}</span>
                    <div className="skill-installed-badges">
                      <span className="skill-installed-version">v{skill.version}</span>
                      <span className={`skill-installed-source ${skill.source}`}>
                        {SOURCE_LABEL[skill.source] || skill.source}
                      </span>
                    </div>
                  </div>
                  <div className="skill-installed-desc">{skill.description}</div>
                  <div className="skill-installed-footer">
                    <div className="skill-installed-author">作者: {skill.author}</div>
                    <div className="skill-installed-actions">
                      {/* 更新检测（远程技能） */}
                      {skill.source === 'remote' && skill.sourceUrl && (
                        <div className="skill-installed-update">
                          {checking ? (
                            <span className="skill-update-checking">检查中...</span>
                          ) : update ? (
                            update.hasUpdate ? (
                              <span className="skill-update-available">v{update.currentVersion} → v{update.latestVersion}</span>
                            ) : (
                              <span className="skill-update-uptodate">已是最新</span>
                            )
                          ) : (
                            <button
                              type="button"
                              className="skill-update-check-btn"
                              onClick={(e) => { e.stopPropagation(); onCheckUpdate(skill.id) }}
                            >
                              检查更新
                            </button>
                          )}
                        </div>
                      )}
                      <label className="skill-toggle" title={skill.enabled ? '点击禁用' : '点击启用'}>
                        <input
                          type="checkbox"
                          checked={skill.enabled}
                          onChange={(e) => onToggleSkill(skill.id, e.target.checked)}
                        />
                        <span className="skill-toggle-slider" />
                      </label>
                      {skill.source !== 'builtin' && (
                        <button
                          type="button"
                          className="skill-uninstall-btn"
                          onClick={(e) => { e.stopPropagation(); onUninstallSkill(skill.id) }}
                          title="卸载"
                        >
                          x
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
