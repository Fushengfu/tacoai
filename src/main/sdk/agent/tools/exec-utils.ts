/**
 * 工具执行器 - 通用工具函数与类型
 *
 * 包含路径解析、进程执行、安全校验等底层工具。
 */

import fs from 'node:fs/promises'
import * as fsSync from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { exec, execFile } from 'node:child_process'
import type { AgentServices } from '../services'

/* ------------------------------------------------------------------ */
/*  通用类型                                                           */
/* ------------------------------------------------------------------ */

export type ExecResult = { content: string; success: boolean }

export type ToolRuntimeContext = {
  allowedToolNames?: Set<string>
  overrides?: any // ProviderOverrides
  services?: AgentServices
  provider?: string // ProviderKey for tools that need LLM calls
  userId?: string
  signal?: AbortSignal
}

/* ------------------------------------------------------------------ */
/*  中止信号处理                                                        */
/* ------------------------------------------------------------------ */

export function makeAbortError(): Error {
  const err = new Error('Aborted')
  err.name = 'AbortError'
  return err
}

export function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return err.name === 'AbortError' || err.message === 'Aborted'
}

/* ------------------------------------------------------------------ */
/*  Workspace 安全检查                                                  */
/* ------------------------------------------------------------------ */

/** 将路径归一化为文件系统真实路径，用于可靠比较。 */
function normalizePathForCompare(p: string): string {
  try {
    return fsSync.realpathSync.native(p)
  } catch {
    const missingParts: string[] = []
    let current = p
    while (true) {
      const parent = path.dirname(current)
      if (parent === current) {
        const normalized = path.normalize(p)
        return process.platform === 'win32' ? normalized.toLowerCase() : normalized
      }
      try {
        const realParent = fsSync.realpathSync.native(parent)
        const basename = path.basename(current)
        return path.join(realParent, basename, ...missingParts)
      } catch {
        missingParts.unshift(path.basename(current))
        current = parent
      }
    }
  }
}

function isPathWithinWorkspace(workspace: string, targetPath: string): boolean {
  const normalizedWs = normalizePathForCompare(workspace)
  const normalizedTarget = normalizePathForCompare(targetPath)
  return normalizedTarget === normalizedWs || normalizedTarget.startsWith(normalizedWs + path.sep)
}

/** 解析路径：相对于 workspace，并检查是否在 workspace 内 */
export function resolveSafe(
  workspace: string,
  filePath: string,
  options?: { allowOutsideWorkspaceRead?: boolean },
): { resolved: string } | { error: string } {
  const normalizedWs = path.normalize(workspace)

  if (path.isAbsolute(filePath)) {
    const normalizedFp = path.normalize(filePath)
    if (isPathWithinWorkspace(workspace, normalizedFp)) {
      return { resolved: normalizedFp }
    }
    if (options?.allowOutsideWorkspaceRead) {
      return { resolved: normalizedFp }
    }
    return { error: `路径不在当前工作空间内: "${filePath}"（工作空间: "${normalizedWs}"）` }
  }

  let cleaned = filePath
  cleaned = cleaned.replace(/^\/+/, '')

  const wsName = path.basename(workspace)
  if (cleaned.startsWith(wsName + '/') || cleaned.startsWith(wsName + '\\')) {
    const without = cleaned.slice(wsName.length + 1)
    const testResolved = path.resolve(workspace, without)
    if (isPathWithinWorkspace(workspace, testResolved)) {
      cleaned = without
    }
  }

  cleaned = cleaned.replace(/\/+$/, '')
  if (!cleaned) cleaned = '.'

  const resolved = path.resolve(workspace, cleaned)
  const normalized = path.normalize(resolved)
  if (!isPathWithinWorkspace(workspace, normalized)) {
    if (options?.allowOutsideWorkspaceRead) {
      return { resolved: normalized }
    }
    return { error: `安全限制：路径 "${filePath}" 超出工作空间 "${workspace}"（解析为 ${normalized}）` }
  }
  return { resolved: normalized }
}

/**
 * 智能路径解析：先尝试直接路径，如果找不到则在项目中搜索匹配的目录/文件。
 */
export async function resolveSmartPath(
  workspace: string,
  filePath: string,
  kind: 'directory' | 'file' | 'any' = 'any',
  options?: { allowOutsideWorkspaceRead?: boolean },
): Promise<{ resolved: string; corrected?: string } | { error: string }> {
  const rawPath = String(filePath ?? '').trim()
  if (path.isAbsolute(rawPath) && options?.allowOutsideWorkspaceRead && !isPathWithinWorkspace(workspace, rawPath)) {
    const normalizedAbs = path.normalize(rawPath)
    try {
      const stat = await fs.stat(normalizedAbs)
      if (kind === 'directory' && !stat.isDirectory()) {
        return { error: `Error: Not a directory: ${normalizedAbs}` }
      }
      if (kind === 'file' && !stat.isFile()) {
        return { error: `Error: Not a file: ${normalizedAbs}` }
      }
      return { resolved: normalizedAbs }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { error: `Error: File not found: ${normalizedAbs}` }
      }
      throw err
    }
  }

  const check = resolveSafe(workspace, filePath, options)
  if ('error' in check) return check

  try {
    const stat = await fs.stat(check.resolved)
    if (kind === 'directory' && !stat.isDirectory()) {
      return { error: `"${check.resolved}" 不是目录` }
    }
    if (kind === 'file' && !stat.isFile()) {
      return { error: `"${check.resolved}" 是一个目录，不是文件` }
    }
    return { resolved: check.resolved }
  } catch {
    // 路径不存在，进入搜索
  }

  const searchName = filePath.replace(/^\.\//, '').replace(/\/+$/, '')
  if (!searchName || searchName === '.') return { error: `路径不存在: ${filePath}` }

  let candidates: string[] = []

  try {
    const { stdout } = await execAsync(
      'git ls-files --cached --others --exclude-standard',
      { cwd: workspace, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }
    )
    const allFiles = stdout.trim().split('\n').filter(Boolean)

    if (kind === 'file' || kind === 'any') {
      candidates = allFiles.filter((f) =>
        f === searchName || f.endsWith('/' + searchName)
      )
    }

    if ((kind === 'directory' || kind === 'any') && candidates.length === 0) {
      const dirs = new Set<string>()
      for (const f of allFiles) {
        const parts = f.split('/')
        for (let i = 1; i < parts.length; i++) {
          dirs.add(parts.slice(0, i).join('/'))
        }
      }
      candidates = [...dirs].filter((d) =>
        d === searchName || d.endsWith('/' + searchName)
      )
    }
  } catch {
    try {
      const found: string[] = []
      const IGNORE = new Set(['.git', 'node_modules', '.next', '__pycache__', '.venv', 'dist', '.cache', '.turbo', 'coverage', 'release'])
      async function scan(dir: string, depth: number) {
        if (depth > 8 || found.length >= 5) return
        const items = await fs.readdir(dir, { withFileTypes: true })
        for (const item of items) {
          if (IGNORE.has(item.name)) continue
          const rel = path.relative(workspace, path.join(dir, item.name))
          if (item.isDirectory()) {
            if (rel === searchName || rel.endsWith('/' + searchName) || rel.endsWith(path.sep + searchName)) {
              found.push(rel)
            }
            await scan(path.join(dir, item.name), depth + 1)
          } else if (kind !== 'directory') {
            if (rel === searchName || rel.endsWith('/' + searchName) || rel.endsWith(path.sep + searchName)) {
              found.push(rel)
            }
          }
        }
      }
      await scan(workspace, 0)
      candidates = found
    } catch { /* ignore */ }
  }

  if (candidates.length === 0) {
    let topDirs = ''
    try {
      const items = await fs.readdir(workspace, { withFileTypes: true })
      const dirs = items.filter((i) => i.isDirectory() && !i.name.startsWith('.')).map((i) => i.name + '/').slice(0, 20)
      if (dirs.length > 0) topDirs = `\n工作空间顶层目录: ${dirs.join(', ')}`
    } catch { /* ignore */ }
    return { error: `路径不存在: "${filePath}"（在工作空间 "${workspace}" 中未找到匹配的 "${searchName}"）${topDirs}\n请使用相对于工作空间根目录的路径，如 "src/components" 而非 "components"` }
  }

  candidates.sort((a, b) => a.length - b.length)
  const best = candidates[0]
  const bestResolved = path.resolve(workspace, best)

  if (!isPathWithinWorkspace(workspace, bestResolved)) {
    return { error: `安全限制：纠正后路径超出工作空间` }
  }

  const hint = candidates.length > 1
    ? `\n（还有其他匹配: ${candidates.slice(1, 4).join(', ')}${candidates.length > 4 ? '...' : ''}）`
    : ''

  return { resolved: bestResolved, corrected: best + hint }
}

/* ------------------------------------------------------------------ */
/*  异步 exec 包装                                                      */
/* ------------------------------------------------------------------ */

let commandEnvCache: NodeJS.ProcessEnv | null = null
let commandEnvLoadingPromise: Promise<NodeJS.ProcessEnv> | null = null

function parseNulSeparatedEnv(raw: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const item of raw.split('\0')) {
    if (!item) continue
    const eq = item.indexOf('=')
    if (eq <= 0) continue
    const key = item.slice(0, eq)
    const value = item.slice(eq + 1)
    if (!key) continue
    env[key] = value
  }
  return env
}

function mergePathValue(primary: string, secondary: string): string {
  const sep = process.platform === 'win32' ? ';' : ':'
  const seen = new Set<string>()
  const normalize = (p: string) => process.platform === 'win32'
    ? p.toLowerCase().replace(/[/\\]+$/, '')
    : p
  const merged: string[] = []
  for (const raw of `${primary}${sep}${secondary}`.split(sep)) {
    const p = raw.trim()
    if (!p) continue
    const key = normalize(p)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(p)
  }
  return merged.join(sep)
}

async function loadLoginShellEnv(): Promise<NodeJS.ProcessEnv> {
  if (process.platform === 'win32') return {}
  const shell = process.env.SHELL || '/bin/zsh'
  const attempts: Array<{ args: string[]; mode: string }> = [
    { args: ['-ilc', 'env -0'], mode: 'login-interactive' },
    { args: ['-lc', 'env -0'], mode: 'login' },
  ]

  for (const attempt of attempts) {
    try {
      const output = await new Promise<string>((resolve, reject) => {
        execFile(shell, attempt.args, {
          encoding: 'utf8',
          timeout: 8000,
          maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env },
        }, (err, stdout) => {
          if (err) { reject(err); return }
          resolve(stdout ?? '')
        })
      })
      const parsed = parseNulSeparatedEnv(output)
      if (Object.keys(parsed).length > 0) {
        return parsed
      }
    } catch { /* ignore */ }
  }
  return {}
}

export async function getRunCommandEnv(): Promise<NodeJS.ProcessEnv> {
  if (commandEnvCache) return commandEnvCache
  if (commandEnvLoadingPromise) return commandEnvLoadingPromise

  commandEnvLoadingPromise = (async () => {
    const systemEnv: NodeJS.ProcessEnv = { ...process.env }
    const shellEnv = await loadLoginShellEnv()
    const merged: NodeJS.ProcessEnv = { ...systemEnv, ...shellEnv }

    const shellPath = shellEnv.PATH || shellEnv.Path
    const systemPath = systemEnv.PATH || systemEnv.Path
    if (shellPath && systemPath) {
      const pathValue = mergePathValue(shellPath, systemPath)
      merged.PATH = pathValue
      merged.Path = pathValue
    }

    commandEnvCache = merged
    return merged
  })()

  try {
    return await commandEnvLoadingPromise
  } finally {
    commandEnvLoadingPromise = null
  }
}

/** 异步执行 shell 命令，带超时和输出限制 */
export function execAsync(
  command: string,
  options: { cwd: string; timeout: number; maxBuffer?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(makeAbortError())
      return
    }

    let settled = false
    const child = exec(command, {
      cwd: options.cwd,
      timeout: options.timeout,
      maxBuffer: options.maxBuffer ?? 1024 * 1024,
      encoding: 'utf-8',
      env: options.env,
    }, (err, stdout, stderr) => {
      if (settled) return
      settled = true
      cleanup()
      if (err) {
        const error = err as Error & { stdout?: string; stderr?: string }
        error.stdout = stdout ?? ''
        error.stderr = stderr ?? ''
        reject(error)
      } else {
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '' })
      }
    })

    const killTimer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* ignore */ }
    }, options.timeout + 5000)

    const onAbort = () => {
      if (settled) return
      settled = true
      try { child.kill('SIGTERM') } catch { /* ignore */ }
      cleanup()
      reject(makeAbortError())
    }

    const cleanup = () => {
      clearTimeout(killTimer)
      if (options.signal) options.signal.removeEventListener('abort', onAbort)
    }

    if (options.signal) options.signal.addEventListener('abort', onAbort, { once: true })

    child.on('exit', cleanup)
    child.on('error', cleanup)
  })
}

/** 异步执行可执行文件（不启动 shell），带超时和输出限制 */
export function execFileAsync(
  file: string,
  args: string[],
  options: { cwd: string; timeout: number; maxBuffer?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(makeAbortError())
      return
    }

    let settled = false
    const child = execFile(file, args, {
      cwd: options.cwd,
      timeout: options.timeout,
      maxBuffer: options.maxBuffer ?? 1024 * 1024,
      encoding: 'utf-8',
      env: options.env,
    }, (err, stdout, stderr) => {
      if (settled) return
      settled = true
      cleanup()
      if (err) {
        const error = err as Error & { stdout?: string; stderr?: string }
        error.stdout = stdout ?? ''
        error.stderr = stderr ?? ''
        reject(error)
      } else {
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '' })
      }
    })

    const killTimer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* ignore */ }
    }, options.timeout + 5000)

    const onAbort = () => {
      if (settled) return
      settled = true
      try { child.kill('SIGTERM') } catch { /* ignore */ }
      cleanup()
      reject(makeAbortError())
    }

    const cleanup = () => {
      clearTimeout(killTimer)
      if (options.signal) options.signal.removeEventListener('abort', onAbort)
    }

    if (options.signal) options.signal.addEventListener('abort', onAbort, { once: true })

    child.on('exit', cleanup)
    child.on('error', cleanup)
  })
}

/* ------------------------------------------------------------------ */
/*  小工具函数                                                          */
/* ------------------------------------------------------------------ */

export function toPosixPath(input: string): string {
  return input.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '').replace(/\/$/, '')
}

export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.floor(parsed)))
}
