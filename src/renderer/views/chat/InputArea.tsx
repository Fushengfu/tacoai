import { useRef, useEffect } from 'react'
import type { AttachedImage, AttachedAsset, QueuedMessage } from '../../types'
import { ProviderSelect } from '../ProviderSelect'

/* ------------------------------------------------------------------ */
/*  InputArea — ChatPanel 底部输入区域                                   */
/* ------------------------------------------------------------------ */

interface InputAreaProps {
  /* 附件 */
  attachedImages: AttachedImage[]
  onAttachedImagesChange: (value: AttachedImage[] | ((prev: AttachedImage[]) => AttachedImage[])) => void
  attachedAssets: AttachedAsset[]
  draft: string
  onDraftChange: (value: string) => void
  /* 发送 */
  sending: boolean
  hasProviders: boolean
  workspace: string
  onSendClick: () => void
  onStop: () => void
  /* 队列 */
  queue: QueuedMessage[]
  onRemoveFromQueue: (id: string) => void
  /* Provider */
  provider: string
  onProviderChange: (id: string) => void
  configuredProviders: readonly { id: string; label: string; source?: 'custom' | 'system' }[]
  onOpenModels?: () => void
  /* 文件 */
  fileInputRef: React.RefObject<HTMLInputElement>
  inputDivRef: React.RefObject<HTMLDivElement>
  onDraftChangeRef: React.MutableRefObject<(value: string) => void>
  handleFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void
  handlePaste: (e: React.ClipboardEvent) => void
  handleAddFiles: () => Promise<void>
  removeImage: (id: string) => void
  removeAsset: (id: string) => void
  toAssetName: (filePath: string) => string
  renderDraftToDiv: (div: HTMLDivElement, draftText: string) => void
  extractDivText: (div: HTMLDivElement) => string
  /* 语音 */
  isRecording: boolean
  toggleRecording: () => void
  elapsedSeconds: number
  /* 授权 */
  authLevel: 'auto' | 'standard'
  handleAuthLevelChange: (level: 'auto' | 'standard') => void
  authDropdownOpen: boolean
  setAuthDropdownOpen: (open: boolean) => void
  authDropdownRef: React.RefObject<HTMLDivElement>
  /* 自动提交 */
  autoCommit: boolean
  handleAutoCommitToggle: () => void
  /* 其他 */
  contextPercent: number
  projectId?: string
  supportsVision?: boolean
  t: (key: string) => string
  setPreviewImageUrl: (url: string | null) => void
}

export function InputArea({
  attachedImages,
  onAttachedImagesChange,
  attachedAssets: _attachedAssets,
  draft,
  onDraftChange,
  sending,
  hasProviders,
  workspace,
  onSendClick,
  onStop,
  queue,
  onRemoveFromQueue,
  provider,
  onProviderChange,
  configuredProviders,
  onOpenModels,
  fileInputRef,
  inputDivRef,
  onDraftChangeRef,
  handleFileSelect,
  handlePaste,
  handleAddFiles,
  removeImage,
  removeAsset: _removeAsset,
  toAssetName: _toAssetName,
  renderDraftToDiv,
  extractDivText,
  isRecording,
  toggleRecording,
  elapsedSeconds,
  authLevel,
  handleAuthLevelChange,
  authDropdownOpen,
  setAuthDropdownOpen,
  authDropdownRef,
  autoCommit,
  handleAutoCommitToggle,
  contextPercent,
  projectId,
  supportsVision,
  t,
  setPreviewImageUrl,
}: InputAreaProps) {
  // 同步 draft prop → contentEditable div
  useEffect(() => {
    const div = inputDivRef.current
    if (!div) return
    const divText = extractDivText(div)
    if (divText !== draft) {
      renderDraftToDiv(div, draft)
    }
  }, [draft])

  return (
    <footer className="composer">
      {queue.length > 0 && (
        <div className="queue-list">
          <div className="queue-header">排队中 ({queue.length})</div>
          {queue.map((item) => (
            <div key={item.id} className="queue-item">
              <span className="queue-text">{item.content}</span>
              <button
                type="button"
                className="queue-remove"
                onClick={() => onRemoveFromQueue(item.id)}
                aria-label="Remove from queue"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="composer-card">
        {/* 图片预览区 */}
        {attachedImages.length > 0 && (
          <div className="composer-images">
            {attachedImages.map((img) => (
              <div key={img.id} className="composer-image-item">
                {img.uploadStatus === 'uploading' && (
                  <div className="composer-image-upload-overlay">
                    <div className="composer-image-progress-bar" style={{ width: `${img.uploadProgress || 0}%` }} />
                    <span className="composer-image-progress-text">{img.uploadProgress || 0}%</span>
                  </div>
                )}
                {img.uploadStatus === 'done' && (
                  <div className="composer-image-done-overlay">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <circle cx="6" cy="6" r="6" fill="#22c55e"/>
                      <path d="M3.5 6l2 2 3-4" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </div>
                )}
                {img.uploadStatus === 'error' && (
                  <div className="composer-image-error-overlay">
                    <span>上传失败</span>
                  </div>
                )}
                {img.dataUrl && (
                  <img
                    src={img.dataUrl}
                    alt={img.name}
                    className="composer-image-thumb"
                    title="点击预览"
                    onClick={() => img.uploadStatus === 'done' && setPreviewImageUrl(img.dataUrl)}
                    style={{ opacity: img.uploadStatus === 'uploading' ? 0.5 : 1 }}
                  />
                )}
                <button
                  type="button"
                  className="composer-image-remove"
                  onClick={(e) => {
                    e.stopPropagation()
                    removeImage(img.id)
                  }}
                  title="移除图片"
                >×</button>
              </div>
            ))}
          </div>
        )}
        {/* 录音指示器 */}
        {isRecording && (
          <div className="voice-recording-bar">
            <span className="voice-recording-dot" />
            <span className="voice-recording-text">录音中... {elapsedSeconds}s</span>
            <span className="voice-recording-hint">再次点击麦克风按钮或✕结束</span>
            <button
              className="voice-recording-stop-btn"
              onClick={toggleRecording}
              title="停止录音"
            >
              ✕
            </button>
          </div>
        )}
        <div
          ref={inputDivRef}
          className="composer-input"
          contentEditable
          suppressContentEditableWarning
          data-placeholder={
            !hasProviders
              ? t('input.no_provider')
              : !workspace
                ? t('input.placeholder.no_workspace')
                : sending
                  ? t('input.placeholder.sending')
                  : t('input.placeholder.default')
          }
          onInput={(e) => {
            const target = e.currentTarget
            let text = ''
            for (const node of target.childNodes) {
              if (node.nodeType === Node.TEXT_NODE) {
                text += node.textContent
              } else if (node.nodeType === Node.ELEMENT_NODE) {
                const el = node as Element
                if (el.classList.contains('file-attachment-chip')) {
                  const path = el.getAttribute('data-file-path')
                  if (path) {
                    text += `[FILE]${path}[/FILE]`
                  }
                } else {
                  text += el.textContent
                }
              }
            }
            onDraftChange(text)
          }}
          onPaste={handlePaste}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              onSendClick()
            }
          }}
        />
        <input
          placeholder="选择图片"
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: 'none' }}
          onChange={handleFileSelect}
        />
        <div className="composer-row">
          <div className="composer-left">
            <button
              type="button"
              className="composer-attach-btn"
              onClick={() => handleAddFiles()}
              title={supportsVision ? t('input.attach_file') : '添加附件'}
              disabled={!hasProviders || !workspace}
            >
              <svg className="composer-btn-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M8.8 12.7l5.7-5.8a3.2 3.2 0 014.6 4.6l-7.2 7.2a5.1 5.1 0 01-7.2-7.2L12 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <ProviderSelect
              value={provider}
              options={configuredProviders}
              onChange={onProviderChange}
              disabled={!hasProviders}
              placeholder={t('input.no_provider')}
              onAddCustomModel={onOpenModels}
            />
            {contextPercent > 0 && (
              <div className="composer-context-bar" title={`上下文 ${contextPercent}%`}>
                <div className="composer-context-bar-track">
                  <div
                    className={`composer-context-bar-fill${contextPercent > 80 ? ' warn' : ''}`}
                    style={{ width: `${contextPercent}%` }}
                  />
                </div>
                <span className="composer-context-bar-label">{contextPercent}%</span>
              </div>
            )}
            {projectId && (
              <>
                <button
                  className={`composer-auto-commit-btn${autoCommit ? ' active' : ''}`}
                  onClick={handleAutoCommitToggle}
                  title={autoCommit ? '自动提交已开启，点击关闭' : '自动提交已关闭，点击开启'}
                >
                  <svg className="auto-commit-icon" viewBox="0 0 24 24" aria-hidden="true" width="13" height="13">
                    <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="1.8"/>
                    <path d="M8 12l3 3 5-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  <span className="auto-commit-label">自动提交</span>
                </button>
                <div className="composer-auth-dropdown" ref={authDropdownRef}>
                  <button
                    className="composer-auth-btn"
                    onClick={() => setAuthDropdownOpen(!authDropdownOpen)}
                    title="授权级别"
                    aria-expanded={authDropdownOpen}
                  >
                    {authLevel === 'auto' ? (
                      <svg className="auth-mode-icon" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M13 2L3 14h6l-2 8 10-12h-6l2-8z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    ) : (
                      <svg className="auth-mode-icon" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                        <path d="M9 12l2 2 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    )}
                    <span className="auth-mode-label">{authLevel === 'auto' ? '全自动' : '标准'}</span>
                    <svg className="auth-mode-arrow" viewBox="0 0 12 7" aria-hidden="true">
                      <path d="M1 1l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </button>
                  {authDropdownOpen && (
                    <div className="composer-auth-menu">
                      <div
                        className={`composer-auth-item${authLevel === 'standard' ? ' active' : ''}`}
                        onClick={() => { handleAuthLevelChange('standard'); setAuthDropdownOpen(false) }}
                      >
                        <svg className="auth-mode-icon" viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                          <path d="M9 12l2 2 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                        <div className="auth-item-text">
                          <span className="auth-item-title">标准模式</span>
                          <span className="auth-item-desc">高风险操作需确认</span>
                        </div>
                      </div>
                      <div
                        className={`composer-auth-item${authLevel === 'auto' ? ' active' : ''}`}
                        onClick={() => { handleAuthLevelChange('auto'); setAuthDropdownOpen(false) }}
                      >
                        <svg className="auth-mode-icon" viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M13 2L3 14h6l-2 8 10-12h-6l2-8z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                        <div className="auth-item-text">
                          <span className="auth-item-title">全自动模式</span>
                          <span className="auth-item-desc">所有操作自动执行</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
          <div className="composer-right">
            <button
              type="button"
              className={`composer-mic-btn${isRecording ? ' recording' : ''}`}
              onClick={toggleRecording}
              title={isRecording ? '点击结束录音' : '点击开始录音'}
              disabled={!hasProviders || !workspace}
            >
              {isRecording ? (
                <span className="mic-recording-dot" />
              ) : (
                <svg className="composer-btn-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  <line x1="12" y1="19" x2="12" y2="23" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  <line x1="8" y1="23" x2="16" y2="23" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              )}
            </button>
            {sending ? (
              <button
                className="send-btn stop"
                type="button"
                onClick={onStop}
                title={t('input.stop')}
              >
                <span className="stop-icon" />
              </button>
            ) : (
              <button
                title={t('input.send')}
                className="send-btn"
                type="button"
                onClick={onSendClick}
                disabled={!hasProviders || !workspace}
              >
                <svg className="send-btn-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 19V5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  <path d="M6.8 10.2L12 5l5.2 5.2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
    </footer>
  )
}
