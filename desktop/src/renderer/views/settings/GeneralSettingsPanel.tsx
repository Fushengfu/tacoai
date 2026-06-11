import type { ThemeMode } from '../../types'
import type { AppUpdateCheckResult } from '../../../shared/ipc'

type GeneralSettingsPanelProps = {
  browserAutoTakeover: boolean
  browserDebugMode: boolean
  browserHiddenMode: boolean
  desktopAutoTakeover: boolean
  recallDebugEnabled: boolean
  themeMode: ThemeMode
  projectRulesDraft: string
  cachedUpdateStatus: AppUpdateCheckResult | null
  updateChecking: boolean
  updateCheckSummary: string
  autoApproveCategories: Set<string>
  onBrowserAutoTakeoverChange: (val: boolean) => void
  onBrowserAutoTakeoverSimple: (val: boolean) => void
  onBrowserDebugModeChange: (val: boolean) => void
  onBrowserHiddenModeChange: (val: boolean) => void
  onDesktopAutoTakeoverChange: (val: boolean) => void
  onRecallDebugEnabledChange: (val: boolean) => void
  onThemeModeChange: (mode: ThemeMode) => void
  onProjectRulesDraftChange: (val: string) => void
  onProjectRulesChange?: (rules: string) => void
  onCheckUpdate: () => void
  onOpenLogDir: () => void
  onUpdateAutoApproveCategories: (categories: Set<string>) => void
}

export function GeneralSettingsPanel({
  browserAutoTakeover,
  browserDebugMode,
  browserHiddenMode,
  desktopAutoTakeover,
  recallDebugEnabled,
  themeMode,
  projectRulesDraft,
  cachedUpdateStatus,
  updateChecking,
  updateCheckSummary,
  autoApproveCategories,
  onBrowserAutoTakeoverChange,
  onBrowserAutoTakeoverSimple,
  onBrowserDebugModeChange,
  onBrowserHiddenModeChange,
  onDesktopAutoTakeoverChange,
  onRecallDebugEnabledChange,
  onThemeModeChange,
  onProjectRulesDraftChange,
  onProjectRulesChange,
  onCheckUpdate,
  onOpenLogDir,
  onUpdateAutoApproveCategories,
}: GeneralSettingsPanelProps) {
  const handleAutoApproveChange = (catId: string, checked: boolean) => {
    const next = new Set(autoApproveCategories)
    if (checked) next.add(catId)
    else next.delete(catId)
    onUpdateAutoApproveCategories(next)

    // 浏览器分类同步到独立的浏览器接管设置（仅同步 UI，不再触发重复 IPC）
    if (catId === 'browser_ops') {
      onBrowserAutoTakeoverSimple(checked)
    }
  }

  return (
    <>
      <div className="settings-card" style={{ marginTop: 16 }}>
        <div className="settings-card-title">主题样式</div>
        <div className="settings-grid">
          <label className="settings-field">
            <span>界面主题</span>
            <select
              value={themeMode}
              onChange={(e) => onThemeModeChange(e.target.value as ThemeMode)}
            >
              <option value="dark">深色默认</option>
              <option value="ocean">海蓝</option>
              <option value="graphite">石墨</option>
            </select>
          </label>
        </div>
      </div>

      <div className="settings-card" style={{ marginTop: 16 }}>
        <div className="settings-card-title">项目规则注入</div>
        <div className="settings-card-desc">
          这里填写的规则会在每次请求时自动注入到 system prompt（仅当前项目生效）。
        </div>
        <label className="settings-field">
          <span>规则内容</span>
          <textarea
            className="mcp-textarea"
            rows={6}
            value={projectRulesDraft}
            onChange={(e) => onProjectRulesDraftChange(e.target.value)}
            placeholder="例如：\n1. 后端统一使用 snake_case JSON 字段\n2. 禁止引入新的全局状态管理库\n3. 所有新增接口必须补充错误码说明"
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
            disabled={!onProjectRulesChange}
          >
            保存项目规则
          </button>
        </div>
      </div>

      {/* 系统维护 */}
      <div className="settings-card" style={{ marginTop: 16 }}>
        <div className="settings-card-title">系统维护</div>
        {cachedUpdateStatus?.success && cachedUpdateStatus.hasUpdate && (
          <div className="settings-update-notice">
            <span>
              检测到新版本 v{cachedUpdateStatus.latestVersion || ''}，
              可点击查看并确认是否升级。
            </span>
            <button
              type="button"
              className="settings-update-notice-btn"
              onClick={onCheckUpdate}
              disabled={updateChecking}
            >
              查看更新
            </button>
          </div>
        )}
        <div className="settings-action-row">
          <div className="settings-action-info">
            <strong>版本检查与升级</strong>
            <small>检查前会先调用登录接口获取 token，再请求版本检查接口；发现新版本后可点击下载更新包。</small>
            {updateCheckSummary && <small>{updateCheckSummary}</small>}
          </div>
          <button
            type="button"
            className="settings-action-btn"
            onClick={onCheckUpdate}
            disabled={updateChecking}
          >
            {updateChecking ? '检查中...' : '检查更新'}
          </button>
        </div>
        <div className="settings-action-row">
          <div className="settings-action-info">
            <strong>日志目录</strong>
            <small>查看 AI 请求、响应及工具调用的完整日志记录，用于调试和问题排查。</small>
          </div>
          <button
            type="button"
            className="settings-action-btn"
            onClick={onOpenLogDir}
          >
            打开日志目录
          </button>
        </div>
      </div>

      {/* 调试 */}
      <div className="settings-card" style={{ marginTop: 16 }}>
        <div className="settings-card-title">调试</div>

        <label className="settings-toggle-row">
          <span className="settings-toggle-label">
            <strong>记忆召回调试日志</strong>
            <small>开启后记录本轮召回候选、分数、入选原因与预算裁剪详情（仅日志可见）。</small>
          </span>
          <input
            type="checkbox"
            className="settings-toggle"
            checked={recallDebugEnabled}
            onChange={(e) => onRecallDebugEnabledChange(e.target.checked)}
          />
        </label>
      </div>

      {/* 浏览器自动化 */}
      <div className="settings-card" style={{ marginTop: 16 }}>
        <div className="settings-card-title">浏览器自动化</div>
        <label className="settings-toggle-row">
          <span className="settings-toggle-label">
            <strong>全局接管模式</strong>
            <small>开启后，AI 操作浏览器时不再需要每次确认，全程自动执行。关闭则每次浏览器操作都需要用户确认。</small>
          </span>
          <input
            type="checkbox"
            className="settings-toggle"
            checked={browserAutoTakeover}
            onChange={(e) => onBrowserAutoTakeoverChange(e.target.checked)}
          />
        </label>

        <label className="settings-toggle-row">
          <span className="settings-toggle-label">
            <strong>调试模式</strong>
            <small>开启后，打开浏览器窗口时自动开启 DevTools 控制台，方便调试页面。对已打开的窗口立即生效。</small>
          </span>
          <input
            type="checkbox"
            className="settings-toggle"
            checked={browserDebugMode}
            onChange={(e) => onBrowserDebugModeChange(e.target.checked)}
          />
        </label>

        <label className="settings-toggle-row">
          <span className="settings-toggle-label">
            <strong>隐藏窗口模式</strong>
            <small>开启后，AI 打开浏览器时默认隐藏窗口（后台执行）。关闭后会显示浏览器窗口。</small>
          </span>
          <input
            type="checkbox"
            className="settings-toggle"
            checked={browserHiddenMode}
            onChange={(e) => onBrowserHiddenModeChange(e.target.checked)}
          />
        </label>
      </div>

      {/* 桌面自动化 */}
      <div className="settings-card" style={{ marginTop: 16 }}>
        <div className="settings-card-title">桌面自动化</div>
        <label className="settings-toggle-row">
          <span className="settings-toggle-label">
            <strong>全局接管模式</strong>
            <small>开启后，AI 操作桌面时不再需要每次确认，全程自动执行。关闭则每次桌面操作都需要用户确认。</small>
          </span>
          <input
            type="checkbox"
            className="settings-toggle"
            checked={desktopAutoTakeover}
            onChange={(e) => onDesktopAutoTakeoverChange(e.target.checked)}
          />
        </label>
      </div>

      {/* 代理自动授权设置 */}
      <div className="settings-card" style={{ marginTop: 16 }}>
        <div className="settings-card-title">代理自动授权</div>
        <div className="settings-card-desc">
          勾选的操作类型将在 Agent 模式下自动执行，无需每次手动确认。未勾选的操作仍需用户授权。
        </div>
        {[
          { id: 'package_install', label: '安装依赖', desc: 'npm install, pip install 等包管理器操作', level: 'danger' },
          { id: 'desktop_ops', label: '桌面操作', desc: '鼠标/键盘/输入等桌面自动化操作', level: 'warning' },
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
              onChange={(e) => handleAutoApproveChange(cat.id, e.target.checked)}
            />
          </label>
        ))}
      </div>
    </>
  )
}
