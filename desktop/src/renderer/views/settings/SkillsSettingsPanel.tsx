import type { SkillInfo, SkillPreview, SkillUpdateInfo } from '../../../shared/ipc'

type SkillsSettingsPanelProps = {
  // URL 安装
  installInput: string
  installing: boolean
  installError: string
  onInstallInputChange: (value: string) => void
  onInstallSkill: () => void
  // 预览
  previewResult: SkillPreview | null
  previewing: boolean
  previewError: string
  onPreviewSkill: () => void
  // 预设
  presetSkills: SkillPreview[]
  installedIds: Set<string>
  onInstallPreset: (presetId: string) => void
  // 已安装 Skills
  skillsLoading: boolean
  skills: SkillInfo[]
  onToggleSkill: (id: string, enabled: boolean) => void
  onUninstallSkill: (id: string) => void
  // 更新检测
  checkingUpdates: Record<string, boolean>
  updateInfo: Record<string, SkillUpdateInfo | null>
  onCheckUpdate: (id: string) => void
}

const CATEGORY_LABELS: Record<string, string> = {
  development: '开发',
  security: '安全',
  testing: '测试',
  documentation: '文档',
  devops: '运维',
  database: '数据库',
  api: 'API',
  automation: '自动化',
}

export function SkillsSettingsPanel({
  installInput,
  installing,
  installError,
  onInstallInputChange,
  onInstallSkill,
  previewResult,
  previewing,
  previewError,
  onPreviewSkill,
  presetSkills,
  installedIds,
  onInstallPreset,
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
      {/* ── 发现 Skills ── */}
      <div className="skills-preset-section">
        <div className="skills-section-title">发现 Skills</div>
        <div className="skills-section-desc">精选社区 Skills，一键安装启用</div>
        <div className="skills-preset-grid">
          {presetSkills.map((preset) => {
            const isInstalled = installedIds.has(preset.id)
            const category = preset.category || 'development'
            return (
              <div key={preset.id} className={`skill-preset-card ${isInstalled ? 'installed' : ''}`}>
                <div className="skill-preset-header">
                  <span className="skill-preset-name">{preset.name}</span>
                  <span className="skill-preset-version">v{preset.version}</span>
                </div>
                <div className="skill-preset-desc">{preset.description}</div>
                <div className="skill-preset-meta">
                  <span className={`skill-preset-category ${category}`}>
                    {CATEGORY_LABELS[category] || category}
                  </span>
                  {preset.tags && preset.tags.length > 0 && (
                    <span className="skill-preset-tags">
                      {preset.tags.map((tag) => (
                        <span key={tag} className="skill-tag">{tag}</span>
                      ))}
                    </span>
                  )}
                </div>
                <div className="skill-preset-footer">
                  <span className="skill-preset-author">作者: {preset.author}</span>
                  <button
                    type="button"
                    className={`skill-preset-install-btn ${isInstalled ? 'installed' : ''}`}
                    onClick={() => onInstallPreset(preset.id)}
                    disabled={isInstalled || installing}
                  >
                    {isInstalled ? '已安装' : '安装'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* ── 从 URL 安装 ── */}
      <div className="skills-install-section">
        <div className="skills-section-title">从 URL 安装</div>
        <div className="skills-section-desc">
          输入 GitHub Skill URL（支持 skill 目录、<code>tree/.../skill-dir</code>、<code>blob/.../SKILL.md</code>）或本地路径
        </div>
        <div className="skills-install-row">
          <input
            className="skills-install-input"
            value={installInput}
            onChange={(e) => onInstallInputChange(e.target.value)}
            placeholder="https://github.com/user/repo/tree/main/path/to/skill"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                if (installInput.trim()) onPreviewSkill()
              }
            }}
            disabled={installing}
          />
          <button
            type="button"
            className="skills-install-preview-btn"
            onClick={onPreviewSkill}
            disabled={previewing || !installInput.trim()}
          >
            {previewing ? '解析中...' : '预览'}
          </button>
          <button
            type="button"
            className="skills-install-btn"
            onClick={onInstallSkill}
            disabled={installing || !installInput.trim()}
          >
            {installing ? '安装中...' : '安装'}
          </button>
        </div>
        {installError && (
          <div className="skills-install-error">{installError}</div>
        )}
        {previewError && (
          <div className="skills-install-error">{previewError}</div>
        )}

        {/* 预览卡片 */}
        {previewResult && (
          <div className="skill-preview-card">
            <div className="skill-preview-header">
              <span className="skill-preview-name">{previewResult.name}</span>
              <span className="skill-preview-version">v{previewResult.version}</span>
            </div>
            <div className="skill-preview-desc">{previewResult.description}</div>
            <div className="skill-preview-meta">
              <span>作者: {previewResult.author}</span>
              {previewResult.category && (
                <span className={`skill-preset-category ${previewResult.category}`}>
                  {CATEGORY_LABELS[previewResult.category] || previewResult.category}
                </span>
              )}
              {previewResult.tags && previewResult.tags.length > 0 && (
                <span className="skill-preset-tags">
                  {previewResult.tags.map((tag) => (
                    <span key={tag} className="skill-tag">{tag}</span>
                  ))}
                </span>
              )}
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
                  安全审核 ({previewResult.security.riskLevel === 'critical' ? '拒绝' : previewResult.security.riskLevel === 'high' ? '高风险' : previewResult.security.riskLevel === 'medium' ? '中风险' : '低风险'}):
                </span>
                <ul className="skill-security-warnings">
                  {previewResult.security.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── 已安装 Skills ── */}
      <div className="skills-list-section">
        <div className="skills-section-title">已安装 Skills ({skills.length})</div>
        {skillsLoading ? (
          <div className="skills-loading">加载中...</div>
        ) : skills.length === 0 ? (
          <div className="skills-empty">暂无已安装的 Skills，从上方 "发现 Skills" 选择一个安装吧</div>
        ) : (
          <div className="skills-list">
            {skills.map((skill) => {
              const update = updateInfo[skill.id]
              const checking = checkingUpdates[skill.id]
              return (
                <div key={skill.id} className={`skill-card ${skill.enabled ? '' : 'disabled'}`}>
                  <div className="skill-card-header">
                    <div className="skill-card-info">
                      <span className="skill-card-name">{skill.name}</span>
                      <span className="skill-card-version">v{skill.version}</span>
                      <span className={`skill-card-source ${skill.source}`}>
                        {skill.source === 'builtin' ? '内置' : skill.source === 'remote' ? '远程' : '本地'}
                      </span>
                    </div>
                    <div className="skill-card-actions">
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
                  <div className="skill-card-desc">{skill.description}</div>
                  <div className="skill-card-meta">
                    <span>作者: {skill.author}</span>
                    {skill.tags && skill.tags.length > 0 && (
                      <span className="skill-card-tags">
                        {skill.tags.map((tag) => (
                          <span key={tag} className="skill-tag">{tag}</span>
                        ))}
                      </span>
                    )}
                  </div>
                  {/* 更新提示 */}
                  {skill.source === 'remote' && skill.sourceUrl && (
                    <div className="skill-card-update">
                      {checking ? (
                        <span className="skill-update-checking">检查更新中...</span>
                      ) : update ? (
                        update.hasUpdate ? (
                          <span className="skill-update-available">
                            有更新: v{update.currentVersion} → v{update.latestVersion}
                          </span>
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
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
