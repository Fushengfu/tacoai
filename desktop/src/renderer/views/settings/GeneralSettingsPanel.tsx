type GeneralSettingsPanelProps = {
  browserDebugMode: boolean
  browserHiddenMode: boolean
  recallDebugEnabled: boolean
  projectRulesDraft: string
  projectRulesFilePath: string
  projectRulesLoading: boolean
  autoApproveCategories: Set<string>
  stepfunApiKey: string
  stepfunApiKeyRevealed: boolean
  /** ASR 提供商 */
  asrProvider: string
  /** ASR 自定义 API URL */
  asrApiUrl: string
  /** ASR 自定义模型 */
  asrModel: string
  onBrowserDebugModeChange: (val: boolean) => void
  onBrowserHiddenModeChange: (val: boolean) => void
  onRecallDebugEnabledChange: (val: boolean) => void
  onProjectRulesDraftChange: (val: string) => void
  onProjectRulesChange?: (rules: string) => void
  onOpenLogDir: () => void
  onUpdateAutoApproveCategories: (categories: Set<string>) => void
  onStepfunApiKeyChange: (val: string) => void
  onToggleStepfunApiKeyReveal: () => void
  onAsrProviderChange: (val: string) => void
  onAsrApiUrlChange: (val: string) => void
  onAsrModelChange: (val: string) => void
}

/** 可用 ASR 提供商列表 */
const ASR_PROVIDER_OPTIONS: Array<{ id: string; label: string; desc: string }> = [
  { id: 'stepfun', label: 'StepFun', desc: '阶跃星辰 ASR（stepaudio-2.5-asr）' },
  // 后续 Phase 2 按需添加：
  // { id: 'aliyun',  label: '阿里云',  desc: '阿里云一句话识别' },
  // { id: 'tencent', label: '腾讯云',  desc: '腾讯云一句话识别' },
  // { id: 'baidu',   label: '百度',    desc: '百度短语音识别' },
  // { id: 'openai',  label: 'OpenAI',  desc: 'OpenAI Whisper API' },
  // { id: 'custom',  label: '自定义',  desc: '自定义 ASR 接口（URL + 字段映射）' },
]

export function GeneralSettingsPanel({
  browserDebugMode,
  browserHiddenMode,
  recallDebugEnabled,
  projectRulesDraft,
  projectRulesFilePath,
  projectRulesLoading,
  autoApproveCategories,
  stepfunApiKey,
  stepfunApiKeyRevealed,
  asrProvider,
  asrApiUrl,
  asrModel,
  onBrowserDebugModeChange,
  onBrowserHiddenModeChange,
  onRecallDebugEnabledChange,
  onProjectRulesDraftChange,
  onProjectRulesChange,
  onOpenLogDir,
  onUpdateAutoApproveCategories,
  onStepfunApiKeyChange,
  onToggleStepfunApiKeyReveal,
  onAsrProviderChange,
  onAsrApiUrlChange,
  onAsrModelChange,
}: GeneralSettingsPanelProps) {
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

      {/* 语音识别 */}
      <div className="settings-card">
        <div className="settings-card-title">语音识别</div>
        <div className="settings-card-desc">
          选择语音识别服务提供商。当前仅支持 StepFun（stepaudio-2.5-asr，0.15 元/小时），
          后续将支持阿里云、腾讯云、百度、OpenAI Whisper 等平台。
        </div>

        {/* 提供商选择 */}
        <label className="settings-field">
          <span>提供商</span>
          <select
            value={asrProvider}
            onChange={(e) => onAsrProviderChange(e.target.value)}
            className="settings-select"
          >
            {ASR_PROVIDER_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id}>{opt.label} — {opt.desc}</option>
            ))}
          </select>
        </label>

        {/* API Key */}
        <label className="settings-field">
          <span>API Key</span>
          <div className="api-key-row">
            <input
              type={stepfunApiKeyRevealed ? 'text' : 'password'}
              value={stepfunApiKey}
              onChange={(e) => onStepfunApiKeyChange(e.target.value)}
              placeholder="sk-..."
              aria-label="ASR API Key"
            />
            <button
              type="button"
              className="reveal-btn"
              title={stepfunApiKeyRevealed ? '隐藏 API Key' : '显示 API Key'}
              onClick={onToggleStepfunApiKeyReveal}
            >
              {stepfunApiKeyRevealed ? '隐藏' : '显示'}
            </button>
          </div>
        </label>

        {/* 自定义 API URL */}
        <label className="settings-field">
          <span>API 地址（可选）</span>
          <input
            type="text"
            value={asrApiUrl}
            onChange={(e) => onAsrApiUrlChange(e.target.value)}
            placeholder="留空使用默认地址"
            aria-label="ASR API 地址"
          />
          <small className="settings-field-hint">自定义 ASR 接口地址，留空则使用所选提供商的默认地址。</small>
        </label>

        {/* 自定义模型 */}
        <label className="settings-field">
          <span>模型（可选）</span>
          <input
            type="text"
            value={asrModel}
            onChange={(e) => onAsrModelChange(e.target.value)}
            placeholder="留空使用默认模型"
            aria-label="ASR 模型名称"
          />
          <small className="settings-field-hint">自定义模型名称，留空则使用所选提供商的默认模型。</small>
        </label>
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
