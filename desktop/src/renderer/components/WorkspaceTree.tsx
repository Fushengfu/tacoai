/**
 * WorkspaceTree — 工作区目录浏览器
 *
 * 顶栏文件夹按钮触发，展开后占满顶部栏下方整个主区域：
 * 左侧目录树，右侧预览区（Monaco 编辑器 / Diff 对比）。
 * 点击文件节点 → 预览/编辑，Ctrl+S 保存；支持 Git 变更对比。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { FileTreeEntry } from '../../shared/ipc'
import { FileEditor } from '../views/editor/FileEditor'
import { DiffEditor } from '@monaco-editor/react'
import type { Monaco } from '@monaco-editor/react'
import { configureMonaco, getMonacoLanguage, MONACO_COMMON_OPTIONS } from '../lib/monaco-setup'
import './WorkspaceTree.css'

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

export interface WorkspaceTreeProps {
  workspace: string
  className?: string
  /** 受控模式：外部传入的开关状态 */
  isOpen?: boolean
  /** 受控模式：开关变化回调 */
  onOpenChange?: (open: boolean) => void
}

/* ------------------------------------------------------------------ */
/*  文件图标 — 按扩展名/文件名匹配 SVG                                  */
/* ------------------------------------------------------------------ */

/** 获取文件名（去掉路径） */
function getBaseName(path: string): string {
  return path.split('/').pop() ?? path.split('\\').pop() ?? path
}

/** 获取小写扩展名（无点号） */
function getExt(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

type IconDef = { color: string; svg: JSX.Element }

/** 颜色按语言语义 */
const ICON_COLORS: Record<string, string> = {
  ts: '#3178C6', tsx: '#3178C6',
  js: '#F7DF1E', jsx: '#F7DF1E', mjs: '#F7DF1E', cjs: '#F7DF1E',
  json: '#757575', jsonc: '#757575',
  html: '#E34F26', htm: '#E34F26',
  css: '#1572B6',
  scss: '#CC6699', sass: '#CC6699', less: '#1D365D',
  md: '#757575', mdx: '#757575',
  py: '#3776AB', pyc: '#3776AB', pyo: '#3776AB',
  java: '#ED8B00', class: '#ED8B00',
  c: '#555555', h: '#757575',
  cpp: '#00599C', cc: '#00599C', cxx: '#00599C', hpp: '#757575',
  go: '#00ADD8',
  rs: '#DEA584',
  swift: '#F05138',
  kt: '#7F52FF', kts: '#7F52FF',
  dart: '#0175C2',
  rb: '#CC342D',
  php: '#777BB4',
  vue: '#4FC08D',
  svelte: '#FF3E00',
  yml: '#CB171E', yaml: '#CB171E',
  xml: '#E34F26', svg: '#FFB13B',
  sql: '#336791', sqlite: '#336791',
  sh: '#4EAA25', bash: '#4EAA25', zsh: '#4EAA25', fish: '#4EAA25',
  toml: '#9C4221',
  ini: '#757575', cfg: '#757575', conf: '#757575',
  graphql: '#E10098', gql: '#E10098',
  dockerfile: '#2496ED',
  makefile: '#777777',
  env: '#ECD53F',
  txt: '#757575', log: '#757575',
  gitignore: '#F05032', gitattributes: '#F05032', gitmodules: '#F05032',
}

/** 扩展名 → 简称（显示在图标内） */
const EXT_LABEL: Record<string, string> = {
  ts: 'TS', tsx: 'TS',
  js: 'JS', jsx: 'JS', mjs: 'JS', cjs: 'JS',
  json: '{}', jsonc: '{}',
  html: '<>', htm: '<>',
  css: '#', scss: '#', sass: '#', less: '#',
  md: 'MD', mdx: 'MD',
  py: 'PY',
  java: 'JV',
  c: 'C',
  cpp: 'C+', cc: 'C+', cxx: 'C+',
  h: 'H', hpp: 'H',
  go: 'Go',
  rs: 'RS',
  swift: 'SW',
  kt: 'KT', kts: 'KT',
  dart: 'DT',
  rb: 'RB',
  php: 'PH',
  vue: 'VU',
  svelte: 'SV',
  yml: 'YM', yaml: 'YM',
  xml: 'XM', svg: 'SV',
  sql: 'SQ', sqlite: 'SQ',
  sh: 'SH', bash: 'SH', zsh: 'SH', fish: 'SH',
  toml: 'TO',
  ini: 'IN', cfg: 'CF', conf: 'CF',
  graphql: 'GQ', gql: 'GQ',
  dockerfile: 'DK',
  makefile: 'MK',
  env: 'EN',
  txt: 'TX', log: 'LG',
  gitignore: 'GI', gitattributes: 'GI', gitmodules: 'GI',
  png: 'IM', jpg: 'IM', jpeg: 'IM', gif: 'IM', webp: 'IM', bmp: 'IM', ico: 'IM',
  pdf: 'PD', zip: 'ZP', gz: 'GZ', tar: 'TA', rar: 'RA', '7z': '7Z',
  lock: 'LK',
}

/** 特殊文件名映射（无扩展名或有特殊含义的文件） */
const SPECIAL_FILES: Record<string, IconDef> = {
  'dockerfile': { color: '#2496ED', svg: <text x="8" y="11" textAnchor="middle" fontSize="8" fontWeight="700" fill="#fff">DK</text> },
  'makefile': { color: '#777777', svg: <text x="8" y="11" textAnchor="middle" fontSize="8" fontWeight="700" fill="#fff">MK</text> },
  'license': { color: '#F7DF1E', svg: <text x="8" y="11" textAnchor="middle" fontSize="7" fontWeight="700" fill="#333">LIC</text> },
  '.gitignore': { color: '#F05032', svg: <text x="8" y="11" textAnchor="middle" fontSize="7" fontWeight="700" fill="#fff">GI</text> },
  '.gitattributes': { color: '#F05032', svg: <text x="8" y="11" textAnchor="middle" fontSize="7" fontWeight="700" fill="#fff">GI</text> },
  '.gitmodules': { color: '#F05032', svg: <text x="8" y="11" textAnchor="middle" fontSize="7" fontWeight="700" fill="#fff">GI</text> },
  '.env': { color: '#ECD53F', svg: <text x="8" y="11" textAnchor="middle" fontSize="7" fontWeight="700" fill="#333">EN</text> },
  '.env.local': { color: '#ECD53F', svg: <text x="8" y="11" textAnchor="middle" fontSize="7" fontWeight="700" fill="#333">EN</text> },
  '.env.development': { color: '#ECD53F', svg: <text x="8" y="11" textAnchor="middle" fontSize="6" fontWeight="700" fill="#333">EN</text> },
  '.env.production': { color: '#ECD53F', svg: <text x="8" y="11" textAnchor="middle" fontSize="6" fontWeight="700" fill="#333">EN</text> },
}

/** 获取文件图标（inline SVG 14x14） */
function getFileIcon(entry: FileTreeEntry): JSX.Element {
  const name = entry.name.toLowerCase()
  const ext = getExt(name)

  // 特殊文件名
  const special = SPECIAL_FILES[name]
  if (special) {
    return (
      <svg viewBox="0 0 16 16" width="16" height="16" className="wst-file-icon-svg">
        <rect x="1" y="2" width="14" height="12" rx="2" fill={special.color} />
        {special.svg}
      </svg>
    )
  }

  // 图片文件
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg'].includes(ext)) {
    return (
      <svg viewBox="0 0 16 16" width="16" height="16" className="wst-file-icon-svg">
        <rect x="1" y="2" width="14" height="12" rx="2" fill="#9B59B6" />
        <circle cx="7" cy="7" r="2" fill="rgba(255,255,255,0.5)" />
        <path d="M4 14l3-4 2 2 3-3 2 3v2H4z" fill="rgba(255,255,255,0.35)" />
      </svg>
    )
  }

  // 压缩文件
  if (['zip', 'gz', 'tar', 'rar', '7z', 'bz2', 'xz'].includes(ext)) {
    return (
      <svg viewBox="0 0 16 16" width="16" height="16" className="wst-file-icon-svg">
        <rect x="1" y="2" width="14" height="12" rx="2" fill="#8E44AD" />
        <rect x="5" y="5" width="6" height="1" rx="0.5" fill="rgba(255,255,255,0.6)" />
        <rect x="5" y="7" width="6" height="1" rx="0.5" fill="rgba(255,255,255,0.6)" />
        <rect x="5" y="9" width="4" height="1" rx="0.5" fill="rgba(255,255,255,0.4)" />
      </svg>
    )
  }

  // 有扩展名的文件
  if (ext && (ICON_COLORS[ext] || EXT_LABEL[ext])) {
    const color = ICON_COLORS[ext] || '#757575'
    const label = EXT_LABEL[ext] || ext.slice(0, 2).toUpperCase()
    const fontSize = label.length <= 2 ? '8' : '7'
    return (
      <svg viewBox="0 0 16 16" width="16" height="16" className="wst-file-icon-svg">
        <rect x="1" y="2" width="14" height="12" rx="2" fill={color} />
        <text x="8" y="11" textAnchor="middle" fontSize={fontSize} fontWeight="700" fill="#fff" fontFamily="system-ui, sans-serif">{label}</text>
      </svg>
    )
  }

  // 默认文件图标
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" className="wst-file-icon-svg">
      <rect x="1" y="2" width="14" height="12" rx="2" fill="#757575" opacity="0.5" />
      <text x="8" y="11" textAnchor="middle" fontSize="7" fontWeight="700" fill="#fff" opacity="0.7">?</text>
    </svg>
  )
}

/* ------------------------------------------------------------------ */
/*  TreeNode — 递归树节点                                              */
/* ------------------------------------------------------------------ */

/** Git 状态 → 徽标映射 */
const STATUS_BADGE: Record<string, { label: string; color: string; title: string }> = {
  M: { label: 'M', color: '#f0c84d', title: '已修改 (Modified)' },
  A: { label: 'A', color: '#3fb950', title: '已新增暂存 (Added)' },
  D: { label: 'D', color: '#f85149', title: '已删除 (Deleted)' },
  '?': { label: 'U', color: '#6b8cff', title: '未跟踪 (Untracked)' },
  R: { label: 'R', color: '#a371f7', title: '已重命名 (Renamed)' },
  C: { label: 'C', color: '#00add8', title: '已复制 (Copied)' },
}

const DEFAULT_BADGE = { label: '●', color: '#f0c84d', title: '有变更' }

function StatusBadge({ status }: { status: string }) {
  const badge = STATUS_BADGE[status] || DEFAULT_BADGE
  return (
    <span
      className="wst-status-badge"
      style={{ background: badge.color }}
      title={badge.title}
    >
      {badge.label}
    </span>
  )
}

function TreeNode({
  entry,
  depth,
  onFileClick,
  onContextMenu,
  fileStatuses,
  changedDirs,
  expandedPaths,
  onToggleDir,
}: {
  entry: FileTreeEntry
  depth: number
  onFileClick: (file: FileTreeEntry) => void
  onContextMenu: (e: React.MouseEvent, entry: FileTreeEntry) => void
  fileStatuses: Record<string, string>
  changedDirs: Set<string>
  expandedPaths: Set<string>
  onToggleDir: (path: string) => void
}) {
  const expanded = expandedPaths.has(entry.path)

  /* 文件节点 */
  if (!entry.isDirectory) {
    const status = fileStatuses[entry.path]
    const isChanged = !!status
    return (
      <div
        className={`wst-node wst-file wst-clickable${isChanged ? ' wst-changed' : ''}`}
        style={{ paddingLeft: `${12 + depth * 14}px` }}
        onClick={() => onFileClick(entry)}
        onContextMenu={(e) => onContextMenu(e, entry)}
        title={`打开 ${entry.name}${status ? ` (${STATUS_BADGE[status]?.title || '已变更'})` : ''}`}
      >
        <span className="wst-icon">{getFileIcon(entry)}</span>
        <span className="wst-name">{entry.name}</span>
        {isChanged && <StatusBadge status={status} />}
      </div>
    )
  }

  /* 目录节点 */
  const hasChildren = entry.children && entry.children.length > 0
  const hasChanges = changedDirs.has(entry.path)

  return (
    <div className="wst-node wst-dir">
      <div
        className={`wst-dir-row${hasChanges ? ' wst-changed' : ''}`}
        style={{ paddingLeft: `${depth * 14}px` }}
        onClick={() => onToggleDir(entry.path)}
        onContextMenu={(e) => onContextMenu(e, entry)}
      >
        <span className={`wst-arrow ${expanded ? 'wst-expanded' : ''}`}>
          {hasChildren ? (
            <svg viewBox="0 0 8 12" width="8" height="10">
              <path d="M1 1l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <span className="wst-no-arrow" />
          )}
        </span>
        <span className={`wst-icon wst-icon-folder ${expanded ? 'wst-folder-open' : ''}`}>
          {expanded ? (
            <svg viewBox="0 0 16 16" width="14" height="14">
              <path d="M1.75 4.25A1.25 1.25 0 0 1 3 3h3l1.25 1.1h5.25a1.25 1.25 0 0 1 1.25 1.25V6H2.5v-.5a1 1 0 0 1 .5-.75z" fill="currentColor" opacity="0.45" />
              <path d="M2 6h12v7.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 13.5V6z" fill="currentColor" opacity="0.75" />
              <rect x="6" y="8" width="4" height="0.8" rx="0.4" fill="rgba(255,255,255,0.2)" />
              <rect x="6" y="10" width="2.5" height="0.8" rx="0.4" fill="rgba(255,255,255,0.15)" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" width="14" height="14">
              <path d="M2 4.5A1.75 1.75 0 0 1 3.75 2.75h3l1.33 1.25h4.67A1.75 1.75 0 0 1 14.5 5.75v6A1.75 1.75 0 0 1 12.75 13.5H3.75A1.75 1.75 0 0 1 2 11.75V4.5z" fill="currentColor" opacity="0.8" />
            </svg>
          )}
        </span>
        <span className="wst-name">{entry.name}</span>
        {hasChanges && <StatusBadge status="M" />}
        {hasChildren && (
          <span className="wst-count">{entry.children!.length}</span>
        )}
      </div>
      {expanded && hasChildren && (
        <div className="wst-children">
          {entry.children!.map((child) => (
            <TreeNode key={child.path} entry={child} depth={depth + 1} onFileClick={onFileClick} onContextMenu={onContextMenu} fileStatuses={fileStatuses} changedDirs={changedDirs} expandedPaths={expandedPaths} onToggleDir={onToggleDir} />
          ))}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  ContextMenu — 右键上下文菜单                                        */
/* ------------------------------------------------------------------ */

type MenuAction = 'createFile' | 'createDir' | 'rename' | 'delete'

interface ContextMenuState {
  x: number
  y: number
  entry: FileTreeEntry
}

function ContextMenu({
  state,
  onAction,
  onClose,
}: {
  state: ContextMenuState
  onAction: (action: MenuAction, entry: FileTreeEntry) => void
  onClose: () => void
}) {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handler)
    document.addEventListener('keydown', keyHandler)
    return () => {
      document.removeEventListener('mousedown', handler)
      document.removeEventListener('keydown', keyHandler)
    }
  }, [onClose])

  const items: { action: MenuAction; label: string }[] = state.entry.isDirectory
    ? [
        { action: 'createFile', label: '新建文件' },
        { action: 'createDir', label: '新建目录' },
        { action: 'rename', label: '重命名' },
        { action: 'delete', label: '删除' },
      ]
    : [
        { action: 'rename', label: '重命名' },
        { action: 'delete', label: '删除' },
      ]

  return (
    <div
      ref={menuRef}
      className="wst-context-menu"
      style={{ left: state.x, top: state.y }}
    >
      {items.map((item) => (
        <div
          key={item.action}
          className="wst-context-menu-item"
          onClick={() => onAction(item.action, state.entry)}
        >
          {item.label}
        </div>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  InputDialog — 输入弹窗（创建/重命名）                               */
/* ------------------------------------------------------------------ */

function InputDialog({
  title,
  placeholder,
  defaultValue,
  onConfirm,
  onCancel,
}: {
  title: string
  placeholder: string
  defaultValue?: string
  onConfirm: (value: string) => void
  onCancel: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(defaultValue ?? '')

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const handleSubmit = () => {
    const trimmed = value.trim()
    if (trimmed) onConfirm(trimmed)
  }

  return (
    <div className="wst-dialog-overlay" onClick={onCancel}>
      <div className="wst-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="wst-dialog-title">{title}</div>
        <input
          ref={inputRef}
          className="wst-dialog-input"
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSubmit()
            if (e.key === 'Escape') onCancel()
          }}
        />
        <div className="wst-dialog-actions">
          <button className="wst-dialog-btn wst-dialog-btn-cancel" onClick={onCancel}>取消</button>
          <button className="wst-dialog-btn wst-dialog-btn-ok" onClick={handleSubmit}>确定</button>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  ConfirmDialog — 确认删除弹窗                                        */
/* ------------------------------------------------------------------ */

function ConfirmDialog({
  entry,
  onConfirm,
  onCancel,
}: {
  entry: FileTreeEntry
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="wst-dialog-overlay" onClick={onCancel}>
      <div className="wst-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="wst-dialog-title">确认删除</div>
        <div className="wst-dialog-body">
          确定要删除 {entry.isDirectory ? '目录' : '文件'}「{entry.name}」吗？此操作不可撤销。
        </div>
        <div className="wst-dialog-actions">
          <button className="wst-dialog-btn wst-dialog-btn-cancel" onClick={onCancel}>取消</button>
          <button className="wst-dialog-btn wst-dialog-btn-danger" onClick={onConfirm}>删除</button>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  FileDiffView — Monaco DiffEditor 变更对比视图                       */
/* ------------------------------------------------------------------ */

function FileDiffView({
  filePath,
  absPath,
  workspace,
}: {
  filePath: string
  absPath: string
  workspace: string
}) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [original, setOriginal] = useState<string>('')
  const [modified, setModified] = useState<string>('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    const load = async () => {
      try {
        const change = await window.taco.git.fileChange(workspace, filePath)
        if (cancelled) return

        if (change) {
          // Git 仓库中：oldContent 可能为 null（新文件），newContent 不为 null
          setOriginal(change.oldContent ?? '')
          setModified(change.newContent ?? '')
        } else {
          // 不是 Git 仓库：回退到 file.read() 直接加载文件内容
          const result = await window.taco.file.read(absPath)
          if (cancelled) return
          if (result.isBinary) {
            setError('二进制文件无法预览')
          } else {
            const content = result.content ?? ''
            setOriginal(content)
            setModified(content)
          }
        }
        setLoading(false)
      } catch (err: any) {
        if (cancelled) return
        console.error('[FileDiffView] 加载 diff 失败:', err)
        setError(err?.message || '加载失败')
        setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [workspace, filePath, absPath])

  const fileName = filePath.split('/').pop() ?? filePath
  const language = getMonacoLanguage(fileName)

  const handleBeforeMount = (monacoInstance: Monaco) => {
    configureMonaco(monacoInstance)
  }

  return (
    <div className="wst-diff">
      {/* diff 头部 */}
      <div className="wst-diff-header">
        <div className="wst-diff-title">
          <span className="wst-diff-filename">{fileName}</span>
          <span className="wst-diff-path">{filePath}</span>
        </div>
        <div className="wst-diff-stats">
          {!loading && !error && (
            <span className="wst-diff-label">变更对比</span>
          )}
        </div>
      </div>

      {/* diff 内容：Monaco DiffEditor */}
      <div className="wst-diff-body">
        {loading ? (
          <div className="wst-diff-state">加载中...</div>
        ) : error ? (
          <div className="wst-diff-state wst-diff-error">{error}</div>
        ) : (
          <DiffEditor
            language={language}
            original={original}
            modified={modified}
            theme="taco-dark"
            beforeMount={handleBeforeMount}
            options={{
              ...MONACO_COMMON_OPTIONS,
              readOnly: true,
              renderSideBySide: true,
            }}
          />
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  WorkspaceTree 主组件                                               */
/* ------------------------------------------------------------------ */

const DEFAULT_TREE_WIDTH = 280
const MIN_TREE_WIDTH = 180
const MAX_TREE_WIDTH = 500

export function WorkspaceTree({ workspace, className, isOpen: isOpenProp, onOpenChange }: WorkspaceTreeProps) {
  const [isOpenInternal, setIsOpenInternal] = useState(false)
  const isControlled = isOpenProp !== undefined
  const isOpen = isControlled ? isOpenProp : isOpenInternal

  const setIsOpen = useCallback((next: boolean) => {
    if (isControlled) {
      onOpenChange?.(next)
    } else {
      setIsOpenInternal(next)
    }
  }, [isControlled, onOpenChange])
  const [tree, setTree] = useState<FileTreeEntry[]>([])
  const [treeLoading, setTreeLoading] = useState(false)
  const [treeError, setTreeError] = useState<string | null>(null)
  const [openFiles, setOpenFiles] = useState<FileTreeEntry[]>([])
  const [activeFileIndex, setActiveFileIndex] = useState<number>(-1)
  /* 全局视图模式：编辑 / 变更 — 对所有文件生效 */
  const [viewMode, setViewMode] = useState<'edit' | 'diff'>('edit')

  /* 当前激活的文件 */
  const activeFile = activeFileIndex >= 0 ? openFiles[activeFileIndex] : null

  /* 关闭指定标签 */
  const handleCloseTab = useCallback((index: number) => {
    setOpenFiles(prev => {
      if (index < 0 || index >= prev.length) return prev
      const newFiles = prev.filter((_, i) => i !== index)
      const newActive = newFiles.length === 0 ? -1 : Math.min(index, newFiles.length - 1)
      setActiveFileIndex(newActive)
      return newFiles
    })
  }, [])

  /* 关闭当前激活标签 */
  const closeActiveTab = useCallback(() => {
    handleCloseTab(activeFileIndex)
  }, [activeFileIndex, handleCloseTab])
  const [treeWidth, setTreeWidth] = useState(DEFAULT_TREE_WIDTH)
  const [fileStatuses, setFileStatuses] = useState<Record<string, string>>({})
  const [changedDirs, setChangedDirs] = useState<Set<string>>(new Set())

  /* 已展开的目录路径集合（跨刷新保持） */
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())

  const handleToggleDir = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }, [])

  /* 右键菜单 */
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  /* 输入弹窗 */
  const [dialog, setDialog] = useState<{
    type: 'createFile' | 'createDir' | 'rename'
    entry: FileTreeEntry  // create 时为父目录，rename 时为要重命名的条目
    defaultName?: string
  } | null>(null)
  /* 删除确认 */
  const [confirmDelete, setConfirmDelete] = useState<FileTreeEntry | null>(null)

  /* 刷新目录树标记 */
  const treeDirtyRef = useRef(false)

  /* 拖拽调整宽度 */
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragRef.current = { startX: e.clientX, startW: treeWidth }
  }, [treeWidth])

  useEffect(() => {
    if (!isOpen) return

    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) return
      const delta = e.clientX - dragRef.current.startX
      const next = Math.round(dragRef.current.startW + delta)
      setTreeWidth(Math.max(MIN_TREE_WIDTH, Math.min(MAX_TREE_WIDTH, next)))
    }

    const onUp = () => {
      dragRef.current = null
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [isOpen])

  /* 加载目录树（首次打开，显示加载状态） */
  const loadTree = useCallback(async () => {
    setTreeLoading(true)
    setTreeError(null)
    try {
      const [data, gitStatus] = await Promise.all([
        window.taco.workspace.tree(workspace),
        window.taco.git.status(workspace).catch(() => null),
      ])
      setTree(data)

      // 计算变更文件 & 变更目录集合
      if (gitStatus) {
        const dirs = new Set<string>()
        for (const file of Object.keys(gitStatus.fileStatuses)) {
          const parts = file.split('/')
          for (let i = 1; i < parts.length; i++) {
            dirs.add(parts.slice(0, i).join('/'))
          }
        }
        setFileStatuses(gitStatus.fileStatuses)
        setChangedDirs(dirs)
      } else {
        setFileStatuses({})
        setChangedDirs(new Set())
      }

      if (data.length === 0) {
        setTreeError('目录为空')
      }
    } catch (err: any) {
      console.error('[WorkspaceTree] 加载目录树失败:', err)
      setTreeError(err?.message || '加载失败')
      setTree([])
    } finally {
      setTreeLoading(false)
    }
  }, [workspace])

  /* 静默刷新目录树（不显示加载状态，避免闪屏） */
  const refreshTree = useCallback(async (force = false) => {
    try {
      const [data, gitStatus] = await Promise.all([
        window.taco.workspace.tree(workspace, force),
        window.taco.git.status(workspace).catch(() => null),
      ])
      setTree(data)

      if (gitStatus) {
        const dirs = new Set<string>()
        for (const file of Object.keys(gitStatus.fileStatuses)) {
          const parts = file.split('/')
          for (let i = 1; i < parts.length; i++) {
            dirs.add(parts.slice(0, i).join('/'))
          }
        }
        setFileStatuses(gitStatus.fileStatuses)
        setChangedDirs(dirs)
      } else {
        setFileStatuses({})
        setChangedDirs(new Set())
      }
    } catch (err: any) {
      console.error('[WorkspaceTree] 刷新目录树失败:', err)
    }
  }, [workspace])

  /* 打开面板 */
  const open = useCallback(() => {
    setIsOpen(true)
    loadTree()
    treeDirtyRef.current = false
  }, [loadTree, setIsOpen])

  /* 关闭面板 */
  const close = useCallback(() => {
    setIsOpen(false)
    setOpenFiles([])
    setActiveFileIndex(-1)
    setViewMode('edit')
    setFileStatuses({})
    setChangedDirs(new Set())
    setContextMenu(null)
    setDialog(null)
    setConfirmDelete(null)
  }, [setIsOpen])

  /* 点击面板的"目录"按钮时，如果标记为脏则刷新 */
  const handleToggle = useCallback(() => {
    if (isOpen) {
      close()
    } else {
      open()
    }
  }, [isOpen, open, close, setIsOpen])

  /* 监听工作区变更，自动刷新目录树 */
  useEffect(() => {
    if (!isOpen || !workspace) return

    window.taco.workspace.watch(workspace)

    const unlisten = window.taco.workspace.onChanged(() => {
      treeDirtyRef.current = true
      refreshTree()
    })

    return () => {
      window.taco.workspace.unwatch()
      unlisten()
    }
  }, [isOpen, workspace, refreshTree])

  /* 点击文件：已打开则切换标签，否则新增标签 */
  const handleFileClick = useCallback((file: FileTreeEntry) => {
    setOpenFiles(prev => {
      const existingIdx = prev.findIndex(f => f.path === file.path)
      if (existingIdx >= 0) {
        setActiveFileIndex(existingIdx)
        return prev
      }
      setActiveFileIndex(prev.length)
      return [...prev, file]
    })
  }, [])

  /* 右键菜单 */
  const handleContextMenu = useCallback((e: React.MouseEvent, entry: FileTreeEntry) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, entry })
  }, [])

  const closeContextMenu = useCallback(() => {
    setContextMenu(null)
  }, [])

  const handleMenuAction = useCallback((action: MenuAction, entry: FileTreeEntry) => {
    setContextMenu(null)

    if (action === 'createFile') {
      setDialog({
        type: 'createFile',
        entry,
      })
    } else if (action === 'createDir') {
      setDialog({
        type: 'createDir',
        entry,
      })
    } else if (action === 'rename') {
      setDialog({
        type: 'rename',
        entry,
        defaultName: entry.name,
      })
    } else if (action === 'delete') {
      setConfirmDelete(entry)
    }
  }, [])

  /* 输入对话框确认 */
  const handleDialogConfirm = useCallback(async (value: string) => {
    if (!dialog) return

    let absNewPath: string
    let absOldPath: string | null = null

    if (dialog.type === 'rename') {
      // 使用 entry.absPath 作为旧路径，拼接新路径
      absOldPath = dialog.entry.absPath
      const lastSep = Math.max(absOldPath.lastIndexOf('/'), absOldPath.lastIndexOf('\\'))
      absNewPath = lastSep >= 0
        ? absOldPath.slice(0, lastSep) + '/' + value
        : value

      // 如果名称没变，直接关闭
      if (value === dialog.defaultName) {
        setDialog(null)
        return
      }
    } else {
      // createFile / createDir：entry 是父目录，新路径 = 父目录 absPath + '/' + 文件名
      absNewPath = dialog.entry.absPath + '/' + value
    }

    try {
      if (dialog.type === 'createFile') {
        await window.taco.file.write(absNewPath, '')
      } else if (dialog.type === 'createDir') {
        await window.taco.file.createDirectory(absNewPath)
      } else if (dialog.type === 'rename') {
        await window.taco.file.rename(absOldPath!, absNewPath)
      }
      treeDirtyRef.current = true
      // 强制刷新绕过缓存，使目录树立即同步
      await refreshTree(true)
    } catch (err: any) {
      console.error('[WorkspaceTree] 操作失败:', err)
    }
    setDialog(null)
  }, [dialog, refreshTree])

  /* 删除确认 */
  const handleDeleteConfirm = useCallback(async () => {
    if (!confirmDelete) return

    try {
      if (confirmDelete.isDirectory) {
        await window.taco.file.deleteDirectory(confirmDelete.absPath)
      } else {
        await window.taco.file.delete(confirmDelete.absPath)
      }
      treeDirtyRef.current = true
      // 强制刷新绕过缓存，使目录树立即同步
      await refreshTree(true)
      // 如果删除的文件在打开标签中，关闭对应标签
      setOpenFiles(prev => {
        const idx = prev.findIndex(f => f.path === confirmDelete.path)
        if (idx < 0) return prev
        const newFiles = prev.filter((_, i) => i !== idx)
        const newActive = newFiles.length === 0 ? -1 : Math.min(idx, newFiles.length - 1)
        setActiveFileIndex(newActive)
        return newFiles
      })
    } catch (err: any) {
      console.error('[WorkspaceTree] 删除失败:', err)
    }
    setConfirmDelete(null)
  }, [confirmDelete, refreshTree])

  return (
    <>
      {/* 触发按钮 */}
      <button
        className={`pill wst-trigger ${className ?? ''} ${isOpen ? 'wst-trigger-active' : ''}`}
        type="button"
        onClick={handleToggle}
        title="项目目录"
      >
        <svg viewBox="0 0 16 16" width="16" height="16" className="wst-trigger-icon">
          <path d="M2 4.5A1.75 1.75 0 0 1 3.75 2.75h3l1.33 1.25h4.67A1.75 1.75 0 0 1 14.5 5.75v6A1.75 1.75 0 0 1 12.75 13.5H3.75A1.75 1.75 0 0 1 2 11.75V4.5z" fill="currentColor" opacity="0.85" />
        </svg>
        <span className="wst-trigger-label">目录</span>
      </button>

      {/* 遮罩层（纯视觉，不响应点击 — 避免误触关闭） */}
      {isOpen && <div className="wst-backdrop" />}

      {/* 全屏面板：顶部栏下方占满 */}
      <div className={`wst-panel ${isOpen ? 'wst-panel-open' : ''}`}>
        {/* 面板头部 */}
        <div className="wst-panel-header">
          <div className="wst-panel-title">
            <svg viewBox="0 0 16 16" width="16" height="16" className="wst-panel-title-icon">
              <path d="M2 4.5A1.75 1.75 0 0 1 3.75 2.75h3l1.33 1.25h4.67A1.75 1.75 0 0 1 14.5 5.75v6A1.75 1.75 0 0 1 12.75 13.5H3.75A1.75 1.75 0 0 1 2 11.75V4.5z" fill="#6b8cff" />
            </svg>
            <span className="wst-panel-title-text">{workspace || '未设置工作空间'}</span>
          </div>
          <button className="wst-panel-close" type="button" onClick={close} title="关闭">
            <svg viewBox="0 0 16 16" width="14" height="14">
              <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* 面板主体：目录树 + 拖拽条 + 预览区 */}
        <div className="wst-panel-body">
          {/* 左侧目录树 */}
          <div className="wst-tree" style={{ width: treeWidth }}>
            <div className="wst-tree-header">
              <svg viewBox="0 0 16 16" width="14" height="14" className="wst-tree-header-icon">
                <path d="M2 4.5A1.75 1.75 0 0 1 3.75 2.75h3l1.33 1.25h4.67A1.75 1.75 0 0 1 14.5 5.75v6A1.75 1.75 0 0 1 12.75 13.5H3.75A1.75 1.75 0 0 1 2 11.75V4.5z" fill="#6b8cff" opacity="0.85" />
              </svg>
              <span>目录</span>
            </div>
            <div className="wst-scroll">
              {treeLoading ? (
                <div className="wst-state">加载中...</div>
              ) : treeError ? (
                <div className="wst-state wst-error">{treeError}</div>
              ) : (
                tree.map((entry) => (
                  <TreeNode key={entry.path} entry={entry} depth={0} onFileClick={handleFileClick} onContextMenu={handleContextMenu} fileStatuses={fileStatuses} changedDirs={changedDirs} expandedPaths={expandedPaths} onToggleDir={handleToggleDir} />
                ))
              )}
            </div>
          </div>

          {/* 拖拽手柄 */}
          <div
            className={`wst-resize-handle ${dragRef.current ? 'wst-resize-active' : ''}`}
            onMouseDown={handleMouseDown}
          />

          {/* 右侧预览区 */}
          <div className="wst-preview">
            {activeFile ? (
              <>
                {/* 文件标签栏 + 模式切换按钮 */}
                <div className="wst-preview-tabs">
                  {/* 文件标签列表 */}
                  <div className="wst-preview-tab-list">
                    {openFiles.map((file, idx) => (
                      <div
                        key={file.path}
                        className={`wst-preview-tab-item ${idx === activeFileIndex ? 'wst-preview-tab-item-active' : ''}`}
                        onClick={() => setActiveFileIndex(idx)}
                        title={file.path}
                      >
                        <span className="wst-preview-tab-icon">{getFileIcon(file)}</span>
                        <span className="wst-preview-tab-name">{file.name}</span>
                        <button
                          type="button"
                          className="wst-preview-tab-item-close"
                          onClick={(e) => { e.stopPropagation(); handleCloseTab(idx); }}
                          title="关闭"
                        >
                          <svg viewBox="0 0 12 12" width="10" height="10">
                            <path d="M3 3l6 6M9 3l-6 6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                          </svg>
                        </button>
                      </div>
                    ))}
                  </div>

                  {/* 编辑 / 变更 模式切换 */}
                  <button
                    type="button"
                    className={`wst-preview-mode-btn ${viewMode === 'edit' ? 'wst-preview-mode-btn-active' : ''}`}
                    onClick={() => setViewMode('edit')}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    className={`wst-preview-mode-btn ${viewMode === 'diff' ? 'wst-preview-mode-btn-active' : ''}`}
                    onClick={() => setViewMode('diff')}
                  >
                    变更
                  </button>
                </div>

                {/* 视图内容 */}
                <div className="wst-preview-content">
                  {viewMode === 'edit' ? (
                    <FileEditor
                      filePath={activeFile.path}
                      workspace={workspace}
                      onClose={closeActiveTab}
                    />
                  ) : (
                    <FileDiffView
                      filePath={activeFile.path}
                      absPath={activeFile.absPath}
                      workspace={workspace}
                    />
                  )}
                </div>
              </>
            ) : (
              <div className="wst-preview-placeholder">
                <svg viewBox="0 0 32 32" width="48" height="48" opacity="0.15">
                  <path d="M6 4h12l6 6v18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" fill="currentColor" />
                  <path d="M18 4v6h6" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  <path d="M10 17h12M10 21h12M10 25h8" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                </svg>
                <p>选择左侧文件以预览</p>
              </div>
            )}
          </div>
        </div>
      </div>
      {/* 右键菜单 */}
      {contextMenu && (
        <ContextMenu state={contextMenu} onAction={handleMenuAction} onClose={closeContextMenu} />
      )}
      {/* 输入弹窗 */}
      {dialog && (
        <InputDialog
          title={
            dialog.type === 'createFile' ? '新建文件'
            : dialog.type === 'createDir' ? '新建目录'
            : '重命名'
          }
          placeholder={
            dialog.type === 'createFile' ? '输入文件名'
            : dialog.type === 'createDir' ? '输入目录名'
            : '输入新名称'
          }
          defaultValue={dialog.defaultName}
          onConfirm={handleDialogConfirm}
          onCancel={() => setDialog(null)}
        />
      )}
      {/* 删除确认 */}
      {confirmDelete && (
        <ConfirmDialog
          entry={confirmDelete}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </>
  )
}

export default WorkspaceTree
