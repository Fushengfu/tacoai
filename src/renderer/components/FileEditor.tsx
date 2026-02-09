import { useCallback, useEffect, useRef, useState } from 'react'
import Editor from '@monaco-editor/react'
import type { Monaco } from '@monaco-editor/react'
import type { editor as monacoEditor } from 'monaco-editor'
import { configureMonaco, getMonacoLanguage, MONACO_COMMON_OPTIONS } from '../lib/monaco-setup'

/** 根据文件扩展名获取显示标签 */
function getLanguageLabel(filePath: string): string {
  const ext = filePath.includes('.') ? filePath.split('.').pop()?.toLowerCase() : ''
  const map: Record<string, string> = {
    ts: 'TypeScript', tsx: 'TypeScript React', js: 'JavaScript', jsx: 'JavaScript React',
    json: 'JSON', html: 'HTML', css: 'CSS', scss: 'SCSS', less: 'LESS',
    md: 'Markdown', py: 'Python', rs: 'Rust', go: 'Go', java: 'Java',
    c: 'C', cpp: 'C++', h: 'C Header', sh: 'Shell', bash: 'Bash',
    yml: 'YAML', yaml: 'YAML', toml: 'TOML', xml: 'XML', svg: 'SVG',
    sql: 'SQL', graphql: 'GraphQL', vue: 'Vue', svelte: 'Svelte',
    rb: 'Ruby', php: 'PHP', swift: 'Swift', kt: 'Kotlin',
    txt: 'Plain Text', env: 'Environment', gitignore: 'Git Ignore',
  }
  if (!ext) return 'Plain Text'
  return map[ext] ?? ext.toUpperCase()
}

/** 格式化文件大小 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

type FileEditorProps = {
  filePath: string
  workspace: string
  onClose: () => void
  onSaved?: () => void
  onViewDiff?: () => void
}

export function FileEditor({ filePath, workspace, onClose, onSaved, onViewDiff }: FileEditorProps) {
  const [content, setContent] = useState<string | null>(null)
  const [originalContent, setOriginalContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isBinary, setIsBinary] = useState(false)
  const [fileSize, setFileSize] = useState(0)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const editorRef = useRef<monacoEditor.IStandaloneCodeEditor | null>(null)
  const handleSaveRef = useRef<() => void>(() => {})

  const absPath = filePath.startsWith('/') ? filePath : `${workspace}/${filePath}`
  const fileName = filePath.split('/').pop() ?? filePath
  const languageLabel = getLanguageLabel(filePath)
  const monacoLang = getMonacoLanguage(filePath)
  const isModified = content !== null && content !== originalContent

  /** 加载文件内容 */
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setSaved(false)

    window.taco.file.read(absPath).then((result) => {
      if (cancelled) return
      setIsBinary(result.isBinary)
      setFileSize(result.size)
      setContent(result.content)
      setOriginalContent(result.content)
      setLoading(false)
    }).catch((err: Error) => {
      if (cancelled) return
      setError(err.message || '读取文件失败')
      setLoading(false)
    })

    return () => { cancelled = true }
  }, [absPath])

  /** 保存文件 */
  const handleSave = useCallback(async () => {
    if (content === null || !isModified || saving) return
    setSaving(true)
    try {
      await window.taco.file.write(absPath, content)
      setOriginalContent(content)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
      onSaved?.()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '保存失败'
      setError(msg)
    } finally {
      setSaving(false)
    }
  }, [content, isModified, saving, absPath, onSaved])

  handleSaveRef.current = handleSave

  /** Monaco 主题注册（在 Editor 创建之前） */
  const handleBeforeMount = useCallback((monaco: Monaco) => {
    configureMonaco(monaco)
  }, [])

  /** Monaco 编辑器挂载回调 */
  const handleEditorDidMount = useCallback((editor: monacoEditor.IStandaloneCodeEditor, monaco: Monaco) => {
    editorRef.current = editor

    // 注册 Cmd/Ctrl+S 保存快捷键
    editor.addAction({
      id: 'taco-save',
      label: 'Save File',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => { handleSaveRef.current() },
    })
  }, [])

  /** 编辑器内容变化 */
  const handleEditorChange = useCallback((value: string | undefined) => {
    setContent(value ?? '')
  }, [])

  const lineCount = content?.split('\n').length ?? 0

  return (
    <div className="file-editor">
      {/* 顶栏 */}
      <div className="file-editor-header">
        <div className="file-editor-title">
          <span className="file-editor-filename">{fileName}</span>
          <span className="file-editor-path">{filePath}</span>
          {isModified && <span className="file-editor-modified">●</span>}
        </div>
        <div className="file-editor-meta">
          <span className="file-editor-lang">{languageLabel}</span>
          <span className="file-editor-size">{formatSize(fileSize)}</span>
          {!isBinary && <span className="file-editor-lines">{lineCount} 行</span>}
        </div>
        <div className="file-editor-actions">
          {onViewDiff && (
            <button type="button" className="file-editor-btn diff" onClick={onViewDiff} title="查看变更 Diff">
              Diff
            </button>
          )}
          {isModified && (
            <button
              type="button"
              className="file-editor-btn save"
              onClick={handleSave}
              disabled={saving}
              title="保存 (⌘S)"
            >
              {saving ? '保存中...' : '保存'}
            </button>
          )}
          {saved && <span className="file-editor-saved">✓ 已保存</span>}
          <button type="button" className="file-editor-btn close" onClick={onClose} title="关闭">✕</button>
        </div>
      </div>

      {/* 内容区 */}
      <div className="file-editor-body">
        {loading ? (
          <div className="file-editor-status">加载中...</div>
        ) : error ? (
          <div className="file-editor-status error">{error}</div>
        ) : isBinary ? (
          <div className="file-editor-status">
            <span>二进制文件，无法编辑</span>
            <span className="file-editor-size-detail">{formatSize(fileSize)}</span>
          </div>
        ) : content !== null ? (
          <Editor
            height="100%"
            language={monacoLang}
            value={content}
            theme="taco-dark"
            beforeMount={handleBeforeMount}
            onChange={handleEditorChange}
            onMount={handleEditorDidMount}
            options={MONACO_COMMON_OPTIONS}
            loading={<div className="file-editor-status">正在加载编辑器...</div>}
          />
        ) : (
          <div className="file-editor-status">无法读取文件内容</div>
        )}
      </div>
    </div>
  )
}
