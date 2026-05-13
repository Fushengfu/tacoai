import type { SkillInfo } from '../../../shared/ipc'

type SkillsSettingsPanelProps = {
  installInput: string
  installing: boolean
  installError: string
  skillsLoading: boolean
  skills: SkillInfo[]
  onInstallInputChange: (value: string) => void
  onInstallSkill: () => void
  onToggleSkill: (id: string, enabled: boolean) => void
  onUninstallSkill: (id: string) => void
}

export function SkillsSettingsPanel({
  installInput,
  installing,
  installError,
  skillsLoading,
  skills,
  onInstallInputChange,
  onInstallSkill,
  onToggleSkill,
  onUninstallSkill,
}: SkillsSettingsPanelProps) {
  return (
    <div className="skills-panel">
      {/* 安装第三方 Skill */}
      <div className="skills-install-section">
        <div className="skills-install-title">安装第三方 Skill</div>
        <div className="skills-install-desc">
          输入 GitHub URL 或本地路径（支持 skill 目录、`tree/.../skill-dir`、`blob/.../SKILL.md`）
        </div>
        <div className="skills-install-row">
          <input
            className="skills-install-input"
            value={installInput}
            onChange={(e) => onInstallInputChange(e.target.value)}
            placeholder="https://github.com/user/repo/tree/main/path/to/skill"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) onInstallSkill()
            }}
            disabled={installing}
          />
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
      </div>

      {/* Skills 列表 */}
      <div className="skills-list-title">已安装 Skills ({skills.length})</div>
      {skillsLoading ? (
        <div className="skills-loading">加载中...</div>
      ) : skills.length === 0 ? (
        <div className="skills-empty">暂无已安装的 Skills</div>
      ) : (
        <div className="skills-list">
          {skills.map((skill) => (
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
                      ✕
                    </button>
                  )}
                </div>
              </div>
              <div className="skill-card-desc">{skill.description}</div>
              <div className="skill-card-meta">
                <span>作者: {skill.author}</span>
                {skill.sourceUrl && (
                  <span className="skill-card-url" title={skill.sourceUrl}>
                    来源: {skill.sourceUrl.replace(/^https?:\/\//, '').slice(0, 40)}...
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
