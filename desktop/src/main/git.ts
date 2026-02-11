/**
 * Git 版本控制工具
 *
 * 基于 child_process.exec 调用本地 git 命令。
 * 用于 Agent 文件变更后的自动提交、版本历史查看、版本回退。
 */

import { exec } from 'node:child_process'

/* ------------------------------------------------------------------ */
/*  工具函数                                                           */
/* ------------------------------------------------------------------ */

/** 执行 git 命令，返回 stdout */
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
    // 格式: hash|shortHash|timestamp|message
    const raw = await git(
      cwd,
      `log --grep="\\[taco\\]" --format="%H|%h|%at|%s" -n ${maxCount}`
    )
    if (!raw) return []

    const commits: GitCommitInfo[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      const [hash, shortHash, ts, ...msgParts] = line.split('|')
      const message = msgParts.join('|') // 消息中可能包含 |
      commits.push({
        hash,
        shortHash,
        message: message.replace(/^\[taco\]\s*/, ''), // 去掉 [taco] 前缀
        timestamp: Number(ts),
        fileCount: 0, // 下面填充
      })
    }

    // 为每个提交获取变更文件数量
    for (const commit of commits) {
      try {
        const stat = await git(cwd, `diff-tree --no-commit-id --name-only -r ${commit.hash}`)
        commit.fileCount = stat ? stat.split('\n').filter(Boolean).length : 0
      } catch {
        // ignore
      }
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
