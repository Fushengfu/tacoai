import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { DragBar } from './DragBar'
import type { FileChangeInfo, FileChangeStatus, GitVersionCommit } from '../types'
import type { FileTreeEntry, EditorId } from '../../shared/ipc'
import { editorCommands } from '../../shared/ipc'
import { computeDiff, diffStats } from '../lib/diff'

type DetailPanelProps = {
  title: string
  messageCount: number
  providerLabel?: string
  contextPercent: number
  usedTokens: number
  maxTokens: number
  /** 完整工作区目录树 */
  workspaceTree?: FileTreeEntry[]
  /** Agent 模式的文件变更列表 */
  fileChanges?: FileChangeInfo[]
  /** 当前选中的文件路径 */
  selectedFile: string | null
  /** 选中文件回调 */
  onSelectFile: (path: string | null) => void
  /** 文件审核状态 */
  fileStatuses: Record<string, FileChangeStatus>
  /** 保存单个文件 */
  onAcceptFile: (filePath: string) => void
  /** 撤销单个文件 */
  onRejectFile: (filePath: string) => void
  /** 保存全部 */
  onAcceptAll: () => void
  /** 撤销全部 */
  onRejectAll: () => void
  /** Git 版本历史 */
  gitVersions?: GitVersionCommit[]
  /** Git 回退到指定提交 */
  onGitRollback?: (hash: string) => void
  /** 加载某个提交的变更文件列表 */
  onLoadCommitFiles?: (hash: string) => Promise<string[]>
  /** 编辑器 */
  editor?: EditorId
  /** 工作空间路径 */
  workspace?: string
  /** 刷新目录树 */
  onRefreshTree?: () => void
  /** 在中间区域打开文件查看/编辑，forceDiff=true 时走 Diff 视图 */
  onOpenFileView?: (filePath: string, forceDiff?: boolean) => void
  /** 当前在编辑器中查看的文件 */
  viewingFile?: string | null
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

/* ------------------------------------------------------------------ */
/*  文件类型图标                                                        */
/* ------------------------------------------------------------------ */

function getFileIcon(name: string): { color: string; label: string } {
  const ext = name.includes('.') ? name.split('.').pop()?.toLowerCase() : ''
  const lowerName = name.toLowerCase()

  // 特殊文件名
  if (lowerName === '.gitignore') return { color: '#f54d27', label: 'GI' }
  if (lowerName.startsWith('.env')) return { color: '#ecd53f', label: 'EN' }
  if (lowerName === 'dockerfile') return { color: '#384d54', label: 'DK' }
  if (lowerName === 'makefile') return { color: '#6d8086', label: 'MK' }
  if (lowerName === 'license') return { color: '#d4a853', label: 'LI' }

  switch (ext) {
    case 'ts': return { color: '#3178c6', label: 'TS' }
    case 'tsx': return { color: '#3178c6', label: 'TX' }
    case 'js': return { color: '#f7df1e', label: 'JS' }
    case 'jsx': return { color: '#f7df1e', label: 'JX' }
    case 'mjs': case 'cjs': return { color: '#f7df1e', label: 'JS' }
    case 'json': return { color: '#cb8e3e', label: '{ }' }
    case 'css': return { color: '#563d7c', label: 'CS' }
    case 'scss': return { color: '#c6538c', label: 'SC' }
    case 'less': return { color: '#1d365d', label: 'LE' }
    case 'html': case 'htm': return { color: '#e34c26', label: '<>' }
    case 'vue': return { color: '#41b883', label: 'VU' }
    case 'svelte': return { color: '#ff3e00', label: 'SV' }
    case 'md': case 'mdx': return { color: '#519aba', label: 'MD' }
    case 'txt': return { color: '#8b8b8b', label: 'TX' }
    case 'py': return { color: '#3572a5', label: 'PY' }
    case 'rb': return { color: '#cc342d', label: 'RB' }
    case 'rs': return { color: '#dea584', label: 'RS' }
    case 'go': return { color: '#00add8', label: 'GO' }
    case 'java': return { color: '#b07219', label: 'JA' }
    case 'c': return { color: '#555555', label: 'C' }
    case 'cpp': case 'cc': case 'cxx': return { color: '#f34b7d', label: 'C+' }
    case 'h': case 'hpp': return { color: '#a074c4', label: 'H' }
    case 'swift': return { color: '#f05138', label: 'SW' }
    case 'kt': case 'kts': return { color: '#a97bff', label: 'KT' }
    case 'dart': return { color: '#00b4ab', label: 'DA' }
    case 'svg': return { color: '#ffb13b', label: 'SV' }
    case 'png': case 'jpg': case 'jpeg': case 'gif': case 'webp': case 'ico':
      return { color: '#a074c4', label: 'IM' }
    case 'sh': case 'bash': case 'zsh': return { color: '#89e051', label: 'SH' }
    case 'yml': case 'yaml': return { color: '#cb171e', label: 'YM' }
    case 'toml': return { color: '#9c4221', label: 'TM' }
    case 'xml': return { color: '#0060ac', label: 'XM' }
    case 'sql': return { color: '#e38c00', label: 'SQ' }
    case 'graphql': case 'gql': return { color: '#e535ab', label: 'GQ' }
    case 'lock': return { color: '#6d8086', label: 'LK' }
    case 'map': return { color: '#6d8086', label: 'MP' }
    case 'wasm': return { color: '#654ff0', label: 'WA' }
    case 'log': return { color: '#6d8086', label: 'LG' }
    default: return { color: '#6d8086', label: '··' }
  }
}

function normalizeSlashPath(input: string): string {
  return String(input ?? '').trim().replace(/[\\/]+/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '').replace(/\/$/, '')
}

function normalizeWorkspaceRelativePath(filePath: string, workspace?: string): string {
  const normalizedFilePath = normalizeSlashPath(filePath)
  if (!normalizedFilePath) return normalizedFilePath
  if (!workspace) return normalizedFilePath

  const normalizedWorkspace = normalizeSlashPath(workspace).replace(/\/+$/, '')
  if (!normalizedWorkspace) return normalizedFilePath

  const lowerFilePath = normalizedFilePath.toLowerCase()
  const lowerWorkspace = normalizedWorkspace.toLowerCase()
  if (lowerFilePath === lowerWorkspace) return ''
  if (lowerFilePath.startsWith(`${lowerWorkspace}/`)) {
    return normalizedFilePath.slice(normalizedWorkspace.length + 1)
  }
  return normalizedFilePath
}

/* ------------------------------------------------------------------ */
/*  从文件路径列表构建树结构（fallback 用）                               */
/* ------------------------------------------------------------------ */

/** 从变更文件路径列表构建 FileTreeEntry 树，保持真实目录层级 */
function buildTreeFromPaths(changes: FileChangeInfo[]): FileTreeEntry[] {
  // 临时树节点
  type TmpNode = {
    name: string
    path: string
    isDirectory: boolean
    children: Map<string, TmpNode>
  }
  const root: TmpNode = { name: '', path: '', isDirectory: true, children: new Map() }

  for (const fc of changes) {
    const normalizedPath = normalizeSlashPath(fc.filePath)
    if (!normalizedPath) continue
    const parts = normalizedPath.split('/').filter(Boolean)
    if (parts.length === 0) continue
    let current = root
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const isLast = i === parts.length - 1
      const partPath = parts.slice(0, i + 1).join('/')

      if (!current.children.has(part)) {
        current.children.set(part, {
          name: part,
          path: partPath,
          isDirectory: !isLast,
          children: new Map(),
        })
      }
      current = current.children.get(part)!
    }
  }

  // 折叠只有一个子目录的中间节点（如 src → renderer → App.tsx 折叠为 src/renderer）
  function collapse(node: TmpNode): TmpNode {
    if (node.isDirectory && node.children.size === 1) {
      const [, child] = [...node.children.entries()][0]
      if (child.isDirectory) {
        const merged: TmpNode = {
          name: node.name ? `${node.name}/${child.name}` : child.name,
          path: child.path,
          isDirectory: true,
          children: child.children,
        }
        return collapse(merged)
      }
    }
    return node
  }

  // 转换为 FileTreeEntry[]
  function toEntries(node: TmpNode): FileTreeEntry[] {
    const collapsed = collapse(node)
    const entries: FileTreeEntry[] = []
    for (const child of collapsed.children.values()) {
      if (child.isDirectory) {
        entries.push({
          name: child.name,
          path: child.path,
          isDirectory: true,
          children: toEntries(child),
        })
      } else {
        entries.push({ name: child.name, path: child.path, isDirectory: false })
      }
    }
    // 目录在前，文件在后
    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return entries
  }

  return toEntries(root)
}

/* ------------------------------------------------------------------ */
/*  变更文件树节点组件（用于变更面板的目录树展示）                            */
/* ------------------------------------------------------------------ */

function ChangeTreeNode({
  entry,
  depth = 0,
  selectedPath,
  viewingPath,
  onFileClick,
  changesMap,
  fileStatuses,
  statusFilter,
  onAcceptFile,
  onRejectFile,
}: {
  entry: FileTreeEntry
  depth?: number
  selectedPath: string | null
  viewingPath?: string | null
  onFileClick: (path: string) => void
  changesMap: Map<string, FileChangeInfo>
  fileStatuses: Record<string, FileChangeStatus>
  statusFilter: 'pending' | 'accepted' | 'rejected'
  onAcceptFile: (filePath: string) => void
  onRejectFile: (filePath: string) => void
}) {
  const [expanded, setExpanded] = useState(true)

  if (entry.isDirectory) {
    return (
      <div>
        <div
          className="change-tree-dir"
          style={{ paddingLeft: depth * 18 + 24 }}
          onClick={() => setExpanded((p) => !p)}
        >
          <span className={`ws-tree-arrow ${expanded ? 'open' : ''}`}>›</span>
          <span className="change-tree-dir-name">{entry.name}</span>
        </div>
        {expanded && entry.children?.map((child) => (
          <ChangeTreeNode
            key={child.path}
            entry={child}
            depth={depth + 1}
            selectedPath={selectedPath}
            viewingPath={viewingPath}
            onFileClick={onFileClick}
            changesMap={changesMap}
            fileStatuses={fileStatuses}
            statusFilter={statusFilter}
            onAcceptFile={onAcceptFile}
            onRejectFile={onRejectFile}
          />
        ))}
      </div>
    )
  }

  // 文件节点
  const change = changesMap.get(entry.path)
  if (!change) return null

  const isActive = selectedPath === entry.path || viewingPath === entry.path
  const icon = getFileIcon(entry.name)
  const isDeleted = change.newContent === null
  const isNew = change.oldContent === null
  const stats = (!isNew && !isDeleted) ? diffStats(computeDiff(change.oldContent, change.newContent)) : null

  return (
    <div
      className={`change-file-row ${statusFilter} ${isActive ? 'selected' : ''}`}
      style={{ paddingLeft: depth * 18 + 24 }}
      onClick={() => onFileClick(entry.path)}
      title={entry.path}
    >
      <span className={`change-file-dot ${statusFilter}`} />
      <span className="ws-file-icon" style={{ background: icon.color }}>{icon.label}</span>
      <span className="change-file-name">{entry.name}</span>
      <span className={`ws-file-change-badge ${isNew ? 'added' : isDeleted ? 'deleted' : 'modified'}`}>
        {isNew ? 'A' : isDeleted ? 'D' : 'M'}
      </span>
      {stats && (
        <span className="ws-file-stats">
          {stats.added > 0 && <span className="stat-add">+{stats.added}</span>}
          {stats.removed > 0 && <span className="stat-remove">-{stats.removed}</span>}
        </span>
      )}
      {statusFilter === 'pending' && (
        <span className="change-file-actions">
          <button type="button" className="ws-file-action-btn accept"
            onClick={(e) => { e.stopPropagation(); onAcceptFile(entry.path) }} title="保存">✓</button>
          <button type="button" className="ws-file-action-btn reject"
            onClick={(e) => { e.stopPropagation(); onRejectFile(entry.path) }} title="撤销">✗</button>
        </span>
      )}
      {statusFilter === 'accepted' && (
        <span className="ws-file-status-icon accepted">✓</span>
      )}
      {statusFilter === 'rejected' && (
        <span className="ws-file-status-icon rejected">✗</span>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  工作区文件树节点组件                                                  */
/* ------------------------------------------------------------------ */

function WsTreeNode({
  entry,
  depth = 0,
  selectedPath,
  viewingPath,
  onFileClick,
  changesMap,
  fileStatuses,
  onAcceptFile,
  onRejectFile,
}: {
  entry: FileTreeEntry
  depth?: number
  /** 当前选中的变更文件路径 */
  selectedPath: string | null
  /** 当前在编辑器中查看的文件路径 */
  viewingPath?: string | null
  /** 文件点击回调（统一处理变更文件和普通文件） */
  onFileClick: (path: string) => void
  changesMap: Map<string, FileChangeInfo>
  fileStatuses: Record<string, FileChangeStatus>
  onAcceptFile: (filePath: string) => void
  onRejectFile: (filePath: string) => void
}) {
  const [expanded, setExpanded] = useState(depth < 2)

  if (entry.isDirectory) {
    return (
      <div className="ws-tree-dir">
        <div
          className="ws-tree-dir-header"
          style={{ paddingLeft: depth * 18 + 24 }}
          onClick={() => setExpanded((p) => !p)}
        >
          <span className={`ws-tree-arrow ${expanded ? 'open' : ''}`}>›</span>
          <span className="ws-tree-dir-name">{entry.name}</span>
        </div>
        {expanded && entry.children?.map((child) => (
          <WsTreeNode
            key={child.path}
            entry={child}
            depth={depth + 1}
            selectedPath={selectedPath}
            viewingPath={viewingPath}
            onFileClick={onFileClick}
            changesMap={changesMap}
            fileStatuses={fileStatuses}
            onAcceptFile={onAcceptFile}
            onRejectFile={onRejectFile}
          />
        ))}
      </div>
    )
  }

  // 文件节点
  const change = changesMap.get(entry.path)
  const isChanged = !!change
  const isActive = selectedPath === entry.path || viewingPath === entry.path
  const status: FileChangeStatus = (
    fileStatuses[entry.path]
    ?? fileStatuses[entry.path.replace(/\//g, '\\')]
    ?? 'pending'
  )
  const icon = getFileIcon(entry.name)

  // 变更类型
  let changeBadge: { label: string; cls: string } | null = null
  if (change) {
    if (change.oldContent === null) changeBadge = { label: 'A', cls: 'added' }
    else if (change.newContent === null) changeBadge = { label: 'D', cls: 'deleted' }
    else changeBadge = { label: 'M', cls: 'modified' }
  }

  // diff 统计（仅变更文件）
  const stats = change ? diffStats(computeDiff(change.oldContent, change.newContent)) : null

  return (
    <div
      className={[
        'ws-tree-file',
        isActive ? 'selected' : '',
        isChanged ? 'changed' : '',
        isChanged && status !== 'pending' ? `file-${status}` : '',
      ].filter(Boolean).join(' ')}
      style={{ paddingLeft: depth * 18 + 24 }}
      onClick={() => onFileClick(entry.path)}
    >
      <span className="ws-file-icon" style={{ background: icon.color }}>{icon.label}</span>
      <span className="ws-file-name">{entry.name}</span>
      {/* 变更标记 */}
      {changeBadge && (
        <span className={`ws-file-change-badge ${changeBadge.cls}`}>{changeBadge.label}</span>
      )}
      {/* diff 统计 */}
      {isChanged && stats && (
        <span className="ws-file-stats">
          {stats.added > 0 && <span className="stat-add">+{stats.added}</span>}
          {stats.removed > 0 && <span className="stat-remove">-{stats.removed}</span>}
        </span>
      )}
      {/* 操作按钮（仅变更文件 pending 状态时显示） */}
      {isChanged && status === 'pending' && (
        <span className="ws-file-actions">
          <button
            type="button"
            className="ws-file-action-btn accept"
            onClick={(e) => { e.stopPropagation(); onAcceptFile(entry.path) }}
            title="保存"
          >✓</button>
          <button
            type="button"
            className="ws-file-action-btn reject"
            onClick={(e) => { e.stopPropagation(); onRejectFile(entry.path) }}
            title="撤销"
          >✗</button>
        </span>
      )}
      {isChanged && status === 'accepted' && (
        <span className="ws-file-status-icon accepted" title="已保存">✓</span>
      )}
      {isChanged && status === 'rejected' && (
        <span className="ws-file-status-icon rejected" title="已撤销">✗</span>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  DetailPanel 主组件                                                  */
/* ------------------------------------------------------------------ */

export function DetailPanel({
  title,
  messageCount,
  providerLabel,
  contextPercent,
  usedTokens,
  maxTokens,
  workspaceTree,
  fileChanges,
  selectedFile,
  onSelectFile,
  fileStatuses,
  onAcceptFile,
  onRejectFile,
  onAcceptAll,
  onRejectAll,
  gitVersions,
  onGitRollback,
  onLoadCommitFiles,
  editor,
  workspace,
  onRefreshTree,
  onOpenFileView,
  viewingFile,
}: Readonly<DetailPanelProps>) {
  const [expandedHashes, setExpandedHashes] = useState<Set<string>>(new Set())
  const [commitFilesCache, setCommitFilesCache] = useState<Record<string, string[]>>({})
  const [rollingBack, setRollingBack] = useState<string | null>(null)

  async function toggleVersionExpand(hash: string) {
    setExpandedHashes((prev) => {
      const next = new Set(prev)
      if (next.has(hash)) next.delete(hash)
      else next.add(hash)
      return next
    })
    if (!commitFilesCache[hash] && onLoadCommitFiles) {
      const files = await onLoadCommitFiles(hash)
      setCommitFilesCache((prev) => ({ ...prev, [hash]: files }))
    }
  }

  async function handleGitRollbackClick(hash: string) {
    if (!onGitRollback || rollingBack !== null) return
    setRollingBack(hash)
    try { await onGitRollback(hash) } finally { setRollingBack(null) }
  }

  const readStatus = useCallback((filePath: string): FileChangeStatus => {
    return (
      fileStatuses[filePath]
      ?? fileStatuses[filePath.replace(/\//g, '\\')]
      ?? 'pending'
    )
  }, [fileStatuses])

  // 去重合并文件变更
  const dedupedChanges = useMemo(() => {
    if (!fileChanges || fileChanges.length === 0) return []
    const map = new Map<string, FileChangeInfo>()
    for (const fc of fileChanges) {
      const normalizedPath = normalizeWorkspaceRelativePath(fc.filePath, workspace)
      if (!normalizedPath) continue
      const existing = map.get(normalizedPath)
      if (existing) {
        map.set(normalizedPath, { filePath: normalizedPath, oldContent: existing.oldContent, newContent: fc.newContent })
      } else {
        map.set(normalizedPath, { ...fc, filePath: normalizedPath })
      }
    }
    return Array.from(map.values()).filter((fc) => fc.oldContent !== fc.newContent)
  }, [fileChanges, workspace])

  // 变更文件映射（path → change）
  const changesMap = useMemo(() => {
    const m = new Map<string, FileChangeInfo>()
    for (const fc of dedupedChanges) m.set(fc.filePath, fc)
    return m
  }, [dedupedChanges])

  const hasChanges = dedupedChanges.length > 0

  // pending 文件数
  const pendingCount = useMemo(() => {
    return dedupedChanges.filter(
      (fc) => readStatus(fc.filePath) === 'pending'
    ).length
  }, [dedupedChanges, readStatus])

  const hasTree = workspaceTree && workspaceTree.length > 0

  // 统计工作区文件总数
  const totalFileCount = useMemo(() => {
    function countFiles(entries: FileTreeEntry[]): number {
      let count = 0
      for (const e of entries) {
        if (e.isDirectory) count += countFiles(e.children ?? [])
        else count++
      }
      return count
    }
    return hasTree ? countFiles(workspaceTree) : 0
  }, [workspaceTree, hasTree])

  // 按状态分组变更文件
  const pendingChanges = useMemo(
    () => dedupedChanges.filter((fc) => readStatus(fc.filePath) === 'pending'),
    [dedupedChanges, readStatus],
  )
  const acceptedChanges = useMemo(
    () => dedupedChanges.filter((fc) => readStatus(fc.filePath) === 'accepted'),
    [dedupedChanges, readStatus],
  )
  const rejectedChanges = useMemo(
    () => dedupedChanges.filter((fc) => readStatus(fc.filePath) === 'rejected'),
    [dedupedChanges, readStatus],
  )

  // 为每个状态分组构建目录树
  const pendingTree = useMemo(() => buildTreeFromPaths(pendingChanges), [pendingChanges])
  const acceptedTree = useMemo(() => buildTreeFromPaths(acceptedChanges), [acceptedChanges])
  const rejectedTree = useMemo(() => buildTreeFromPaths(rejectedChanges), [rejectedChanges])

  // 目录树面板是否展开（默认折叠，持久化到 localStorage）
  const [treeExpanded, setTreeExpanded] = useState(() => {
    try { return localStorage.getItem('taco.panel.treeExpanded') === 'true' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem('taco.panel.treeExpanded', String(treeExpanded)) } catch { /* ignore */ }
  }, [treeExpanded])

  // 变更面板是否展开（默认展开，持久化到 localStorage）
  const [changesExpanded, setChangesExpanded] = useState(() => {
    try { const v = localStorage.getItem('taco.panel.changesExpanded'); return v === null ? true : v === 'true' } catch { return true }
  })
  useEffect(() => {
    try { localStorage.setItem('taco.panel.changesExpanded', String(changesExpanded)) } catch { /* ignore */ }
  }, [changesExpanded])

  // 版本历史面板是否展开（默认展开，持久化到 localStorage）
  const [gitExpanded, setGitExpanded] = useState(() => {
    try { const v = localStorage.getItem('taco.panel.gitExpanded'); return v === null ? true : v === 'true' } catch { return true }
  })
  useEffect(() => {
    try { localStorage.setItem('taco.panel.gitExpanded', String(gitExpanded)) } catch { /* ignore */ }
  }, [gitExpanded])

  // fallback: 没有工作区目录树时，从变更文件路径构建树
  const fallbackTree = useMemo(() => {
    if (hasTree || dedupedChanges.length === 0) return []
    return buildTreeFromPaths(dedupedChanges)
  }, [hasTree, dedupedChanges])

  const showTree = hasTree || (hasChanges && fallbackTree.length > 0)
  const showGit = !!(gitVersions && gitVersions.length > 0)

  // 被删除的文件（不在目录树中但在 changesMap 中 newContent === null 的）
  const deletedFiles = useMemo(() => {
    if (!hasTree) return []
    return dedupedChanges.filter((fc) => fc.newContent === null)
  }, [dedupedChanges, hasTree])

  /** 用外部编辑器打开文件（双击时） */
  const handleOpenExternal = useCallback((filePath: string) => {
    if (!editor || !workspace) return
    const isAbs = filePath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith('\\\\')
    const sep = /[a-zA-Z]:[\\/]/.test(workspace) || workspace.includes('\\') ? '\\' : '/'
    const fullPath = isAbs
      ? filePath
      : `${workspace.replace(/[\\/]+$/, '')}${sep}${filePath.replace(/[\\/]/g, sep)}`
    globalThis.window.taco.shell.openInEditor(fullPath, editor).catch(() => {})
  }, [editor, workspace])

  /** 目录树文件单击：直接进入编辑模式 */
  const handleTreeFileClick = useCallback((path: string) => {
    if (onOpenFileView) {
      onOpenFileView(path, false)
    } else {
      onSelectFile(selectedFile === path ? null : path)
    }
  }, [onOpenFileView, onSelectFile, selectedFile])

  /** 变更文件面板单击：进入 Diff 视图 */
  const handleChangeFileClick = useCallback((path: string) => {
    if (onOpenFileView) {
      onOpenFileView(path, true)
    } else {
      onSelectFile(selectedFile === path ? null : path)
    }
  }, [onOpenFileView, onSelectFile, selectedFile])

  // ── 面板拖动调整大小 ──
  const treePanelRef = useRef<HTMLDivElement>(null)
  const changesPanelRef = useRef<HTMLDivElement>(null)
  const gitPanelRef = useRef<HTMLDivElement>(null)

  // 折叠/展开时重置手动设置的高度，让 flex 自动分配
  useEffect(() => {
    treePanelRef.current?.style.removeProperty('flex')
    changesPanelRef.current?.style.removeProperty('flex')
    gitPanelRef.current?.style.removeProperty('flex')
  }, [treeExpanded, changesExpanded, gitExpanded])

  const startPanelResize = useCallback((
    e: React.MouseEvent,
    aboveRef: { current: HTMLDivElement | null },
    belowRef: { current: HTMLDivElement | null },
  ) => {
    e.preventDefault()
    const elA = aboveRef.current
    const elB = belowRef.current
    if (!elA || !elB) return

    const startY = e.clientY
    const startHA = elA.getBoundingClientRect().height
    const startHB = elB.getBoundingClientRect().height

    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientY - startY
      const newA = Math.max(36, startHA + delta)
      const newB = Math.max(36, startHB - delta)
      elA.style.flex = `0 0 ${newA}px`
      elB.style.flex = `0 0 ${newB}px`
    }

    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])

  return (
    <aside className="detail-panel">
      <DragBar />

      {/* 会话信息卡片 */}
      <div className="detail-card">
        <div className="detail-title">{title}</div>
        <div className="detail-sub">
          {messageCount > 0 ? `${messageCount} 条消息` : '暂无消息'}
        </div>
        {providerLabel && (
          <div className="detail-provider">当前模型: {providerLabel}</div>
        )}
        <div className="context-bar-label" style={{ marginTop: 4 }}>
          <span>上下文 ~{formatTokens(usedTokens)}/{formatTokens(maxTokens)}</span>
          <span>{contextPercent}%</span>
        </div>
        <div className="context-bar-track">
          <div
            className={`context-bar-fill${contextPercent > 80 ? ' warn' : ''}`}
            style={{ width: `${contextPercent}%` }}
          />
        </div>
      </div>

      {/* ── 工作区文件树（上方，可折叠，与变更面板样式一致） ── */}
      {hasTree ? (
        <div className="change-group-panel" ref={treePanelRef}>
          <div
            className="change-group-header"
            onClick={() => setTreeExpanded((p) => !p)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter') setTreeExpanded((p) => !p) }}
          >
            <span className={`ws-tree-arrow ${treeExpanded ? 'open' : ''}`}>›</span>
            <span className="change-group-title">文件</span>
            <span className="change-group-count">{totalFileCount}</span>
          </div>
          {treeExpanded && (
            <div className="change-group-body">
              {workspaceTree.map((entry) => (
                <WsTreeNode
                  key={entry.path}
                  entry={entry}
                  selectedPath={selectedFile}
                  viewingPath={viewingFile}
                  onFileClick={handleTreeFileClick}
                  changesMap={changesMap}
                  fileStatuses={fileStatuses}
                  onAcceptFile={onAcceptFile}
                  onRejectFile={onRejectFile}
                />
              ))}
              {/* 已删除的文件（目录树中不存在） */}
              {deletedFiles.length > 0 && (
                <div className="ws-tree-deleted-section">
                  <div className="ws-tree-deleted-label">已删除</div>
                  {deletedFiles.map((fc) => {
                    const fileName = normalizeSlashPath(fc.filePath).split('/').pop() || fc.filePath
                    const icon = getFileIcon(fileName)
                    const status = readStatus(fc.filePath)
                    return (
                      <div
                        key={fc.filePath}
                        className={`ws-tree-file changed deleted-ghost ${status !== 'pending' ? `file-${status}` : ''}`}
                        style={{ paddingLeft: 4 }}
                        onClick={() => handleTreeFileClick(fc.filePath)}
                      >
                        <span className="ws-file-icon" style={{ background: icon.color }}>{icon.label}</span>
                        <span className="ws-file-name">{fc.filePath}</span>
                        <span className="ws-file-change-badge deleted">D</span>
                        {status === 'pending' && (
                          <span className="ws-file-actions">
                            <button type="button" className="ws-file-action-btn reject"
                              onClick={(e) => { e.stopPropagation(); onRejectFile(fc.filePath) }} title="恢复">✗</button>
                          </span>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      ) : hasChanges && fallbackTree.length > 0 ? (
        /* 没有工作区目录树但有变更文件时，从路径构建树形结构 */
        <div className="change-group-panel" ref={treePanelRef}>
          <div
            className="change-group-header"
            onClick={() => setTreeExpanded((p) => !p)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter') setTreeExpanded((p) => !p) }}
          >
            <span className={`ws-tree-arrow ${treeExpanded ? 'open' : ''}`}>›</span>
            <span className="change-group-title">文件</span>
            <span className="change-group-count">{dedupedChanges.length}</span>
          </div>
          {treeExpanded && (
            <div className="change-group-body">
              {fallbackTree.map((entry) => (
                <WsTreeNode
                  key={entry.path}
                  entry={entry}
                  selectedPath={selectedFile}
                  viewingPath={viewingFile}
                  onFileClick={handleTreeFileClick}
                  changesMap={changesMap}
                  fileStatuses={fileStatuses}
                  onAcceptFile={onAcceptFile}
                  onRejectFile={onRejectFile}
                />
              ))}
            </div>
          )}
        </div>
      ) : null}

      {/* 面板间分割线（文件树 ↔ 变更面板） */}
      {showTree && hasChanges && (
        <div className="detail-resize-handle" onMouseDown={(e) => startPanelResize(e, treePanelRef, changesPanelRef)} />
      )}
      {/* 面板间分割线（文件树 ↔ 版本历史，无变更时） */}
      {showTree && !hasChanges && showGit && (
        <div className="detail-resize-handle" onMouseDown={(e) => startPanelResize(e, treePanelRef, gitPanelRef)} />
      )}

      {/* ── 变更文件面板（下方，按状态分组） ── */}
      {hasChanges && (
        <div className="change-group-panel" ref={changesPanelRef}>
          <div
            className="change-group-header"
            onClick={() => setChangesExpanded((p) => !p)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter') setChangesExpanded((p) => !p) }}
          >
            <span className={`ws-tree-arrow ${changesExpanded ? 'open' : ''}`}>›</span>
            <span className="change-group-title">变更文件</span>
            <span className="change-group-count">{dedupedChanges.length}</span>
            {pendingCount > 0 && (
              <span className="change-group-pending-badge">{pendingCount} 待审核</span>
            )}
          </div>

          {changesExpanded && (
            <div className="change-group-body">
              {/* 批量操作 */}
              {pendingCount > 0 && (
                <div className="detail-changes-bulk">
                  <button type="button" className="bulk-action-btn accept" onClick={onAcceptAll} title="保存所有变更">
                    ✓ 全部保存
                  </button>
                  <button type="button" className="bulk-action-btn reject" onClick={onRejectAll} title="撤销所有变更">
                    ✗ 全部撤销
                  </button>
                </div>
              )}

              {/* 待审核 */}
              {pendingChanges.length > 0 && (
                <div className="change-status-section">
                  <div className="change-status-label pending">待审核 ({pendingChanges.length})</div>
                  {pendingTree.map((entry) => (
                    <ChangeTreeNode
                      key={entry.path}
                      entry={entry}
                      selectedPath={selectedFile}
                      viewingPath={viewingFile}
                      onFileClick={handleChangeFileClick}
                      changesMap={changesMap}
                      fileStatuses={fileStatuses}
                      statusFilter="pending"
                      onAcceptFile={onAcceptFile}
                      onRejectFile={onRejectFile}
                    />
                  ))}
                </div>
              )}

              {/* 已保存 */}
              {acceptedChanges.length > 0 && (
                <div className="change-status-section">
                  <div className="change-status-label accepted">已保存 ({acceptedChanges.length})</div>
                  {acceptedTree.map((entry) => (
                    <ChangeTreeNode
                      key={entry.path}
                      entry={entry}
                      selectedPath={selectedFile}
                      viewingPath={viewingFile}
                      onFileClick={handleChangeFileClick}
                      changesMap={changesMap}
                      fileStatuses={fileStatuses}
                      statusFilter="accepted"
                      onAcceptFile={onAcceptFile}
                      onRejectFile={onRejectFile}
                    />
                  ))}
                </div>
              )}

              {/* 已撤销 */}
              {rejectedChanges.length > 0 && (
                <div className="change-status-section">
                  <div className="change-status-label rejected">已撤销 ({rejectedChanges.length})</div>
                  {rejectedTree.map((entry) => (
                    <ChangeTreeNode
                      key={entry.path}
                      entry={entry}
                      selectedPath={selectedFile}
                      viewingPath={viewingFile}
                      onFileClick={handleChangeFileClick}
                      changesMap={changesMap}
                      fileStatuses={fileStatuses}
                      statusFilter="rejected"
                      onAcceptFile={onAcceptFile}
                      onRejectFile={onRejectFile}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 面板间分割线（变更面板 ↔ 版本历史） */}
      {hasChanges && showGit && (
        <div className="detail-resize-handle" onMouseDown={(e) => startPanelResize(e, changesPanelRef, gitPanelRef)} />
      )}

      {/* Git 版本历史 */}
      {gitVersions && gitVersions.length > 0 && (
        <div className="version-history" ref={gitPanelRef}>
          <div
            className="change-group-header"
            onClick={() => setGitExpanded((p) => !p)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter') setGitExpanded((p) => !p) }}
          >
            <span className={`ws-tree-arrow ${gitExpanded ? 'open' : ''}`}>›</span>
            <span className="change-group-title">版本历史 (Git)</span>
            <span className="change-group-count">{gitVersions.length} 个提交</span>
          </div>
          {gitExpanded && <div className="version-timeline">
            {gitVersions.map((commit, idx) => {
              const isExpanded = expandedHashes.has(commit.hash)
              const isLatest = idx === 0
              const isRolling = rollingBack === commit.hash
              const files = commitFilesCache[commit.hash]
              const timeStr = new Date(commit.timestamp * 1000).toLocaleString('zh-CN', {
                month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
              })
              return (
                <div key={commit.hash} className={`version-item ${isLatest ? 'latest' : ''}`}>
                  <div className="version-item-dot" />
                  <div className="version-item-content">
                    <div
                      className="version-item-header"
                      onClick={() => toggleVersionExpand(commit.hash)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => e.key === 'Enter' && toggleVersionExpand(commit.hash)}
                    >
                      <span className="version-item-label" title={commit.hash}>{commit.shortHash}</span>
                      <span className="version-item-summary">{commit.message}</span>
                      <span className="version-item-count">{commit.fileCount} 文件</span>
                    </div>
                    <div className="version-item-time">{timeStr}</div>
                    {isExpanded && (
                      <div className="version-item-detail">
                        {files ? (
                          <div className="version-item-files">
                            {files.map((f) => {
                              const fn = f.split('/').pop() || f
                              const ic = getFileIcon(fn)
                              return (
                                <div key={f} className="version-file-entry">
                                  <span className="ws-file-icon small" style={{ background: ic.color }}>{ic.label}</span>
                                  <span className="version-file-name">{fn}</span>
                                </div>
                              )
                            })}
                          </div>
                        ) : (
                          <div className="version-item-loading">加载中...</div>
                        )}
                        {!isLatest && onGitRollback && (
                          <button
                            type="button"
                            className="version-rollback-btn"
                            onClick={() => handleGitRollbackClick(commit.hash)}
                            disabled={rollingBack !== null}
                          >
                            {isRolling ? '回退中...' : `↩ 回退到 ${commit.shortHash}`}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>}
        </div>
      )}

      <div className="detail-footer">Taco v{globalThis.window.taco?.version ?? '0.1.0'}</div>
    </aside>
  )
}
