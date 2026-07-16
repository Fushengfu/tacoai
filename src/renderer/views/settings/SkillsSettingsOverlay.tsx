import { useState, useEffect, useCallback } from 'react'
import type { SkillInfo, SkillPreview, SkillUpdateInfo, ClawHubSearchResult } from '../../../shared/ipc'
import { SkillsSettingsPanel } from './SkillsSettingsPanel'

type SkillsSettingsOverlayProps = {
  onClose: () => void
  workspace?: string | null
}

export function SkillsSettingsOverlay({ onClose, workspace }: Readonly<SkillsSettingsOverlayProps>) {
  // 已安装 skills
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [skillsLoading, setSkillsLoading] = useState(false)

  // 搜索
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<ClawHubSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')

  // 选中的搜索结果
  const [selectedResult, setSelectedResult] = useState<ClawHubSearchResult | null>(null)

  // 预览
  const [previewResult, setPreviewResult] = useState<SkillPreview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [previewError, setPreviewError] = useState('')

  // SKILL.md 详细内容
  const [detailContent, setDetailContent] = useState('')
  const [detailLoading, setDetailLoading] = useState(false)

  // 安装
  const [installing, setInstalling] = useState(false)
  const [installError, setInstallError] = useState('')
  const [installingSlug, setInstallingSlug] = useState<string | null>(null)

  // 更新检测
  const [checkingUpdates, setCheckingUpdates] = useState<Record<string, boolean>>({})
  const [updateInfo, setUpdateInfo] = useState<Record<string, SkillUpdateInfo | null>>({})

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

  useEffect(() => { loadSkills() }, [loadSkills])

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

  const handleSearch = async () => {
    const q = searchQuery.trim()
    if (!q) return
    setSearching(true)
    setSearchError('')
    setSearchResults([])
    setSelectedResult(null)
    setPreviewResult(null)
    setPreviewError('')
    setDetailContent('')
    try {
      const results = await window.taco.skills.search(q)
      setSearchResults(results)
      if (results.length === 0) {
        setSearchError('未找到匹配的技能')
      }
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : '搜索失败')
    } finally {
      setSearching(false)
    }
  }

  const handleSelectResult = async (result: ClawHubSearchResult) => {
    setSelectedResult(result)
    setPreviewResult(null)
    setPreviewError('')
    setDetailContent('')
    setDetailLoading(true)
    // 构造预览数据
    setPreviewing(true)
    const preview: SkillPreview = {
      id: result.slug,
      name: result.displayName,
      description: result.summary,
      version: result.version || '—',
      author: result.owner?.displayName || result.ownerHandle || '未知',
      sourceUrl: `https://clawhub.ai/skills/${result.slug}`,
      tools: [],
      tags: [],
    }
    setPreviewResult(preview)
    setPreviewing(false)
    // 同时拉取 SKILL.md 原文
    try {
      const content = await window.taco.skills.getDetail(result.slug)
      setDetailContent(content)
    } catch (err) {
      console.error('获取 SKILL.md 失败:', err)
      setDetailContent('')
    } finally {
      setDetailLoading(false)
    }
  }

  const handleInstallFromSearch = async () => {
    if (!selectedResult) return
    setInstalling(true)
    setInstallError('')
    setInstallingSlug(selectedResult.slug)
    try {
      const newSkill = await window.taco.skills.install(selectedResult.slug)
      setSearchResults((prev) => prev.filter((r) => r.slug !== selectedResult.slug))
      setSelectedResult(null)
      setPreviewResult(null)
      setDetailContent('')
      setSkills((prev) => {
        const exists = prev.findIndex((s) => s.id === newSkill.id)
        if (exists >= 0) {
          const next = [...prev]
          next[exists] = newSkill
          return next
        }
        return [...prev, newSkill]
      })
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : String(err))
    } finally {
      setInstalling(false)
      setInstallingSlug(null)
    }
  }

  const isInstalled = useCallback((slug: string) => {
    return skills.some((s) => s.id === slug)
  }, [skills])

  const handleSkillCheckUpdate = async (skillId: string) => {
    setCheckingUpdates((prev) => ({ ...prev, [skillId]: true }))
    try {
      const result = await window.taco.skills.checkUpdate(skillId)
      setUpdateInfo((prev) => ({ ...prev, [skillId]: result }))
    } catch {
      setUpdateInfo((prev) => ({ ...prev, [skillId]: null }))
    } finally {
      setCheckingUpdates((prev) => ({ ...prev, [skillId]: false }))
    }
  }

  return (
    <main className="settings-page">
      <header className="settings-header">
        <button className="settings-back-btn" type="button" onClick={onClose} title="返回">
          <svg className="settings-back-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M14.75 6.5L9.25 12L14.75 17.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M10 12H20" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
          </svg>
          <span>返回</span>
        </button>
        <div className="settings-title">Skills</div>
      </header>
      <div className="settings-body">
        <SkillsSettingsPanel
          // 搜索
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
          onSearch={handleSearch}
          searching={searching}
          searchResults={searchResults}
          searchError={searchError}
          // 选中 & 预览
          selectedResult={selectedResult}
          onSelectResult={handleSelectResult}
          previewResult={previewResult}
          previewing={previewing}
          previewError={previewError}
          // SKILL.md 详细内容
          detailContent={detailContent}
          detailLoading={detailLoading}
          // 安装
          installing={installing}
          installError={installError}
          installingSlug={installingSlug}
          onInstallFromSearch={handleInstallFromSearch}
          isInstalled={isInstalled}
          // 已安装
          skillsLoading={skillsLoading}
          skills={skills}
          onToggleSkill={handleToggleSkill}
          onUninstallSkill={handleUninstallSkill}
          checkingUpdates={checkingUpdates}
          updateInfo={updateInfo}
          onCheckUpdate={handleSkillCheckUpdate}
        />
      </div>
    </main>
  )
}
