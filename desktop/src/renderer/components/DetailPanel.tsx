import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { DragBar } from './DragBar'
import type { FileChangeInfo, FileChangeStatus, GitVersionCommit } from '../types'
import type { FileTreeEntry } from '../../shared/ipc'
import type { ProjectTokenStats } from '../hooks/useChat'
import { computeDiff, diffStats } from '../lib/diff'

type DetailPanelProps = {
  title: string
  messageCount: number
  providerLabel?: string
  contextPercent: number
  usedTokens: number
  maxTokens: number
  /** 当前项目累计 token 统计 */
  projectTokenStats?: ProjectTokenStats
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
  /** Git 已暂存文件列表（相对工作区路径） */
  stagedFiles?: string[]
  /** Git 未暂存文件列表（相对工作区路径） */
  unstagedFiles?: string[]
  /** Git 状态是否已经完成过一次加载 */
  gitStatusLoaded?: boolean
  /** Git 暂存单个文件 */
  onStageFile?: (filePath: string) => void
  /** Git 暂存全部 */
  onStageAll?: () => void
  /** Git 版本历史 */
  gitVersions?: GitVersionCommit[]
  /** Git 回退到指定提交 */
  onGitRollback?: (hash: string) => void
  /** 加载某个提交的变更文件列表 */
  onLoadCommitFiles?: (hash: string) => Promise<string[]>
  /** 工作空间路径 */
  workspace?: string
  /** 文件树面板是否展开 */
  treeExpanded: boolean
  /** 设置文件树面板展开状态 */
  onTreeExpandedChange: (expanded: boolean) => void
  /** 变更面板是否展开 */
  changesExpanded: boolean
  /** 设置变更面板展开状态 */
  onChangesExpandedChange: (expanded: boolean) => void
  /** Git 历史面板是否展开 */
  gitExpanded: boolean
  /** 设置 Git 历史面板展开状态 */
  onGitExpandedChange: (expanded: boolean) => void
  /** 手动刷新文件目录/变更文件等项目面板 */
  onRefreshTree?: () => void
  /** 在中间区域打开文件查看/编辑，forceDiff=true 时走 Diff 视图 */
  onOpenFileView?: (filePath: string, forceDiff?: boolean) => void
  /** 当前在编辑器中查看的文件 */
  viewingFile?: string | null
  /** 删除文件回调 */
  onDeleteFile?: (filePath: string) => void
  /** 删除目录回调 */
  onDeleteDirectory?: (dirPath: string) => void
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

/* ------------------------------------------------------------------ */
/*  文件类型图标                                                        */
/* ------------------------------------------------------------------ */

type TreeIcon = { color: string; label: string }

const SPECIAL_FILE_ICONS: Record<string, TreeIcon> = {
  '.gitignore': { color: '#f54d27', label: 'GI' },
  '.gitattributes': { color: '#f54d27', label: 'GA' },
  '.editorconfig': { color: '#8f8f8f', label: 'ED' },
  '.npmrc': { color: '#cb3837', label: 'NP' },
  '.prettierrc': { color: '#f7b93e', label: 'PR' },
  '.eslintrc': { color: '#4b32c3', label: 'ES' },
  '.env': { color: '#ecd53f', label: 'EN' },
  '.env.local': { color: '#ecd53f', label: 'EL' },
  '.env.example': { color: '#ecd53f', label: 'EE' },
  'dockerfile': { color: '#2496ed', label: 'DK' },
  'docker-compose.yml': { color: '#2496ed', label: 'DC' },
  'docker-compose.yaml': { color: '#2496ed', label: 'DC' },
  'makefile': { color: '#6d8086', label: 'MK' },
  'license': { color: '#d4a853', label: 'LC' },
  'readme.md': { color: '#519aba', label: 'RD' },
  'package.json': { color: '#cb3837', label: 'PK' },
  'package-lock.json': { color: '#cb3837', label: 'PL' },
  'pnpm-lock.yaml': { color: '#f8ad00', label: 'PN' },
  'yarn.lock': { color: '#2c8ebb', label: 'YR' },
  'bun.lockb': { color: '#f2ce77', label: 'BN' },
  'go.mod': { color: '#00add8', label: 'GM' },
  'go.sum': { color: '#00add8', label: 'GS' },
  'cargo.toml': { color: '#dea584', label: 'CT' },
  'cargo.lock': { color: '#dea584', label: 'CL' },
  'requirements.txt': { color: '#3572a5', label: 'RQ' },
  'pyproject.toml': { color: '#3572a5', label: 'PP' },
  'pipfile': { color: '#3572a5', label: 'PF' },
  'gemfile': { color: '#cc342d', label: 'GF' },
  'composer.json': { color: '#8d6748', label: 'CM' },
  'composer.lock': { color: '#8d6748', label: 'CK' },
  'pom.xml': { color: '#b07219', label: 'PM' },
  'build.gradle': { color: '#3f8e99', label: 'GR' },
  'build.gradle.kts': { color: '#3f8e99', label: 'GR' },
  'tsconfig.json': { color: '#3178c6', label: 'TC' },
  'vite.config.ts': { color: '#646cff', label: 'VT' },
  'vite.config.js': { color: '#646cff', label: 'VT' },
  'webpack.config.js': { color: '#8ed6fb', label: 'WP' },
  'rollup.config.js': { color: '#ec4a3f', label: 'RP' },
  'tailwind.config.js': { color: '#38bdf8', label: 'TW' },
  'postcss.config.js': { color: '#dd3a0a', label: 'PC' },
  'next.config.js': { color: '#111111', label: 'NX' },
  'nuxt.config.ts': { color: '#00dc82', label: 'NU' },
  'jest.config.js': { color: '#99424f', label: 'JT' },
  'vitest.config.ts': { color: '#729b1b', label: 'VS' },
  'biome.json': { color: '#60a5fa', label: 'BM' },
}

const EXT_FILE_ICONS: Record<string, TreeIcon> = {
  ts: { color: '#3178c6', label: 'TS' },
  tsx: { color: '#3178c6', label: 'TX' },
  js: { color: '#f7df1e', label: 'JS' },
  jsx: { color: '#f7df1e', label: 'JX' },
  mjs: { color: '#f7df1e', label: 'JS' },
  cjs: { color: '#f7df1e', label: 'JS' },
  json: { color: '#cb8e3e', label: 'JS' },
  jsonc: { color: '#cb8e3e', label: 'JC' },
  html: { color: '#e34c26', label: 'HT' },
  htm: { color: '#e34c26', label: 'HT' },
  css: { color: '#563d7c', label: 'CS' },
  scss: { color: '#c6538c', label: 'SC' },
  less: { color: '#1d365d', label: 'LS' },
  vue: { color: '#41b883', label: 'VU' },
  svelte: { color: '#ff3e00', label: 'SV' },
  md: { color: '#519aba', label: 'MD' },
  mdx: { color: '#519aba', label: 'MX' },
  txt: { color: '#8b8b8b', label: 'TX' },
  log: { color: '#6d8086', label: 'LG' },
  py: { color: '#3572a5', label: 'PY' },
  rb: { color: '#cc342d', label: 'RB' },
  rs: { color: '#dea584', label: 'RS' },
  rl: { color: '#dea584', label: 'RS' },
  go: { color: '#00add8', label: 'GO' },
  java: { color: '#b07219', label: 'JV' },
  class: { color: '#b07219', label: 'JV' },
  jar: { color: '#b07219', label: 'JV' },
  c: { color: '#555555', label: 'C' },
  cpp: { color: '#f34b7d', label: 'CP' },
  cc: { color: '#f34b7d', label: 'CP' },
  cxx: { color: '#f34b7d', label: 'CP' },
  hxx: { color: '#a074c4', label: 'HP' },
  hh: { color: '#a074c4', label: 'HP' },
  hpp: { color: '#a074c4', label: 'HP' },
  h: { color: '#a074c4', label: 'H' },
  php: { color: '#777bb4', label: 'PH' },
  phtml: { color: '#777bb4', label: 'PH' },
  phar: { color: '#777bb4', label: 'PH' },
  inc: { color: '#777bb4', label: 'PH' },
  cs: { color: '#178600', label: 'CS' },
  scala: { color: '#dc322f', label: 'SC' },
  r: { color: '#276dc3', label: 'R' },
  swift: { color: '#f05138', label: 'SW' },
  kt: { color: '#a97bff', label: 'KT' },
  kts: { color: '#a97bff', label: 'KT' },
  dart: { color: '#00b4ab', label: 'DA' },
  sh: { color: '#89e051', label: 'SH' },
  bash: { color: '#89e051', label: 'SH' },
  zsh: { color: '#89e051', label: 'SH' },
  yml: { color: '#cb171e', label: 'YM' },
  yaml: { color: '#cb171e', label: 'YM' },
  toml: { color: '#9c4221', label: 'TM' },
  ini: { color: '#9c4221', label: 'IN' },
  env: { color: '#ecd53f', label: 'EN' },
  xml: { color: '#0060ac', label: 'XM' },
  sql: { color: '#e38c00', label: 'SQ' },
  graphql: { color: '#e535ab', label: 'GQ' },
  gql: { color: '#e535ab', label: 'GQ' },
  lock: { color: '#6d8086', label: 'LK' },
  map: { color: '#6d8086', label: 'MP' },
  wasm: { color: '#654ff0', label: 'WA' },
  svg: { color: '#ffb13b', label: 'SG' },
  png: { color: '#a074c4', label: 'IM' },
  jpg: { color: '#a074c4', label: 'IM' },
  jpeg: { color: '#a074c4', label: 'IM' },
  gif: { color: '#a074c4', label: 'IM' },
  webp: { color: '#a074c4', label: 'IM' },
  bmp: { color: '#a074c4', label: 'IM' },
  ico: { color: '#a074c4', label: 'IM' },
}

function getFileIcon(name: string): TreeIcon {
  const lowerName = name.toLowerCase()
  const exact = SPECIAL_FILE_ICONS[lowerName]
  if (exact) return exact
  if (lowerName.startsWith('.env.')) return { color: '#ecd53f', label: 'EN' }
  const ext = lowerName.includes('.') ? lowerName.split('.').pop() ?? '' : ''
  return EXT_FILE_ICONS[ext] ?? { color: '#6d8086', label: 'FI' }
}

function FolderSvg({ open }: { open: boolean }) {
  const fill = '#4a5b73'
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {open ? (
        <path
          d="M2.8 8.4a2.4 2.4 0 0 1 2.4-2.4h5.1l1.9 2h7.8a2.4 2.4 0 0 1 2.3 3.1l-1.7 6.1a2.4 2.4 0 0 1-2.3 1.7H5.1a2.4 2.4 0 0 1-2.4-2.4z"
          fill={fill}
        />
      ) : (
        <path
          d="M3 7.8A2.8 2.8 0 0 1 5.8 5h4.7l2 2h5.5A2.8 2.8 0 0 1 20.8 9.8v7.4A2.8 2.8 0 0 1 18 20H5.8A2.8 2.8 0 0 1 3 17.2z"
          fill={fill}
        />
      )}
    </svg>
  )
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

  // 转换为 FileTreeEntry[]
  function toEntries(node: TmpNode): FileTreeEntry[] {
    const entries: FileTreeEntry[] = []
    for (const child of node.children.values()) {
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

function buildTreeFromFilePaths(paths: string[]): FileTreeEntry[] {
  return buildTreeFromPaths(
    (paths ?? [])
      .map((filePath) => normalizeSlashPath(filePath))
      .filter(Boolean)
      .map((filePath) => ({ filePath, oldContent: null, newContent: null })),
  )
}

type FileDiffStat = {
  added: number
  removed: number
}

function countLines(text: string | null): number {
  if (!text) return 0
  return text.split('\n').length
}

function scheduleNonBlocking(task: () => void): void {
  const win = window as Window & {
    requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number
  }
  if (typeof win.requestIdleCallback === 'function') {
    win.requestIdleCallback(() => task(), { timeout: 120 })
    return
  }
  window.setTimeout(task, 0)
}

const MAX_RENDER_CHANGE_PATHS = 2_500
const MAX_RENDER_WORKSPACE_TREE_NODES = 2_000

type TreeCountStats = {
  nodes: number
  files: number
}

type LimitedWorkspaceTree = {
  entries: FileTreeEntry[]
  hiddenNodes: number
  totalFiles: number
}

function countTreeEntryStats(entry: FileTreeEntry): TreeCountStats {
  if (!entry.isDirectory) return { nodes: 1, files: 1 }
  let nodes = 1
  let files = 0
  for (const child of entry.children ?? []) {
    const childStats = countTreeEntryStats(child)
    nodes += childStats.nodes
    files += childStats.files
  }
  return { nodes, files }
}

function limitWorkspaceTree(entries: FileTreeEntry[] | undefined, maxNodes: number): LimitedWorkspaceTree {
  if (!entries || entries.length === 0 || maxNodes <= 0) {
    return { entries: [], hiddenNodes: 0, totalFiles: 0 }
  }
  let remaining = maxNodes
  let hiddenNodes = 0
  let totalFiles = 0

  const walk = (list: FileTreeEntry[]): FileTreeEntry[] => {
    const out: FileTreeEntry[] = []
    for (const entry of list) {
      if (remaining <= 0) {
        const stats = countTreeEntryStats(entry)
        hiddenNodes += stats.nodes
        totalFiles += stats.files
        continue
      }

      remaining--
      if (entry.isDirectory) {
        const children = walk(entry.children ?? [])
        out.push({ ...entry, children })
      } else {
        totalFiles++
        out.push(entry)
      }
    }
    return out
  }

  return {
    entries: walk(entries),
    hiddenNodes,
    totalFiles,
  }
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
  diffStatsMap,
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
  diffStatsMap: Map<string, FileDiffStat>
  fileStatuses: Record<string, FileChangeStatus>
  statusFilter: 'pending' | 'accepted' | 'rejected'
  onAcceptFile: (filePath: string) => void
  onRejectFile: (filePath: string) => void
}) {
  const [expanded, setExpanded] = useState(depth < 1)

  if (entry.isDirectory) {
    return (
      <div>
        <div
          className="change-tree-dir"
          style={{ paddingLeft: depth * 18 + 24 }}
          onClick={() => setExpanded((p) => !p)}
        >
          <span className={`ws-tree-arrow ${expanded ? 'open' : ''}`}>›</span>
          <span className={`ws-folder-icon ${expanded ? 'open' : ''}`}>
            <FolderSvg open={expanded} />
          </span>
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
            diffStatsMap={diffStatsMap}
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

  const isActive = selectedPath === entry.path || viewingPath === entry.path
  const icon = getFileIcon(entry.name)
  const isDeleted = Boolean(change && change.newContent === null)
  const isNew = Boolean(change && change.oldContent === null && change.newContent !== null)
  const stats = diffStatsMap.get(entry.path) ?? null
  const parentPath = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : ''
  const changeTypeLabel = isNew ? '新增' : isDeleted ? '删除' : '修改'
  const statusLabel = statusFilter === 'pending' ? '未暂存' : statusFilter === 'accepted' ? '已暂存' : '已撤销'

  return (
    <div
      className={`change-file-row ${statusFilter} ${isActive ? 'selected' : ''}`}
      style={{ paddingLeft: depth * 18 + 24 }}
      onClick={() => onFileClick(entry.path)}
      title={entry.path}
    >
      <span className={`change-file-status-chip ${statusFilter}`}>{statusLabel}</span>
      <span className="ws-file-icon" style={{ background: icon.color }}>{icon.label}</span>
      <span className="change-file-main">
        <span className="change-file-name">{entry.name}</span>
        {parentPath && <span className="change-file-parent">{parentPath}</span>}
      </span>
      {change && (
        <span className={`ws-file-change-badge ${isNew ? 'added' : isDeleted ? 'deleted' : 'modified'}`}>
          {changeTypeLabel}
        </span>
      )}
      {stats && (
        <span className="ws-file-stats">
          {stats.added > 0 && <span className="stat-add">+{stats.added}</span>}
          {stats.removed > 0 && <span className="stat-remove">-{stats.removed}</span>}
        </span>
      )}
      {statusFilter === 'pending' && (
        <span className="change-file-actions">
          <button type="button" className="ws-file-action-btn accept"
            onClick={(e) => { e.stopPropagation(); onAcceptFile(entry.path) }} title="暂存">暂存</button>
        </span>
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
  diffStatsMap,
  changedPathSet,
  stagedPathSet,
  unstagedPathSet,
  fileStatuses,
  onAcceptFile,
  onRejectFile,
  onContextMenu,
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
  diffStatsMap: Map<string, FileDiffStat>
  changedPathSet: Set<string>
  stagedPathSet: Set<string>
  unstagedPathSet: Set<string>
  fileStatuses: Record<string, FileChangeStatus>
  onAcceptFile: (filePath: string) => void
  onRejectFile: (filePath: string) => void
  /** 右键菜单回调 */
  onContextMenu?: (e: React.MouseEvent, path: string, isDirectory: boolean) => void
}) {
  const [expanded, setExpanded] = useState(false)

  if (entry.isDirectory) {
    return (
      <div className="ws-tree-dir">
        <div
          className="ws-tree-dir-header"
          style={{ paddingLeft: depth * 18 + 24 }}
          onClick={() => setExpanded((p) => !p)}
          onContextMenu={(e) => onContextMenu?.(e, entry.path, true)}
        >
          <span className={`ws-tree-arrow ${expanded ? 'open' : ''}`}>›</span>
          <span className={`ws-folder-icon ${expanded ? 'open' : ''}`}>
            <FolderSvg open={expanded} />
          </span>
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
            diffStatsMap={diffStatsMap}
            changedPathSet={changedPathSet}
            stagedPathSet={stagedPathSet}
            unstagedPathSet={unstagedPathSet}
            fileStatuses={fileStatuses}
            onAcceptFile={onAcceptFile}
            onRejectFile={onRejectFile}
            onContextMenu={onContextMenu}
          />
        ))}
      </div>
    )
  }

  // 文件节点
  const change = changesMap.get(entry.path)
  const hasDiff = !!change
  const isChanged = hasDiff || changedPathSet.has(entry.path)
  const isActive = selectedPath === entry.path || viewingPath === entry.path
  const status: FileChangeStatus = (
    stagedPathSet.has(entry.path)
      ? 'accepted'
      : (
        unstagedPathSet.has(entry.path)
          ? 'pending'
          : (
            fileStatuses[entry.path]
            ?? fileStatuses[entry.path.replace(/\//g, '\\')]
            ?? 'pending'
          )
      )
  )
  const icon = getFileIcon(entry.name)

  // 变更类型
  let changeBadge: { label: string; cls: string } | null = null
  if (change) {
    if (change.oldContent === null) changeBadge = { label: 'A', cls: 'added' }
    else if (change.newContent === null) changeBadge = { label: 'D', cls: 'deleted' }
    else changeBadge = { label: 'M', cls: 'modified' }
  } else if (isChanged) {
    changeBadge = { label: 'M', cls: 'modified' }
  }

  // diff 统计（仅变更文件）
  const stats = diffStatsMap.get(entry.path) ?? null

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
      onContextMenu={(e) => onContextMenu?.(e, entry.path, false)}
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
            title="暂存"
          >✓</button>
          {hasDiff && (
            <button
              type="button"
              className="ws-file-action-btn reject"
              onClick={(e) => { e.stopPropagation(); onRejectFile(entry.path) }}
              title="撤销"
            >✗</button>
          )}
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
  projectTokenStats,
  workspaceTree,
  fileChanges,
  selectedFile,
  onSelectFile,
  fileStatuses,
  onAcceptFile,
  onRejectFile,
  onAcceptAll,
  onRejectAll,
  stagedFiles,
  unstagedFiles,
  gitStatusLoaded = false,
  onStageFile,
  onStageAll,
  gitVersions,
  onGitRollback,
  onLoadCommitFiles,
  workspace,
  treeExpanded,
  onTreeExpandedChange,
  changesExpanded,
  onChangesExpandedChange,
  gitExpanded,
  onGitExpandedChange,
  onRefreshTree,
  onOpenFileView,
  viewingFile,
  onDeleteFile,
  onDeleteDirectory,
}: Readonly<DetailPanelProps>) {
  const [expandedHashes, setExpandedHashes] = useState<Set<string>>(new Set())
  const [commitFilesCache, setCommitFilesCache] = useState<Record<string, string[]>>({})
  const [rollingBack, setRollingBack] = useState<string | null>(null)
  // 右键菜单状态
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    path: string
    isDirectory: boolean
  } | null>(null)

  // 右键菜单处理
  const handleContextMenu = useCallback((e: React.MouseEvent, path: string, isDirectory: boolean) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, path, isDirectory })
  }, [])

  const closeContextMenu = useCallback(() => {
    setContextMenu(null)
  }, [])

  // 点击其他地方关闭菜单
  useEffect(() => {
    if (!contextMenu) return
    const handleClick = () => closeContextMenu()
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [contextMenu, closeContextMenu])

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

  const diffStatsJobSeqRef = useRef(0)
  const [asyncDiffStats, setAsyncDiffStats] = useState<Record<string, FileDiffStat>>({})
  useEffect(() => {
    if (!treeExpanded && !changesExpanded) {
      diffStatsJobSeqRef.current++
      setAsyncDiffStats({})
      return
    }

    const seq = ++diffStatsJobSeqRef.current
    const base: Record<string, FileDiffStat> = {}
    const modifyTargets: FileChangeInfo[] = []

    for (const fc of dedupedChanges) {
      if (fc.oldContent === null && fc.newContent !== null) {
        base[fc.filePath] = { added: countLines(fc.newContent), removed: 0 }
        continue
      }
      if (fc.oldContent !== null && fc.newContent === null) {
        base[fc.filePath] = { added: 0, removed: countLines(fc.oldContent) }
        continue
      }
      if (fc.oldContent !== null && fc.newContent !== null) {
        modifyTargets.push(fc)
      }
    }

    setAsyncDiffStats(base)
    if (modifyTargets.length === 0) return

    let i = 0
    const CHUNK_SIZE = 1
    const runChunk = () => {
      if (seq !== diffStatsJobSeqRef.current) return
      const end = Math.min(i + CHUNK_SIZE, modifyTargets.length)
      const partial: Record<string, FileDiffStat> = {}
      for (; i < end; i++) {
        const fc = modifyTargets[i]
        try {
          const oldText = fc.oldContent ?? ''
          const newText = fc.newContent ?? ''
          // 极大文本退化为近似统计，避免阻塞主线程。
          if ((oldText.length + newText.length) > 180_000) {
            const oldLines = countLines(oldText)
            const newLines = countLines(newText)
            partial[fc.filePath] = {
              added: Math.max(0, newLines - oldLines),
              removed: Math.max(0, oldLines - newLines),
            }
          } else {
            partial[fc.filePath] = diffStats(computeDiff(oldText, newText))
          }
        } catch {
          partial[fc.filePath] = { added: 0, removed: 0 }
        }
      }
      if (Object.keys(partial).length > 0) {
        setAsyncDiffStats((prev) => {
          if (seq !== diffStatsJobSeqRef.current) return prev
          return { ...prev, ...partial }
        })
      }
      if (i < modifyTargets.length) {
        scheduleNonBlocking(runChunk)
      }
    }

    scheduleNonBlocking(runChunk)
    return () => {
      if (seq === diffStatsJobSeqRef.current) {
        diffStatsJobSeqRef.current++
      }
    }
  }, [dedupedChanges, treeExpanded, changesExpanded])

  const diffStatsMap = useMemo(() => {
    const map = new Map<string, FileDiffStat>()
    for (const [path, stats] of Object.entries(asyncDiffStats)) {
      map.set(path, stats)
    }
    return map
  }, [asyncDiffStats])

  const normalizedUnstaged = useMemo(() => {
    const seen = new Set<string>()
    for (const rawPath of unstagedFiles ?? []) {
      const normalized = normalizeWorkspaceRelativePath(rawPath, workspace)
      if (normalized) seen.add(normalized)
    }
    return Array.from(seen).sort((a, b) => a.localeCompare(b))
  }, [unstagedFiles, workspace])

  const normalizedStaged = useMemo(() => {
    const seen = new Set<string>()
    for (const rawPath of stagedFiles ?? []) {
      const normalized = normalizeWorkspaceRelativePath(rawPath, workspace)
      if (normalized) seen.add(normalized)
    }
    return Array.from(seen).sort((a, b) => a.localeCompare(b))
  }, [stagedFiles, workspace])

  const effectiveUnstaged = useMemo(() => {
    if (normalizedUnstaged.length > 0 || normalizedStaged.length > 0) return normalizedUnstaged
    if (gitStatusLoaded) return []
    const fallback = dedupedChanges.map((fc) => fc.filePath).filter(Boolean)
    return Array.from(new Set(fallback)).sort((a, b) => a.localeCompare(b))
  }, [normalizedUnstaged, normalizedStaged, dedupedChanges, gitStatusLoaded])

  const allDisplayChangePaths = useMemo(() => {
    const set = new Set<string>()
    for (const p of effectiveUnstaged) set.add(p)
    for (const p of normalizedStaged) set.add(p)
    if (set.size === 0 && !gitStatusLoaded) {
      for (const fc of dedupedChanges) set.add(fc.filePath)
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [effectiveUnstaged, normalizedStaged, dedupedChanges, gitStatusLoaded])
  const displayChangePaths = useMemo(
    () => allDisplayChangePaths.slice(0, MAX_RENDER_CHANGE_PATHS),
    [allDisplayChangePaths],
  )
  const hiddenChangePathsCount = Math.max(0, allDisplayChangePaths.length - displayChangePaths.length)
  const diffablePathSet = useMemo(
    () => new Set(dedupedChanges.map((fc) => fc.filePath)),
    [dedupedChanges],
  )
  const changedPathSet = useMemo(
    () => new Set(displayChangePaths),
    [displayChangePaths],
  )
  const unstagedPathSet = useMemo(
    () => new Set(effectiveUnstaged),
    [effectiveUnstaged],
  )
  const stagedPathSet = useMemo(
    () => new Set(normalizedStaged),
    [normalizedStaged],
  )

  const hasChanges = allDisplayChangePaths.length > 0
  const unstagedCount = effectiveUnstaged.length
  const stagedCount = normalizedStaged.length

  const hasTree = workspaceTree && workspaceTree.length > 0

  const workspaceTreeLimited = useMemo(
    () => limitWorkspaceTree(workspaceTree, MAX_RENDER_WORKSPACE_TREE_NODES),
    [workspaceTree],
  )
  const renderedWorkspaceTree = workspaceTreeLimited.entries
  const hiddenWorkspaceNodeCount = workspaceTreeLimited.hiddenNodes
  const totalFileCount = hasTree ? workspaceTreeLimited.totalFiles : 0

  const unstagedTree = useMemo(() => buildTreeFromFilePaths(effectiveUnstaged), [effectiveUnstaged])
  const stagedTree = useMemo(() => buildTreeFromFilePaths(normalizedStaged), [normalizedStaged])

  // 变更面板状态 Tab（未暂存/已暂存），默认未暂存，持久化到 localStorage
  const [changeTab, setChangeTab] = useState<'unstaged' | 'staged'>(() => {
    try { return localStorage.getItem('taco.panel.changeTab') === 'staged' ? 'staged' : 'unstaged' } catch { return 'unstaged' }
  })
  useEffect(() => {
    try { localStorage.setItem('taco.panel.changeTab', changeTab) } catch { /* ignore */ }
  }, [changeTab])

  // fallback: 没有工作区目录树时，从变更文件路径构建树
  const fallbackTree = useMemo(() => {
    if (hasTree || displayChangePaths.length === 0) return []
    return buildTreeFromFilePaths(displayChangePaths)
  }, [hasTree, displayChangePaths])

  const showTree = hasTree || (hasChanges && fallbackTree.length > 0)
  const showGit = !!(gitVersions && gitVersions.length > 0)
  const activeChangeTab: 'unstaged' | 'staged' = changeTab

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
      onOpenFileView(path, diffablePathSet.has(path))
    } else {
      onSelectFile(selectedFile === path ? null : path)
    }
  }, [onOpenFileView, onSelectFile, selectedFile, diffablePathSet])

  const handleManualRefreshClick = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault()
    e.stopPropagation()
    onRefreshTree?.()
  }, [onRefreshTree])

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
        <div className="detail-token-stats">
          <div className="detail-token-stats-title">项目累计 Token</div>
          <div className="detail-token-stats-grid">
            <span>累计输入</span>
            <span>{formatTokens(projectTokenStats?.inputTokens ?? 0)}</span>
            <span>累计输出</span>
            <span>{formatTokens(projectTokenStats?.outputTokens ?? 0)}</span>
            <span>命中</span>
            <span>{formatTokens(projectTokenStats?.hitTokens ?? 0)}</span>
            <span>未命中</span>
            <span>{formatTokens(projectTokenStats?.missTokens ?? 0)}</span>
            <span>总计</span>
            <span>{formatTokens(projectTokenStats?.totalTokens ?? 0)}</span>
          </div>
        </div>
      </div>

      {/* ── 工作区文件树（上方，可折叠，与变更面板样式一致） ── */}
      {hasTree ? (
        <div className="change-group-panel" ref={treePanelRef}>
          <div
            className="change-group-header"
            onClick={() => onTreeExpandedChange(!treeExpanded)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter') onTreeExpandedChange(!treeExpanded) }}
          >
            <span className={`ws-tree-arrow ${treeExpanded ? 'open' : ''}`}>›</span>
            <span className="change-group-title">文件</span>
            <span className="change-group-count">{totalFileCount}</span>
            {onRefreshTree && (
              <div className="detail-changes-actions">
                <button
                  type="button"
                  className="tree-refresh-btn"
                  onClick={handleManualRefreshClick}
                  aria-label="手动刷新文件目录"
                  title="手动刷新文件目录"
                >
                  ↻
                </button>
              </div>
            )}
          </div>
          {treeExpanded && (
            <div className="change-group-body">
              {hiddenWorkspaceNodeCount > 0 && (
                <div className="change-tab-empty">
                  文件过多，仅渲染前 {MAX_RENDER_WORKSPACE_TREE_NODES} 个节点（其余 {hiddenWorkspaceNodeCount} 个节点已折叠）
                </div>
              )}
              {renderedWorkspaceTree.map((entry) => (
                <WsTreeNode
                  key={entry.path}
                  entry={entry}
                  selectedPath={selectedFile}
                  viewingPath={viewingFile}
                  onFileClick={handleTreeFileClick}
                  changesMap={changesMap}
                  diffStatsMap={diffStatsMap}
                  changedPathSet={changedPathSet}
                  stagedPathSet={stagedPathSet}
                  unstagedPathSet={unstagedPathSet}
                  fileStatuses={fileStatuses}
                  onAcceptFile={onAcceptFile}
                  onRejectFile={onRejectFile}
                  onContextMenu={handleContextMenu}
                />
              ))}
            </div>
          )}
        </div>
      ) : hasChanges && fallbackTree.length > 0 ? (
        /* 没有工作区目录树但有变更文件时，从路径构建树形结构 */
        <div className="change-group-panel" ref={treePanelRef}>
          <div
            className="change-group-header"
            onClick={() => onTreeExpandedChange(!treeExpanded)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter') onTreeExpandedChange(!treeExpanded) }}
          >
            <span className={`ws-tree-arrow ${treeExpanded ? 'open' : ''}`}>›</span>
            <span className="change-group-title">文件</span>
            <span className="change-group-count">{allDisplayChangePaths.length}</span>
            {onRefreshTree && (
              <div className="detail-changes-actions">
                <button
                  type="button"
                  className="tree-refresh-btn"
                  onClick={handleManualRefreshClick}
                  aria-label="手动刷新文件目录"
                  title="手动刷新文件目录"
                >
                  ↻
                </button>
              </div>
            )}
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
                  diffStatsMap={diffStatsMap}
                  changedPathSet={changedPathSet}
                  stagedPathSet={stagedPathSet}
                  unstagedPathSet={unstagedPathSet}
                  fileStatuses={fileStatuses}
                  onAcceptFile={onAcceptFile}
                  onRejectFile={onRejectFile}
                  onContextMenu={handleContextMenu}
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
            onClick={() => onChangesExpandedChange(!changesExpanded)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter') onChangesExpandedChange(!changesExpanded) }}
          >
            <span className={`ws-tree-arrow ${changesExpanded ? 'open' : ''}`}>›</span>
            <span className="change-group-title">变更文件</span>
            <span className="change-group-count">{allDisplayChangePaths.length}</span>
            {unstagedCount > 0 && (
              <span className="change-group-pending-badge">{unstagedCount} 未暂存</span>
            )}
            {onRefreshTree && (
              <div className="detail-changes-actions">
                <button
                  type="button"
                  className="tree-refresh-btn"
                  onClick={handleManualRefreshClick}
                  aria-label="手动刷新变更文件"
                  title="手动刷新变更文件"
                >
                  ↻
                </button>
              </div>
            )}
          </div>

          {changesExpanded && (
            <div className="change-group-body">
              {hiddenChangePathsCount > 0 && (
                <div className="change-tab-empty">
                  变更过多，仅渲染前 {displayChangePaths.length} 项（其余 {hiddenChangePathsCount} 项已折叠）
                </div>
              )}
              <div className="change-tabs" role="tablist" aria-label="变更状态">
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeChangeTab === 'unstaged'}
                  className={`change-tab ${activeChangeTab === 'unstaged' ? 'active pending' : ''}`}
                  onClick={() => setChangeTab('unstaged')}
                >
                  未暂存 ({unstagedCount})
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeChangeTab === 'staged'}
                  className={`change-tab ${activeChangeTab === 'staged' ? 'active accepted' : ''}`}
                  onClick={() => setChangeTab('staged')}
                >
                  已暂存 ({stagedCount})
                </button>
              </div>

              <div className="change-panel-legend" aria-hidden="true">
                <span className="legend-item"><span className="legend-pill pending">未暂存</span>待暂存到 Git</span>
                <span className="legend-item"><span className="legend-pill accepted">已暂存</span>已进入暂存区</span>
                <span className="legend-item"><span className="legend-pill modified">修改</span>文件内容改动</span>
              </div>

              {/* 批量操作：仅未暂存 Tab 显示 */}
              {activeChangeTab === 'unstaged' && unstagedCount > 0 && (
                <div className="detail-changes-bulk">
                  <button type="button" className="bulk-action-btn accept" onClick={onStageAll ?? onAcceptAll} title="暂存所有变更">
                    + 全部暂存
                  </button>
                </div>
              )}

              <div className="change-tab-pane">
                {activeChangeTab === 'unstaged' ? (
                  unstagedTree.length > 0 ? (
                    unstagedTree.map((entry) => (
                      <ChangeTreeNode
                        key={entry.path}
                        entry={entry}
                        selectedPath={selectedFile}
                        viewingPath={viewingFile}
                        onFileClick={handleChangeFileClick}
                        changesMap={changesMap}
                        diffStatsMap={diffStatsMap}
                        fileStatuses={fileStatuses}
                        statusFilter="pending"
                        onAcceptFile={onStageFile ?? onAcceptFile}
                        onRejectFile={onRejectFile}
                      />
                    ))
                  ) : (
                    <div className="change-tab-empty">暂无未暂存文件</div>
                  )
                ) : (
                  stagedTree.length > 0 ? (
                    stagedTree.map((entry) => (
                      <ChangeTreeNode
                        key={entry.path}
                        entry={entry}
                        selectedPath={selectedFile}
                        viewingPath={viewingFile}
                        onFileClick={handleChangeFileClick}
                        changesMap={changesMap}
                        diffStatsMap={diffStatsMap}
                        fileStatuses={fileStatuses}
                        statusFilter="accepted"
                        onAcceptFile={onAcceptFile}
                        onRejectFile={onRejectFile}
                      />
                    ))
                  ) : (
                    <div className="change-tab-empty">暂无已暂存文件</div>
                  )
                )}
              </div>
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
            onClick={() => onGitExpandedChange(!gitExpanded)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter') onGitExpandedChange(!gitExpanded) }}
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

      {/* 右键菜单 */}
      {contextMenu && (
        <div
          className="tree-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.isDirectory ? (
            <>
              <div
                className="context-menu-item danger"
                onClick={() => { onDeleteDirectory?.(contextMenu.path); closeContextMenu() }}
              >
                删除目录
              </div>
            </>
          ) : (
            <>
              <div
                className="context-menu-item danger"
                onClick={() => { onDeleteFile?.(contextMenu.path); closeContextMenu() }}
              >
                删除文件
              </div>
            </>
          )}
        </div>
      )}
    </aside>
  )
}
