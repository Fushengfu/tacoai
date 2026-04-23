import { useState, useEffect, useCallback } from 'react'
import QRCode from 'qrcode'
import type { GuiPlusForm, ModelConfig, ThemeMode } from '../types'
import type { SkillInfo, ProjectNote, ProjectTaskMemory, NoteCategory, McpServerInfo, MobileBridgeConfig, MemoryScopeStats, AppUpdateCheckResult } from '../../shared/ipc'
import { providers } from '../constants'
import {
  loadUploadSettings,
  normalizeUploadSettingsState,
  saveUploadSettings,
  type UploadSettingsState,
} from '../lib/upload-config'

const NOTE_CATEGORIES: { value: NoteCategory; label: string }[] = [
  { value: 'convention', label: '代码规范' },
  { value: 'credential', label: '凭证/账号' },
  { value: 'architecture', label: '架构设计' },
  { value: 'config', label: '配置信息' },
  { value: 'other', label: '其他' },
]

const DEFAULT_MOBILE_BRIDGE_CONFIG: MobileBridgeConfig = {
  enabled: false,
  port: 18400,
  token: 'taco-mobile',
}

type SettingsPageProps = {
  modelConfigs: ModelConfig[]
  activeModelConfigId: string
  onSetActiveModelConfigId: (id: string) => void
  onAddModelConfig: () => string
  onUpdateModelConfig: (id: string, patch: Partial<Omit<ModelConfig, 'id'>>) => void
  onRemoveModelConfig: (id: string) => void
  guiPlusForm: GuiPlusForm
  onUpdateGuiPlusField: <K extends keyof GuiPlusForm>(key: K, value: GuiPlusForm[K]) => void
  themeMode: ThemeMode
  onThemeModeChange: (mode: ThemeMode) => void
  projectRules?: string
  onProjectRulesChange?: (rules: string) => void
  onClose: () => void
  workspace?: string | null
  projectId?: string
}

type SettingsTab = 'general' | 'models' | 'gui_plus' | 'skills' | 'notes' | 'mcp'
type ModelConfigDraft = Pick<ModelConfig, 'provider' | 'baseUrl' | 'apiKey' | 'model' | 'maxTokens' | 'temperature' | 'supportsVision'>

function toModelDraft(model: ModelConfig): ModelConfigDraft {
  return {
    provider: model.provider,
    baseUrl: model.baseUrl,
    apiKey: model.apiKey,
    model: model.model,
    maxTokens: model.maxTokens,
    temperature: model.temperature ?? '',
    supportsVision: Boolean(model.supportsVision),
  }
}

export function SettingsPage({
  modelConfigs,
  activeModelConfigId,
  onSetActiveModelConfigId,
  onAddModelConfig,
  onUpdateModelConfig,
  onRemoveModelConfig,
  guiPlusForm,
  onUpdateGuiPlusField,
  themeMode,
  onThemeModeChange,
  projectRules,
  onProjectRulesChange,
  onClose,
  workspace,
  projectId,
}: Readonly<SettingsPageProps>) {
  const [tab, setTab] = useState<SettingsTab>('general')
  const [revealApiKey, setRevealApiKey] = useState<Record<string, boolean>>({})
  const [editingModelId, setEditingModelId] = useState<string | null>(null)
  const [modelDraftForId, setModelDraftForId] = useState('')
  const [modelDraftDirty, setModelDraftDirty] = useState(false)
  const [modelDraft, setModelDraft] = useState<ModelConfigDraft | null>(null)
  const [revealGuiPlusKey, setRevealGuiPlusKey] = useState(false)
  const [uploadDraft, setUploadDraft] = useState<UploadSettingsState>(() => loadUploadSettings())
  const [uploadSaved, setUploadSaved] = useState<UploadSettingsState>(() => loadUploadSettings())
  const [revealUploadSecrets, setRevealUploadSecrets] = useState<Record<string, boolean>>({})

  // Skills 状态
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [installInput, setInstallInput] = useState('')
  const [installing, setInstalling] = useState(false)
  const [installError, setInstallError] = useState('')

  // Notes 状态
  const [notes, setNotes] = useState<ProjectNote[]>([])
  const [notesLoading, setNotesLoading] = useState(false)
  const [editingNote, setEditingNote] = useState<Partial<ProjectNote> | null>(null)
  const [noteSaving, setNoteSaving] = useState(false)
  const [expandedNoteIds, setExpandedNoteIds] = useState<Set<string>>(new Set())
  const [taskMemories, setTaskMemories] = useState<ProjectTaskMemory[]>([])
  const [taskMemoriesLoading, setTaskMemoriesLoading] = useState(false)
  const [expandedTaskMemoryIds, setExpandedTaskMemoryIds] = useState<Set<string>>(new Set())
  const [memoryStats, setMemoryStats] = useState<MemoryScopeStats | null>(null)
  const [memoryStatsLoading, setMemoryStatsLoading] = useState(false)
  const [memoryExporting, setMemoryExporting] = useState(false)
  const [memoryExportPath, setMemoryExportPath] = useState('')

  // 通用设置
  const [browserAutoTakeover, setBrowserAutoTakeover] = useState<boolean>(() =>
    localStorage.getItem('taco.browserAutoTakeover') === 'true'
  )
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
  const [updateChecking, setUpdateChecking] = useState(false)
  const [updateCheckSummary, setUpdateCheckSummary] = useState('')
  const [cachedUpdateStatus, setCachedUpdateStatus] = useState<AppUpdateCheckResult | null>(null)

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

  // MCP 状态
  const [mcpServers, setMcpServers] = useState<McpServerInfo[]>([])
  const [mcpLoading, setMcpLoading] = useState(false)
  const [mcpEditing, setMcpEditing] = useState<Partial<McpServerInfo> | null>(null)
  const [mcpSaving, setMcpSaving] = useState(false)
  const [mobileBridge, setMobileBridge] = useState<MobileBridgeConfig>(DEFAULT_MOBILE_BRIDGE_CONFIG)
  const [mobileBridgeSaving, setMobileBridgeSaving] = useState(false)
  const [mobileBridgeConnectHost, setMobileBridgeConnectHost] = useState(() =>
    localStorage.getItem('taco.mobileBridgeConnectHost') ?? ''
  )
  const [mobileBridgeQrDataUrl, setMobileBridgeQrDataUrl] = useState('')
  const [mobileBridgeQrPayload, setMobileBridgeQrPayload] = useState('')
  const [projectRulesDraft, setProjectRulesDraft] = useState(projectRules ?? '')

  useEffect(() => {
    setProjectRulesDraft(projectRules ?? '')
  }, [projectRules])

  useEffect(() => {
    if (modelConfigs.length <= 0) {
      setEditingModelId(null)
      setModelDraft(null)
      setModelDraftForId('')
      setModelDraftDirty(false)
      return
    }

    const hasEditing = editingModelId && modelConfigs.some((item) => item.id === editingModelId)
    if (hasEditing) return

    const active = modelConfigs.find((item) => item.id === activeModelConfigId)
    setEditingModelId(active?.id ?? modelConfigs[0].id)
  }, [activeModelConfigId, editingModelId, modelConfigs])

  useEffect(() => {
    if (!editingModelId) {
      setModelDraft(null)
      setModelDraftForId('')
      setModelDraftDirty(false)
      return
    }
    const selected = modelConfigs.find((item) => item.id === editingModelId)
    if (!selected) return

    if (modelDraftForId !== selected.id || !modelDraftDirty) {
      setModelDraft(toModelDraft(selected))
      setModelDraftForId(selected.id)
      setModelDraftDirty(false)
    }
  }, [editingModelId, modelConfigs, modelDraftDirty, modelDraftForId])

  const notesWorkspace = (workspace ?? '').trim()
  const notesProjectId = (projectId ?? '').trim()
  const hasNotesScope = Boolean(notesWorkspace || notesProjectId)

  useEffect(() => {
    let cancelled = false
    window.taco.mobileBridge.getConfig()
      .then((cfg) => {
        if (!cancelled) setMobileBridge(cfg)
      })
      .catch((err) => {
        console.error('加载移动端桥接配置失败:', err)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const host = mobileBridgeConnectHost.trim()
    const token = mobileBridge.token.trim() || DEFAULT_MOBILE_BRIDGE_CONFIG.token
    if (!host || !mobileBridge.enabled) {
      setMobileBridgeQrDataUrl('')
      setMobileBridgeQrPayload('')
      return () => {
        cancelled = true
      }
    }

    const payload = `taco-mobile://bridge/connect?host=${encodeURIComponent(host)}&port=${mobileBridge.port}&token=${encodeURIComponent(token)}`
    setMobileBridgeQrPayload(payload)

    QRCode.toDataURL(payload, {
      margin: 1,
      width: 220,
      color: {
        dark: '#EAF0FF',
        light: '#00000000',
      },
    }).then((dataUrl: string) => {
      if (!cancelled) setMobileBridgeQrDataUrl(dataUrl)
    }).catch((err: unknown) => {
      console.error('生成移动端连接二维码失败:', err)
      if (!cancelled) setMobileBridgeQrDataUrl('')
    })

    return () => {
      cancelled = true
    }
  }, [mobileBridge.enabled, mobileBridge.port, mobileBridge.token, mobileBridgeConnectHost])

  const saveMobileBridge = useCallback(async (next: MobileBridgeConfig) => {
    setMobileBridgeSaving(true)
    try {
      const safePort = Number.isFinite(next.port) ? Math.max(1, Math.min(65535, Math.round(next.port))) : DEFAULT_MOBILE_BRIDGE_CONFIG.port
      const safeConfig: MobileBridgeConfig = {
        enabled: Boolean(next.enabled),
        port: safePort,
        token: next.token.trim() || DEFAULT_MOBILE_BRIDGE_CONFIG.token,
      }
      const saved = await window.taco.mobileBridge.setConfig(safeConfig)
      setMobileBridge(saved)
    } catch (err) {
      console.error('保存移动端桥接配置失败:', err)
    } finally {
      setMobileBridgeSaving(false)
    }
  }, [])

  const loadSkills = useCallback(async () => {
    setSkillsLoading(true)
    try {
      const list = await window.taco.skills.list(workspace ?? undefined)
      setSkills(list)
    } catch (err) {
      console.error('加载 Skills 失败:', err)
    } finally {
      setSkillsLoading(false)
    }
  }, [workspace])

  useEffect(() => {
    if (tab === 'skills') loadSkills()
  }, [tab, loadSkills])

  const handleToggleSkill = async (id: string, enabled: boolean) => {
    try {
      await window.taco.skills.toggle(id, enabled)
      setSkills((prev) => prev.map((s) => s.id === id ? { ...s, enabled } : s))
    } catch (err) {
      console.error('切换 Skill 状态失败:', err)
    }
  }

  const handleUninstallSkill = async (id: string) => {
    try {
      await window.taco.skills.uninstall(id)
      setSkills((prev) => prev.filter((s) => s.id !== id))
    } catch (err) {
      console.error('卸载 Skill 失败:', err)
    }
  }

  const handleCheckUpdate = async () => {
    setUpdateChecking(true)
    try {
      const result: AppUpdateCheckResult = await window.taco.updater.check(true)
      setCachedUpdateStatus(result)
      if (!result.success) {
        setUpdateCheckSummary(`检查失败：${result.message || '未知错误'}`)
        return
      }
      if (result.hasUpdate) {
        const downloadText = result.downloadTriggered ? '，已开始下载' : ''
        setUpdateCheckSummary(`发现新版本 v${result.latestVersion || ''}${downloadText}`)
      } else {
        setUpdateCheckSummary('当前已是最新版本')
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setUpdateCheckSummary(`检查失败：${message}`)
    } finally {
      setUpdateChecking(false)
    }
  }

  useEffect(() => {
    if (tab !== 'general') return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let retries = 0

    const pullStatus = async () => {
      try {
        const status = await window.taco.updater.getStatus()
        if (cancelled) return
        setCachedUpdateStatus(status)

        // 启动检查是异步触发，首次可能还没结果，短暂重试拉取
        if (!status && retries < 20) {
          retries += 1
          timer = setTimeout(() => { void pullStatus() }, 800)
        }
      } catch {
        // ignore
      }
    }

    void pullStatus()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [tab])

  // ── Notes 逻辑 ──
  const loadNotes = useCallback(async () => {
    if (!hasNotesScope) {
      setNotes([])
      setTaskMemories([])
      setMemoryStats(null)
      setMemoryExportPath('')
      return
    }
    setNotesLoading(true)
    setTaskMemoriesLoading(true)
    setMemoryStatsLoading(true)
    try {
      const [list, memories, stats] = await Promise.all([
        window.taco.notes.list(notesWorkspace, notesProjectId || undefined),
        window.taco.notes.listTaskMemories(notesWorkspace, notesProjectId || undefined),
        window.taco.notes.stats(notesWorkspace, notesProjectId || undefined),
      ])
      setNotes(list)
      setTaskMemories(memories)
      setMemoryStats(stats)
    } catch (err) {
      console.error('加载笔记失败:', err)
    } finally {
      setNotesLoading(false)
      setTaskMemoriesLoading(false)
      setMemoryStatsLoading(false)
    }
  }, [hasNotesScope, notesWorkspace, notesProjectId])

  useEffect(() => {
    if (tab === 'notes') loadNotes()
  }, [tab, loadNotes])

  const handleSaveNote = async () => {
    if (!hasNotesScope || !editingNote) return
    const title = (editingNote.title || '').trim()
    const content = (editingNote.content || '').trim()
    if (!title || !content) return
    setNoteSaving(true)
    try {
      const now = new Date().toISOString()
      const note: ProjectNote = {
        id: editingNote.id || `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        title,
        content,
        category: editingNote.category || 'other',
        createdAt: editingNote.createdAt || now,
        updatedAt: now,
      }
      const saved = await window.taco.notes.save(notesWorkspace, note, notesProjectId || undefined)
      setNotes((prev) => {
        const idx = prev.findIndex((n) => n.id === saved.id)
        if (idx >= 0) {
          const next = [...prev]
          next[idx] = saved
          return next
        }
        return [...prev, saved]
      })
      setEditingNote(null)
    } catch (err) {
      console.error('保存笔记失败:', err)
    } finally {
      setNoteSaving(false)
    }
  }

  const handleDeleteNote = async (id: string) => {
    if (!hasNotesScope) return
    try {
      await window.taco.notes.delete(notesWorkspace, id, notesProjectId || undefined)
      setNotes((prev) => prev.filter((n) => n.id !== id))
      setExpandedNoteIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    } catch (err) {
      console.error('删除笔记失败:', err)
    }
  }

  const toggleNoteExpanded = (id: string) => {
    setExpandedNoteIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleTaskMemoryExpanded = (id: string) => {
    setExpandedTaskMemoryIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleDeleteTaskMemory = async (id: string) => {
    if (!hasNotesScope) return
    try {
      await window.taco.notes.deleteTaskMemory(notesWorkspace, id, notesProjectId || undefined)
      setTaskMemories((prev) => prev.filter((item) => item.id !== id))
      setExpandedTaskMemoryIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    } catch (err) {
      console.error('删除任务记忆失败:', err)
    }
  }

  const handleExportMemoryScope = async () => {
    if (!hasNotesScope || memoryExporting) return
    setMemoryExporting(true)
    try {
      const exported = await window.taco.notes.exportScope(notesWorkspace, notesProjectId || undefined)
      setMemoryExportPath(exported.filePath)
      await loadNotes()
    } catch (err) {
      console.error('导出记忆失败:', err)
    } finally {
      setMemoryExporting(false)
    }
  }

  const formatBytes = (value: number) => {
    if (!Number.isFinite(value) || value <= 0) return '0 B'
    if (value < 1024) return `${value} B`
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
    if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
    return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`
  }

  const outcomeLabel = (outcome: ProjectTaskMemory['outcome']) => {
    if (outcome === 'success') return '完成'
    if (outcome === 'aborted') return '中止'
    return '失败'
  }

  // ── MCP 逻辑 ──
  const loadMcpServers = useCallback(async () => {
    setMcpLoading(true)
    try {
      const list = await window.taco.mcp.list()
      setMcpServers(list)
    } catch (err) {
      console.error('加载 MCP 服务器失败:', err)
    } finally {
      setMcpLoading(false)
    }
  }, [])

  useEffect(() => {
    if (tab === 'mcp') loadMcpServers()
  }, [tab, loadMcpServers])

  const handleToggleMcp = async (id: string, enabled: boolean) => {
    try {
      await window.taco.mcp.toggle(id, enabled)
      setMcpServers((prev) => prev.map((s) => s.id === id ? { ...s, enabled, status: enabled ? 'starting' : 'stopped' } : s))
      // 延迟刷新获取真实状态
      setTimeout(loadMcpServers, 3000)
    } catch (err) {
      console.error('切换 MCP 状态失败:', err)
    }
  }

  const handleRemoveMcp = async (id: string) => {
    try {
      await window.taco.mcp.remove(id)
      setMcpServers((prev) => prev.filter((s) => s.id !== id))
    } catch (err) {
      console.error('删除 MCP 服务器失败:', err)
    }
  }

  const handleSaveMcp = async () => {
    if (!mcpEditing) return
    setMcpSaving(true)
    try {
      const server: McpServerInfo = {
        id: mcpEditing.id || mcpEditing.name?.toLowerCase().replace(/\s+/g, '-') || `mcp-${Date.now()}`,
        name: mcpEditing.name || '',
        description: mcpEditing.description || '',
        command: mcpEditing.command || '',
        args: mcpEditing.args || [],
        env: mcpEditing.env || {},
        enabled: mcpEditing.enabled ?? false,
        builtin: mcpEditing.builtin ?? false,
        status: 'stopped',
        toolCount: 0,
      }
      await window.taco.mcp.save(server)
      setMcpEditing(null)
      await loadMcpServers()
    } catch (err) {
      console.error('保存 MCP 服务器失败:', err)
    } finally {
      setMcpSaving(false)
    }
  }

  const handleInstallSkill = async () => {
    const source = installInput.trim()
    if (!source) return
    setInstalling(true)
    setInstallError('')
    try {
      const newSkill = await window.taco.skills.install(source)
      setSkills((prev) => {
        const exists = prev.findIndex((s) => s.id === newSkill.id)
        if (exists >= 0) {
          const next = [...prev]
          next[exists] = newSkill
          return next
        }
        return [...prev, newSkill]
      })
      setInstallInput('')
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : String(err))
    } finally {
      setInstalling(false)
    }
  }

  const selectedModel = editingModelId
    ? (modelConfigs.find((item) => item.id === editingModelId) ?? null)
    : null

  const modelHasChanges = Boolean(
    selectedModel
    && modelDraft
    && (
      selectedModel.provider !== modelDraft.provider
      || selectedModel.baseUrl !== modelDraft.baseUrl
      || selectedModel.apiKey !== modelDraft.apiKey
      || selectedModel.model !== modelDraft.model
      || selectedModel.maxTokens !== modelDraft.maxTokens
      || (selectedModel.temperature ?? '') !== modelDraft.temperature
      || Boolean(selectedModel.supportsVision) !== Boolean(modelDraft.supportsVision)
    ),
  )

  const updateDraftField = <K extends keyof ModelConfigDraft>(key: K, value: ModelConfigDraft[K]) => {
    setModelDraft((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        [key]: value,
      }
    })
    setModelDraftDirty(true)
  }

  const handleSaveModelDraft = () => {
    if (!selectedModel || !modelDraft) return
    onUpdateModelConfig(selectedModel.id, modelDraft)
    setModelDraftDirty(false)
  }

  const uploadHasChanges = JSON.stringify(normalizeUploadSettingsState(uploadDraft))
    !== JSON.stringify(normalizeUploadSettingsState(uploadSaved))

  const updateUploadProvider = (provider: UploadSettingsState['provider']) => {
    setUploadDraft((prev) => ({ ...prev, provider }))
  }

  const updateUploadField = <K extends keyof UploadSettingsState['aliyunOss']>(
    key: K,
    value: UploadSettingsState['aliyunOss'][K],
  ) => {
    setUploadDraft((prev) => ({
      ...prev,
      aliyunOss: {
        ...prev.aliyunOss,
        [key]: value,
      },
    }))
  }

  const updateQiniuField = <K extends keyof UploadSettingsState['qiniu']>(
    key: K,
    value: UploadSettingsState['qiniu'][K],
  ) => {
    setUploadDraft((prev) => ({
      ...prev,
      qiniu: {
        ...prev.qiniu,
        [key]: value,
      },
    }))
  }

  const handleSaveUploadDraft = () => {
    const normalized = normalizeUploadSettingsState(uploadDraft)
    saveUploadSettings(normalized)
    setUploadDraft(normalized)
    setUploadSaved(normalized)
  }

  const flushModelDraft = useCallback(() => {
    if (!modelDraftDirty || !modelDraftForId || !modelDraft) return false
    onUpdateModelConfig(modelDraftForId, modelDraft)
    setModelDraftDirty(false)
    return true
  }, [modelDraftDirty, modelDraftForId, modelDraft, onUpdateModelConfig])

  const handleSelectModel = useCallback((id: string) => {
    if (!id || id === editingModelId) return
    flushModelDraft()
    setEditingModelId(id)
  }, [editingModelId, flushModelDraft])

  const handleAddModel = useCallback(() => {
    flushModelDraft()
    const id = onAddModelConfig()
    setEditingModelId(id)
  }, [flushModelDraft, onAddModelConfig])

  const handleRemoveModelWithConfirm = useCallback((id: string, displayName: string) => {
    const targetId = String(id || '').trim()
    if (!targetId) return
    const targetName = String(displayName || '').trim() || targetId
    const confirmed = window.confirm(`确认删除模型「${targetName}」？此操作不可恢复。`)
    if (!confirmed) return
    if (editingModelId === targetId) setEditingModelId(null)
    onRemoveModelConfig(targetId)
  }, [editingModelId, onRemoveModelConfig])

  useEffect(() => {
    if (tab !== 'models') {
      flushModelDraft()
    }
  }, [tab, flushModelDraft])

  return (
    <main className="settings-page">
      <header className="settings-header">
        <button
          className="settings-back-btn"
          type="button"
          onClick={() => {
            flushModelDraft()
            onClose()
          }}
          title="返回"
        >
          <svg
            className="settings-back-icon"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M14.75 6.5L9.25 12L14.75 17.5"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M10 12H20"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
            />
          </svg>
          <span>返回</span>
        </button>
        <div className="settings-title">设置</div>
      </header>

        {/* 标签切换 */}
        <div className="settings-tabs">
          <button
            type="button"
            className={`settings-tab ${tab === 'general' ? 'active' : ''}`}
            onClick={() => setTab('general')}
          >
            通用
          </button>
          <button
            type="button"
            className={`settings-tab ${tab === 'models' ? 'active' : ''}`}
            onClick={() => setTab('models')}
          >
            模型配置
          </button>
          <button
            type="button"
            className={`settings-tab ${tab === 'gui_plus' ? 'active' : ''}`}
            onClick={() => setTab('gui_plus')}
          >
            GUI-Plus
          </button>
          <button
            type="button"
            className={`settings-tab ${tab === 'skills' ? 'active' : ''}`}
            onClick={() => setTab('skills')}
          >
            Skills
          </button>
          <button
            type="button"
            className={`settings-tab ${tab === 'notes' ? 'active' : ''}`}
            onClick={() => setTab('notes')}
          >
            记忆
          </button>
          <button
            type="button"
            className={`settings-tab ${tab === 'mcp' ? 'active' : ''}`}
            onClick={() => setTab('mcp')}
          >
            MCP
          </button>
        </div>

        <div className={`settings-body ${tab === 'models' ? 'is-models' : ''}`}>
          {/* ── 通用设置 ── */}
          {tab === 'general' && (<>
            <div className="settings-card">
              <div className="settings-card-title">浏览器自动化</div>
              <label className="settings-toggle-row">
                <span className="settings-toggle-label">
                  <strong>全局接管模式</strong>
                  <small>开启后，AI 操作浏览器时不再需要每次确认，全程自动执行。关闭则仅首次需要确认。</small>
                </span>
                <input
                  type="checkbox"
                  className="settings-toggle"
                  checked={browserAutoTakeover}
                  onChange={(e) => {
                    const val = e.target.checked
                    setBrowserAutoTakeover(val)
                    localStorage.setItem('taco.browserAutoTakeover', String(val))
                    window.taco.browser.setAutoTakeover(val)
                  }}
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
                  onChange={(e) => {
                    const val = e.target.checked
                    setBrowserDebugMode(val)
                    localStorage.setItem('taco.browserDebugMode', String(val))
                    window.taco.browser.setDebugMode(val)
                  }}
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
                  onChange={(e) => {
                    const val = e.target.checked
                    setBrowserHiddenMode(val)
                    localStorage.setItem('taco.browserHiddenMode', String(val))
                    window.taco.browser.setHiddenMode(val)
                  }}
                />
              </label>

              <label className="settings-toggle-row">
                <span className="settings-toggle-label">
                  <strong>桌面自动化免确认授权</strong>
                  <small>开启后，AI 执行鼠标/键盘/输入等桌面自动化时不再弹出聊天区授权确认。</small>
                </span>
                <input
                  type="checkbox"
                  className="settings-toggle"
                  checked={autoApproveCategories.has('desktop_ops')}
                  onChange={(e) => {
                    const next = new Set(autoApproveCategories)
                    if (e.target.checked) next.add('desktop_ops')
                    else next.delete('desktop_ops')
                    updateAutoApproveCategories(next)
                  }}
                />
              </label>

              <label className="settings-toggle-row">
                <span className="settings-toggle-label">
                  <strong>记忆召回调试日志</strong>
                  <small>开启后记录本轮召回候选、分数、入选原因与预算裁剪详情（仅日志可见）。</small>
                </span>
                <input
                  type="checkbox"
                  className="settings-toggle"
                  checked={recallDebugEnabled}
                  onChange={(e) => {
                    const val = e.target.checked
                    setRecallDebugEnabled(val)
                    localStorage.setItem('taco.recallDebugEnabled', String(val))
                  }}
                />
              </label>

            </div>

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
                  onChange={(e) => setProjectRulesDraft(e.target.value)}
                  placeholder="例如：\n1. 后端统一使用 snake_case JSON 字段\n2. 禁止引入新的全局状态管理库\n3. 所有新增接口必须补充错误码说明"
                />
              </label>
              <div className="settings-action-row">
                <div className="settings-action-info">
                  <small>提示：项目规则用于“约束执行风格”，不会替代系统安全规则。</small>
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

            <div className="settings-card" style={{ marginTop: 16 }}>
              <div className="settings-card-title">移动端桥接（手机 -&gt; 桌面）</div>
              <div className="settings-card-desc">
                手机端通过 HTTP 调用桌面端，将输入的文本指令注入当前会话并执行。
              </div>
              <label className="settings-toggle-row">
                <span className="settings-toggle-label">
                  <strong>启用移动端桥接</strong>
                  <small>开启后监听本机端口，接收手机端下发的指令。</small>
                </span>
                <input
                  type="checkbox"
                  className="settings-toggle"
                  checked={mobileBridge.enabled}
                  onChange={(e) => {
                    const next = { ...mobileBridge, enabled: e.target.checked }
                    setMobileBridge(next)
                    void saveMobileBridge(next)
                  }}
                />
              </label>
              <div className="settings-grid">
                <label className="settings-field">
                  <span>监听端口</span>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={mobileBridge.port}
                    onChange={(e) => setMobileBridge((prev) => ({ ...prev, port: Number(e.target.value || DEFAULT_MOBILE_BRIDGE_CONFIG.port) }))}
                  />
                </label>
                <label className="settings-field">
                  <span>访问令牌（Token）</span>
                  <input
                    value={mobileBridge.token}
                    onChange={(e) => setMobileBridge((prev) => ({ ...prev, token: e.target.value }))}
                    placeholder="taco-mobile"
                  />
                </label>
                <label className="settings-field">
                  <span>扫码连接地址（IP / 域名 / 穿透地址）</span>
                  <input
                    value={mobileBridgeConnectHost}
                    onChange={(e) => {
                      const next = e.target.value
                      setMobileBridgeConnectHost(next)
                      localStorage.setItem('taco.mobileBridgeConnectHost', next)
                    }}
                    placeholder="例如 192.168.1.100 或 https://xxx.ngrok.app"
                  />
                </label>
              </div>
              <div className="mobile-bridge-qr-wrap">
                <div className="mobile-bridge-qr-title">手机扫码自动导入连接配置</div>
                {!mobileBridge.enabled && (
                  <div className="mobile-bridge-qr-hint">请先开启移动端桥接。</div>
                )}
                {mobileBridge.enabled && !mobileBridgeConnectHost.trim() && (
                  <div className="mobile-bridge-qr-hint">请先填写“扫码连接地址”。</div>
                )}
                {mobileBridge.enabled && mobileBridgeConnectHost.trim() && mobileBridgeQrDataUrl && (
                  <div className="mobile-bridge-qr-content">
                    <img src={mobileBridgeQrDataUrl} alt="mobile-bridge-qr" className="mobile-bridge-qr-image" />
                    <div className="mobile-bridge-qr-meta">
                      <small>手机端「连接配置」页面点击“扫码导入”即可自动填充。</small>
                      <small>二维码内容：{mobileBridgeQrPayload}</small>
                      <button
                        type="button"
                        className="settings-action-btn"
                        onClick={() => {
                          void navigator.clipboard.writeText(mobileBridgeQrPayload).catch((err) => {
                            console.error('复制扫码配置失败:', err)
                          })
                        }}
                      >
                        复制配置串
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <div className="settings-action-row" style={{ marginTop: 8 }}>
                <div className="settings-action-info">
                  <small>接口：GET /context、POST /select、POST /command、POST /abort，Header：X-Taco-Token</small>
                </div>
                <button
                  type="button"
                  className="settings-action-btn"
                  onClick={() => void saveMobileBridge(mobileBridge)}
                  disabled={mobileBridgeSaving}
                >
                  {mobileBridgeSaving ? '保存中...' : '保存配置'}
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
                    onClick={() => { void handleCheckUpdate() }}
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
                  onClick={() => { void handleCheckUpdate() }}
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
                  onClick={() => window.taco.shell.openLogDir({ projectId, workspace: workspace || undefined })}
                >
                  打开日志目录
                </button>
              </div>
            </div>

            {/* 代理自动授权设置 */}
            <div className="settings-card" style={{ marginTop: 16 }}>
              <div className="settings-card-title">代理自动授权</div>
              <div className="settings-card-desc">
                勾选的操作类型将在 Agent 模式下自动执行，无需每次手动确认。未勾选的操作仍需用户授权。
              </div>
              {[
                { id: 'package_install', label: '安装依赖', desc: 'npm install, pip install 等包管理器操作', level: 'danger' },
                { id: 'git_ops', label: 'Git 操作', desc: 'git push, git merge, git rebase 等', level: 'warning' },
                { id: 'git_force', label: 'Git 强制操作', desc: 'git push --force, git reset --hard 等不可逆操作', level: 'danger' },
                { id: 'destructive_cmd', label: '删除/权限操作', desc: 'rm -rf, chmod, chown 等破坏性命令', level: 'danger' },
                { id: 'privilege_cmd', label: '权限提升', desc: 'sudo, su 等需要管理员权限的命令', level: 'danger' },
                { id: 'docker_ops', label: 'Docker 操作', desc: 'docker run, docker build 等容器操作', level: 'warning' },
                { id: 'system_modify', label: '系统修改', desc: 'mkfs, dd 等磁盘级操作', level: 'danger' },
                { id: 'network_script', label: '网络脚本', desc: 'curl | sh 等下载并执行的命令', level: 'danger' },
                { id: 'browser_ops', label: '浏览器操作', desc: 'AI 操控浏览器的所有自动化操作', level: 'warning' },
                { id: 'desktop_ops', label: '桌面操作', desc: 'AI 操控鼠标/键盘/输入等桌面自动化', level: 'warning' },
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
                    onChange={(e) => {
                      const next = new Set(autoApproveCategories)
                      if (e.target.checked) next.add(cat.id)
                      else next.delete(cat.id)
                      updateAutoApproveCategories(next)
                      // 浏览器分类同步到独立的浏览器接管设置
                      if (cat.id === 'browser_ops') {
                        setBrowserAutoTakeover(e.target.checked)
                        localStorage.setItem('taco.browserAutoTakeover', String(e.target.checked))
                        window.taco.browser.setAutoTakeover(e.target.checked)
                      }
                    }}
                  />
                </label>
              ))}
            </div>
          </>)}

          {/* ── 模型配置 ── */}
          {tab === 'models' && (
            <>
              <div className="settings-models-add-wrap">
                <button
                  type="button"
                  className="notes-add-btn settings-models-add-btn"
                  onClick={handleAddModel}
                >
                  + 添加模型
                </button>
              </div>

              {modelConfigs.length <= 0 ? (
                <div className="settings-card">
                  <div className="settings-card-desc">暂无模型配置，点击上方“添加模型”开始。</div>
                </div>
              ) : (
                <div className="settings-models-layout">
                  <div className="settings-models-list-wrap">
                    <div className="settings-models-list">
                      {modelConfigs.map((item) => {
                        const isSelected = editingModelId === item.id
                        const providerLabel = providers.find((p) => p.id === item.provider)?.label ?? item.provider
                        const cardTitle = item.model.trim() || `${providerLabel} 模型`
                        return (
                          <div
                            key={item.id}
                            className={`settings-model-card ${isSelected ? 'active' : ''}`}
                            role="button"
                            tabIndex={0}
                            onClick={() => handleSelectModel(item.id)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault()
                                handleSelectModel(item.id)
                              }
                            }}
                          >
                          <div className="settings-model-card-top">
                            <div className="settings-model-card-title">{cardTitle}</div>
                            <div className="settings-model-card-top-actions">
                              {activeModelConfigId === item.id && (
                                <span className="settings-model-badge">默认</span>
                              )}
                              <button
                                type="button"
                                className="settings-model-card-delete"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleRemoveModelWithConfirm(item.id, cardTitle)
                                }}
                              >
                                删除
                              </button>
                            </div>
                          </div>
                          <div className="settings-model-card-meta-row">
                            <span className="settings-model-card-meta">{providerLabel}</span>
                            <span className={`settings-model-mini-tag ${item.apiKey.trim() ? 'ok' : ''}`}>
                              {item.apiKey.trim() ? 'API Key 已配置' : '缺少 API Key'}
                            </span>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                  </div>

                  <div className="settings-card settings-models-editor">
                    {selectedModel && modelDraft ? (
                      <>
                        <div className="settings-action-row">
                          <div className="settings-action-info">
                            <strong>编辑模型：{selectedModel.model.trim() || selectedModel.id}</strong>
                            <small>{selectedModel.id}</small>
                          </div>
                          <div className="settings-model-editor-actions">
                            <button
                              type="button"
                              className="settings-action-btn"
                              disabled={activeModelConfigId === selectedModel.id}
                              onClick={() => onSetActiveModelConfigId(selectedModel.id)}
                            >
                              {activeModelConfigId === selectedModel.id ? '默认模型' : '设为默认'}
                            </button>
                          </div>
                        </div>
                        <div className="settings-grid settings-model-editor-grid">
                          <label className="settings-field">
                            <span>Provider</span>
                            <select
                              value={modelDraft.provider}
                              onChange={(e) => updateDraftField('provider', e.target.value as ModelConfig['provider'])}
                            >
                              {providers.map((provider) => (
                                <option key={provider.id} value={provider.id}>{provider.label}</option>
                              ))}
                            </select>
                          </label>
                          <label className="settings-field">
                            <span>Base URL</span>
                            <input
                              value={modelDraft.baseUrl}
                              onChange={(e) => updateDraftField('baseUrl', e.target.value)}
                              placeholder="https://api.example.com/v1"
                            />
                          </label>
                          <label className="settings-field">
                            <span>API Key</span>
                            <div className="api-key-row">
                              <input
                                type={revealApiKey[selectedModel.id] ? 'text' : 'password'}
                                value={modelDraft.apiKey}
                                onChange={(e) => updateDraftField('apiKey', e.target.value)}
                                placeholder="sk-..."
                                aria-label={`${selectedModel.id} API Key`}
                              />
                              <button
                                type="button"
                                className="reveal-btn"
                                title={revealApiKey[selectedModel.id] ? '隐藏 API Key' : '显示 API Key'}
                                onClick={() =>
                                  setRevealApiKey((prev) => ({ ...prev, [selectedModel.id]: !(prev[selectedModel.id] ?? false) }))
                                }
                              >
                                {revealApiKey[selectedModel.id] ? '隐藏' : '显示'}
                              </button>
                            </div>
                          </label>
                          <label className="settings-field">
                            <span>Model</span>
                            <input
                              value={modelDraft.model}
                              onChange={(e) => updateDraftField('model', e.target.value)}
                              placeholder="填写官方模型 ID（以控制台为准）"
                            />
                          </label>
                          <label className="settings-field">
                            <span>Max Tokens</span>
                            <input
                              type="number"
                              min={1}
                              step={1}
                              value={modelDraft.maxTokens}
                              onChange={(e) => updateDraftField('maxTokens', e.target.value)}
                              placeholder="131072（示例）"
                            />
                          </label>
                          <label className="settings-field">
                            <span>Temperature（可选）</span>
                            <input
                              type="number"
                              min={0}
                              max={2}
                              step={0.1}
                              value={modelDraft.temperature}
                              onChange={(e) => updateDraftField('temperature', e.target.value)}
                              placeholder="留空则使用默认值"
                            />
                          </label>
                          <label className="settings-field">
                            <span>视觉理解能力</span>
                            <div className="settings-toggle-row">
                              <span className="settings-toggle-label">
                                <strong>{modelDraft.supportsVision ? '支持视觉理解' : '不支持视觉理解'}</strong>
                                <small>
                                  启用后，系统提示词会允许模型直接理解用户图片，不再强制要求必须通过 MCP 图片分析。
                                </small>
                              </span>
                              <input
                                type="checkbox"
                                className="settings-toggle"
                                checked={Boolean(modelDraft.supportsVision)}
                                onChange={(e) => updateDraftField('supportsVision', e.target.checked)}
                              />
                            </div>
                          </label>
                        </div>
                        <div className="settings-action-row">
                          <div className="settings-action-info">
                            <strong>{modelHasChanges ? '有未保存修改' : '已保存'}</strong>
                            <small>点击保存后，配置会立即写入本地。</small>
                          </div>
                          <button
                            type="button"
                            className="settings-action-btn"
                            disabled={!modelHasChanges}
                            onClick={handleSaveModelDraft}
                          >
                            保存模型配置
                          </button>
                        </div>
                      </>
                    ) : (
                      <div className="settings-card-desc">请选择左侧模型后进行编辑。</div>
                    )}
                  </div>
                </div>
              )}

              <div className="settings-card" style={{ marginTop: 16 }}>
                <div className="settings-card-title">上传配置（公网媒体）</div>
                <div className="settings-card-desc">
                  当消息包含本地媒体路径时，可先上传到你配置的对象存储，再以公网 https URL 发送给模型。
                </div>
                <div className="settings-grid">
                  <label className="settings-field">
                    <span>上传服务</span>
                    <select
                      value={uploadDraft.provider}
                      onChange={(e) => updateUploadProvider(e.target.value as UploadSettingsState['provider'])}
                    >
                      <option value="none">不启用</option>
                      <option value="aliyun_oss">阿里云 OSS</option>
                      <option value="qiniu">七牛云</option>
                    </select>
                  </label>
                </div>

                {uploadDraft.provider === 'aliyun_oss' && (
                  <div className="settings-grid" style={{ marginTop: 12 }}>
                    <label className="settings-field">
                      <span>AccessKey ID</span>
                      <input
                        value={uploadDraft.aliyunOss.accessKeyId}
                        onChange={(e) => updateUploadField('accessKeyId', e.target.value)}
                        placeholder="LTAI..."
                      />
                    </label>
                    <label className="settings-field">
                      <span>AccessKey Secret</span>
                      <div className="api-key-row">
                        <input
                          type={revealUploadSecrets.aliyunSecret ? 'text' : 'password'}
                          value={uploadDraft.aliyunOss.accessKeySecret}
                          onChange={(e) => updateUploadField('accessKeySecret', e.target.value)}
                          placeholder="请输入 AccessKey Secret"
                        />
                        <button
                          type="button"
                          className="reveal-btn"
                          onClick={() => setRevealUploadSecrets((prev) => ({ ...prev, aliyunSecret: !prev.aliyunSecret }))}
                        >
                          {revealUploadSecrets.aliyunSecret ? '隐藏' : '显示'}
                        </button>
                      </div>
                    </label>
                    <label className="settings-field">
                      <span>Bucket</span>
                      <input
                        value={uploadDraft.aliyunOss.bucket}
                        onChange={(e) => updateUploadField('bucket', e.target.value)}
                        placeholder="my-bucket"
                      />
                    </label>
                    <label className="settings-field">
                      <span>Endpoint</span>
                      <input
                        value={uploadDraft.aliyunOss.endpoint}
                        onChange={(e) => updateUploadField('endpoint', e.target.value)}
                        placeholder="oss-cn-beijing.aliyuncs.com"
                      />
                    </label>
                    <label className="settings-field">
                      <span>公网访问前缀（可选）</span>
                      <input
                        value={uploadDraft.aliyunOss.publicBaseUrl}
                        onChange={(e) => updateUploadField('publicBaseUrl', e.target.value)}
                        placeholder="https://cdn.example.com"
                      />
                    </label>
                    <label className="settings-field">
                      <span>对象前缀（可选）</span>
                      <input
                        value={uploadDraft.aliyunOss.objectPrefix}
                        onChange={(e) => updateUploadField('objectPrefix', e.target.value)}
                        placeholder="taco/uploads"
                      />
                    </label>
                  </div>
                )}

                {uploadDraft.provider === 'qiniu' && (
                  <div className="settings-grid" style={{ marginTop: 12 }}>
                    <label className="settings-field">
                      <span>AccessKey</span>
                      <input
                        value={uploadDraft.qiniu.accessKey}
                        onChange={(e) => updateQiniuField('accessKey', e.target.value)}
                        placeholder="请输入七牛 AccessKey"
                      />
                    </label>
                    <label className="settings-field">
                      <span>SecretKey</span>
                      <div className="api-key-row">
                        <input
                          type={revealUploadSecrets.qiniuSecret ? 'text' : 'password'}
                          value={uploadDraft.qiniu.secretKey}
                          onChange={(e) => updateQiniuField('secretKey', e.target.value)}
                          placeholder="请输入七牛 SecretKey"
                        />
                        <button
                          type="button"
                          className="reveal-btn"
                          onClick={() => setRevealUploadSecrets((prev) => ({ ...prev, qiniuSecret: !prev.qiniuSecret }))}
                        >
                          {revealUploadSecrets.qiniuSecret ? '隐藏' : '显示'}
                        </button>
                      </div>
                    </label>
                    <label className="settings-field">
                      <span>Bucket</span>
                      <input
                        value={uploadDraft.qiniu.bucket}
                        onChange={(e) => updateQiniuField('bucket', e.target.value)}
                        placeholder="my-bucket"
                      />
                    </label>
                    <label className="settings-field">
                      <span>上传地址（可选）</span>
                      <input
                        value={uploadDraft.qiniu.uploadUrl}
                        onChange={(e) => updateQiniuField('uploadUrl', e.target.value)}
                        placeholder="https://up.qiniup.com"
                      />
                    </label>
                    <label className="settings-field">
                      <span>公网访问前缀</span>
                      <input
                        value={uploadDraft.qiniu.publicBaseUrl}
                        onChange={(e) => updateQiniuField('publicBaseUrl', e.target.value)}
                        placeholder="https://cdn.example.com"
                      />
                    </label>
                    <label className="settings-field">
                      <span>对象前缀（可选）</span>
                      <input
                        value={uploadDraft.qiniu.objectPrefix}
                        onChange={(e) => updateQiniuField('objectPrefix', e.target.value)}
                        placeholder="taco/uploads"
                      />
                    </label>
                    <label className="settings-field">
                      <span>Token 有效期（秒，可选）</span>
                      <input
                        type="number"
                        min={60}
                        step={60}
                        value={uploadDraft.qiniu.expiresSeconds}
                        onChange={(e) => updateQiniuField('expiresSeconds', e.target.value)}
                        placeholder="3600"
                      />
                    </label>
                  </div>
                )}

                <div className="settings-action-row">
                  <div className="settings-action-info">
                    <strong>{uploadHasChanges ? '有未保存修改' : '已保存'}</strong>
                    <small>仅本机保存；启用后会用于本地媒体文件上传。</small>
                  </div>
                  <button
                    type="button"
                    className="settings-action-btn"
                    disabled={!uploadHasChanges}
                    onClick={handleSaveUploadDraft}
                  >
                    保存上传配置
                  </button>
                </div>
              </div>
            </>
          )}

          {tab === 'gui_plus' && (
            <div className="gui-plus-panel">
              <div className="mcp-desc">
                GUI-Plus 用于桌面截图识别与结构化视觉理解，不参与聊天模型选择。
              </div>
              <div className="settings-card">
                <div className="settings-card-title">GUI-Plus（桌面识别工具）</div>
                <div className="settings-grid">
                <label className="settings-field">
                  <span>Base URL</span>
                  <input
                    value={guiPlusForm.baseUrl}
                    onChange={(e) => onUpdateGuiPlusField('baseUrl', e.target.value)}
                    placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"
                  />
                </label>
                <label className="settings-field">
                  <span>API Key</span>
                  <div className="api-key-row">
                    <input
                      type={revealGuiPlusKey ? 'text' : 'password'}
                      value={guiPlusForm.apiKey}
                      onChange={(e) => onUpdateGuiPlusField('apiKey', e.target.value)}
                      placeholder="sk-..."
                      aria-label="GUI-Plus API Key"
                    />
                    <button
                      type="button"
                      className="reveal-btn"
                      title={revealGuiPlusKey ? '隐藏 API Key' : '显示 API Key'}
                      onClick={() => setRevealGuiPlusKey((prev) => !prev)}
                    >
                      {revealGuiPlusKey ? '隐藏' : '显示'}
                    </button>
                  </div>
                </label>
                <label className="settings-field">
                  <span>Model</span>
                  <input
                    value={guiPlusForm.model}
                    onChange={(e) => onUpdateGuiPlusField('model', e.target.value)}
                    placeholder="gui-plus"
                  />
                </label>
                <label className="settings-field">
                  <span>Min Pixels</span>
                  <input
                    type="number"
                    value={guiPlusForm.minPixels}
                    onChange={(e) => onUpdateGuiPlusField('minPixels', e.target.value)}
                    placeholder="3136"
                  />
                </label>
                <label className="settings-field">
                  <span>Max Pixels</span>
                  <input
                    type="number"
                    value={guiPlusForm.maxPixels}
                    onChange={(e) => onUpdateGuiPlusField('maxPixels', e.target.value)}
                    placeholder="1003520"
                  />
                </label>
                <label className="settings-field">
                  <span>高清图像模式</span>
                  <div className="settings-toggle-row">
                    <span className="settings-toggle-label">
                      <strong>{guiPlusForm.highResolution ? '已开启' : '已关闭'}</strong>
                      <small>开启后截图会按更高分辨率发送给 GUI-Plus，细节更清晰，但请求更慢、消耗更多 token。</small>
                    </span>
                    <input
                      className="settings-toggle"
                      type="checkbox"
                      checked={guiPlusForm.highResolution}
                      onChange={(e) => onUpdateGuiPlusField('highResolution', e.target.checked)}
                    />
                  </div>
                </label>
                <label className="settings-field">
                  <span>返回 Token 用量</span>
                  <div className="settings-toggle-row">
                    <span className="settings-toggle-label">
                      <strong>{guiPlusForm.includeUsage ? '已开启' : '已关闭'}</strong>
                      <small>开启后会在响应中包含 token 用量统计（输入/输出/总量），便于在面板中做消耗追踪。</small>
                    </span>
                    <input
                      className="settings-toggle"
                      type="checkbox"
                      checked={guiPlusForm.includeUsage}
                      onChange={(e) => onUpdateGuiPlusField('includeUsage', e.target.checked)}
                    />
                  </div>
                </label>
                </div>
              </div>
            </div>
          )}

          {/* ── Skills 管理 ── */}
          {tab === 'skills' && (
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
                    onChange={(e) => setInstallInput(e.target.value)}
                    placeholder="https://github.com/user/repo/tree/main/path/to/skill"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleInstallSkill()
                    }}
                    disabled={installing}
                  />
                  <button
                    type="button"
                    className="skills-install-btn"
                    onClick={handleInstallSkill}
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
                              onChange={(e) => handleToggleSkill(skill.id, e.target.checked)}
                            />
                            <span className="skill-toggle-slider" />
                          </label>
                          {skill.source !== 'builtin' && (
                            <button
                              type="button"
                              className="skill-uninstall-btn"
                              onClick={() => handleUninstallSkill(skill.id)}
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
          )}

          {/* ── 记忆 ── */}
          {tab === 'notes' && (
            <div className="notes-panel">
              {!hasNotesScope ? (
                <div className="notes-empty">请先创建会话或选择工作空间后再使用记忆</div>
              ) : (
                <>
                  <div className="note-card" style={{ marginBottom: 14 }}>
                    <div className="note-card-header">
                      <span className="note-card-category architecture">记忆库状态</span>
                      <span className="note-card-title">SQLite / 当前作用域</span>
                      <div className="note-card-actions">
                        <button
                          type="button"
                          className="note-card-btn edit"
                          onClick={() => void loadNotes()}
                          disabled={memoryStatsLoading}
                          title="刷新"
                        >
                          刷新
                        </button>
                        <button
                          type="button"
                          className="note-card-btn edit"
                          onClick={handleExportMemoryScope}
                          disabled={memoryExporting}
                          title="导出当前作用域记忆"
                        >
                          {memoryExporting ? '导出中...' : '导出'}
                        </button>
                      </div>
                    </div>
                    <div className="note-card-content expanded">
                      {memoryStatsLoading || !memoryStats ? '加载中...' : [
                        `作用域：${memoryStats.scope}`,
                        `数据库：${memoryStats.dbPath}`,
                        `库大小：${formatBytes(memoryStats.dbSizeBytes)}`,
                        `手工记忆：${memoryStats.manualNotes}`,
                        `自动记忆（活动）：${memoryStats.activeTaskMemories}`,
                        `自动记忆（归档）：${memoryStats.archivedTaskMemories}`,
                        `自动记忆（软删除）：${memoryStats.deletedTaskMemories}`,
                        `上下文快照：${memoryStats.snapshots}`,
                        `整理审计：${memoryStats.maintainRuns}`,
                        memoryStats.latestNoteUpdatedAt ? `最近手工记忆：${new Date(memoryStats.latestNoteUpdatedAt).toLocaleString()}` : '',
                        memoryStats.latestTaskMemoryUpdatedAt ? `最近自动记忆：${new Date(memoryStats.latestTaskMemoryUpdatedAt).toLocaleString()}` : '',
                        memoryStats.latestSnapshotUpdatedAt ? `最近快照：${new Date(memoryStats.latestSnapshotUpdatedAt).toLocaleString()}` : '',
                        memoryExportPath ? `最近导出：${memoryExportPath}` : '',
                      ].filter(Boolean).join('\n')}
                    </div>
                  </div>

                  {/* 新增/编辑笔记表单 */}
                  {editingNote ? (
                    <div className="note-form">
                      <div className="note-form-title">
                        {editingNote.id ? '编辑记忆' : '新增记忆'}
                      </div>
                      <div className="note-form-fields">
                        <input
                          className="note-form-input"
                          value={editingNote.title || ''}
                          onChange={(e) => setEditingNote((prev) => ({ ...prev, title: e.target.value }))}
                          placeholder="标题（如：数据库配置）"
                        />
                        <select
                          className="note-form-select"
                          value={editingNote.category || 'other'}
                          onChange={(e) => setEditingNote((prev) => ({ ...prev, category: e.target.value as NoteCategory }))}
                        >
                          {NOTE_CATEGORIES.map((cat) => (
                            <option key={cat.value} value={cat.value}>{cat.label}</option>
                          ))}
                        </select>
                        <textarea
                          className="note-form-textarea"
                          value={editingNote.content || ''}
                          onChange={(e) => setEditingNote((prev) => ({ ...prev, content: e.target.value }))}
                          placeholder="记忆内容（如：MySQL 地址 127.0.0.1:3306，用户名 root，密码 xxx）"
                          rows={4}
                        />
                      </div>
                      <div className="note-form-actions">
                        <button
                          type="button"
                          className="note-form-btn save"
                          onClick={handleSaveNote}
                          disabled={noteSaving || !(editingNote.title?.trim()) || !(editingNote.content?.trim())}
                        >
                          {noteSaving ? '保存中...' : '保存'}
                        </button>
                        <button
                          type="button"
                          className="note-form-btn cancel"
                          onClick={() => setEditingNote(null)}
                        >
                          取消
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="notes-add-btn"
                      onClick={() => setEditingNote({ category: 'other' })}
                    >
                      + 新增记忆
                    </button>
                  )}

                  {/* 记忆列表 */}
                  <div className="notes-list-title">
                    手动记忆 ({notes.length})
                    <span className="notes-list-hint">由你手动维护或 AI 通过 save_note 写入的长期项目记忆。</span>
                  </div>
                  {notesLoading ? (
                    <div className="notes-loading">加载中...</div>
                  ) : notes.length === 0 ? (
                    <div className="notes-empty">
                      暂无记忆。你可以手动添加，或在对话中提到重要信息时 AI 会自动记录。
                    </div>
                  ) : (
                    <div className="notes-list">
                      {notes.map((note) => {
                        const expanded = expandedNoteIds.has(note.id)
                        const hasLongContent = note.content.length > 140 || note.content.includes('\n')
                        return (
                          <div key={note.id} className="note-card">
                            <div className="note-card-header">
                              <span className={`note-card-category ${note.category}`}>
                                {NOTE_CATEGORIES.find((c) => c.value === note.category)?.label || note.category}
                              </span>
                              <span className="note-card-title">{note.title}</span>
                              <div className="note-card-actions">
                                <button
                                  type="button"
                                  className="note-card-btn edit"
                                  onClick={() => setEditingNote(note)}
                                  title="编辑"
                                >
                                  编辑
                                </button>
                                <button
                                  type="button"
                                  className="note-card-btn delete"
                                  onClick={() => handleDeleteNote(note.id)}
                                  title="删除"
                                >
                                  ✕
                                </button>
                              </div>
                            </div>
                            <div className={`note-card-content ${expanded ? 'expanded' : ''}`}>{note.content}</div>
                            <div className="note-card-footer">
                              <div className="note-card-meta">
                                更新于 {new Date(note.updatedAt).toLocaleString()}
                              </div>
                              {hasLongContent && (
                                <button
                                  type="button"
                                  className="note-card-toggle-btn"
                                  onClick={() => toggleNoteExpanded(note.id)}
                                >
                                  {expanded ? '收起' : '展开'}
                                </button>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}

                  {/* 任务记忆列表（自动生成，仅查看） */}
                  <div className="notes-list-title" style={{ marginTop: 14 }}>
                    自动记忆 ({taskMemories.length})
                    <span className="notes-list-hint">每轮用户提问自动记录“用户原问 + 处理结果要点”，用于后续上下文重放与召回。</span>
                  </div>
                  {taskMemoriesLoading ? (
                    <div className="notes-loading">加载中...</div>
                  ) : taskMemories.length === 0 ? (
                    <div className="notes-empty">
                      暂无自动记忆。发起提问后会自动生成。
                    </div>
                  ) : (
                    <div className="notes-list">
                      {taskMemories.map((memory) => {
                        const expanded = expandedTaskMemoryIds.has(memory.id)
                        const resultBody = (memory.assistantResult || '').trim()
                        const detailLines = [
                          `用户问题：${memory.userQuery || memory.goal || '无'}`,
                          `用户意图：${memory.intentType || 'other'}${memory.intentSummary ? ` | ${memory.intentSummary}` : ''}`,
                          `意图目标：${memory.intentGoal || memory.goal || '无'}`,
                          `结果：${outcomeLabel(memory.outcome)}`,
                          `执行动作：${memory.tools.length > 0 ? memory.tools.join('、') : '无'}`,
                          `修改文件：${memory.changedFiles.length > 0 ? memory.changedFiles.join('、') : '无'}`,
                          `关键标识符：${memory.identifiers.length > 0 ? memory.identifiers.join('、') : '无'}`,
                          memory.failures.length > 0 ? `异常：${memory.failures.slice(0, 3).join('；')}` : '',
                        ].filter(Boolean)
                        const detailText = detailLines.join('\n')
                        const memoryDigest = (memory.summary || '').trim()
                        const contentText = [
                          memoryDigest ? `记忆摘要：\n${memoryDigest}` : '',
                          resultBody ? `处理结果：\n${resultBody}` : '',
                          detailText ? `结构化信息：\n${detailText}` : '',
                        ].filter(Boolean).join('\n\n')
                        const hasLongContent = contentText.length > 180 || contentText.includes('\n')
                        return (
                          <div key={memory.id} className="note-card">
                            <div className="note-card-header">
                              <span className="note-card-category other">{outcomeLabel(memory.outcome)}</span>
                              <span className="note-card-title">{memory.goal || '（无目标）'}</span>
                              <div className="note-card-actions">
                                <button
                                  type="button"
                                  className="note-card-btn delete"
                                  onClick={() => handleDeleteTaskMemory(memory.id)}
                                  title="删除"
                                >
                                  ✕
                                </button>
                              </div>
                            </div>
                            <div className={`note-card-content ${expanded ? 'expanded' : ''}`}>
                              {contentText || '（无可展示内容）'}
                            </div>
                            <div className="note-card-footer">
                              <div className="note-card-meta">
                                更新时间 {new Date(memory.updatedAt).toLocaleString()}
                              </div>
                              {hasLongContent && (
                                <button
                                  type="button"
                                  className="note-card-toggle-btn"
                                  onClick={() => toggleTaskMemoryExpanded(memory.id)}
                                >
                                  {expanded ? '收起' : '展开'}
                                </button>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* ── MCP 管理 ── */}
          {tab === 'mcp' && (
            <div className="mcp-panel">
              <div className="mcp-desc">
                MCP (Model Context Protocol) 让 AI 能够连接外部工具服务，如图片理解、网络搜索等。
              </div>

              {/* 新增/编辑 MCP 服务器表单 */}
              {mcpEditing ? (
                <div className="mcp-form">
                  <div className="mcp-form-title">
                    {mcpEditing.id ? '编辑 MCP 服务器' : '添加 MCP 服务器'}
                  </div>
                  <label className="settings-field">
                    <span>名称</span>
                    <input
                      value={mcpEditing.name ?? ''}
                      onChange={(e) => setMcpEditing((p) => ({ ...p, name: e.target.value }))}
                      placeholder="如: MiniMax"
                    />
                  </label>
                  <label className="settings-field">
                    <span>描述（可选）</span>
                    <input
                      value={mcpEditing.description ?? ''}
                      onChange={(e) => setMcpEditing((p) => ({ ...p, description: e.target.value }))}
                      placeholder="简要描述"
                    />
                  </label>
                  <label className="settings-field">
                    <span>启动命令</span>
                    <input
                      value={mcpEditing.command ?? ''}
                      onChange={(e) => setMcpEditing((p) => ({ ...p, command: e.target.value }))}
                      placeholder="如: uvx, npx, node"
                    />
                  </label>
                  <label className="settings-field">
                    <span>命令参数（每行一个）</span>
                    <textarea
                      className="mcp-textarea"
                      value={(mcpEditing.args ?? []).join('\n')}
                      onChange={(e) => setMcpEditing((p) => ({ ...p, args: e.target.value.split('\n').filter(Boolean) }))}
                      placeholder="minimax-coding-plan-mcp&#10;-y"
                      rows={3}
                    />
                  </label>
                  <label className="settings-field">
                    <span>环境变量（KEY=VALUE，每行一个）</span>
                    <textarea
                      className="mcp-textarea"
                      value={Object.entries(mcpEditing.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n')}
                      onChange={(e) => {
                        const env: Record<string, string> = {}
                        e.target.value.split('\n').forEach((line) => {
                          const idx = line.indexOf('=')
                          if (idx > 0) env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
                        })
                        setMcpEditing((p) => ({ ...p, env }))
                      }}
                      placeholder="MINIMAX_API_KEY=your-api-key&#10;MINIMAX_API_HOST=https://api.minimaxi.com"
                      rows={4}
                    />
                  </label>
                  <div className="mcp-form-actions">
                    <button
                      type="button"
                      className="note-form-btn save"
                      onClick={handleSaveMcp}
                      disabled={mcpSaving || !mcpEditing.name?.trim() || !mcpEditing.command?.trim()}
                    >
                      {mcpSaving ? '保存中...' : '保存并启用'}
                    </button>
                    <button
                      type="button"
                      className="note-form-btn cancel"
                      onClick={() => setMcpEditing(null)}
                    >
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="notes-add-btn"
                  onClick={() => setMcpEditing({ enabled: true })}
                >
                  + 添加 MCP 服务器
                </button>
              )}

              {/* 已安装 MCP 列表 */}
              {mcpLoading ? (
                <div className="notes-loading">加载中...</div>
              ) : mcpServers.length === 0 ? (
                <div className="notes-empty">暂无 MCP 服务器。</div>
              ) : (
                <div className="mcp-list">
                  {mcpServers.map((server) => (
                    <div key={server.id} className={`mcp-card ${server.status}`}>
                      <div className="mcp-card-header">
                        <div className="mcp-card-info">
                          <span className="mcp-card-name">
                            {server.name}
                            {server.builtin && <span className="mcp-badge builtin">内置</span>}
                          </span>
                          <span className="mcp-card-meta">
                            <span className={`mcp-status ${server.status}`}>
                              {server.status === 'running' ? '● 运行中' :
                               server.status === 'starting' ? '◌ 启动中...' :
                               server.status === 'error' ? '✕ 错误' : '○ 已停止'}
                            </span>
                            {server.toolCount > 0 && <span className="mcp-tool-count">{server.toolCount} 个工具</span>}
                          </span>
                          {server.description && <span className="mcp-card-desc">{server.description}</span>}
                          {/* 检查是否有未配置的 API Key */}
                          {!server.enabled && server.env && Object.entries(server.env).some(([k, v]) => k.toLowerCase().includes('api_key') && !v) && (
                            <span className="mcp-card-hint">⚠ 请先点击「编辑」配置 API Key，再启用</span>
                          )}
                          {server.error && <span className="mcp-card-error">{server.error}</span>}
                        </div>
                        <div className="mcp-card-actions">
                          <input
                            type="checkbox"
                            className="settings-toggle"
                            checked={server.enabled}
                            onChange={(e) => handleToggleMcp(server.id, e.target.checked)}
                            title={server.enabled ? '禁用' : '启用'}
                          />
                          <button
                            type="button"
                            className="note-card-btn edit"
                            onClick={() => setMcpEditing(server)}
                            title="编辑"
                          >
                            编辑
                          </button>
                          {!server.builtin && (
                            <button
                              type="button"
                              className="note-card-btn delete"
                              onClick={() => handleRemoveMcp(server.id)}
                              title="删除"
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

    </main>
  )
}
