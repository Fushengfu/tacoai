import { useState, useEffect, useCallback } from 'react'
import { PROVIDER_DEFAULT_BASE_URLS } from '../constants'
import { GeneralSettingsPanel } from './settings/GeneralSettingsPanel'
import { secureStorage, SecureStorageKey } from '../lib/secure-storage'

type SettingsPageProps = {
  onClose: () => void
  workspace?: string | null
  projectId?: string
}

export function SettingsPage({
  onClose,
  workspace,
  projectId,
}: Readonly<SettingsPageProps>) {
  const [browserDebugMode, setBrowserDebugMode] = useState<boolean>(() =>
    localStorage.getItem('taco.browserDebugMode') === 'true'
  )
  const [browserHiddenMode, setBrowserHiddenMode] = useState<boolean>(() => {
    const saved = localStorage.getItem('taco.browserHiddenMode')
    return saved === null ? true : saved === 'true'
  })
  const [recallDebugEnabled, setRecallDebugEnabled] = useState<boolean>(() =>
    localStorage.getItem('taco.recallDebugEnabled') === 'true'
  )
  const [stepfunApiKey, setStepfunApiKey] = useState('')
  const [stepfunApiKeyRevealed, setStepfunApiKeyRevealed] = useState(false)

  // 自动授权分类
  const [autoApproveCategories, setAutoApproveCategoriesState] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem('taco.autoApproveCategories')
      return saved ? new Set(JSON.parse(saved) as string[]) : new Set()
    } catch { return new Set() }
  })

  const updateAutoApproveCategories = useCallback((next: Set<string>) => {
    setAutoApproveCategoriesState(next)
    const arr = [...next]
    localStorage.setItem('taco.autoApproveCategories', JSON.stringify(arr))
    window.taco.agent.setAutoApprove(arr)
  }, [])

  const [projectRulesDraft, setProjectRulesDraft] = useState('')
  const [projectRulesLoading, setProjectRulesLoading] = useState(false)

  const loadProjectRulesFromFile = useCallback(async (ws: string) => {
    if (!ws) {
      setProjectRulesDraft('')
      return
    }
    setProjectRulesLoading(true)
    try {
      let result = await window.taco.file.read(`${ws}/.taco/rules/rules.md`)
      // 新路径不存在时，尝试从旧路径读取并迁移
      if (result?.size === 0) {
        const oldResult = await window.taco.file.read(`${ws}/.taco/rules.md`)
        if (oldResult && typeof oldResult.content === 'string' && oldResult.content.length > 0) {
          await window.taco.file.write(`${ws}/.taco/rules/rules.md`, oldResult.content)
          result = oldResult
        }
      }
      if (result && typeof result.content === 'string') {
        setProjectRulesDraft(result.content)
        // 文件不存在时自动创建空的规则文件
        if (result.size === 0) {
          window.taco.file.write(`${ws}/.taco/rules/rules.md`, '').catch(() => {})
        }
      } else {
        setProjectRulesDraft('')
      }
    } catch {
      // 新路径不存在 → 尝试旧路径兼容
      try {
        const oldResult = await window.taco.file.read(`${ws}/.taco/rules.md`)
        if (oldResult && typeof oldResult.content === 'string') {
          setProjectRulesDraft(oldResult.content)
          if (oldResult.content.length > 0) {
            window.taco.file.write(`${ws}/.taco/rules/rules.md`, oldResult.content).catch(() => {})
          }
        } else {
          setProjectRulesDraft('')
        }
      } catch {
        setProjectRulesDraft('')
      }
    } finally {
      setProjectRulesLoading(false)
    }
  }, [])

  const handleSaveProjectRules = useCallback(async () => {
    const ws = (workspace ?? '').trim()
    if (!ws) return
    try {
      await window.taco.file.write(`${ws}/.taco/rules/rules.md`, projectRulesDraft)
    } catch (err) {
      console.error('保存项目规则失败:', err)
    }
  }, [workspace, projectRulesDraft])

  useEffect(() => {
    if (workspace) loadProjectRulesFromFile(workspace)
  }, [workspace, loadProjectRulesFromFile])

  // 加载 StepFun ASR API Key
  useEffect(() => {
    secureStorage.get(SecureStorageKey.API_KEY_STEPFUN).then((key) => {
      if (key) setStepfunApiKey(key)
    })
  }, [])

  const handleStepfunApiKeyChange = useCallback((val: string) => {
    setStepfunApiKey(val)
    if (val.trim()) {
      secureStorage.set(SecureStorageKey.API_KEY_STEPFUN, val.trim())
      window.taco.voice.registerApiKey(val.trim())
    } else {
      secureStorage.delete(SecureStorageKey.API_KEY_STEPFUN)
      window.taco.voice.registerApiKey(null)
    }
  }, [])

  return (
    <main className="settings-page">
      <header className="settings-header">
        <button
          className="settings-back-btn"
          type="button"
          onClick={onClose}
          title="返回"
        >
          <svg className="settings-back-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M14.75 6.5L9.25 12L14.75 17.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M10 12H20" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
          </svg>
          <span>返回</span>
        </button>
        <div className="settings-title">设置</div>
      </header>

      <div className="settings-body">
        <GeneralSettingsPanel
          browserDebugMode={browserDebugMode}
          browserHiddenMode={browserHiddenMode}
          recallDebugEnabled={recallDebugEnabled}
          projectRulesDraft={projectRulesDraft}
          projectRulesFilePath=".taco/rules/rules.md"
          projectRulesLoading={projectRulesLoading}
          autoApproveCategories={autoApproveCategories}
          stepfunApiKey={stepfunApiKey}
          stepfunApiKeyRevealed={stepfunApiKeyRevealed}
          onBrowserDebugModeChange={(val) => {
            setBrowserDebugMode(val)
            localStorage.setItem('taco.browserDebugMode', String(val))
            window.taco.browser.setDebugMode(val)
          }}
          onBrowserHiddenModeChange={(val) => {
            setBrowserHiddenMode(val)
            localStorage.setItem('taco.browserHiddenMode', String(val))
            window.taco.browser.setHiddenMode(val)
          }}
          onRecallDebugEnabledChange={(val) => {
            setRecallDebugEnabled(val)
            localStorage.setItem('taco.recallDebugEnabled', String(val))
          }}
          onProjectRulesDraftChange={setProjectRulesDraft}
          onProjectRulesChange={handleSaveProjectRules}
          onOpenLogDir={() => window.taco.shell.openLogDir({ projectId, workspace: workspace || undefined })}
          onUpdateAutoApproveCategories={updateAutoApproveCategories}
          onStepfunApiKeyChange={handleStepfunApiKeyChange}
          onToggleStepfunApiKeyReveal={() => setStepfunApiKeyRevealed((prev) => !prev)}
        />
      </div>
    </main>
  )
}

export { PROVIDER_DEFAULT_BASE_URLS }
