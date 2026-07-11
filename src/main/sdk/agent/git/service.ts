/**
 * Universal Git 抽象层
 *
 * 自动检测系统是否安装了原生 git CLI：
 * - 已安装：走 native 后端（child_process.exec，性能最优）
 * - 未安装：走 isomorphic-git 后端（纯 JS 实现，零系统依赖）
 *
 * 上层调用者（agent-loop.ts / IPC handlers）无需感知差异。
 */

import { exec, execFile } from 'node:child_process'
import * as fsPromises from 'node:fs/promises'
import * as nodePath from 'node:path'

// ---------------------------------------------------------------------------
// 类型定义（与 git-service.ts 保持一致）
// ---------------------------------------------------------------------------

export type GitCommitInfo = {
  hash: string
  shortHash: string
  message: string
  timestamp: number
  fileCount: number
}

export type GitWorkingTreeStatus = {
  staged: string[]
  unstaged: string[]
  fileStatuses: Record<string, string>
}

export type GitFileChangeInfo = {
  filePath: string
  oldContent: string | null
  newContent: string | null
}

// ---------------------------------------------------------------------------
// 后端检测
// ---------------------------------------------------------------------------

type GitBackend = 'native' | 'iso'
type BackendCache = { backend: GitBackend; detectedAt: number }
const BACKEND_CACHE_TTL_MS = 5 * 60 * 1000 // 5 分钟内有效，超时自动重检

let backendCache: BackendCache | null = null

async function detectGitBackend(): Promise<GitBackend> {
  // 缓存未过期，直接返回
  if (backendCache && Date.now() - backendCache.detectedAt < BACKEND_CACHE_TTL_MS) {
    return backendCache.backend
  }
  try {
    await new Promise<void>((resolve, reject) => {
      execFile('git', ['--version'], { timeout: 5000 }, (err) => {
        err ? reject(err) : resolve()
      })
    })
    backendCache = { backend: 'native', detectedAt: Date.now() }
  } catch {
    backendCache = { backend: 'iso', detectedAt: Date.now() }
  }
  return backendCache.backend
}

/** 强制重置检测缓存（用于测试或 Git 安装后的立即切换） */
export function resetGitBackendDetection(): void {
  backendCache = null
}

// ---------------------------------------------------------------------------
// 共享工具函数
// ---------------------------------------------------------------------------

function normalizeGitRelativePath(filePath: string): string {
  return String(filePath ?? '')
    .trim()
    .replace(/[\\]+/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
}

function isBinaryBuffer(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8192)
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

async function readWorkingTreeText(cwd: string, filePath: string): Promise<string | null> {
  const rel = normalizeGitRelativePath(filePath)
  if (!rel) return null
  try {
    const absPath = nodePath.join(cwd, rel)
    const buf = await fsPromises.readFile(absPath)
    if (isBinaryBuffer(buf)) return null
    return buf.toString('utf-8')
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Native 后端（复用 git-service.ts 的原始实现）
// ---------------------------------------------------------------------------

/** 执行 git 命令（通过 shell），返回 stdout */
function nativeGit(cwd: string, args: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(`git ${args}`, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr.trim() || err.message))
      } else {
        resolve(stdout.trim())
      }
    })
  })
}

/** 执行 git 命令（通过 shell），返回原始 stdout */
function nativeGitRaw(cwd: string, args: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(`git ${args}`, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr.trim() || err.message))
      } else {
        resolve(stdout)
      }
    })
  })
}

/** 执行 git 命令（直接 execFile，跳过 shell，跨平台安全），返回 stdout */
function nativeGitExecFile(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr.trim() || err.message))
      } else {
        resolve(stdout.trim())
      }
    })
  })
}

/** 执行 git 命令（直接 execFile），返回原始 stdout */
function nativeGitExecFileRaw(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr.trim() || err.message))
      } else {
        resolve(stdout)
      }
    })
  })
}

async function nativeIsGitRepo(cwd: string): Promise<boolean> {
  try {
    await nativeGit(cwd, 'rev-parse --is-inside-work-tree')
    return true
  } catch {
    return false
  }
}

function parseGitNameList(raw: string): string[] {
  if (!raw) return []
  const normalized = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/[\\]+/g, '/').replace(/^\.\//, ''))
  return Array.from(new Set(normalized)).sort((a, b) => a.localeCompare(b))
}

async function nativeGitEnsureRepo(cwd: string): Promise<void> {
  if (await nativeIsGitRepo(cwd)) return
  await nativeGit(cwd, 'init')
  await nativeGit(cwd, 'config user.name "Taco"')
  await nativeGit(cwd, 'config user.email "taco@local"')
  await nativeGit(cwd, 'add -A')
  try {
    await nativeGit(cwd, 'commit -m "[taco] 初始版本" --allow-empty')
  } catch {
    /* 没有文件可提交也无所谓 */
  }
}

async function nativeGitCommit(cwd: string, message: string): Promise<string | null> {
  await nativeGitEnsureRepo(cwd)
  await nativeGit(cwd, 'add -A')
  try {
    await nativeGit(cwd, 'diff --cached --quiet')
    return null
  } catch {
    /* 有变更，继续 */
  }
  const safeMsg = message.replace(/"/g, '\\"')
  await nativeGit(cwd, `commit -m "[taco] ${safeMsg}"`)
  return await nativeGit(cwd, 'rev-parse HEAD')
}

async function nativeGitLog(cwd: string, maxCount = 50): Promise<GitCommitInfo[]> {
  if (!(await nativeIsGitRepo(cwd))) return []
  try {
    const raw = await nativeGitRaw(
      cwd,
      `log --grep="\\[taco\\]" --format="%H%x1f%h%x1f%at%x1f%s%x1e" --name-only -n ${maxCount}`
    )
    if (!raw) return []
    const commits: GitCommitInfo[] = []
    const records = raw.split('\u001e')
    for (const record of records) {
      const block = record.trim()
      if (!block) continue
      const lines = block.split('\n')
      const header = lines.shift()?.trim()
      if (!header) continue
      const [hash, shortHash, ts, ...msgParts] = header.split('\u001f')
      if (!hash || !shortHash || !ts) continue
      const message = msgParts.join('\u001f')
      const fileCount = lines.map((line) => line.trim()).filter(Boolean).length
      commits.push({
        hash,
        shortHash,
        message: message.replace(/^\[taco\]\s*/, ''),
        timestamp: Number(ts),
        fileCount,
      })
    }
    return commits
  } catch {
    return []
  }
}

async function nativeGitCommitFiles(cwd: string, hash: string): Promise<string[]> {
  try {
    const raw = await nativeGit(cwd, `diff-tree --no-commit-id --name-only -r ${hash}`)
    return raw ? raw.split('\n').filter(Boolean) : []
  } catch {
    return []
  }
}

async function nativeGitStatus(cwd: string): Promise<GitWorkingTreeStatus> {
  if (!(await nativeIsGitRepo(cwd))) {
    return { staged: [], unstaged: [], fileStatuses: {} }
  }
  try {
    const [stagedRaw, unstagedRaw, untrackedRaw, porcelainRaw] = await Promise.all([
      nativeGit(cwd, 'diff --cached --name-only --'),
      nativeGit(cwd, 'diff --name-only --'),
      nativeGit(cwd, 'ls-files --others --exclude-standard'),
      nativeGit(cwd, 'status --porcelain'),
    ])
    const staged = parseGitNameList(stagedRaw)
    const unstaged = parseGitNameList([unstagedRaw, untrackedRaw].filter(Boolean).join('\n'))
    const fileStatuses: Record<string, string> = {}
    if (porcelainRaw) {
      for (const line of porcelainRaw.split('\n')) {
        if (!line || line.length < 4) continue
        const idx = line.charAt(0)
        const wt = line.charAt(1)
        const rest = line.slice(3).trim()
        if (!rest) continue
        if ((idx === 'R' || idx === 'C') && rest.includes(' -> ')) {
          const newPath = rest.split(' -> ').pop()!
          fileStatuses[normalizeGitRelativePath(newPath)] = idx
          continue
        }
        const status = wt !== ' ' ? wt : idx
        fileStatuses[normalizeGitRelativePath(rest)] = status
      }
    }
    return { staged, unstaged, fileStatuses }
  } catch {
    return { staged: [], unstaged: [], fileStatuses: {} }
  }
}

async function nativeReadHeadText(cwd: string, filePath: string): Promise<string | null> {
  const rel = normalizeGitRelativePath(filePath)
  if (!rel) return null
  try {
    const out = await nativeGitExecFileRaw(cwd, ['show', `HEAD:${rel}`])
    if (out.includes('\u0000')) return null
    return out
  } catch {
    return null
  }
}

async function nativeReadStagedText(cwd: string, filePath: string): Promise<string | null> {
  const rel = normalizeGitRelativePath(filePath)
  if (!rel) return null
  try {
    const out = await nativeGitExecFileRaw(cwd, ['show', `:${rel}`])
    if (out.includes('\u0000')) return null
    return out
  } catch {
    return null
  }
}

async function nativeGitFileChange(cwd: string, filePath: string): Promise<GitFileChangeInfo | null> {
  if (!(await nativeIsGitRepo(cwd))) return null
  const rel = normalizeGitRelativePath(filePath)
  if (!rel) return null
  let oldContent: string | null = await nativeReadHeadText(cwd, rel)
  if (oldContent === null) {
    oldContent = await nativeReadStagedText(cwd, rel)
  }
  const newContent = await readWorkingTreeText(cwd, rel)
  return { filePath: rel, oldContent, newContent }
}

async function nativeGitStageFiles(cwd: string, filePaths: string[]): Promise<void> {
  await nativeGitEnsureRepo(cwd)
  const normalized = Array.from(new Set(
    (filePaths ?? []).map((p) => String(p ?? '').trim()).filter(Boolean)
  ))
  if (normalized.length === 0) return
  await nativeGitExecFile(cwd, ['add', '--', ...normalized])
}

async function nativeGitStageAll(cwd: string): Promise<void> {
  await nativeGitEnsureRepo(cwd)
  await nativeGit(cwd, 'add -A')
}

async function nativeGitRollback(cwd: string, hash: string): Promise<void> {
  await nativeGit(cwd, `reset --hard ${hash}`)
}

async function nativeGitHead(cwd: string): Promise<string | null> {
  try {
    return await nativeGit(cwd, 'rev-parse HEAD')
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// isomorphic-git 后端
// ---------------------------------------------------------------------------

let isoGitModule: typeof import('isomorphic-git') | null = null

async function getIsoGit(): Promise<typeof import('isomorphic-git')> {
  if (!isoGitModule) {
    isoGitModule = await import('isomorphic-git')
  }
  return isoGitModule
}

/**
 * 将 Node.js fs/promises 适配为 isomorphic-git 的 PromiseFsClient。
 * isomorphic-git 的 readFile 默认返回 Buffer，与 fs/promises 行为一致。
 */
function makeIsoFs(cwd: string) {
  return {
    readFile: (filepath: string, opts?: { encoding?: string }) =>
      fsPromises.readFile(filepath, opts as any),
    writeFile: (filepath: string, data: Buffer | string, opts?: { mode?: number }) =>
      fsPromises.writeFile(filepath, data, opts as any),
    unlink: (filepath: string) => fsPromises.unlink(filepath),
    readdir: (filepath: string) => fsPromises.readdir(filepath),
    mkdir: (filepath: string) => fsPromises.mkdir(filepath, { recursive: true }),
    rmdir: (filepath: string) => fsPromises.rmdir(filepath),
    stat: (filepath: string) => fsPromises.stat(filepath),
    lstat: (filepath: string) => fsPromises.lstat(filepath),
    readlink: (filepath: string) => fsPromises.readlink(filepath),
    symlink: (target: string, filepath: string) => fsPromises.symlink(target, filepath),
  }
}

async function isoGitDir(cwd: string): Promise<string> {
  return nodePath.join(cwd, '.git')
}

async function isoIsGitRepo(cwd: string): Promise<boolean> {
  try {
    const git = await getIsoGit()
    const gitdir = await isoGitDir(cwd)
    await git.resolveRef({ fs: makeIsoFs(cwd), dir: cwd, gitdir, ref: 'HEAD' })
    return true
  } catch {
    return false
  }
}

async function isoGitEnsureRepo(cwd: string): Promise<void> {
  if (await isoIsGitRepo(cwd)) return
  const git = await getIsoGit()
  const isoFs = makeIsoFs(cwd)
  await git.init({ fs: isoFs, dir: cwd })

  // 创建 .gitignore，排除 .taco/
  const gitignorePath = nodePath.join(cwd, '.gitignore')
  try {
    const existing = await fsPromises.readFile(gitignorePath, 'utf-8')
    if (!existing.includes('.taco/')) {
      await fsPromises.appendFile(gitignorePath, '\n.taco/\n')
    }
  } catch {
    await fsPromises.writeFile(gitignorePath, '.taco/\n')
  }

  // 初始提交
  await git.add({ fs: isoFs, dir: cwd, filepath: '.' })
  try {
    await git.commit({
      fs: isoFs,
      dir: cwd,
      message: '[taco] 初始版本',
      author: { name: 'Taco', email: 'taco@local' },
    })
  } catch {
    /* 没有文件可提交也无所谓 */
  }
}

async function isoGitCommit(cwd: string, message: string): Promise<string | null> {
  await isoGitEnsureRepo(cwd)
  const git = await getIsoGit()
  const isoFs = makeIsoFs(cwd)

  // 暂存所有变更
  await git.add({ fs: isoFs, dir: cwd, filepath: '.' })

  // 检查是否有暂存的变更
  const matrix = await git.statusMatrix({ fs: isoFs, dir: cwd })
  const hasStaged = matrix.some(([_file, HEAD, _workdir, STAGE]) => {
    // STAGE !== HEAD 表示有暂存变更
    return STAGE !== HEAD && STAGE !== 1
  })
  if (!hasStaged) return null

  const safeMsg = `[taco] ${message}`
  const commitOid = await git.commit({
    fs: isoFs,
    dir: cwd,
    message: safeMsg,
    author: { name: 'Taco', email: 'taco@local' },
  })

  return commitOid
}

async function isoGitLog(cwd: string, maxCount = 50): Promise<GitCommitInfo[]> {
  if (!(await isoIsGitRepo(cwd))) return []
  try {
    const git = await getIsoGit()
    const isoFs = makeIsoFs(cwd)
    const logEntries = await git.log({ fs: isoFs, dir: cwd, depth: maxCount })
    const result: GitCommitInfo[] = []
    for (const entry of logEntries) {
      if (!entry.commit.message.startsWith('[taco]')) continue
      // 获取该提交的文件数
      let fileCount = 0
      try {
        const { commit: commitObj } = await git.readCommit({
          fs: isoFs, dir: cwd, oid: entry.oid,
        })
        const { tree: treeEntries } = await git.readTree({
          fs: isoFs, dir: cwd, oid: commitObj.tree,
        })
        fileCount = treeEntries.length
      } catch {
        fileCount = 0
      }
      result.push({
        hash: entry.oid,
        shortHash: entry.oid.slice(0, 7),
        message: entry.commit.message.replace(/^\[taco\]\s*/, ''),
        timestamp: entry.commit.author.timestamp,
        fileCount,
      })
      if (result.length >= maxCount) break
    }
    return result
  } catch {
    return []
  }
}

async function isoGitCommitFiles(cwd: string, hash: string): Promise<string[]> {
  try {
    const git = await getIsoGit()
    const isoFs = makeIsoFs(cwd)
    const { commit } = await git.readCommit({ fs: isoFs, dir: cwd, oid: hash })
    const { tree } = await git.readTree({ fs: isoFs, dir: cwd, oid: commit.tree })
    return tree.map((e: { path: string }) => e.path)
  } catch {
    return []
  }
}

async function isoGitStatus(cwd: string): Promise<GitWorkingTreeStatus> {
  if (!(await isoIsGitRepo(cwd))) {
    return { staged: [], unstaged: [], fileStatuses: {} }
  }
  try {
    const git = await getIsoGit()
    const isoFs = makeIsoFs(cwd)
    const matrix = await git.statusMatrix({ fs: isoFs, dir: cwd })

    const staged: string[] = []
    const unstaged: string[] = []
    const fileStatuses: Record<string, string> = {}

    for (const [filepath, HEAD, WORKDIR, STAGE] of matrix) {
      const norm = filepath.replace(/\\/g, '/')

      // 判断状态码（简化版 porcelain）
      let status = ' '
      if (HEAD === 0) {
        // 文件不在 HEAD 中
        if (STAGE === 2) status = 'A'      // 已暂存的新文件
        else if (WORKDIR === 1) status = '?' // 未跟踪
      } else {
        // 文件在 HEAD 中
        if (WORKDIR === 0) status = 'D'           // 已删除
        else if (STAGE === 3) status = 'M'        // 已暂存的修改
        else if (WORKDIR === 2) status = 'M'      // 未暂存的修改
      }

      if (status !== ' ') {
        fileStatuses[norm] = status
      }

      // STAGE !== HEAD 且 HEAD === 1 时 STAGE 与 HEAD 不同 → 有暂存变更
      if (HEAD === 1 && STAGE !== 1) {
        staged.push(norm)
      } else if (HEAD === 0 && (STAGE === 2 || STAGE === 3)) {
        staged.push(norm)
      }

      // WORKDIR !== STAGE → 有未暂存变更
      if (WORKDIR !== STAGE && !(STAGE === 1 && WORKDIR === 1)) {
        unstaged.push(norm)
      }
    }

    return { staged, unstaged, fileStatuses }
  } catch {
    return { staged: [], unstaged: [], fileStatuses: {} }
  }
}

/** 从指定 ref 读取文件内容（等价于 git show REF:filepath） */
async function isoReadFileAtRef(
  cwd: string,
  ref: string,
  filepath: string,
): Promise<string | null> {
  try {
    const git = await getIsoGit()
    const isoFs = makeIsoFs(cwd)
    const gitdir = await isoGitDir(cwd)

    const oid = await git.resolveRef({ fs: isoFs, dir: cwd, gitdir, ref })
    if (!oid) return null

    const { commit } = await git.readCommit({ fs: isoFs, dir: cwd, gitdir, oid })

    const parts = filepath.replace(/\\/g, '/').split('/').filter(Boolean)
    if (parts.length === 0) return null

    let currentTreeOid = commit.tree
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i]
      const isLast = i === parts.length - 1
      const { tree: entries } = await git.readTree({ fs: isoFs, dir: cwd, gitdir, oid: currentTreeOid })
      const entry = entries.find((e: { path: string }) => e.path === name)
      if (!entry) return null

      if (isLast) {
        const { blob } = await git.readBlob({ fs: isoFs, dir: cwd, gitdir, oid: entry.oid })
        const buf = Buffer.from(blob)
        if (isBinaryBuffer(buf)) return null
        return buf.toString('utf-8')
      } else {
        currentTreeOid = entry.oid
      }
    }
    return null
  } catch {
    return null
  }
}

async function isoGitFileChange(cwd: string, filePath: string): Promise<GitFileChangeInfo | null> {
  if (!(await isoIsGitRepo(cwd))) return null
  const rel = normalizeGitRelativePath(filePath)
  if (!rel) return null

  // oldContent：优先 HEAD，其次暂存区
  let oldContent: string | null = await isoReadFileAtRef(cwd, 'HEAD', rel)
  if (oldContent === null) {
    oldContent = await isoReadFileAtRef(cwd, '', rel) // '' = index/staging area
  }
  const newContent = await readWorkingTreeText(cwd, rel)
  return { filePath: rel, oldContent, newContent }
}

async function isoGitStageFiles(cwd: string, filePaths: string[]): Promise<void> {
  await isoGitEnsureRepo(cwd)
  const normalized = Array.from(new Set(
    (filePaths ?? []).map((p) => String(p ?? '').trim()).filter(Boolean)
  ))
  if (normalized.length === 0) return
  const git = await getIsoGit()
  const isoFs = makeIsoFs(cwd)
  for (const fp of normalized) {
    await git.add({ fs: isoFs, dir: cwd, filepath: fp })
  }
}

async function isoGitStageAll(cwd: string): Promise<void> {
  await isoGitEnsureRepo(cwd)
  const git = await getIsoGit()
  const isoFs = makeIsoFs(cwd)
  await git.add({ fs: isoFs, dir: cwd, filepath: '.' })
}

async function isoGitRollback(cwd: string, hash: string): Promise<void> {
  const git = await getIsoGit()
  const isoFs = makeIsoFs(cwd)
  const gitdir = await isoGitDir(cwd)

  // 先将 HEAD 指向目标提交
  await git.writeRef({ fs: isoFs, dir: cwd, gitdir, ref: 'refs/heads/master', value: hash, force: true })
  // Checkout（force 覆盖工作区变更）
  try {
    await git.checkout({ fs: isoFs, dir: cwd, gitdir, ref: hash, force: true })
  } catch {
    // 至少更新 HEAD symref
    await git.writeRef({ fs: isoFs, dir: cwd, gitdir, ref: 'HEAD', value: 'refs/heads/master', force: true, symbolic: true })
  }
}

async function isoGitHead(cwd: string): Promise<string | null> {
  try {
    const git = await getIsoGit()
    const isoFs = makeIsoFs(cwd)
    const gitdir = await isoGitDir(cwd)
    return await git.resolveRef({ fs: isoFs, dir: cwd, gitdir, ref: 'HEAD' })
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 统一公开 API（自动路由到对应后端）
// ---------------------------------------------------------------------------

export async function gitEnsureRepo(cwd: string): Promise<void> {
  const backend = await detectGitBackend()
  return backend === 'native' ? nativeGitEnsureRepo(cwd) : isoGitEnsureRepo(cwd)
}

export async function gitCommit(cwd: string, message: string): Promise<string | null> {
  const backend = await detectGitBackend()
  return backend === 'native' ? nativeGitCommit(cwd, message) : isoGitCommit(cwd, message)
}

export async function gitLog(cwd: string, maxCount?: number): Promise<GitCommitInfo[]> {
  const backend = await detectGitBackend()
  return backend === 'native' ? nativeGitLog(cwd, maxCount) : isoGitLog(cwd, maxCount)
}

export async function gitCommitFiles(cwd: string, hash: string): Promise<string[]> {
  const backend = await detectGitBackend()
  return backend === 'native' ? nativeGitCommitFiles(cwd, hash) : isoGitCommitFiles(cwd, hash)
}

export async function gitStatus(cwd: string): Promise<GitWorkingTreeStatus> {
  const backend = await detectGitBackend()
  return backend === 'native' ? nativeGitStatus(cwd) : isoGitStatus(cwd)
}

export async function gitFileChange(cwd: string, filePath: string): Promise<GitFileChangeInfo | null> {
  const backend = await detectGitBackend()
  return backend === 'native' ? nativeGitFileChange(cwd, filePath) : isoGitFileChange(cwd, filePath)
}

export async function gitStageFiles(cwd: string, filePaths: string[]): Promise<void> {
  const backend = await detectGitBackend()
  return backend === 'native' ? nativeGitStageFiles(cwd, filePaths) : isoGitStageFiles(cwd, filePaths)
}

export async function gitStageAll(cwd: string): Promise<void> {
  const backend = await detectGitBackend()
  return backend === 'native' ? nativeGitStageAll(cwd) : isoGitStageAll(cwd)
}

export async function gitRollback(cwd: string, hash: string): Promise<void> {
  const backend = await detectGitBackend()
  return backend === 'native' ? nativeGitRollback(cwd, hash) : isoGitRollback(cwd, hash)
}

export async function gitHead(cwd: string): Promise<string | null> {
  const backend = await detectGitBackend()
  return backend === 'native' ? nativeGitHead(cwd) : isoGitHead(cwd)
}
