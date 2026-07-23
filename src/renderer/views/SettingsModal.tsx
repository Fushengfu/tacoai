import { useState, useEffect, useCallback } from 'react'
import { PROVIDER_DEFAULT_BASE_URLS } from '../constants'
import { GeneralSettingsPanel } from './settings/GeneralSettingsPanel'

type SettingsPageProps = {
  onClose: () => void
  workspace?: string | null
  projectId?: string
  rewriteModelOptions: { id: string; label: string }[]
}

export function SettingsPage({
  onClose,
  workspace,
  projectId,
  rewriteModelOptions,
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
  // TTS 语音朗读设置
  const [autoTtsEnabled, setAutoTtsEnabled] = useState<boolean>(() =>
    localStorage.getItem('taco-tts-auto') === '1'
  )
  const [selectedVoiceUri, setSelectedVoiceUri] = useState<string>(() =>
    localStorage.getItem('taco-tts-voice') || ''
  )
  const [ttsRate, setTtsRate] = useState<number>(() => {
    const saved = localStorage.getItem('taco-tts-rate')
    return saved ? parseFloat(saved) : 1.0
  })
  const [ttsPitch, setTtsPitch] = useState<number>(() => {
    const saved = localStorage.getItem('taco-tts-pitch')
    return saved ? parseFloat(saved) : 1.0
  })
  const [availableVoices, setAvailableVoices] = useState<SpeechSynthesisVoice[]>(() => {
    if ('speechSynthesis' in window) {
      return window.speechSynthesis.getVoices()
    }
    return []
  })

  // TTS AI 润色设置
  const [ttsRewriteEnabled, setTtsRewriteEnabled] = useState<boolean>(() =>
    localStorage.getItem('taco-tts-rewrite-enabled') === '1'
  )
  const [ttsRewriteModelId, setTtsRewriteModelId] = useState<string>(() =>
    localStorage.getItem('taco-tts-rewrite-model') || ''
  )

  // 监听 voices 变化（首次可能异步加载）
  useEffect(() => {
    if (!('speechSynthesis' in window)) return
    const voices = window.speechSynthesis.getVoices()
    if (voices.length > 0) {
      setAvailableVoices(voices)
    }
    const handler = () => setAvailableVoices(window.speechSynthesis.getVoices())
    window.speechSynthesis.addEventListener('voiceschanged', handler)
    return () => window.speechSynthesis.removeEventListener('voiceschanged', handler)
  }, [])

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
          autoTtsEnabled={autoTtsEnabled}
          onAutoTtsChange={(val) => {
            setAutoTtsEnabled(val)
            localStorage.setItem('taco-tts-auto', val ? '1' : '0')
          }}
          ttsRate={ttsRate}
          onTtsRateChange={(val) => {
            setTtsRate(val)
            localStorage.setItem('taco-tts-rate', String(val))
          }}
          ttsPitch={ttsPitch}
          onTtsPitchChange={(val) => {
            setTtsPitch(val)
            localStorage.setItem('taco-tts-pitch', String(val))
          }}
          availableVoices={availableVoices}
          selectedVoiceUri={selectedVoiceUri}
          onSelectedVoiceChange={(uri) => {
            setSelectedVoiceUri(uri)
            localStorage.setItem('taco-tts-voice', uri)
          }}
          ttsRewriteEnabled={ttsRewriteEnabled}
          onTtsRewriteEnabledChange={(val) => {
            setTtsRewriteEnabled(val)
            localStorage.setItem('taco-tts-rewrite-enabled', val ? '1' : '0')
          }}
          ttsRewriteModelId={ttsRewriteModelId}
          ttsRewriteModelOptions={rewriteModelOptions}
          onTtsRewriteModelIdChange={(id) => {
            setTtsRewriteModelId(id)
            localStorage.setItem('taco-tts-rewrite-model', id)
          }}
        />
      </div>
    </main>
  )
}

export { PROVIDER_DEFAULT_BASE_URLS }
