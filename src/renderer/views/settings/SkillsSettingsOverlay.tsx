import { useState, useEffect, useCallback } from 'react'
import type { SkillInfo, SkillPreview, SkillUpdateInfo } from '../../../shared/ipc'
import { SkillsSettingsPanel } from './SkillsSettingsPanel'

type SkillsSettingsOverlayProps = {
  onClose: () => void
  workspace?: string | null
}

export function SkillsSettingsOverlay({ onClose, workspace }: Readonly<SkillsSettingsOverlayProps>) {
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [installInput, setInstallInput] = useState('')
  const [installing, setInstalling] = useState(false)
  const [installError, setInstallError] = useState('')
  const [previewResult, setPreviewResult] = useState<SkillPreview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [previewError, setPreviewError] = useState('')
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
      setPreviewResult(null)
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : String(err))
    } finally {
      setInstalling(false)
    }
  }

  const handlePreviewSkill = async () => {
    const source = installInput.trim()
    if (!source) return
    setPreviewing(true)
    setPreviewError('')
    setPreviewResult(null)
    try {
      const result = await window.taco.skills.preview(source)
      setPreviewResult(result)
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : String(err))
    } finally {
      setPreviewing(false)
    }
  }

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
          installInput={installInput}
          installing={installing}
          installError={installError}
          onInstallInputChange={setInstallInput}
          onInstallSkill={handleInstallSkill}
          previewResult={previewResult}
          previewing={previewing}
          previewError={previewError}
          onPreviewSkill={handlePreviewSkill}
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
