import { useMemo, useCallback } from 'react'

type GeneralSettingsPanelProps = {
  browserDebugMode: boolean
  browserHiddenMode: boolean
  recallDebugEnabled: boolean
  projectRulesDraft: string
  projectRulesFilePath: string
  projectRulesLoading: boolean
  autoApproveCategories: Set<string>
  onBrowserDebugModeChange: (val: boolean) => void
  onBrowserHiddenModeChange: (val: boolean) => void
  onRecallDebugEnabledChange: (val: boolean) => void
  onProjectRulesDraftChange: (val: string) => void
  onProjectRulesChange?: (rules: string) => void
  onOpenLogDir: () => void
  onUpdateAutoApproveCategories: (categories: Set<string>) => void
  /** TTS 自动朗读 */
  autoTtsEnabled: boolean
  onAutoTtsChange: (val: boolean) => void
  /** TTS 语速 (0.5-2.0) */
  ttsRate: number
  onTtsRateChange: (val: number) => void
  /** TTS 音高 (0.5-2.0) */
  ttsPitch: number
  onTtsPitchChange: (val: number) => void
  /** TTS 音色选择 */
  availableVoices: SpeechSynthesisVoice[]
  selectedVoiceUri: string
  onSelectedVoiceChange: (uri: string) => void
}

export function GeneralSettingsPanel({
  browserDebugMode,
  browserHiddenMode,
  recallDebugEnabled,
  projectRulesDraft,
  projectRulesFilePath,
  projectRulesLoading,
  autoApproveCategories,
  onBrowserDebugModeChange,
  onBrowserHiddenModeChange,
  onRecallDebugEnabledChange,
  onProjectRulesDraftChange,
  onProjectRulesChange,
  onOpenLogDir,
  onUpdateAutoApproveCategories,
  autoTtsEnabled,
  onAutoTtsChange,
  ttsRate,
  onTtsRateChange,
  ttsPitch,
  onTtsPitchChange,
  availableVoices,
  selectedVoiceUri,
  onSelectedVoiceChange,
}: GeneralSettingsPanelProps) {
  // 按语言分组 voices
  const voiceGroups = useMemo(() => {
    const groups: Record<string, SpeechSynthesisVoice[]> = {}
    for (const v of availableVoices) {
      const lang = v.lang.split('-')[0] || v.lang || 'other'
      if (!groups[lang]) groups[lang] = []
      groups[lang].push(v)
    }
    return groups
  }, [availableVoices])

  // 试听当前选中音色（使用当前设置的语速和音高）
  const previewVoice = useCallback(() => {
    if (!('speechSynthesis' in window)) return
    const voice = availableVoices.find(v => v.voiceURI === selectedVoiceUri)
    window.speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(
      selectedVoiceUri
        ? voice?.lang?.startsWith('zh') ? '你好，这是语音朗读效果，语速和音高已按当前设置。' : 'Hello, this is a voice sample with the current rate and pitch settings.'
        : '你好'
    )
    u.rate = ttsRate
    u.pitch = ttsPitch
    u.volume = 0.8
    if (voice) u.voice = voice
    window.speechSynthesis.speak(u)
  }, [selectedVoiceUri, availableVoices, ttsRate, ttsPitch])

  const handleAutoApproveChange = (catId: string, checked: boolean, level?: string) => {
    // danger 级别勾选时二次确认
    if (checked && level === 'danger') {
      const confirmed = window.confirm(
        '警告：此操作属于危险级别（可导致不可逆的文件损坏或系统修改）。确定要开启自动授权吗？'
      )
      if (!confirmed) return
    }
    const next = new Set(autoApproveCategories)
    if (checked) next.add(catId)
    else next.delete(catId)
    onUpdateAutoApproveCategories(next)
  }

  return (
    <>
      {/* 项目规则 */}
      <div className="settings-card">
        <div className="settings-card-title">项目规则</div>
        <div className="settings-card-desc">
          此项目根目录下的 <code>{projectRulesFilePath}</code> 文件。AI 每轮对话都会自动读取此文件内容作为项目规则注入上下文。可直接在此编辑内容，点击"保存"写入文件。
        </div>
        <label className="settings-field">
          <span>规则内容</span>
          <textarea
            className="mcp-textarea"
            rows={6}
            value={projectRulesDraft}
            onChange={(e) => onProjectRulesDraftChange(e.target.value)}
            disabled={projectRulesLoading}
            placeholder={projectRulesLoading ? '正在读取文件...' : '例如：\n1. 后端统一使用 snake_case JSON 字段\n2. 禁止引入新的全局状态管理库\n3. 所有新增接口必须补充错误码说明'}
          />
        </label>
        <div className="settings-action-row">
          <div className="settings-action-info">
            <small>提示：项目规则用于"约束执行风格"，不会替代系统安全规则。</small>
          </div>
          <button
            type="button"
            className="settings-action-btn"
            onClick={() => onProjectRulesChange?.(projectRulesDraft.trim())}
            disabled={!onProjectRulesChange || projectRulesLoading}
          >
            保存项目规则
          </button>
        </div>
      </div>

      {/* 语音朗读设置 */}
      <div className="settings-card">
        <div className="settings-card-title">语音朗读</div>
        <div className="settings-card-desc">
          AI 回复消息自动语音朗读。开启后每条 AI 回复完成后自动播放，无需手动点击。
        </div>

        <label className="settings-toggle-row">
          <span className="settings-toggle-label">
            <strong>自动朗读 AI 回复</strong>
            <small>开启后，AI 回复完成时自动语音朗读。</small>
          </span>
          <input type="checkbox" className="settings-toggle" checked={autoTtsEnabled} onChange={(e) => onAutoTtsChange(e.target.checked)} />
        </label>

        <hr className="settings-card-divider" />

        <label className="settings-field">
          <span>朗读音色</span>
          <select
            value={selectedVoiceUri}
            onChange={(e) => onSelectedVoiceChange(e.target.value)}
          >
            <option value="">系统默认</option>
            {Object.keys(voiceGroups).sort().map(lang => (
              <optgroup key={lang} label={lang === 'zh' ? '中文' : lang === 'en' ? 'English' : lang}>
                {voiceGroups[lang].map(v => (
                  <option key={v.voiceURI} value={v.voiceURI}>
                    {v.name} {v.lang?.startsWith('zh') ? '' : `(${v.lang})`}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>

        <hr className="settings-card-divider" />

        <label className="settings-field">
          <span>语速（{ttsRate.toFixed(2)}）</span>
          <div className="settings-slider-row">
            <span className="settings-slider-label">慢</span>
            <input
              type="range"
              min="0.5"
              max="2.0"
              step="0.05"
              value={ttsRate}
              onChange={(e) => onTtsRateChange(parseFloat(e.target.value))}
              className="settings-slider"
            />
            <span className="settings-slider-label">快</span>
          </div>
        </label>

        <label className="settings-field">
          <span>音高（{ttsPitch.toFixed(2)}）</span>
          <div className="settings-slider-row">
            <span className="settings-slider-label">低</span>
            <input
              type="range"
              min="0.5"
              max="2.0"
              step="0.05"
              value={ttsPitch}
              onChange={(e) => onTtsPitchChange(parseFloat(e.target.value))}
              className="settings-slider"
            />
            <span className="settings-slider-label">高</span>
          </div>
        </label>

        <div className="settings-action-row">
          <div className="settings-action-info">
            <small>选择后点击试听按钮可以预览音色效果。</small>
          </div>
          <button type="button" className="settings-action-btn" onClick={previewVoice}>
            试听
          </button>
        </div>
      </div>

      {/* 调试与自动化 */}
      <div className="settings-card">
        <div className="settings-card-title">调试与自动化</div>

        <div className="settings-action-row">
          <div className="settings-action-info">
            <strong>日志目录</strong>
            <small>查看 AI 请求、响应及工具调用的完整日志。</small>
          </div>
          <button type="button" className="settings-action-btn" onClick={onOpenLogDir}>
            打开日志目录
          </button>
        </div>

        <hr className="settings-card-divider" />

        <label className="settings-toggle-row">
          <span className="settings-toggle-label">
            <strong>记忆召回调试日志</strong>
            <small>记录本轮召回候选、分数、入选原因与预算裁剪详情（仅日志可见）。</small>
          </span>
          <input type="checkbox" className="settings-toggle" checked={recallDebugEnabled} onChange={(e) => onRecallDebugEnabledChange(e.target.checked)} />
        </label>

        <label className="settings-toggle-row">
          <span className="settings-toggle-label">
            <strong>浏览器调试模式</strong>
            <small>打开浏览器窗口时自动开启 DevTools 控制台。</small>
          </span>
          <input type="checkbox" className="settings-toggle" checked={browserDebugMode} onChange={(e) => onBrowserDebugModeChange(e.target.checked)} />
        </label>

        <label className="settings-toggle-row">
          <span className="settings-toggle-label">
            <strong>浏览器隐藏窗口</strong>
            <small>AI 打开浏览器时默认隐藏窗口（后台执行）。</small>
          </span>
          <input type="checkbox" className="settings-toggle" checked={browserHiddenMode} onChange={(e) => onBrowserHiddenModeChange(e.target.checked)} />
        </label>
      </div>

      {/* 代理自动授权 */}
      <div className="settings-card">
        <div className="settings-card-title">代理自动授权</div>
        <div className="settings-card-desc">
          勾选的操作类型将在 Agent 模式下自动执行，无需每次手动确认。未勾选的操作仍需用户授权。
        </div>
        {[
          { id: 'package_install', label: '安装依赖', desc: 'npm install, pip install 等包管理器操作', level: 'danger' },
          { id: 'desktop_ops', label: '电脑操作', desc: '鼠标/键盘/输入等电脑使用操作', level: 'warning' },
          { id: 'browser_ops', label: '浏览器操作', desc: 'AI 操控浏览器执行自动化', level: 'warning' },
          { id: 'git_ops', label: 'Git 操作', desc: 'git push, git merge, git rebase 等', level: 'warning' },
          { id: 'git_force', label: 'Git 强制操作', desc: 'git push --force, git reset --hard 等不可逆操作', level: 'danger' },
          { id: 'destructive_cmd', label: '删除/权限操作', desc: 'rm -rf, chmod, chown 等破坏性命令', level: 'danger' },
          { id: 'privilege_cmd', label: '权限提升', desc: 'sudo, su 等需要管理员权限的命令', level: 'danger' },
          { id: 'docker_ops', label: 'Docker 操作', desc: 'docker run, docker build 等容器操作', level: 'warning' },
          { id: 'system_modify', label: '系统修改', desc: 'mkfs, dd 等磁盘级操作', level: 'danger' },
          { id: 'network_script', label: '网络脚本', desc: 'curl | sh 等下载并执行的命令', level: 'danger' },

        ].map((cat) => (
          <label key={cat.id} className="settings-toggle-row">
            <span className="settings-toggle-label">
              <strong>
                <span className={`auto-approve-level ${cat.level}`}>{cat.level === 'danger' ? '危险' : '注意'}</span>
                {cat.label}
              </strong>
              <small>{cat.desc}</small>
            </span>
            <input
              type="checkbox"
              className="settings-toggle"
              checked={autoApproveCategories.has(cat.id)}
              onChange={(e) => handleAutoApproveChange(cat.id, e.target.checked, cat.level)}
            />
          </label>
        ))}
      </div>
    </>
  )
}
