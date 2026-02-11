import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DiffEditor } from '@monaco-editor/react'
import type { Monaco } from '@monaco-editor/react'
import type { editor as monacoEditor } from 'monaco-editor'
import type { FileChangeInfo, FileChangeStatus } from '../types'
import { computeDiff, diffStats } from '../lib/diff'
import { configureMonaco, getMonacoLanguage, MONACO_COMMON_OPTIONS } from '../lib/monaco-setup'

type DiffViewProps = {
  change: FileChangeInfo
  onClose?: () => void
  status?: FileChangeStatus
  onAccept?: () => void
  onReject?: () => void
  workspace?: string
  onSaved?: () => void
}

export function DiffView({
  change, onClose, status = 'pending', onAccept, onReject, workspace, onSaved,
}: DiffViewProps) {
  const [editing, setEditing] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [localNewContent, setLocalNewContent] = useState<string | null>(null)

  const diffEditorRef = useRef<monacoEditor.IStandaloneDiffEditor | null>(null)
  const editingRef = useRef(editing)
  editingRef.current = editing
  const handleSaveRef = useRef<() => void>(() => {})

  /** 切换文件时重置编辑状态 */
  useEffect(() => {
    setEditing(false)
    setEditContent('')
    setLocalNewContent(null)
  }, [change.filePath])

  const effectiveNewContent = localNewContent ?? change.newContent

  /* ---- Diff 统计 ---- */
  const diffLines = useMemo(
    () => computeDiff(change.oldContent, editing ? editContent : effectiveNewContent),
    [change.oldContent, effectiveNewContent, editing, editContent],
  )
  const stats = useMemo(() => diffStats(diffLines), [diffLines])

  const monacoLang = getMonacoLanguage(change.filePath)

  /* ---- 编辑操作 ---- */

  const handleStartEdit = useCallback(() => {
    setEditContent(effectiveNewContent ?? '')
    setEditing(true)
  }, [effectiveNewContent])

  const handleSave = useCallback(async () => {
    if (saving || !workspace) return
    setSaving(true)
    try {
      const absPath = change.filePath.startsWith('/')
        ? change.filePath
        : `${workspace}/${change.filePath}`
      await window.taco.file.write(absPath, editContent)
      setLocalNewContent(editContent)
      onSaved?.()
    } catch (err) {
      console.error('保存失败:', err)
    } finally {
      setSaving(false)
    }
  }, [saving, workspace, change.filePath, editContent, onSaved])

  handleSaveRef.current = handleSave

  /** Cmd/Ctrl+S 快捷键（仅编辑模式） */
  useEffect(() => {
    if (!editing) return
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        handleSaveRef.current()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [editing])

  /** Monaco 主题注册 */
  const handleBeforeMount = useCallback((monaco: Monaco) => {
    configureMonaco(monaco)
  }, [])

  /** DiffEditor 挂载回调 */
  const handleDiffMount = useCallback((diffEditor: monacoEditor.IStandaloneDiffEditor, monaco: Monaco) => {
    diffEditorRef.current = diffEditor
    const modEditor = diffEditor.getModifiedEditor()

    // 监听修改侧内容变化
    modEditor.onDidChangeModelContent(() => {
      if (editingRef.current) {
        setEditContent(modEditor.getValue())
      }
    })

    // 注册 Cmd+S 保存快捷键到修改侧
    modEditor.addAction({
      id: 'taco-diff-save',
      label: 'Save File',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => { handleSaveRef.current() },
    })
  }, [])

  /** 退出编辑模式时，恢复 modified 内容 */
  useEffect(() => {
    if (!editing && diffEditorRef.current) {
      const modEditor = diffEditorRef.current.getModifiedEditor()
      const model = modEditor.getModel()
      const target = effectiveNewContent ?? ''
      if (model && model.getValue() !== target) {
        model.setValue(target)
      }
    }
  }, [editing, effectiveNewContent])

  const isModified = editing && editContent !== (effectiveNewContent ?? '')

  const diffOptions = {
    ...MONACO_COMMON_OPTIONS,
    readOnly: !editing,
    originalEditable: false,
    renderSideBySide: true,
    enableSplitViewResizing: true,
    ignoreTrimWhitespace: false,
    renderIndicators: true,
    renderMarginRevertIcon: false,
  }

  return (
    <div className="diff-view-center">
      {/* ---- 头部 ---- */}
      <div className="diff-view-center-header">
        <div className="diff-view-center-title">
          <span className="diff-view-center-path">{change.filePath}</span>
          <span className="diff-summary">
            {change.oldContent === null && effectiveNewContent !== null ? (
              <span className="stat-add">新建文件</span>
            ) : effectiveNewContent === null && change.oldContent !== null ? (
              <span className="stat-remove">已删除</span>
            ) : (
              <>
                <span className="stat-add">+{stats.added}</span>
                <span className="stat-remove">-{stats.removed}</span>
              </>
            )}
          </span>
          {editing && <span className="diff-edit-mode-badge">编辑模式</span>}
        </div>

        <div className="diff-view-center-actions">
          {effectiveNewContent !== null && (
            <button
              type="button"
              className={`diff-action-btn edit ${editing ? 'active' : ''}`}
              onClick={editing ? () => setEditing(false) : handleStartEdit}
              title={editing ? '返回只读 Diff' : '编辑文件'}
            >
              {editing ? '◀ 只读' : '✎ 编辑'}
            </button>
          )}

          {editing && isModified && (
            <button
              type="button"
              className="diff-action-btn accept"
              onClick={handleSave}
              disabled={saving}
              title="保存 (⌘S)"
            >
              {saving ? '保存中...' : '💾 保存'}
            </button>
          )}

          {!editing && status === 'pending' && onAccept && (
            <button type="button" className="diff-action-btn accept" onClick={onAccept} title="确认变更">
              ✓ {effectiveNewContent === null ? '确认删除' : '保存'}
            </button>
          )}
          {!editing && status === 'pending' && onReject && (
            <button type="button" className="diff-action-btn reject" onClick={onReject} title="撤销变更">
              ✗ {change.oldContent === null ? '撤销创建' : effectiveNewContent === null ? '恢复文件' : '撤销修改'}
            </button>
          )}

          {status === 'accepted' && <span className="diff-status-badge accepted">已保存</span>}
          {status === 'rejected' && <span className="diff-status-badge rejected">已撤销</span>}

          {onClose && (
            <button type="button" className="diff-view-center-close" onClick={onClose} title="关闭">✕</button>
          )}
        </div>
      </div>

      {/* ---- Monaco Diff Editor ---- */}
      <div className="diff-view-monaco-body">
        <DiffEditor
          original={change.oldContent ?? ''}
          modified={editing ? editContent : (effectiveNewContent ?? '')}
          originalLanguage={monacoLang}
          modifiedLanguage={monacoLang}
          theme="taco-dark"
          beforeMount={handleBeforeMount}
          onMount={handleDiffMount}
          options={diffOptions}
          loading={<div className="file-editor-status">正在加载 Diff 编辑器...</div>}
        />
      </div>
    </div>
  )
}
