/**
 * 工作区目录树构建
 *
 * 包含工作区文件/目录收集、树形渲染等。供 list_dir 和 find_file 复用。
 */

import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import ignore from 'ignore'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type WorkspaceEntryKind = 'file' | 'directory'

type WorkspaceEntry = {
  path: string
  name: string
  kind: WorkspaceEntryKind
  depth: number
}

type CollectWorkspaceOptions = {
  maxDepth?: number
  includeHidden?: boolean
  maxEntries?: number
}

type TreeRenderOptions = {
  maxDepth: number
  includeFiles: boolean
  maxLines?: number
}

type TreeRenderResult = {
  text: string
  stats: {
    directoryCount: number
    fileCount: number
    lineCount: number
  }
  truncated: boolean
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.floor(parsed)))
}

function toPosixPath(input: string): string {
  return input.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '').replace(/\/$/, '')
}

function isHiddenPath(relPath: string): boolean {
  return relPath.split('/').some((segment) => segment.startsWith('.'))
}

/** fs.readdir 递归时忽略的目录/文件名 */
const FS_IGNORE = new Set([
  '.git', 'node_modules', '.next', '__pycache__', '.venv', 'venv',
  'dist', '.cache', '.turbo', 'coverage', 'release', '.nuxt',
  '.output', '.svelte-kit', '.parcel-cache', '.DS_Store',
])

/* ------------------------------------------------------------------ */
/*  .gitignore 解析（使用 ignore 库，与 git 行为一致）                  */
/* ------------------------------------------------------------------ */

/**
 * 加载并合并所有 .gitignore 规则。
 *
 * 与 git 行为一致：不仅读取根目录的 .gitignore，还会递归查找子目录中的
 * .gitignore 文件，并按层级合并规则。子目录的规则优先级更高。
 */
async function loadAllGitignoreRules(rootDir: string): Promise<import('ignore').Ignore> {
  const ig = ignore()

  // 先收集所有 .gitignore 文件路径（按深度排序，根目录优先）
  const gitignorePaths: string[] = []

  async function findGitignoreFiles(absDir: string, relDir: string, depth: number) {
    if (depth > 12) return
    let items: fsSync.Dirent[]
    try {
      items = fsSync.readdirSync(absDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of items) {
      if (item.name === '.gitignore' && item.isFile()) {
        gitignorePaths.push(path.join(absDir, '.gitignore'))
      }
      if (item.isDirectory() && !FS_IGNORE.has(item.name) && !item.name.startsWith('.')) {
        await findGitignoreFiles(
          path.join(absDir, item.name),
          relDir ? `${relDir}/${item.name}` : item.name,
          depth + 1,
        )
      }
    }
  }

  await findGitignoreFiles(rootDir, '', 0)

  // 按路径深度排序（根目录 .gitignore 优先加载）
  gitignorePaths.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length)

  for (const gitignorePath of gitignorePaths) {
    try {
      const content = await fs.readFile(gitignorePath, 'utf-8')
      ig.add(content)
    } catch {
      // 忽略读取失败的文件
    }
  }

  return ig
}

/**
 * 快速判断路径是否被 .gitignore 规则忽略。
 *
 * 使用 ignore 库的 .ignores() 方法，与 git 的忽略行为完全一致。
 * 支持所有 gitignore 语法：通配符、目录后缀 /、否定 !、锚定等。
 */
function isPathIgnored(relPath: string, ig: import('ignore').Ignore): boolean {
  // ignore 库要求路径不带前导 ./
  const cleanPath = relPath.replace(/^\.\//, '')
  if (!cleanPath) return false
  return ig.ignores(cleanPath)
}

function shouldSkipName(name: string, includeHidden: boolean): boolean {
  if (FS_IGNORE.has(name)) return true
  if (!includeHidden && name.startsWith('.')) return true
  return false
}

function addDirectoryAncestors(relPath: string, dirSet: Set<string>) {
  const parts = relPath.split('/')
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join('/')
    if (dir) dirSet.add(dir)
  }
}

function buildWorkspaceEntries(fileSet: Set<string>, dirSet: Set<string>): WorkspaceEntry[] {
  const entries: WorkspaceEntry[] = []
  for (const dir of dirSet) {
    const clean = toPosixPath(dir)
    if (!clean) continue
    entries.push({
      path: clean,
      name: clean.split('/').pop() || clean,
      kind: 'directory',
      depth: clean.split('/').length,
    })
  }
  for (const file of fileSet) {
    const clean = toPosixPath(file)
    if (!clean) continue
    entries.push({
      path: clean,
      name: clean.split('/').pop() || clean,
      kind: 'file',
      depth: clean.split('/').length,
    })
  }
  entries.sort((a, b) => a.path.localeCompare(b.path))
  return entries
}

async function hasDirectoryContent(dir: string): Promise<boolean> {
  try {
    const items = await fs.readdir(dir)
    return items.length > 0
  } catch {
    return false
  }
}

/**
 * 统一的工作区索引收集器。
 *
 * 优先使用 git ls-files（快且尊重 .gitignore），失败时回退到 fs.readdir。
 * 返回统一的 file/directory 条目，供 list_dir / find_file 复用。
 */
async function collectWorkspaceEntries(
  rootDir: string,
  options: CollectWorkspaceOptions = {},
): Promise<{ entries: WorkspaceEntry[]; truncated: boolean }> {
  const maxDepth = clampNumber(options.maxDepth, 1, 24, 12)
  const maxEntries = clampNumber(options.maxEntries, 200, 10000, 4000)
  const includeHidden = Boolean(options.includeHidden)
  const fileSet = new Set<string>()
  const dirSet = new Set<string>()
  let truncated = false

  // 方法一：git ls-files
  try {
    const { exec } = await import('node:child_process')
    await new Promise<void>((resolve, reject) => {
      exec('git rev-parse --show-toplevel', { cwd: rootDir, timeout: 3000 }, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
    const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
      exec(
        'git ls-files --cached --others --exclude-standard',
        { cwd: rootDir, timeout: 6000, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout) => {
          if (err) reject(err)
          else resolve({ stdout })
        }
      )
    })
    const files = stdout.trim().split('\n').filter(Boolean)
    if (files.length > 0 || !(await hasDirectoryContent(rootDir))) {
      for (const raw of files) {
        if (fileSet.size + dirSet.size >= maxEntries) {
          truncated = true
          break
        }
        const relPath = toPosixPath(raw)
        if (!relPath) continue
        if (!includeHidden && isHiddenPath(relPath)) continue
        if (relPath.split('/').length > maxDepth + 8) {
          truncated = true
          continue
        }
        // 验证文件在磁盘上真实存在（git ls-files --cached 返回的是索引，
        // 目录清空后索引中的文件可能已被删除）
        try {
          fsSync.accessSync(path.join(rootDir, relPath), fsSync.constants.F_OK)
        } catch {
          continue
        }
        fileSet.add(relPath)
        addDirectoryAncestors(relPath, dirSet)
      }
      return { entries: buildWorkspaceEntries(fileSet, dirSet), truncated }
    }
  } catch {
    // 非 git 仓库或 git 不可用，回退到 fs.readdir
  }

  // 方法二：fs.readdir 递归
  const ig = await loadAllGitignoreRules(rootDir)
  const scanDepth = Math.min(maxDepth + 8, 24)
  async function scan(absDir: string, relDir: string, depth: number) {
    if (depth > scanDepth || fileSet.size + dirSet.size >= maxEntries) {
      truncated = true
      return
    }
    let items: import('node:fs').Dirent[]
    try {
      items = await fs.readdir(absDir, { withFileTypes: true })
    } catch {
      return
    }
    items.sort((a, b) => a.name.localeCompare(b.name))

    for (const item of items) {
      if (shouldSkipName(item.name, includeHidden)) continue

      const relPath = toPosixPath(relDir ? `${relDir}/${item.name}` : item.name)
      if (!relPath) continue

      // 使用 ignore 库判断是否被 .gitignore 忽略
      if (isPathIgnored(relPath, ig)) continue

      if (item.isDirectory()) {
        dirSet.add(relPath)
        await scan(path.join(absDir, item.name), relPath, depth + 1)
      } else if (item.isFile()) {
        fileSet.add(relPath)
      }
    }
  }

  await scan(rootDir, '', 0)
  return { entries: buildWorkspaceEntries(fileSet, dirSet), truncated }
}

/* ------------------------------------------------------------------ */
/*  Tree renderer                                                      */
/* ------------------------------------------------------------------ */

function renderTree(
  entries: WorkspaceEntry[],
  rootDir: string,
  options: TreeRenderOptions,
): TreeRenderResult {
  const { maxDepth, includeFiles, maxLines = 200 } = options
  const lines: string[] = []
  let directoryCount = 0
  let fileCount = 0
  let truncated = false

  // 按目录分组
  const dirMap = new Map<string, WorkspaceEntry[]>()
  for (const entry of entries) {
    const parent = entry.path.includes('/')
      ? entry.path.split('/').slice(0, -1).join('/')
      : '.'
    if (!dirMap.has(parent)) dirMap.set(parent, [])
    dirMap.get(parent)!.push(entry)
  }

  // 递归渲染
  function renderDir(relDir: string, prefix: string, depth: number) {
    if (depth > maxDepth) return
    const children = dirMap.get(relDir) ?? []
    const dirs = children.filter((e) => e.kind === 'directory')
    const files = includeFiles ? children.filter((e) => e.kind === 'file') : []
    const sorted = [...dirs, ...files].sort((a, b) => a.name.localeCompare(b.name))

    for (let i = 0; i < sorted.length; i++) {
      if (lines.length >= maxLines) {
        truncated = true
        return
      }
      const entry = sorted[i]
      const isLast = i === sorted.length - 1
      const connector = isLast ? '└── ' : '├── '
      const childPrefix = isLast ? prefix + '    ' : prefix + '│   '

      if (entry.kind === 'directory') {
        directoryCount++
        lines.push(`${prefix}${connector}${entry.name}/`)
        renderDir(entry.path, childPrefix, depth + 1)
      } else {
        fileCount++
        lines.push(`${prefix}${connector}${entry.name}`)
      }
    }
  }

  const header = `./ (${entries.filter((e) => e.kind === 'directory').length} dirs, ${entries.filter((e) => e.kind === 'file').length} files)`
  lines.push(header)
  renderDir('.', '', 0)

  return {
    text: lines.join('\n'),
    stats: { directoryCount, fileCount, lineCount: lines.length },
    truncated,
  }
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

export async function getWorkspaceTree(
  rootDir: string,
  options: {
    maxDepth?: number
    includeFiles?: boolean
    includeHidden?: boolean
    maxEntries?: number
    maxLines?: number
  } = {},
): Promise<TreeRenderResult & { entries: WorkspaceEntry[] }> {
  const maxDepth = clampNumber(options.maxDepth, 1, 12, 4)
  const includeFiles = options.includeFiles !== false
  const includeHidden = Boolean(options.includeHidden)
  const maxEntries = clampNumber(options.maxEntries, 200, 10000, 4000)
  const maxLines = options.maxLines ?? 200

  const { entries, truncated: entriesTruncated } = await collectWorkspaceEntries(rootDir, {
    maxDepth,
    includeHidden,
    maxEntries,
  })

  const tree = renderTree(entries, rootDir, {
    maxDepth,
    includeFiles,
    maxLines,
  })

  return {
    ...tree,
    entries,
    truncated: tree.truncated || entriesTruncated,
  }
}
