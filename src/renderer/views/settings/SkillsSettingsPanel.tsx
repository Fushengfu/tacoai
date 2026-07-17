import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { SkillInfo, SkillPreview, SkillUpdateInfo, SkillSearchResult } from '../../../shared/ipc'

/**
 * 提取代码块纯文本（Markdown 代码块中 code children 可能是数组或字符串）
 */
function extractCodeText(children: React.ReactNode): string {
  if (typeof children === 'string') return children
  if (typeof children === 'number') return String(children)
  if (Array.isArray(children)) return children.map((c) => (typeof c === 'string' ? c : '')).join('')
  return ''
}

type SkillsSettingsPanelProps = {
  // 搜索
  searchQuery: string
  onSearchQueryChange: (value: string) => void
  onSearch: (categoryId?: string) => void
  searching: boolean
  searchResults: SkillSearchResult[]
  searchError: string
  // 搜索源
  searchSource: 'clawhub' | 'skillhub' | 'all'
  onSearchSourceChange: (source: 'clawhub' | 'skillhub' | 'all') => void
  searchSources: { id: string; label: string }[]
  // 分类
  categories: { id: string; label: string }[]
  selectedCategory: string
  onSelectCategory: (id: string) => void
  // 选中 & 预览
  selectedResult: SkillSearchResult | null
  onSelectResult: (result: SkillSearchResult) => void
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
  // 已安装技能详情
  selectedInstalledSkillId: string | null
  installedSkillDetailContent: string
  installedSkillDetailLoading: boolean
  onSelectInstalledSkill: (id: string) => void
  // 关闭侧边弹窗
  onCloseSidePanel: () => void
  // 清空搜索
  onClearSearch: () => void
}

function formatDownloads(n: number): string {
  if (n >= 10000) return `${(n / 1000).toFixed(1)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

const SOURCE_LABEL: Record<string, string> = {
  builtin: '内置',
  remote: '第三方',
}

const SKILL_SOURCE_BADGE: Record<string, { label: string; className: string }> = {
  clawhub: { label: 'ClawHub', className: 'source-clawhub' },
  skillhub: { label: 'SkillHub', className: 'source-skillhub' },
}

export function SkillsSettingsPanel({
  searchQuery,
  onSearchQueryChange,
  onSearch,
  searching,
  searchResults,
  searchError,
  searchSource,
  onSearchSourceChange,
  searchSources,
  categories,
  selectedCategory,
  onSelectCategory,
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
  selectedInstalledSkillId,
  installedSkillDetailContent,
  installedSkillDetailLoading,
  onSelectInstalledSkill,
  onCloseSidePanel,
  onClearSearch,
}: SkillsSettingsPanelProps) {
  const [activeTab, setActiveTab] = useState<'discover' | 'installed'>('discover')

  const selectedInstalledSkill = selectedInstalledSkillId
    ? skills.find((s) => s.id === selectedInstalledSkillId) ?? null
    : null

  return (
    <div className="skills-panel">
      {/* ── Tab 切换栏 ── */}
      <div className="skills-tabs">
        <button
          type="button"
          className={`skills-tab ${activeTab === 'discover' ? 'active' : ''}`}
          onClick={() => setActiveTab('discover')}
        >
          🔍 发现 Skills
        </button>
        <button
          type="button"
          className={`skills-tab ${activeTab === 'installed' ? 'active' : ''}`}
          onClick={() => setActiveTab('installed')}
        >
          📦 已安装 Skills ({skills.length})
        </button>
      </div>

      {/* ── "发现 Skills" Tab ── */}
      {activeTab === 'discover' && (
        <div className="skills-tab-panel">
          <div className="skills-section-desc" style={{ marginBottom: 12 }}>
            从 ClawHub 和腾讯 SkillHub 技能市场搜索并安装技能（148K+ 技能）
          </div>
          <div className="skills-install-row">
            <div className="skills-install-input-wrap">
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
              {searchQuery && (
                <button
                  type="button"
                  className="skills-install-input-clear"
                  onClick={onClearSearch}
                  title="清空"
                  disabled={searching}
                >
                  ×
                </button>
              )}
            </div>
            <button
              type="button"
              className="skills-install-btn"
              onClick={() => onSearch()}
              disabled={searching || !searchQuery.trim()}
            >
              {searching ? '搜索中...' : '搜索'}
            </button>
          </div>

          {/* 搜索源选择 */}
          <div className="skills-source-selector">
            {searchSources.map((src) => (
              <button
                key={src.id}
                type="button"
                className={`skill-source-tag ${searchSource === src.id ? 'active' : ''}`}
                onClick={() => onSearchSourceChange(src.id as 'clawhub' | 'skillhub' | 'all')}
              >
                {src.label}
              </button>
            ))}
          </div>

          {searchError && (
            <div className="skills-install-error">{searchError}</div>
          )}

          {/* 分类标签 */}
          <div className="skills-category-tags">
            {categories.map((cat) => (
              <button
                key={cat.id}
                type="button"
                className={`skill-category-tag ${selectedCategory === cat.id ? 'active' : ''}`}
                onClick={() => onSelectCategory(cat.id)}
              >
                {cat.label}
              </button>
            ))}
          </div>

          {/* 搜索结果网格 */}
          {searchResults.length > 0 && (
            <div className="skills-search-results">
              <div className="skills-search-count">{searchResults.length} 个结果</div>
              <div className="skills-preset-grid">
                {searchResults.map((result) => {
                  const installed = isInstalled(result.slug)
                  const selected = selectedResult?.slug === result.slug
                  const srcBadge = SKILL_SOURCE_BADGE[result.source]
                  return (
                    <div
                      key={`${result.source}-${result.slug}`}
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
                          {result.authorName} · ↓{formatDownloads(result.downloads)}
                          {srcBadge && (
                            <span className={`skill-preset-source ${srcBadge.className}`}>{srcBadge.label}</span>
                          )}
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


        </div>
      )}

      {/* ── "已安装 Skills" Tab ── */}
      {activeTab === 'installed' && (
        <div className="skills-tab-panel">
          <div className="skills-section-desc" style={{ marginBottom: 12 }}>
            点击卡片查看 SKILL.md 详情
          </div>
          {skillsLoading ? (
            <div className="skills-loading">加载中...</div>
          ) : skills.length === 0 ? (
            <div className="skills-empty">暂无已安装的 Skills，前往"发现 Skills"搜索并安装吧</div>
          ) : (
            <>
              <div className="skills-installed-grid">
                {skills.map((skill) => {
                  const update = updateInfo[skill.id]
                  const checking = checkingUpdates[skill.id]
                  const isSelected = selectedInstalledSkillId === skill.id
                  return (
                    <div
                      key={skill.id}
                      className={`skill-installed-card ${skill.enabled ? '' : 'disabled'} ${isSelected ? 'selected' : ''}`}
                      onClick={() => onSelectInstalledSkill(skill.id)}
                    >
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
                        <div className="skill-installed-actions" onClick={(e) => e.stopPropagation()}>
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
                                  onClick={() => onCheckUpdate(skill.id)}
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
                              onClick={() => onUninstallSkill(skill.id)}
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


            </>
          )}
        </div>
      )}

      {/* ── 侧边详情弹窗 ── */}
      {(selectedResult || selectedInstalledSkill) && (
        <div
          className="skills-side-panel-backdrop"
          onClick={onCloseSidePanel}
        >
          <div
            className="skills-side-panel"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="skills-side-panel-close"
              onClick={onCloseSidePanel}
              title="关闭"
            >
              ×
            </button>

            <div className="skills-side-panel-content">
              {/* ── 来自搜索结果的详情 ── */}
              {selectedResult && (
                <>
                  <div className="skills-side-panel-title">
                    {selectedResult.displayName}
                    {SKILL_SOURCE_BADGE[selectedResult.source] && (
                      <span className={`skill-preset-source ${SKILL_SOURCE_BADGE[selectedResult.source].className}`} style={{ marginLeft: 8 }}>
                        {SKILL_SOURCE_BADGE[selectedResult.source].label}
                      </span>
                    )}
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
                    </>
                  ) : null}

                  {/* SKILL.md — 来自搜索结果 */}
                  <div className="skill-detail-section">
                    <div className="skill-detail-header">
                      <span className="skills-section-title" style={{ fontSize: 13 }}>SKILL.md 原文</span>
                      {detailLoading && <span className="skill-detail-loading">加载中...</span>}
                    </div>
                    {detailContent ? (
                      <div className="skill-detail-markdown">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            pre({ children }) { return <>{children}</> },
                            code({ className, children, ...rest }) {
                              const rawCode = extractCodeText(children)
                              const isBlock = (className && /language-/.test(className)) || (!className && rawCode.includes('\n'))
                              if (isBlock) {
                                const lang = className ? className.replace('language-', '') : ''
                                return (
                                  <div className="skill-md-code-block">
                                    {lang && <div className="skill-md-code-lang">{lang}</div>}
                                    <pre><code className={className}>{rawCode}</code></pre>
                                  </div>
                                )
                              }
                              return <code className="skill-md-inline-code" {...rest}>{children}</code>
                            },
                            a({ href, children, ...rest }) {
                              return (
                                <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
                                  {children}
                                </a>
                              )
                            },
                          }}
                        >
                          {detailContent}
                        </ReactMarkdown>
                      </div>
                    ) : !detailLoading ? (
                      <div className="skill-detail-empty">无法加载 SKILL.md 内容</div>
                    ) : null}
                  </div>
                </>
              )}

              {/* ── 来自已安装技能的详情 ── */}
              {selectedInstalledSkill && !selectedResult && (
                <>
                  <div className="skills-side-panel-title">
                    {selectedInstalledSkill.name}
                    <span className={`skill-installed-source ${selectedInstalledSkill.source}`} style={{ marginLeft: 8 }}>
                      {SOURCE_LABEL[selectedInstalledSkill.source] || selectedInstalledSkill.source}
                    </span>
                    <span className="skill-installed-version" style={{ marginLeft: 6, fontSize: 12 }}>v{selectedInstalledSkill.version}</span>
                  </div>

                  <div className="skill-preview-card">
                    <div className="skill-preview-desc">{selectedInstalledSkill.description}</div>
                    <div className="skill-preview-meta">
                      <span>作者: {selectedInstalledSkill.author}</span>
                      {selectedInstalledSkill.sourceUrl && (
                        <span>来源: {selectedInstalledSkill.sourceUrl}</span>
                      )}
                    </div>
                    <div className="skills-selected-actions">
                      <label className="skill-toggle" title={selectedInstalledSkill.enabled ? '点击禁用' : '点击启用'}>
                        <input
                          type="checkbox"
                          checked={selectedInstalledSkill.enabled}
                          onChange={(e) => onToggleSkill(selectedInstalledSkill.id, e.target.checked)}
                        />
                        <span className="skill-toggle-slider" />
                      </label>
                      <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                        {selectedInstalledSkill.enabled ? '已启用' : '已禁用'}
                      </span>
                    </div>
                  </div>

                  {/* SKILL.md — 来自已安装技能 */}
                  <div className="skill-detail-section">
                    <div className="skill-detail-header">
                      <span className="skills-section-title" style={{ fontSize: 13 }}>SKILL.md 原文</span>
                      {installedSkillDetailLoading && <span className="skill-detail-loading">加载中...</span>}
                    </div>
                    {installedSkillDetailContent ? (
                      <div className="skill-detail-markdown">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            pre({ children }) { return <>{children}</> },
                            code({ className, children, ...rest }) {
                              const rawCode = extractCodeText(children)
                              const isBlock = (className && /language-/.test(className)) || (!className && rawCode.includes('\n'))
                              if (isBlock) {
                                const lang = className ? className.replace('language-', '') : ''
                                return (
                                  <div className="skill-md-code-block">
                                    {lang && <div className="skill-md-code-lang">{lang}</div>}
                                    <pre><code className={className}>{rawCode}</code></pre>
                                  </div>
                                )
                              }
                              return <code className="skill-md-inline-code" {...rest}>{children}</code>
                            },
                            a({ href, children, ...rest }) {
                              return (
                                <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
                                  {children}
                                </a>
                              )
                            },
                          }}
                        >
                          {installedSkillDetailContent}
                        </ReactMarkdown>
                      </div>
                    ) : !installedSkillDetailLoading ? (
                      <div className="skill-detail-empty">无法加载 SKILL.md 内容</div>
                    ) : null}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
