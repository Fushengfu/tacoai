import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Editor from '@monaco-editor/react'
import type { Monaco } from '@monaco-editor/react'
import type { editor as monacoEditor } from 'monaco-editor'
import type { FileTreeEntry } from '../../../shared/ipc'
import { configureMonaco, getMonacoLanguage, MONACO_COMMON_OPTIONS } from '../../lib/monaco-setup'

const MODEL_FILE_EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonc', 'md', 'mdx',
  'py', 'go', 'rs', 'dart', 'java', 'c', 'h', 'cpp', 'cc', 'cxx', 'hpp',
  'php', 'rb', 'swift', 'kt', 'kts', 'sh', 'bash', 'zsh', 'yml', 'yaml',
  'toml', 'ini', 'env', 'xml', 'sql', 'graphql', 'gql', 'txt', 'log', 'vue', 'svelte',
])
const MAX_WORKSPACE_MODELS = 120
const MAX_MODEL_FILE_SIZE = 300 * 1024

/** 根据文件扩展名获取显示标签 */
function getLanguageLabel(filePath: string): string {
  const ext = filePath.includes('.') ? filePath.split('.').pop()?.toLowerCase() : ''
  const map: Record<string, string> = {
    ts: 'TypeScript', tsx: 'TypeScript React', js: 'JavaScript', jsx: 'JavaScript React',
    json: 'JSON', html: 'HTML', css: 'CSS', scss: 'SCSS', less: 'LESS',
    md: 'Markdown', py: 'Python', rs: 'Rust', dart: 'Dart', go: 'Go', java: 'Java',
    c: 'C', cpp: 'C++', h: 'C Header', sh: 'Shell', bash: 'Bash',
    yml: 'YAML', yaml: 'YAML', toml: 'TOML', xml: 'XML', svg: 'SVG',
    sql: 'SQL', graphql: 'GraphQL', vue: 'Vue', svelte: 'Svelte',
    rb: 'Ruby', php: 'PHP', swift: 'Swift', kt: 'Kotlin',
    txt: 'Plain Text', env: 'Environment', gitignore: 'Git Ignore', log: 'Log',
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

function toSlashPath(input: string): string {
  return String(input ?? '').replace(/[\\]+/g, '/')
}

function toMonacoUriPath(absPath: string): string {
  const normalized = toSlashPath(absPath)
  if (/^[a-zA-Z]:\//.test(normalized)) return `file:///${encodeURI(normalized)}`
  if (normalized.startsWith('/')) return `file://${encodeURI(normalized)}`
  return `inmemory://model/${encodeURIComponent(normalized)}`
}

function shouldPreloadAsModel(relPath: string): boolean {
  const base = relPath.split('/').pop()?.toLowerCase() ?? ''
  if (base === '.env' || base === '.gitignore') return true
  const ext = base.includes('.') ? base.split('.').pop() ?? '' : ''
  return MODEL_FILE_EXTS.has(ext)
}

function flattenTreeFiles(entries: FileTreeEntry[], out: string[] = []): string[] {
  for (const entry of entries) {
    if (entry.isDirectory) {
      if (entry.children) flattenTreeFiles(entry.children, out)
      continue
    }
    out.push(entry.path)
  }
  return out
}

function workspaceRelativePath(absPath: string, workspace: string): string | null {
  const a = toSlashPath(absPath).replace(/\/+$/, '')
  const w = toSlashPath(workspace).replace(/\/+$/, '')
  if (!w) return null
  const aLower = a.toLowerCase()
  const wLower = w.toLowerCase()
  if (aLower === wLower) return ''
  if (aLower.startsWith(`${wLower}/`)) return a.slice(w.length + 1)
  return null
}

function toUri(monaco: Monaco, rawFileName: string): ReturnType<Monaco['Uri']['parse']> {
  const text = String(rawFileName ?? '')
  if (/^[a-zA-Z]:[\\/]/.test(text) || text.startsWith('/')) return monaco.Uri.file(text)
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)) return monaco.Uri.parse(text)
  return monaco.Uri.file(text)
}

type FileEditorProps = {
  filePath: string
  workspace: string
  onClose: () => void
  onSaved?: (change?: { filePath: string; oldContent: string | null; newContent: string | null }) => void
  onViewDiff?: () => void
  onNavigateToFile?: (filePath: string, line: number, column: number) => void
  initialSelection?: { line: number; column: number } | null
}

export function FileEditor({
  filePath,
  workspace,
  onClose,
  onSaved,
  onViewDiff,
  onNavigateToFile,
  initialSelection,
}: FileEditorProps) {
  const [content, setContent] = useState<string | null>(null)
  const [originalContent, setOriginalContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isBinary, setIsBinary] = useState(false)
  const [isTruncated, setIsTruncated] = useState(false)
  const [fileSize, setFileSize] = useState(0)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null)

  const editorRef = useRef<monacoEditor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<Monaco | null>(null)
  const mouseListenerRef = useRef<{ dispose: () => void } | null>(null)
  const handleSaveRef = useRef<() => void>(() => {})

  const absPath = useMemo(
    () => (filePath.startsWith('/') ? filePath : `${workspace.replace(/[\\/]+$/, '')}/${filePath}`),
    [filePath, workspace],
  )
  const monacoPath = useMemo(() => toMonacoUriPath(absPath), [absPath])
  const fileName = filePath.split('/').pop() ?? filePath
  const languageLabel = getLanguageLabel(filePath)
  const monacoLang = getMonacoLanguage(filePath)
  const isModified = content !== null && content !== originalContent
  const ext = filePath.includes('.') ? filePath.split('.').pop()?.toLowerCase() ?? '' : ''
  const isImageFile = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg'].includes(ext)

  /** 加载文件内容 */
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setSaved(false)
    setIsTruncated(false)
    setImageDataUrl(null)

    window.taco.file.read(absPath).then((result) => {
      if (cancelled) return
      setIsBinary(result.isBinary)
      setIsTruncated(result.truncated === true)
      setFileSize(result.size)
      setContent(result.content)
      setOriginalContent(result.content)
      setImageDataUrl(result.dataUrl ?? null)
      setLoading(false)
    }).catch((err: Error) => {
      if (cancelled) return
      setError(err.message || '读取文件失败')
      setLoading(false)
    })

    return () => { cancelled = true }
  }, [absPath])

  /** 预加载工作区文本模型，提升 Ctrl/Cmd+点击跨文件跳转命中率 */
  const preloadWorkspaceModels = useCallback(async (monaco: Monaco) => {
    try {
      const tree = await window.taco.workspace.tree(workspace)
      const fileList = flattenTreeFiles(tree)
        .filter((relPath) => relPath !== filePath)
        .filter((relPath) => shouldPreloadAsModel(relPath))
        .slice(0, MAX_WORKSPACE_MODELS)

      for (const relPath of fileList) {
        const absolute = relPath.startsWith('/') ? relPath : `${workspace.replace(/[\\/]+$/, '')}/${relPath}`
        const uri = monaco.Uri.parse(toMonacoUriPath(absolute))
        if (monaco.editor.getModel(uri)) continue
        const result = await window.taco.file.read(absolute)
        if (result.isBinary || result.truncated || result.content === null || result.size > MAX_MODEL_FILE_SIZE) continue
        monaco.editor.createModel(result.content, getMonacoLanguage(relPath), uri)
      }
    } catch {
      // 忽略预加载失败，不影响编辑器主体能力
    }
  }, [workspace, filePath])

  const ensureModelLoaded = useCallback(async (monaco: Monaco, uri: ReturnType<Monaco['Uri']['parse']>) => {
    const existing = monaco.editor.getModel(uri)
    if (existing) return existing
    if (uri.scheme !== 'file') return null
    try {
      const result = await window.taco.file.read(uri.fsPath)
      if (result.isBinary || result.truncated || result.content === null || result.size > MAX_MODEL_FILE_SIZE) return null
      return monaco.editor.createModel(result.content, getMonacoLanguage(uri.fsPath), uri)
    } catch {
      return null
    }
  }, [])

  const jumpToDefinition = useCallback(async (position: { lineNumber: number; column: number }) => {
    const editor = editorRef.current
    const monaco = monacoRef.current
    if (!editor || !monaco) return

    const model = editor.getModel()
    if (!model) return
    const language = model.getLanguageId()
    if (language !== 'typescript' && language !== 'javascript') return

    try {
      const getWorker = language === 'typescript'
        ? await monaco.languages.typescript.getTypeScriptWorker()
        : await monaco.languages.typescript.getJavaScriptWorker()
      const worker = await getWorker(model.uri)
      const offset = model.getOffsetAt(position)
      const definitions = await worker.getDefinitionAtPosition(model.uri.toString(), offset)
      if (!definitions || definitions.length === 0) return

      const target = definitions[0]
      const targetUri = toUri(monaco, target.fileName)
      const targetModel = await ensureModelLoaded(monaco, targetUri)
      const targetPosition = targetModel
        ? targetModel.getPositionAt(target.textSpan.start)
        : { lineNumber: 1, column: 1 }

      const sameModel = targetUri.toString() === model.uri.toString()
      if (sameModel) {
        editor.setPosition(targetPosition)
        editor.revealPositionInCenter(targetPosition)
        editor.focus()
        return
      }

      if (onNavigateToFile) {
        const relPath = workspaceRelativePath(targetUri.fsPath, workspace)
        if (relPath) {
          onNavigateToFile(relPath, targetPosition.lineNumber, targetPosition.column)
        }
      }
    } catch {
      // 忽略跳转失败，保持编辑器可用
    }
  }, [ensureModelLoaded, onNavigateToFile, workspace])

  /** 保存文件 */
  const handleSave = useCallback(async () => {
    if (content === null || isBinary || isTruncated || !isModified || saving) return
    setSaving(true)
    const previousContent = originalContent
    try {
      await window.taco.file.write(absPath, content)
      setOriginalContent(content)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
      onSaved?.({
        filePath,
        oldContent: previousContent,
        newContent: content,
      })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '保存失败'
      setError(msg)
    } finally {
      setSaving(false)
    }
  }, [content, isBinary, isModified, isTruncated, saving, originalContent, absPath, filePath, onSaved])

  handleSaveRef.current = handleSave

  /** Monaco 主题注册（在 Editor 创建之前） */
  const handleBeforeMount = useCallback((monaco: Monaco) => {
    configureMonaco(monaco)
    monaco.languages.typescript.typescriptDefaults.setEagerModelSync(true)
    monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
      allowJs: true,
      checkJs: true,
      allowNonTsExtensions: true,
      esModuleInterop: true,
      resolveJsonModule: true,
      target: monaco.languages.typescript.ScriptTarget.ES2022,
      module: monaco.languages.typescript.ModuleKind.ESNext,
      moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
      jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
    })
  }, [])

  /** Monaco 编辑器挂载回调 */
  const handleEditorDidMount = useCallback((editor: monacoEditor.IStandaloneCodeEditor, monaco: Monaco) => {
    editorRef.current = editor
    monacoRef.current = monaco

    // 注册 Cmd/Ctrl+S 保存快捷键
    editor.addAction({
      id: 'taco-save',
      label: 'Save File',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => { handleSaveRef.current() },
    })

    // 支持 F12 定义跳转
    editor.addAction({
      id: 'taco-go-to-definition',
      label: 'Go to Definition',
      keybindings: [monaco.KeyCode.F12],
      run: () => {
        const pos = editor.getPosition()
        if (!pos) return
        void jumpToDefinition(pos)
      },
    })

    mouseListenerRef.current?.dispose()
    mouseListenerRef.current = editor.onMouseDown((evt) => {
      const hasModifier = evt.event.metaKey || evt.event.ctrlKey
      if (!hasModifier || !evt.target.position) return
      void jumpToDefinition(evt.target.position)
    })

    void preloadWorkspaceModels(monaco)
  }, [jumpToDefinition, preloadWorkspaceModels])

  /** 编辑器内容变化 */
  const handleEditorChange = useCallback((value: string | undefined) => {
    setContent(value ?? '')
  }, [])

  useEffect(() => {
    if (!initialSelection || !editorRef.current) return
    const editor = editorRef.current
    const target = {
      lineNumber: Math.max(1, Math.floor(initialSelection.line)),
      column: Math.max(1, Math.floor(initialSelection.column)),
    }
    editor.setPosition(target)
    editor.revealPositionInCenter(target)
    editor.focus()
  }, [absPath, initialSelection])

  useEffect(() => {
    return () => {
      mouseListenerRef.current?.dispose()
      mouseListenerRef.current = null
    }
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
          {isTruncated && <span className="file-editor-truncated">尾部预览</span>}
        </div>
        <div className="file-editor-actions">
          {onViewDiff && (
            <button type="button" className="file-editor-btn diff" onClick={onViewDiff} title="查看变更 Diff">
              Diff
            </button>
          )}
          {!isTruncated && isModified && (
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
        ) : isImageFile && imageDataUrl ? (
          <div className="file-editor-image-wrap">
            <img src={imageDataUrl} alt={fileName} className="file-editor-image-preview" />
          </div>
        ) : isBinary ? (
          <div className="file-editor-status">
            <span>二进制文件，无法编辑</span>
            <span className="file-editor-size-detail">{formatSize(fileSize)}</span>
          </div>
        ) : content !== null ? (
          <Editor
            path={monacoPath}
            height="100%"
            language={monacoLang}
            value={content}
            theme="taco-dark"
            beforeMount={handleBeforeMount}
            onChange={handleEditorChange}
            onMount={handleEditorDidMount}
            options={{ ...MONACO_COMMON_OPTIONS, readOnly: isTruncated }}
            loading={<div className="file-editor-status">正在加载编辑器...</div>}
          />
        ) : (
          <div className="file-editor-status">无法读取文件内容</div>
        )}
      </div>
    </div>
  )
}
