import { useState, useEffect } from 'react'
import { loadUploadSettings, normalizeUploadSettingsState, saveUploadSettings, type UploadSettingsState } from '../../lib/upload-config'
import { UploadSettingsPanel } from './UploadSettingsPanel'

type UploadSettingsOverlayProps = {
  onClose: () => void
}

export function UploadSettingsOverlay({ onClose }: Readonly<UploadSettingsOverlayProps>) {
  const [uploadDraft, setUploadDraft] = useState<UploadSettingsState>(() => loadUploadSettings())
  const [uploadSaved, setUploadSaved] = useState<UploadSettingsState>(() => loadUploadSettings())
  const [revealUploadSecrets, setRevealUploadSecrets] = useState<Record<string, boolean>>({})

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
      aliyunOss: { ...prev.aliyunOss, [key]: value },
    }))
  }

  const updateQiniuField = <K extends keyof UploadSettingsState['qiniu']>(
    key: K,
    value: UploadSettingsState['qiniu'][K],
  ) => {
    setUploadDraft((prev) => ({
      ...prev,
      qiniu: { ...prev.qiniu, [key]: value },
    }))
  }

  const handleSaveUploadDraft = () => {
    const normalized = normalizeUploadSettingsState(uploadDraft)
    saveUploadSettings(normalized)
    setUploadDraft(normalized)
    setUploadSaved(normalized)
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
            <div className="settings-title">上传配置</div>
          </header>
          <div className="settings-body">
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
          </div>
        </main>
  )
}
