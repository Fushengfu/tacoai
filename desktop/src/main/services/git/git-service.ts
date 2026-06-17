/**
 * Git 版本控制工具
 *
 * 基于 child_process.exec 调用本地 git 命令。
 * 用于 Agent 文件变更后的自动提交、版本历史查看、版本回退。
 */

import { exec, execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'

/* ------------------------------------------------------------------ */
/*  工具函数                                                           */
/* ------------------------------------------------------------------ */

/** 执行 git 命令（通过 shell），返回 stdout */
function git(cwd: string, args: string): Promise<string> {
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

/** 执行 git 命令（通过 shell），返回原始 stdout（不 trim，保留换行） */
function gitRaw(cwd: string, args: string): Promise<string> {
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
function gitExecFile(cwd: string, args: string[]): Promise<string> {
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

/** 执行 git 命令（直接 execFile，跳过 shell），返回原始 stdout（不 trim） */
function gitExecFileRaw(cwd: string, args: string[]): Promise<string> {
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

/** 检查目录是否是 git 仓库 */
async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await git(cwd, 'rev-parse --is-inside-work-tree')
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ */
/*  公开 API                                                           */
/* ------------------------------------------------------------------ */

/** Git commit 记录（精简） */
export type GitCommitInfo = {
  hash: string
  shortHash: string
  message: string
  timestamp: number  // Unix seconds
  fileCount: number
}

export type GitWorkingTreeStatus = {
  staged: string[]
  unstaged: string[]
  /** 每个文件的 porcelain 状态码：M=已修改 A=新增暂存 D=已删除 ?=未跟踪 R=重命名 C=已复制 */
  fileStatuses: Record<string, string>
}

export type GitFileChangeInfo = {
  filePath: string
  oldContent: string | null
  newContent: string | null
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

function normalizeGitRelativePath(filePath: string): string {
  return String(filePath ?? '')
    .trim()
    .replace(/[\\]+/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
}

/** 检测是否为二进制内容（含 NUL 字节） */
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
    const buf = Buffer.from(await fs.readFile(absPath))
    if (isBinaryBuffer(buf)) return null
    return buf.toString('utf-8')
  } catch {
    return null
  }
}

async function readHeadText(cwd: string, filePath: string): Promise<string | null> {
  const rel = normalizeGitRelativePath(filePath)
  if (!rel) return null
  try {
    // 使用 execFile 直接传数组参数，跳过 shell，Windows/macOS 均可靠
    const out = await gitExecFileRaw(cwd, ['show', `HEAD:${rel}`])
    if (out.includes('\u0000')) return null
    return out
  } catch {
    return null
  }
}

/**
 * 从暂存区读取文件内容（git show :path）。
 * 用于 HEAD 中不存在的文件（新增未提交的文件），也能获取旧版本进行 diff。
 */
async function readStagedText(cwd: string, filePath: string): Promise<string | null> {
  const rel = normalizeGitRelativePath(filePath)
  if (!rel) return null
  try {
    const out = await gitExecFileRaw(cwd, ['show', `:${rel}`])
    if (out.includes('\u0000')) return null
    return out
  } catch {
    return null
  }
}

/**
 * 确保工作空间是 git 仓库。
 * 如果不是，则初始化并做一次初始提交。
 */
export async function gitEnsureRepo(cwd: string): Promise<void> {
  if (await isGitRepo(cwd)) return
  await git(cwd, 'init')
  // 配置用户信息（仅对此仓库生效，不影响全局）
  await git(cwd, 'config user.name "Taco"')
  await git(cwd, 'config user.email "taco@local"')
  // 初始提交
  await git(cwd, 'add -A')
  try {
    await git(cwd, 'commit -m "[taco] 初始版本" --allow-empty')
  } catch {
    // 如果没有文件可提交也无所谓
  }
}

/**
 * 暂存所有变更并提交。
 * @returns commit hash，如果没有变更则返回 null
 */
export async function gitCommit(cwd: string, message: string): Promise<string | null> {
  await gitEnsureRepo(cwd)

  // 暂存所有变更
  await git(cwd, 'add -A')

  // 检查是否有暂存的变更
  try {
    await git(cwd, 'diff --cached --quiet')
    // 没有变更
    return null
  } catch {
    // 有变更，继续提交
  }

  // 提交
  const safeMsg = message.replace(/"/g, '\\"')
  await git(cwd, `commit -m "[taco] ${safeMsg}"`)

  // 返回 commit hash
  const hash = await git(cwd, 'rev-parse HEAD')
  return hash
}

/**
 * 获取 Taco 的提交历史（仅 [taco] 前缀的提交）
 */
export async function gitLog(cwd: string, maxCount = 50): Promise<GitCommitInfo[]> {
  if (!(await isGitRepo(cwd))) return []

  try {
    // 使用单次 git log + name-only，避免每条 commit 额外 diff-tree 的 N+1 开销
    const raw = await gitRaw(
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
        message: message.replace(/^\[taco\]\s*/, ''), // 去掉 [taco] 前缀
        timestamp: Number(ts),
        fileCount,
      })
    }

    return commits
  } catch {
    return []
  }
}

/**
 * 获取某个提交变更的文件列表
 */
export async function gitCommitFiles(cwd: string, hash: string): Promise<string[]> {
  try {
    const raw = await git(cwd, `diff-tree --no-commit-id --name-only -r ${hash}`)
    return raw ? raw.split('\n').filter(Boolean) : []
  } catch {
    return []
  }
}

/**
 * 获取工作区文件状态（已暂存 / 未暂存）
 */
export async function gitStatus(cwd: string): Promise<GitWorkingTreeStatus> {
  if (!(await isGitRepo(cwd))) {
    return { staged: [], unstaged: [], fileStatuses: {} }
  }
  try {
    const [stagedRaw, unstagedRaw, untrackedRaw, porcelainRaw] = await Promise.all([
      git(cwd, 'diff --cached --name-only --'),
      git(cwd, 'diff --name-only --'),
      git(cwd, 'ls-files --others --exclude-standard'),
      git(cwd, 'status --porcelain'),
    ])
    const staged = parseGitNameList(stagedRaw)
    const unstaged = parseGitNameList([unstagedRaw, untrackedRaw].filter(Boolean).join('\n'))

    // 解析 porcelain 获取每文件状态码
    const fileStatuses: Record<string, string> = {}
    if (porcelainRaw) {
      for (const line of porcelainRaw.split('\n')) {
        if (!line || line.length < 4) continue
        const idx = line.charAt(0)
        const wt = line.charAt(1)
        const rest = line.slice(3).trim() // skip "XY "
        if (!rest) continue

        // 重命名/复制：格式为 "R  old -> new"
        if ((idx === 'R' || idx === 'C') && rest.includes(' -> ')) {
          const newPath = rest.split(' -> ').pop()!
          fileStatuses[normalizeGitRelativePath(newPath)] = idx
          continue
        }

        // 常规文件：工作区状态优先，其次索引状态
        const status = wt !== ' ' ? wt : idx
        fileStatuses[normalizeGitRelativePath(rest)] = status
      }
    }
    return { staged, unstaged, fileStatuses }
  } catch {
    return { staged: [], unstaged: [], fileStatuses: {} }
  }
}

/**
 * 获取指定文件的差异快照（HEAD → 暂存区 → null vs 工作区）
 */
export async function gitFileChange(cwd: string, filePath: string): Promise<GitFileChangeInfo | null> {
  if (!(await isGitRepo(cwd))) return null
  const rel = normalizeGitRelativePath(filePath)
  if (!rel) return null

  // oldContent 策略：HEAD → 暂存区 → null（新文件从未被跟踪）
  let oldContent: string | null = await readHeadText(cwd, rel)
  if (oldContent === null) {
    oldContent = await readStagedText(cwd, rel)
  }

  const newContent = await readWorkingTreeText(cwd, rel)
  // 始终返回文件信息：即使内容完全相同也让 UI 展示无差异高亮的文件内容
  return { filePath: rel, oldContent, newContent }
}

/**
 * 暂存指定文件
 */
export async function gitStageFiles(cwd: string, filePaths: string[]): Promise<void> {
  await gitEnsureRepo(cwd)
  const normalized = Array.from(new Set(
    (filePaths ?? [])
      .map((p) => String(p ?? '').trim())
      .filter(Boolean),
  ))
  if (normalized.length === 0) return
  // 使用 execFile 直接传路径数组，跨平台安全（Windows cmd.exe 不识别单引号）
  await gitExecFile(cwd, ['add', '--', ...normalized])
}

/**
 * 暂存全部变更
 */
export async function gitStageAll(cwd: string): Promise<void> {
  await gitEnsureRepo(cwd)
  await git(cwd, 'add -A')
}

/**
 * 回退到指定提交（硬重置）
 * 注意：这会丢弃目标提交之后的所有变更！
 */
export async function gitRollback(cwd: string, hash: string): Promise<void> {
  await git(cwd, `reset --hard ${hash}`)
}

/**
 * 获取当前 HEAD 的 hash
 */
export async function gitHead(cwd: string): Promise<string | null> {
  try {
    return await git(cwd, 'rev-parse HEAD')
  } catch {
    return null
  }
}
