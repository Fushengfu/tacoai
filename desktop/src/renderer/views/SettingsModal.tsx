import { useState, useEffect, useCallback } from 'react'
import type { GuiPlusForm, ModelConfig, ThemeMode } from '../types'
import type { SkillInfo, ProjectNote, ProjectTaskMemory, NoteCategory, McpServerInfo, MemoryScopeStats, AppUpdateCheckResult } from '../../shared/ipc'
import {
  loadUploadSettings,
  normalizeUploadSettingsState,
  saveUploadSettings,
  type UploadSettingsState,
} from '../lib/upload-config'
import { GeneralSettingsPanel } from './settings/GeneralSettingsPanel'
import { ModelsSettingsPanel } from './settings/ModelsSettingsPanel'
import { UploadSettingsPanel } from './settings/UploadSettingsPanel'
import { GuiPlusSettingsPanel } from './settings/GuiPlusSettingsPanel'
import { SkillsSettingsPanel } from './settings/SkillsSettingsPanel'
import { NotesSettingsPanel } from './settings/NotesSettingsPanel'
import { McpSettingsPanel } from './settings/McpSettingsPanel'

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
  memberInfo?: { username: string } | null
  memberToken?: string
}

type SettingsTab = 'general' | 'models' | 'upload' | 'gui_plus' | 'skills' | 'notes' | 'mcp'
type ModelConfigDraft = Pick<ModelConfig, 'provider' | 'baseUrl' | 'apiKey' | 'model' | 'contextLength' | 'temperature' | 'supportsVision' | 'supportsReasoning'>

function toModelDraft(model: ModelConfig): ModelConfigDraft {
  return {
    provider: model.provider,
    baseUrl: model.baseUrl,
    apiKey: model.apiKey,
    model: model.model,
    contextLength: model.contextLength,
    temperature: model.temperature ?? '',
    supportsVision: Boolean(model.supportsVision),
    supportsReasoning: Boolean(model.supportsReasoning),
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
  memberInfo,
  memberToken,
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
  const [editingNote, setEditingNote] = useState<Partial<ProjectNote & { category: NoteCategory }> | null>(null)
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
    loadSkills()
  }, [loadSkills])

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
      || selectedModel.contextLength !== modelDraft.contextLength
      || (selectedModel.temperature ?? '') !== modelDraft.temperature
      || Boolean(selectedModel.supportsVision) !== Boolean(modelDraft.supportsVision)
      || Boolean(selectedModel.supportsReasoning) !== Boolean(modelDraft.supportsReasoning)
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
            className={`settings-tab ${tab === 'upload' ? 'active' : ''}`}
            onClick={() => setTab('upload')}
          >
            上传配置
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
          {tab === 'general' && (
            <GeneralSettingsPanel
              browserAutoTakeover={browserAutoTakeover}
              browserDebugMode={browserDebugMode}
              browserHiddenMode={browserHiddenMode}
              recallDebugEnabled={recallDebugEnabled}
              themeMode={themeMode}
              projectRulesDraft={projectRulesDraft}
              cachedUpdateStatus={cachedUpdateStatus}
              updateChecking={updateChecking}
              updateCheckSummary={updateCheckSummary}
              autoApproveCategories={autoApproveCategories}
              onBrowserAutoTakeoverChange={(val) => {
                setBrowserAutoTakeover(val)
                localStorage.setItem('taco.browserAutoTakeover', String(val))
                window.taco.browser.setAutoTakeover(val)
              }}
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
              onThemeModeChange={onThemeModeChange}
              onProjectRulesDraftChange={setProjectRulesDraft}
              onProjectRulesChange={onProjectRulesChange}
              onCheckUpdate={handleCheckUpdate}
              onOpenLogDir={() => window.taco.shell.openLogDir({ projectId, workspace: workspace || undefined })}
              onUpdateAutoApproveCategories={updateAutoApproveCategories}
            />
          )}

          {/* ── 模型配置 ── */}
          {tab === 'models' && (
            <ModelsSettingsPanel
              modelConfigs={modelConfigs}
              activeModelConfigId={activeModelConfigId}
              editingModelId={editingModelId}
              selectedModel={selectedModel}
              modelDraft={modelDraft}
              modelHasChanges={modelHasChanges}
              revealApiKey={revealApiKey}
              onAddModel={handleAddModel}
              onSelectModel={handleSelectModel}
              onRemoveModelWithConfirm={handleRemoveModelWithConfirm}
              onSetActiveModelConfigId={onSetActiveModelConfigId}
              onModelDraftFieldChange={updateDraftField}
              onSaveModelDraft={handleSaveModelDraft}
              onToggleApiKeyReveal={(id) => setRevealApiKey((prev) => ({ ...prev, [id]: !(prev[id] ?? false) }))}
            />
          )}

          {/* ── 上传配置 ── */}
          {tab === 'upload' && (
            <UploadSettingsPanel
              uploadDraft={uploadDraft}
              uploadHasChanges={uploadHasChanges}
              onUpdateProvider={updateUploadProvider}
              onUpdateAliyunField={updateUploadField}
              onUpdateQiniuField={updateQiniuField}
              onSave={handleSaveUploadDraft}
              revealUploadSecrets={revealUploadSecrets}
              onToggleSecret={(key) => setRevealUploadSecrets((prev) => ({ ...prev, [key]: !(prev[key] ?? false) }))}
            />
          )}

          {/* ── GUI-Plus ── */}
          {tab === 'gui_plus' && (
            <GuiPlusSettingsPanel
              guiPlusForm={guiPlusForm}
              onUpdateGuiPlusField={onUpdateGuiPlusField}
              revealGuiPlusKey={revealGuiPlusKey}
              onToggleGuiPlusKey={() => setRevealGuiPlusKey((prev) => !prev)}
            />
          )}

          {/* ── Skills ── */}
          {tab === 'skills' && (
            <SkillsSettingsPanel
              installInput={installInput}
              installing={installing}
              installError={installError}
              skillsLoading={skillsLoading}
              skills={skills}
              onInstallInputChange={setInstallInput}
              onInstallSkill={handleInstallSkill}
              onToggleSkill={handleToggleSkill}
              onUninstallSkill={handleUninstallSkill}
            />
          )}

          {/* ── 记忆 ── */}
          {tab === 'notes' && (
            <NotesSettingsPanel
              hasNotesScope={hasNotesScope}
              memoryStats={memoryStats}
              memoryStatsLoading={memoryStatsLoading}
              memoryExporting={memoryExporting}
              memoryExportPath={memoryExportPath}
              notes={notes}
              notesLoading={notesLoading}
              taskMemories={taskMemories}
              taskMemoriesLoading={taskMemoriesLoading}
              editingNote={editingNote}
              expandedNoteIds={expandedNoteIds}
              expandedTaskMemoryIds={expandedTaskMemoryIds}
              onRefreshNotes={loadNotes}
              onExportMemoryScope={handleExportMemoryScope}
              onEditingNoteChange={setEditingNote}
              onSaveNote={handleSaveNote}
              onDeleteNote={handleDeleteNote}
              onDeleteTaskMemory={handleDeleteTaskMemory}
              onToggleNoteExpanded={toggleNoteExpanded}
              onToggleTaskMemoryExpanded={toggleTaskMemoryExpanded}
            />
          )}

          {/* ── MCP ── */}
          {tab === 'mcp' && (
            <McpSettingsPanel
              mcpEditing={mcpEditing}
              mcpSaving={mcpSaving}
              mcpLoading={mcpLoading}
              mcpServers={mcpServers}
              onMcpEditingChange={setMcpEditing}
              onSaveMcp={handleSaveMcp}
              onToggleMcp={handleToggleMcp}
              onRemoveMcp={handleRemoveMcp}
            />
          )}
        </div>

    </main>
  )
}
