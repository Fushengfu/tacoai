/**
 * 工具执行引擎
 *
 * 包含所有工具的执行器函数、路径解析、命令执行、文件操作等。
 */

import fs from 'node:fs/promises'
import * as fsSync from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { exec, execFile, execSync } from 'node:child_process'
import type { AgentServices } from '../services'
import type { BrowserActionType } from '../types'
import { readActiveSkillDetail, readActiveSkillResource, installSkill, previewSkill, uninstallSkill, searchSkills } from '../skills/service'
import { normalizeToolName, toolDefinitions, type ToolCall, type ToolResult, type FileChange } from './definitions'
import { assessToolCallsRisk, type RiskInfo, type RiskCategory, type RiskLevel } from './risk'
import { getWorkspaceTree } from './workspace-tree'
import { uploadDataUrlToStorage, requestChatCompletion, requestChatCompletionStream, isBuiltinProvider } from '../llm/client'
import type { ChatMessage, ProviderOverrides, ProviderKey } from '../llm/client'
import { recallMemoriesByKeywords } from '../memory/recall-tool'

// ---------------------------------------------------------------------------
// 截图/文件上传到云存储（统一走网关 API）
// ---------------------------------------------------------------------------

// 上传截图到云存储
async function uploadScreenshotToCloud(dataUrl: string, services: AgentServices): Promise<string | null> {
  try {
    if (!dataUrl || !dataUrl.startsWith('data:')) {
      services.logger('SCREENSHOT_UPLOAD_SKIP', { reason: 'invalid_data_url' })
      return null
    }
    const cloudUrl = await uploadDataUrlToStorage(null as any, dataUrl, undefined, services.getToken?.())
    services.logger('SCREENSHOT_UPLOADED', { cloudUrl })
    return cloudUrl
  } catch (err) {
    services.logger('SCREENSHOT_UPLOAD_FAIL', { error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

type ExecResult = { content: string; success: boolean }

type ToolRuntimeContext = {
  allowedToolNames?: Set<string>
  overrides?: ProviderOverrides
  services?: AgentServices
}

/* ------------------------------------------------------------------ */
/*  视觉模型图片分析（analyze_image 工具）                                 */
/* ------------------------------------------------------------------ */

const VISION_ANALYSIS_SYSTEM_PROMPT = `你是一个截图分析助手。根据用户的截图目的来分析截图内容。

请遵循以下规则：
- 只描述截图中实际存在的内容，不要猜测或编造
- 重点关注与截图目的直接相关的元素（按钮、文本、输入框、状态提示等）
- 如果目的是确认某个元素是否存在，明确指出该元素是否可见及其大致位置
- 如果目的是了解页面/桌面状态，描述当前的整体布局和关键内容
- 输出简洁、结构化，优先回应截图目的，不要在无目的时冗长描述所有细节
- 使用中文回复`

async function execAnalyzeImage(
  args: Record<string, unknown>,
  workspace: string,
  runtimeContext?: ToolRuntimeContext,
): Promise<ExecResult> {
  const image = typeof args.image === 'string' ? args.image.trim() : ''
  const goal = typeof args.goal === 'string' ? args.goal : undefined

  if (!image) {
    return { content: 'Error: image parameter is required (file path or data: URL)', success: false }
  }
  if (!goal) {
    return { content: 'Error: goal parameter is required', success: false }
  }

  // 解析图片为 data: URL
  let dataUrl: string
  if (image.startsWith('data:')) {
    dataUrl = image
  } else if (image.startsWith('http://') || image.startsWith('https://')) {
    dataUrl = image
  } else {
    try {
      const resolvedPath = path.isAbsolute(image) ? image : path.resolve(workspace, image)
      const buffer = await fs.readFile(resolvedPath)
      const ext = path.extname(resolvedPath).toLowerCase()
      const mimeTypes: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.bmp': 'image/bmp',
      }
      const mime = mimeTypes[ext] || 'image/png'
      dataUrl = `data:${mime};base64,${buffer.toString('base64')}`
    } catch (err) {
      return { content: `Error: failed to read image file: ${err instanceof Error ? err.message : String(err)}`, success: false }
    }
  }

  const services = runtimeContext?.services
  const overrides = runtimeContext?.overrides
  let selectedProvider: ProviderKey | null = null
  let effectiveOverrides: ProviderOverrides | undefined = overrides

  if (overrides) {
    for (const [key, cfg] of Object.entries(overrides)) {
      if (cfg.supportsVision === true && cfg.apiKey && cfg.model) {
        selectedProvider = key as ProviderKey
        break
      }
    }
  }

  if (!selectedProvider && services) {
    try {
      const providersState = services.database.getAppProviders()
      if (providersState?.data) {
        for (const cfg of providersState.data.modelConfigs) {
          if (cfg.supportsVision && cfg.apiKey && cfg.model) {
            const p = String(cfg.provider ?? '') as ProviderKey
            selectedProvider = p
            const parsedTemp = cfg.temperature ? Number(cfg.temperature) : undefined
            effectiveOverrides = {
              [p]: {
                baseUrl: (cfg.baseUrl as string) || undefined,
                apiKey: cfg.apiKey as string,
                model: cfg.model as string,
                temperature: parsedTemp !== undefined && Number.isFinite(parsedTemp) && parsedTemp >= 0 && parsedTemp <= 2 ? parsedTemp : undefined,
                supportsVision: true,
                supportsReasoning: cfg.supportsReasoning as boolean | undefined,
              },
            } as ProviderOverrides
            services.logger('ANALYZE_IMAGE_VISION_FALLBACK_DB', { provider: p, model: cfg.model })
            break
          }
        }
      }
    } catch (dbErr) {
      services?.logger('ANALYZE_IMAGE_DB_LOAD_FAIL', { error: dbErr instanceof Error ? dbErr.message : String(dbErr) })
    }
  }

  if (!selectedProvider && services?.gatewayModelCache) {
    const gwModels = services.gatewayModelCache.get()
    if (gwModels && gwModels.length > 0) {
      for (const m of gwModels) {
        if (m.supportsVision && m.apiKey && m.model) {
          const p = String(m.provider ?? '') as ProviderKey
          selectedProvider = p
          const parsedTemp = m.temperature ? Number(m.temperature) : undefined
          effectiveOverrides = {
            [p]: {
              baseUrl: (m.baseUrl as string) || undefined,
              apiKey: m.apiKey as string,
              model: m.model as string,
              temperature: parsedTemp !== undefined && Number.isFinite(parsedTemp) && parsedTemp >= 0 && parsedTemp <= 2 ? parsedTemp : undefined,
              supportsVision: true,
              supportsReasoning: m.supportsReasoning as boolean | undefined,
            },
          } as ProviderOverrides
          services.logger('ANALYZE_IMAGE_VISION_FALLBACK_GATEWAY', { provider: p, model: m.model })
          break
        }
      }
    } else {
      services?.logger('ANALYZE_IMAGE_GATEWAY_CACHE_EMPTY', {})
    }
  }

  if (!selectedProvider) {
    return { content: 'Error: no vision-capable model available. Please configure a vision model in settings.', success: false }
  }

  try {
    const messages: ChatMessage[] = [
      { role: 'system', content: VISION_ANALYSIS_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: `截图目的：${goal}` },
        ],
      } as ChatMessage,
    ]

    const stream = requestChatCompletionStream(selectedProvider, messages, effectiveOverrides)
    let accumulated = ''
    for await (const chunk of stream) {
      accumulated += chunk
    }
    if (accumulated.trim()) {
      services?.logger('ANALYZE_IMAGE_SUCCESS', { provider: selectedProvider, contentLength: accumulated.length })
      return { content: accumulated.trim(), success: true }
    }
    return { content: 'Error: vision model returned empty response', success: false }
  } catch (err) {
    services?.logger('ANALYZE_IMAGE_FAIL', { error: err instanceof Error ? err.message : String(err) })
    return { content: `Error: vision analysis failed: ${err instanceof Error ? err.message : String(err)}`, success: false }
  }
}

/* ------------------------------------------------------------------ */
/*  Workspace 安全检查                                                  */
/* ------------------------------------------------------------------ */

function makeAbortError(): Error {
  const err = new Error('Aborted')
  err.name = 'AbortError'
  return err
}

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return err.name === 'AbortError' || err.message === 'Aborted'
}

/** 将路径归一化为文件系统真实路径，用于可靠比较。
 *  处理：symlink 解析、Windows 盘符大小写、macOS APFS 大小写、Unicode 规范化。
 *  路径不存在时逐级向上查找已存在的父目录，剩余部分拼接回。
 */
function normalizePathForCompare(p: string): string {
  try {
    return fsSync.realpathSync.native(p)
  } catch {
    // 路径不存在：逐级向上查找已存在的父目录
    const missingParts: string[] = []
    let current = p
    while (true) {
      const parent = path.dirname(current)
      if (parent === current) {
        // 已到达文件系统根目录，全部父级都不存在，回退到小写比较（Windows）
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
function resolveSafe(
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
async function resolveSmartPath(
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
      // 期望目录但拿到了文件，继续搜索
    } else if (kind === 'file' && !stat.isFile()) {
      // 期望文件但拿到了目录，继续搜索
    } else {
      return { resolved: check.resolved }
    }
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

async function getRunCommandEnv(): Promise<NodeJS.ProcessEnv> {
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
function execAsync(
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

/* ------------------------------------------------------------------ */
/*  Tool executors                                                      */
/* ------------------------------------------------------------------ */

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  workspace: string,
  signal?: AbortSignal,
  projectId?: string,
  logScope?: string,
  runtimeContext?: ToolRuntimeContext,
): Promise<ExecResult & { fileChange?: FileChange }> {
  try {
    if (signal?.aborted) throw makeAbortError()
    const normalizedName = normalizeToolName(name)
    switch (normalizedName) {
      case 'read_file':
        return await execReadFile(args, workspace)
      case 'read_skill':
        return await execReadSkill(args, runtimeContext)
      case 'read_skill_resource':
        return await execReadSkillResource(args, runtimeContext)
      case 'write_file':
        return await execWriteFile(args, workspace)
      case 'edit_file':
        return await execEditFile(args, workspace)
      case 'delete_file':
        return await execDeleteFile(args, workspace)
      case 'list_dir':
        return await execListDirectory(args, workspace)
      case 'run_command':
        return await execRunCommand(args, workspace, signal)
      case 'find_file':
        return await execFindFile(args, workspace)
      /* ---- MCP ---- */
      case 'analyze_image':
        return await execAnalyzeImage(args, workspace, runtimeContext)
      case 'mcp_call':
        return await execMcpCall(args, signal, runtimeContext?.services, workspace)
      case 'mcp_list_tools':
        return await execMcpListTools(runtimeContext?.services)
      case 'upload_file':
        return await execUploadFile(args, workspace, runtimeContext?.services)
      /* ---- 终端工具 ---- */
      case 'terminal_create':
        return await execTerminalCreate(args, workspace, runtimeContext?.services)
      case 'terminal_run':
        return await execTerminalRun(args, runtimeContext?.services)
      case 'terminal_list':
        return await execTerminalList(runtimeContext?.services)
      case 'terminal_close':
        return await execTerminalClose(args, runtimeContext?.services)
      case 'run_skill_script':
        return await execRunSkillScript(args, workspace, projectId, signal, logScope, runtimeContext)
      /* ---- 记忆回想 ---- */
      case 'recall_memories':
        return await execRecallMemories(args, workspace, projectId, runtimeContext)
      case 'search_skills':
        return await execSearchSkills(args, runtimeContext)
      case 'install_skill':
        return await execInstallSkill(args, workspace, runtimeContext)
      case 'uninstall_skill':
        return await execUninstallSkill(args, runtimeContext)
      default:
        return { content: `Unknown tool: ${name}`, success: false }
    }
  } catch (err) {
    if (isAbortError(err)) throw err
    const msg = err instanceof Error ? err.message : String(err)
    return { content: `Error: ${msg}`, success: false }
  }
}

async function execReadFile(args: Record<string, unknown>, workspace: string): Promise<ExecResult> {
  const filePath = String(args.path ?? '')
  if (!filePath) return { content: 'Error: path is required', success: false }
  const rawStartLine = Number(args.startLine)
  const rawEndLine = Number(args.endLine)
  const rawMaxChars = Number(args.maxChars)

  const check = await resolveSmartPath(workspace, filePath, 'file', { allowOutsideWorkspaceRead: true })
  if ('error' in check) return { content: check.error, success: false }
  const resolved = check.resolved
  const correctedNote = check.corrected ? `[自动纠正路径: "${filePath}" → "${check.corrected.split('\n')[0]}"]\n` : ''

  try {
    const stat = await fs.stat(resolved)
    if (!stat.isFile()) return { content: `Error: Not a file: ${resolved}`, success: false }
    if (stat.size > 1024 * 1024) return { content: `Error: File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB), max 1MB`, success: false }
    const fullContent = await fs.readFile(resolved, 'utf-8')
    const lines = fullContent.split('\n')
    const totalLines = lines.length

    const DEFAULT_MAX_CHARS = 24000
    const HARD_MAX_CHARS = 28000
    const maxChars = Number.isFinite(rawMaxChars) && rawMaxChars > 0
      ? Math.min(Math.floor(rawMaxChars), HARD_MAX_CHARS)
      : DEFAULT_MAX_CHARS

    let startLine = Number.isFinite(rawStartLine) && rawStartLine > 0 ? Math.floor(rawStartLine) : 1
    let endLine = Number.isFinite(rawEndLine) && rawEndLine > 0 ? Math.floor(rawEndLine) : totalLines
    startLine = Math.max(1, Math.min(startLine, Math.max(1, totalLines)))
    endLine = Math.max(startLine, Math.min(endLine, Math.max(1, totalLines)))

    let actualEndLine = endLine
    let chunk = lines.slice(startLine - 1, endLine).join('\n')
    let truncatedByChars = false
    if (chunk.length > maxChars) {
      truncatedByChars = true
      let acc = ''
      actualEndLine = startLine - 1
      for (let i = startLine - 1; i < endLine; i++) {
        const line = lines[i] ?? ''
        const next = acc ? `${acc}\n${line}` : line
        if (next.length > maxChars) {
          if (!acc) {
            acc = next.slice(0, maxChars)
            actualEndLine = i + 1
          }
          break
        }
        acc = next
        actualEndLine = i + 1
      }
      chunk = acc
    }

    const hasRemainingBefore = startLine > 1
    const hasRemainingAfter = actualEndLine < totalLines
    const partial = hasRemainingBefore || hasRemainingAfter || truncatedByChars

    const nextStartLine = Math.min(totalLines, actualEndLine + 1)
    const nextEndLine = Math.min(totalLines, nextStartLine + 199)
    const prevEndLine = startLine - 1
    const prevStartLine = Math.max(1, prevEndLine - 199)

    const meta: string[] = [
      `[read_file] path: ${resolved}`,
      `[read_file] lines: ${startLine}-${actualEndLine}/${totalLines}`,
      `[read_file] chars: ${chunk.length}/${fullContent.length}`,
      `[read_file] partial: ${partial ? 'yes' : 'no'}`,
    ]
    if (hasRemainingBefore) {
      meta.push(`[read_file] previous_chunk_hint: read_file(path="${filePath}", startLine=${prevStartLine}, endLine=${prevEndLine})`)
    }
    if (hasRemainingAfter) {
      meta.push(`[read_file] next_chunk_hint: read_file(path="${filePath}", startLine=${nextStartLine}, endLine=${nextEndLine})`)
    }

    const guidance = partial
      ? '\n\n[提示] 当前仅返回文件的部分内容。继续编码前，请按需调用 read_file 的 startLine/endLine 分块读取剩余范围。'
      : ''

    return {
      content: correctedNote + meta.join('\n') + '\n\n' + chunk + guidance,
      success: true,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { content: `Error: File not found: ${resolved}`, success: false }
    }
    throw err
  }
}

async function execReadSkill(args: Record<string, unknown>, runtimeContext?: ToolRuntimeContext): Promise<ExecResult> {
  const skillId = String(args.skill_id ?? '').trim()
  if (!skillId) return { content: 'Error: skill_id is required', success: false }

  const detail = readActiveSkillDetail(skillId)
  if (!detail) {
    return {
      content: `Error: Skill not found or not enabled for current request: ${skillId}`,
      success: false,
    }
  }

  return { content: detail.content, success: true }
}

async function execReadSkillResource(args: Record<string, unknown>, runtimeContext?: ToolRuntimeContext): Promise<ExecResult> {
  const skillId = String(args.skill_id ?? '').trim()
  const resourcePath = String(args.resource_path ?? '').trim()
  if (!skillId) return { content: 'Error: skill_id is required', success: false }
  if (!resourcePath) return { content: 'Error: resource_path is required', success: false }

  const detail = await readActiveSkillResource(skillId, resourcePath)
  if (!detail) {
    return {
      content: `Error: Skill resource not found or not allowed: ${skillId}/${resourcePath}`,
      success: false,
    }
  }

  return {
    content: [
      `[SKILL_RESOURCE skill_id="${skillId}" path="${resourcePath}"]`,
      detail.content,
      '[/SKILL_RESOURCE]',
    ].join('\n'),
    success: true,
  }
}

function toPosixPath(input: string): string {
  return input.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '').replace(/\/$/, '')
}

async function execWriteFile(args: Record<string, unknown>, workspace: string): Promise<ExecResult & { fileChange?: FileChange }> {
  const filePath = String(args.path ?? '')
  const fileContent = String(args.content ?? '')
  if (!filePath) return { content: 'Error: path is required', success: false }
  const check = resolveSafe(workspace, filePath)
  if ('error' in check) return { content: check.error, success: false }
  const resolved = check.resolved

  let oldContent: string | null = null
  try {
    const stat = await fs.stat(resolved)
    if (stat.isFile()) {
      oldContent = await fs.readFile(resolved, 'utf-8')
    }
  } catch {
    // 文件不存在 → 新建
  }

  const dir = path.dirname(resolved)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(resolved, fileContent, 'utf-8')

  const relPath = toPosixPath(path.relative(workspace, resolved))
  return {
    content: `File written: ${resolved} (${fileContent.length} chars)`,
    success: true,
    fileChange: { filePath: relPath, oldContent, newContent: fileContent },
  }
}

function countTextOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let start = 0
  while (true) {
    const idx = haystack.indexOf(needle, start)
    if (idx < 0) break
    count += 1
    start = idx + needle.length
  }
  return count
}

async function execEditFile(args: Record<string, unknown>, workspace: string): Promise<ExecResult & { fileChange?: FileChange }> {
  const filePath = String(args.path ?? '')
  const oldText = String(args.oldText ?? '')
  const newText = String(args.newText ?? '')
  const replaceAll = Boolean(args.replaceAll ?? false)
  const expectedRaw = Number(args.expectedOccurrences)

  if (!filePath) return { content: 'Error: path is required', success: false }
  if (!oldText) return { content: 'Error: oldText is required and cannot be empty', success: false }

  const check = resolveSafe(workspace, filePath)
  if ('error' in check) return { content: check.error, success: false }
  const resolved = check.resolved

  let oldContent: string
  try {
    const stat = await fs.stat(resolved)
    if (!stat.isFile()) return { content: `Error: Not a file: ${resolved}`, success: false }
    oldContent = await fs.readFile(resolved, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { content: `Error: File not found: ${resolved}`, success: false }
    }
    throw err
  }

  let lineEnding = '\n'
  if (oldContent.includes('\r\n')) {
    lineEnding = '\r\n'
  } else if (oldContent.includes('\r')) {
    lineEnding = '\r'
  }

  const normalizeLineEndings = (s: string) => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const normalizedContent = normalizeLineEndings(oldContent)
  const normalizedOldText = normalizeLineEndings(oldText)
  const normalizedNewText = normalizeLineEndings(newText)

  const occurrences = countTextOccurrences(normalizedContent, normalizedOldText)
  if (occurrences === 0) {
    return { content: `Error: oldText not found in file: ${resolved}`, success: false }
  }
  if (Number.isFinite(expectedRaw) && expectedRaw >= 0 && occurrences !== Math.floor(expectedRaw)) {
    return {
      content: `Error: expectedOccurrences mismatch for ${resolved}, expected=${Math.floor(expectedRaw)}, actual=${occurrences}`,
      success: false,
    }
  }

  const replacedCount = replaceAll ? occurrences : 1
  let newContent = replaceAll
    ? normalizedContent.split(normalizedOldText).join(normalizedNewText)
    : normalizedContent.replace(normalizedOldText, normalizedNewText)

  if (newContent === normalizedContent) {
    return { content: `Error: edit produced no changes for ${resolved}`, success: false }
  }

  if (lineEnding !== '\n') {
    newContent = newContent.replace(/\n/g, lineEnding)
  }

  await fs.writeFile(resolved, newContent, 'utf-8')

  const relPath = toPosixPath(path.relative(workspace, resolved))
  return {
    content: `File edited: ${resolved} (replaced ${replacedCount} occurrence${replacedCount > 1 ? 's' : ''})`,
    success: true,
    fileChange: { filePath: relPath, oldContent, newContent },
  }
}

async function execDeleteFile(args: Record<string, unknown>, workspace: string): Promise<ExecResult & { fileChange?: FileChange }> {
  const filePath = String(args.path ?? '')
  if (!filePath) return { content: 'Error: path is required', success: false }
  const check = resolveSafe(workspace, filePath)
  if ('error' in check) return { content: check.error, success: false }
  const resolved = check.resolved

  let oldContent: string | null = null
  try {
    const stat = await fs.stat(resolved)
    if (!stat.isFile()) return { content: `Error: Not a file: ${resolved}`, success: false }
    oldContent = await fs.readFile(resolved, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { content: `Error: File not found: ${resolved}`, success: false }
    }
    throw err
  }

  // 直接使用 Node.js 删除文件（不依赖 electron.shell.trashItem）
  await fs.rm(resolved, { force: true })

  const relPath = toPosixPath(path.relative(workspace, resolved))
  return {
    content: `File deleted: ${resolved}`,
    success: true,
    fileChange: { filePath: relPath, oldContent, newContent: null },
  }
}

/* ------------------------------------------------------------------ */
/*  list_dir / find_file 执行器                                         */
/* ------------------------------------------------------------------ */

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.floor(parsed)))
}

async function execListDirectory(args: Record<string, unknown>, workspace: string): Promise<ExecResult> {
  const rawPath = String(args.path ?? '').trim() || '.'
  const maxDepth = clampNumber(args.maxDepth, 1, 12, 4)
  const includeFiles = args.includeFiles !== false && args.showFiles !== false
  const includeHidden = Boolean(args.includeHidden)
  const maxEntries = clampNumber(args.maxEntries, 200, 10000, 4000)

  const check = await resolveSmartPath(workspace, rawPath, 'directory')
  if ('error' in check) return { content: check.error, success: false }
  const resolved = check.resolved
  const correctedNote = check.corrected ? `[自动纠正路径: "${rawPath}" → "${check.corrected.split('\n')[0]}"]\n` : ''

  const tree = await getWorkspaceTree(resolved, {
    maxDepth,
    includeFiles,
    includeHidden,
    maxEntries,
  })

  const relPath = rawPath === '.' ? '.' : toPosixPath(path.relative(workspace, resolved))
  const header = `[list_dir] path: ${resolved} (relative: ${relPath})\n`
  const stats = `目录: ${tree.stats.directoryCount}, 文件: ${tree.stats.fileCount}, 行数: ${tree.stats.lineCount}`
  const truncated = tree.truncated ? '\n[提示] 目录条目过多，已截断显示。' : ''

  return {
    content: correctedNote + header + stats + truncated + '\n\n' + tree.text,
    success: true,
  }
}

async function execFindFile(args: Record<string, unknown>, workspace: string): Promise<ExecResult> {
  const pattern = String(args.pattern ?? '').trim()
  if (!pattern) return { content: 'Error: pattern is required', success: false }

  const directory = String(args.directory ?? '').trim() || '.'
  const type = String(args.type ?? 'file')
  const mode = String(args.mode ?? 'auto')
  const includeHidden = Boolean(args.includeHidden)
  const maxResults = clampNumber(args.maxResults, 1, 200, 50)

  const check = await resolveSmartPath(workspace, directory, 'directory')
  if ('error' in check) return { content: check.error, success: false }
  const resolved = check.resolved
  const correctedNote = check.corrected ? `[自动纠正路径: "${directory}" → "${check.corrected.split('\n')[0]}"]\n` : ''

  const tree = await getWorkspaceTree(resolved, {
    maxDepth: 12,
    includeFiles: true,
    includeHidden,
    maxEntries: 10000,
  })

  const entries = tree.entries
  const filtered = entries.filter((entry) => {
    if (type === 'directory' && entry.kind !== 'directory') return false
    if (type === 'file' && entry.kind !== 'file') return false

    const name = entry.name
    const relPath = entry.path

    if (mode === 'exact') {
      return name === pattern || relPath === pattern
    }
    if (mode === 'glob') {
      const minimatch = requireMinimatch()
      if (minimatch) return minimatch(name, pattern) || minimatch(relPath, pattern)
      return name.includes(pattern) || relPath.includes(pattern)
    }
    const lowerPattern = pattern.toLowerCase()
    const lowerName = name.toLowerCase()
    const lowerPath = relPath.toLowerCase()
    let pi = 0
    for (let i = 0; i < lowerName.length && pi < lowerPattern.length; i++) {
      if (lowerName[i] === lowerPattern[pi]) pi++
    }
    if (pi === lowerPattern.length) return true
    return lowerPath.includes(lowerPattern)
  }).slice(0, maxResults)

  if (filtered.length === 0) {
    return { content: correctedNote + `No files found matching "${pattern}"`, success: true }
  }

  const lines = filtered.map((e) => `${e.kind === 'directory' ? '[D]' : '[F]'} ${e.path}`)
  return {
    content: correctedNote + `Found ${filtered.length} result(s) for "${pattern}":\n\n` + lines.join('\n'),
    success: true,
  }
}

let minimatchCache: ((path: string, pattern: string) => boolean) | null = null
function requireMinimatch(): ((path: string, pattern: string) => boolean) | null {
  if (minimatchCache) return minimatchCache
  try {
    const mod = require('minimatch')
    minimatchCache = mod.minimatch
    return minimatchCache
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/*  run_command 执行器                                                  */
/* ------------------------------------------------------------------ */

async function execRunCommand(
  args: Record<string, unknown>,
  workspace: string,
  signal?: AbortSignal,
): Promise<ExecResult> {
  const command = String(args.command ?? '').trim()
  if (!command) return { content: 'Error: command is required', success: false }

  const check = resolveSafe(workspace, String(args.cwd ?? '.'))
  const cwd = 'error' in check ? workspace : check.resolved

  const MAX_OUTPUT_CHARS = 12000
  const TIMEOUT_MS = 120_000

  try {
    const env = await getRunCommandEnv()
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      signal,
      env,
    })

    const combined = (stdout ? `stdout:\n${stdout}` : '') +
      (stderr ? `\nstderr:\n${stderr}` : '')

    if (combined.length > MAX_OUTPUT_CHARS) {
      return {
        content: combined.slice(0, MAX_OUTPUT_CHARS) +
          `\n\n[输出已截断，共 ${combined.length} 字符，仅显示前 ${MAX_OUTPUT_CHARS} 字符]`,
        success: true,
      }
    }

    return { content: combined || '(命令执行成功，无输出)', success: true }
  } catch (err) {
    if (isAbortError(err)) throw err
    const execErr = err as Error & { stdout?: string; stderr?: string; code?: string | number; signal?: string }
    const stdout = execErr.stdout ?? ''
    const stderr = execErr.stderr ?? ''
    const combined = (stdout ? `stdout:\n${stdout}` : '') + (stderr ? `\nstderr:\n${stderr}` : '')

    let reason = execErr.message
    if (execErr.code === 'ENOENT') reason = '命令未找到'
    else if (execErr.signal === 'SIGTERM') reason = '命令被终止'
    else if (execErr.code === 'ETIMEDOUT' || reason.includes('timeout')) reason = '命令执行超时'

    const output = combined.length > MAX_OUTPUT_CHARS
      ? combined.slice(0, MAX_OUTPUT_CHARS) + `\n\n[输出已截断]`
      : combined

    return {
      content: `Error: ${reason}${output ? '\n\n' + output : ''}`,
      success: false,
    }
  }
}

/* ---- 文件上传到云存储 ---- */

const FILE_EXT_MIME_MAP: Record<string, string> = {
  '.apk': 'application/vnd.android.package-archive',
  '.ipa': 'application/octet-stream',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar.gz': 'application/x-gzip',
  '.tar': 'application/x-tar',
  '.dmg': 'application/x-apple-diskimage',
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.msi': 'application/x-msi',
  '.deb': 'application/vnd.debian.binary-package',
  '.rpm': 'application/x-rpm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/ico',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.ts': 'application/typescript',
}

function detectFileMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  if (filePath.toLowerCase().endsWith('.tar.gz')) return 'application/x-gzip'
  return FILE_EXT_MIME_MAP[ext] || 'application/octet-stream'
}

async function execUploadFile(args: Record<string, unknown>, workspace: string, services?: AgentServices): Promise<ExecResult> {
  const rawPath = String(args.filePath ?? '').trim()
  if (!rawPath) return { content: 'Error: filePath is required', success: false }

  const resolved = path.resolve(workspace, rawPath)

  try {
    await fs.access(resolved)
  } catch {
    return { content: `Error: File not found: ${rawPath}`, success: false }
  }

  let fileSize: number
  let fileName: string
  try {
    const stat = await fs.stat(resolved)
    if (!stat.isFile()) return { content: `Error: Not a file: ${rawPath}`, success: false }
    fileSize = stat.size
    fileName = path.basename(resolved)
  } catch (err) {
    return { content: `Error: Cannot read file: ${err instanceof Error ? err.message : String(err)}`, success: false }
  }

  if (!services) {
    return { content: 'Error: services not available', success: false }
  }

  const customPrefix = String(args.objectPrefix ?? '').trim()

  let dataUrl: string
  try {
    const bytes = await fs.readFile(resolved)
    const base64 = bytes.toString('base64')
    const mimeType = detectFileMime(resolved)
    dataUrl = `data:${mimeType};base64,${base64}`
  } catch (err) {
    return { content: `Error: Failed to read file: ${err instanceof Error ? err.message : String(err)}`, success: false }
  }

  try {
    const cloudUrl = await uploadDataUrlToStorage(null as any, dataUrl, undefined, services.getToken?.())
    services.logger('UPLOAD_FILE_SUCCESS', { filePath: resolved, fileSize, fileName, cloudUrl })

    const formattedSize = fileSize < 1024
      ? `${fileSize} B`
      : fileSize < 1024 * 1024
        ? `${(fileSize / 1024).toFixed(1)} KB`
        : `${(fileSize / (1024 * 1024)).toFixed(1)} MB`

    return {
      content: JSON.stringify({
        cloudUrl,
        fileName,
        filePath: resolved,
        fileSize,
        formattedSize,
        mimeType: detectFileMime(resolved),
      }),
      success: true,
    }
  } catch (err) {
    services.logger('UPLOAD_FILE_FAIL', { filePath: resolved, error: err instanceof Error ? err.message : String(err) })
    return {
      content: `Error: 上传失败 - ${err instanceof Error ? err.message : String(err)}`,
      success: false,
    }
  }
}

/* ------------------------------------------------------------------ */
/*  终端工具执行器                                                      */
/* ------------------------------------------------------------------ */

async function execTerminalCreate(
  args: Record<string, unknown>,
  workspace: string,
  services?: AgentServices,
): Promise<ExecResult> {
  const name = typeof args.name === 'string' ? args.name.trim() : undefined
  const cwdRaw = typeof args.cwd === 'string' ? args.cwd.trim() : undefined

  let cwd: string | undefined
  if (cwdRaw) {
    const check = resolveSafe(workspace, cwdRaw)
    if ('error' in check) {
      return { content: `Error: cwd 路径超出工作空间: ${check.error}`, success: false }
    }
    cwd = check.resolved
  }

  if (!services?.terminal) {
    return { content: 'Error: terminal service not available', success: false }
  }

  try {
    const info = services.terminal.create({ name, cwd })
    return { content: JSON.stringify(info), success: true }
  } catch (err) {
    return { content: `Error: 创建终端失败: ${err instanceof Error ? err.message : String(err)}`, success: false }
  }
}

async function execTerminalRun(
  args: Record<string, unknown>,
  services?: AgentServices,
): Promise<ExecResult> {
  const terminalId = String(args.terminalId ?? '').trim()
  if (!terminalId) return { content: 'Error: terminalId is required', success: false }

  const command = String(args.command ?? '')
  const timeoutMs = Number.isFinite(Number(args.timeout)) ? Number(args.timeout) : undefined
  const stream = args.stream === true
  const streamMs = Number.isFinite(Number(args.streamMs)) ? Number(args.streamMs) : undefined

  if (!services?.terminal) {
    return { content: 'Error: terminal service not available', success: false }
  }

  try {
    const result = await services.terminal.run(terminalId, command, timeoutMs || 120000, stream, streamMs)
    return { content: result.output, success: true }
  } catch (err) {
    return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, success: false }
  }
}

async function execTerminalList(services?: AgentServices): Promise<ExecResult> {
  if (!services?.terminal) {
    return { content: '终端服务不可用', success: false }
  }

  try {
    const terminals = services.terminal.list()
    if (terminals.length === 0) {
      return { content: '当前没有活跃的 AI 终端会话。使用 terminal_create 创建新终端。', success: true }
    }
    return { content: JSON.stringify(terminals, null, 2), success: true }
  } catch (err) {
    return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, success: false }
  }
}

async function execTerminalClose(
  args: Record<string, unknown>,
  services?: AgentServices,
): Promise<ExecResult> {
  const terminalId = String(args.terminalId ?? '').trim()
  if (!terminalId) return { content: 'Error: terminalId is required', success: false }

  if (!services?.terminal) {
    return { content: 'Error: terminal service not available', success: false }
  }

  try {
    const closed = services.terminal.close(terminalId)
    if (closed) {
      return { content: `终端 ${terminalId} 已关闭`, success: true }
    }
    return { content: `终端 ${terminalId} 不存在或已关闭`, success: false }
  } catch (err) {
    return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, success: false }
  }
}

/* ------------------------------------------------------------------ */
/*  技能脚本执行                                                          */
/* ------------------------------------------------------------------ */

const BROWSER_SCRIPT_TO_ACTION: Record<string, BrowserActionType> = {
  navigate: 'navigate',
  screenshot: 'screenshot',
  click: 'click',
  type: 'type',
  scroll: 'scroll',
  hover: 'hover',
  keypress: 'keypress',
  drag: 'drag',
  select: 'select',
  get_content: 'get_content',
  wait: 'wait',
  evaluate: 'evaluate',
  get_info: 'get_info',
}

async function execRunSkillScript(
  args: Record<string, unknown>,
  workspace: string,
  projectId?: string,
  signal?: AbortSignal,
  logScope?: string,
  runtimeContext?: ToolRuntimeContext,
): Promise<ExecResult> {
  const skillId = String(args.skill_id ?? '').trim()
  const scriptName = String(args.script_name ?? '').trim()
  const params = (args.params ?? {}) as Record<string, unknown>

  if (!skillId) return { content: 'Error: skill_id is required', success: false }
  if (!scriptName) return { content: 'Error: script_name is required', success: false }

  const services = runtimeContext?.services

  if (skillId === 'browser-use') {
    if (scriptName === 'get_console_logs') {
      return await execBrowserGetConsoleLogs(params, projectId, services)
    }
    if (scriptName === 'list') {
      if (!services?.browser) return { content: 'Error: browser service not available', success: false }
      const instances = services.browser.listInstances()
      return { content: JSON.stringify(instances, null, 2), success: true }
    }
    if (scriptName === 'close') {
      if (!services?.browser) return { content: 'Error: browser service not available', success: false }
      if (!params.appId) return { content: 'Error: appId is required. Use list to get all browser window IDs, then close them one by one.', success: false }
      const appId = String(params.appId)
      services.browser.closeInstance(appId)
      return { content: `浏览器窗口 [${appId}] 已关闭`, success: true }
    }
    const action = BROWSER_SCRIPT_TO_ACTION[scriptName]
    if (!action) {
      return {
        content: `浏览器技能不支持此脚本: ${scriptName}。可用脚本: ${Object.keys(BROWSER_SCRIPT_TO_ACTION).join(', ')}, get_console_logs, list, close`,
        success: false,
      }
    }
    return await execBrowserAction(action, params, projectId, services, runtimeContext, workspace)
  }

  if (skillId === 'computer-use') {
    if (scriptName === 'screenshot') {
      return await execDesktopScreenshot(params, logScope, services, runtimeContext, workspace)
    }
    if (scriptName === 'action') {
      return await execDesktopAction(params, signal, logScope, services)
    }
    return {
      content: `电脑使用技能不支持此脚本: ${scriptName}。可用脚本: screenshot, action`,
      success: false,
    }
  }

  // ---- 外部技能：子进程执行脚本 ----
  const { getSkillRootDir } = await import('../skills/service')
  const rootDir = getSkillRootDir(skillId)
  if (!rootDir) {
    return { content: `技能 "${skillId}" 未找到或未激活`, success: false }
  }

  const scriptPath = path.join(rootDir, 'scripts', scriptName)
  const MAX_OUTPUT_CHARS = 12000
  const TIMEOUT_MS = 120_000

  try {
    const env = await getRunCommandEnv()
    const { stdout, stderr } = await execAsync(scriptPath, {
      cwd: path.dirname(scriptPath),
      timeout: TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      signal,
      env,
    })

    const combined = (stdout ? `stdout:\n${stdout}` : '') +
      (stderr ? `\nstderr:\n${stderr}` : '')

    if (combined.length > MAX_OUTPUT_CHARS) {
      return {
        content: combined.slice(0, MAX_OUTPUT_CHARS) +
          `\n\n[输出已截断，共 ${combined.length} 字符，仅显示前 ${MAX_OUTPUT_CHARS} 字符]`,
        success: true,
      }
    }

    return { content: combined || '(命令执行成功，无输出)', success: true }
  } catch (err) {
    if (isAbortError(err)) throw err
    const execErr = err as Error & { stdout?: string; stderr?: string; code?: string | number }
    const stdout = execErr.stdout ?? ''
    const stderr = execErr.stderr ?? ''
    const combined = (stdout ? `stdout:\n${stdout}` : '') + (stderr ? `\nstderr:\n${stderr}` : '')

    let reason = execErr.message
    if (execErr.code === 'ENOENT') reason = `脚本未找到: ${scriptPath}`
    else if (execErr.code === 'EACCES') reason = `脚本无执行权限: ${scriptPath}`

    const output = combined.length > MAX_OUTPUT_CHARS
      ? combined.slice(0, MAX_OUTPUT_CHARS) + `\n\n[输出已截断]`
      : combined

    return {
      content: `Error: ${reason}${output ? '\n\n' + output : ''}`,
      success: false,
    }
  }
}

/* ------------------------------------------------------------------ */
/*  浏览器使用执行器                                                    */
/* ------------------------------------------------------------------ */

function scopedBrowserAppId(projectId?: string): string | undefined {
  const raw = String(projectId ?? '').trim()
  if (!raw) return undefined
  const safe = raw.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 64)
  return safe ? `project-${safe}` : undefined
}

/* ---- 记忆回想工具 ---- *//* ---- 时间范围解析 ---- */

/**
 * 将 AI 自由描述的时间范围解析为 ISO 时间戳区间。
 * 支持："昨天"、"上周"、"上个月"、"最近N天"、"YYYY年M月" 等。
 * 不传或不识别则返回 undefined。
 */
function parseTimeRange(timeRange?: string): { timeFrom?: string; timeTo?: string } | undefined {
  const s = String(timeRange ?? '').trim()
  if (!s) return undefined

  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())

  // 昨天
  if (/^昨/.test(s)) {
    const d = new Date(today.getTime() - 86400000)
    return { timeFrom: d.toISOString().slice(0, 10), timeTo: today.toISOString().slice(0, 10) }
  }

  // 最近N天
  const recentDays = s.match(/最近(\d+)\s*天/)
  if (recentDays) {
    const n = parseInt(recentDays[1], 10)
    const d = new Date(today.getTime() - n * 86400000)
    return { timeFrom: d.toISOString().slice(0, 10) }
  }

  // 今天
  if (/^今/.test(s)) {
    return { timeFrom: today.toISOString().slice(0, 10) }
  }

  // 本周
  if (/本\s*周/.test(s)) {
    const day = today.getDay()
    const monday = new Date(today.getTime() - (day === 0 ? 6 : day - 1) * 86400000)
    return { timeFrom: monday.toISOString().slice(0, 10) }
  }

  // 上周
  if (/上周/.test(s)) {
    const day = today.getDay()
    const thisMonday = new Date(today.getTime() - (day === 0 ? 6 : day - 1) * 86400000)
    const lastMonday = new Date(thisMonday.getTime() - 7 * 86400000)
    return { timeFrom: lastMonday.toISOString().slice(0, 10), timeTo: thisMonday.toISOString().slice(0, 10) }
  }

  // 本月
  if (/本\s*月/.test(s)) {
    return { timeFrom: new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10) }
  }

  // 上个月
  if (/上\s*个?\s*月/.test(s)) {
    const thisMonthFirst = new Date(now.getFullYear(), now.getMonth(), 1)
    const lastMonthFirst = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    return { timeFrom: lastMonthFirst.toISOString().slice(0, 10), timeTo: thisMonthFirst.toISOString().slice(0, 10) }
  }

  // 最近N个月
  const recentMonths = s.match(/最近(\d+)\s*个?\s*月/)
  if (recentMonths) {
    const n = parseInt(recentMonths[1], 10)
    const d = new Date(now.getFullYear(), now.getMonth() - n, 1)
    return { timeFrom: d.toISOString().slice(0, 10) }
  }

  // YYYY年M月 或 YYYY年
  const yearMonth = s.match(/(\d{4})\s*年(?:\s*(\d{1,2})\s*月)?/)
  if (yearMonth) {
    const y = parseInt(yearMonth[1], 10)
    const m = yearMonth[2] ? parseInt(yearMonth[2], 10) - 1 : 0
    const from = new Date(y, m, 1)
    const to = yearMonth[2] ? new Date(y, m + 1, 1) : new Date(y + 1, 0, 1)
    return { timeFrom: from.toISOString().slice(0, 10), timeTo: to.toISOString().slice(0, 10) }
  }

  // 去年
  if (/去\s*年/.test(s)) {
    const thisYearFirst = new Date(now.getFullYear(), 0, 1)
    const lastYearFirst = new Date(now.getFullYear() - 1, 0, 1)
    return { timeFrom: lastYearFirst.toISOString().slice(0, 10), timeTo: thisYearFirst.toISOString().slice(0, 10) }
  }

  // 无法识别 → 不限时间
  return undefined
}

/* ---- 记忆回想工具 ---- */

async function execRecallMemories(
  args: Record<string, unknown>,
  workspace: string,
  projectId?: string,
  runtimeContext?: ToolRuntimeContext,
): Promise<ExecResult> {
  const query = String(args.query ?? '').trim()
  if (!query) return { content: 'Error: query is required', success: false }

  const rawLimit = Number(args.limit)
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 5

  const timeRange = String(args.timeRange ?? '').trim() || undefined
  const parsed = parseTimeRange(timeRange)

  const db = runtimeContext?.services?.database
  if (!db) return { content: 'Error: database service not available', success: false }

  try {
    const content = await recallMemoriesByKeywords(db, workspace, projectId, query, limit, parsed?.timeFrom, parsed?.timeTo)
    return { content, success: true }
  } catch (err) {
    return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, success: false }
  }
}

/* ---- 技能搜索工具 ---- */

async function execSearchSkills(
  args: Record<string, unknown>,
  runtimeContext?: ToolRuntimeContext,
): Promise<ExecResult> {
  const query = String(args.query ?? '').trim()
  if (!query) return { content: 'Error: query is required', success: false }

  const services = runtimeContext?.services

  try {
    const results = await searchSkills(query)

    if (results.length === 0) {
      return { content: `在 ClawHub 技能市场中未找到与"${query}"相关的技能。请尝试换一些关键词。`, success: true }
    }

    const items = results.map((item) => ({
      name: item.displayName,
      slug: item.slug,
      description: item.summary || '无描述',
      author: item.owner?.displayName || item.ownerHandle || '未知',
      downloads: item.downloads ?? 0,
      version: item.version || '—',
      installSlug: item.slug,
    }))

    return {
      content: JSON.stringify({
        source: 'ClawHub 技能市场（clawhub.ai）',
        total: results.length,
        results: items,
        hint: '使用 install_skill 工具安装你感兴趣的技能。传入 source 参数为 installSlug（搜索结果中的 slug 字段）。',
      }, null, 2),
      success: true,
    }
  } catch (err) {
    services?.logger('SEARCH_SKILLS_FAIL', { error: err instanceof Error ? err.message : String(err) })
    return { content: `Error: 搜索技能失败: ${err instanceof Error ? err.message : String(err)}`, success: false }
  }
}

/* ---- 技能安装工具 ---- */

function isClawHubSlug(source: string): boolean {
  // 不是 URL、不是本地路径
  if (source.startsWith('http://') || source.startsWith('https://')) return false
  if (source.startsWith('/') || source.startsWith('.') || source.startsWith('~')) return false
  // 匹配 @author/name 或 author/name 格式
  if (/^@?[\w-]+\/[\w-]+$/.test(source)) return true
  // 匹配纯 slug 格式（如 skill-creator、my-tool 等），不含 / 且不包含路径特征
  if (/^[\w-]+$/.test(source)) return true
  return false
}

function buildClawHubDownloadUrl(slug: string): string {
  // ClawHub 下载 API 只需要纯技能名，不含 @author/ 前缀
  // 从 @chindden/skill-creator 或 chindden/skill-creator 提取 skill-creator
  // 从 skill-creator 直接使用
  const pureSlug = slug.replace(/^@/, '').split('/').pop() ?? slug
  return `https://clawhub.ai/api/v1/download?slug=${encodeURIComponent(pureSlug)}`
}

async function downloadAndExtractZip(
  url: string,
  destDir: string,
  logger?: AgentServices['logger'],
): Promise<void> {
  const zipPath = path.join(destDir, 'skill.zip')
  
  // 下载 ZIP
  logger?.('CLAWHUB_DOWNLOAD_START', { url })
  const resp = await fetch(url, { headers: { 'User-Agent': 'Taco-AI' } })
  if (!resp.ok) {
    throw new Error(`ClawHub 下载失败: ${resp.status} ${resp.statusText}`)
  }
  
  const buffer = Buffer.from(await resp.arrayBuffer())
  await fs.writeFile(zipPath, buffer)
  logger?.('CLAWHUB_DOWNLOAD_DONE', { size: buffer.length })

  // 解压 ZIP
  try {
    const platform = os.platform()
    if (platform === 'win32') {
      execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`, { stdio: 'pipe' })
    } else {
      execSync(`unzip -o "${zipPath}" -d "${destDir}"`, { stdio: 'pipe' })
    }
  } catch (unzipErr) {
    throw new Error(`解压 ZIP 失败: ${unzipErr instanceof Error ? unzipErr.message : String(unzipErr)}`)
  }

  // 清理 ZIP 文件
  try { await fs.unlink(zipPath) } catch { /* ignore */ }
  
  // 如果解压后内容都是一个子目录，上移一层
  const entries = await fs.readdir(destDir)
  const nonZipEntries = entries.filter(e => e !== 'skill.zip')
  if (nonZipEntries.length === 1) {
    const innerDir = path.join(destDir, nonZipEntries[0])
    const stat = await fs.stat(innerDir)
    if (stat.isDirectory()) {
      const innerEntries = await fs.readdir(innerDir)
      for (const entry of innerEntries) {
        await fs.rename(path.join(innerDir, entry), path.join(destDir, entry))
      }
      await fs.rmdir(innerDir)
    }
  }
}

/**
 * 构建安全预览报告文本，供 AI 展示给用户
 */
function buildSecurityPreview(preview: { name: string; description: string; author: string; security?: { riskLevel: string; warnings: string[] } }): string {
  const sec = preview.security
  if (!sec || sec.warnings.length === 0) {
    return `✅ 技能"${preview.name}"安全检查通过，无风险。`
  }

  const levelLabel: Record<string, string> = {
    low: '低',
    medium: '中',
    high: '高',
    critical: '致命',
  }
  const label = levelLabel[sec.riskLevel] ?? sec.riskLevel

  let report = `🔍 技能"${preview.name}"安全检查报告：\n`
  report += `- 作者: ${preview.author}\n`
  report += `- 描述: ${preview.description}\n`
  report += `- 风险等级: ${label}\n`
  report += `- 风险项:\n`
  for (const w of sec.warnings) {
    report += `  ⚠ ${w}\n`
  }
  return report
}

async function execInstallSkill(
  args: Record<string, unknown>,
  workspace: string,
  runtimeContext?: ToolRuntimeContext,
): Promise<ExecResult> {
  const source = String(args.source ?? '').trim()
  if (!source) return { content: 'Error: source is required', success: false }

  const force = args.force === true || args.force === 'true'
  const services = runtimeContext?.services

  try {
    // ClawHub slug → 下载 ZIP → 解压 → 安全预览 → 安装
    if (isClawHubSlug(source)) {
      services?.logger('INSTALL_SKILL_CLAWHUB_START', { slug: source, force })
      
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'taco-skill-'))
      const downloadUrl = buildClawHubDownloadUrl(source)
      
      await downloadAndExtractZip(downloadUrl, tmpDir, services?.logger)
      
      // 找到解压后的 SKILL.md 所在目录
      const findSkillMdDir = async (dir: string): Promise<string> => {
        try {
          await fs.access(path.join(dir, 'SKILL.md'))
          return dir
        } catch {
          const entries = await fs.readdir(dir)
          for (const entry of entries) {
            const subDir = path.join(dir, entry)
            try {
              const stat = await fs.stat(subDir)
              if (stat.isDirectory()) {
                const result = await findSkillMdDir(subDir)
                if (result) return result
              }
            } catch { /* ignore */ }
          }
        }
        return ''
      }
      
      const skillDir = await findSkillMdDir(tmpDir)
      if (!skillDir) {
        await fs.rm(tmpDir, { recursive: true, force: true })
        return { content: 'Error: 下载的技能包中未找到 SKILL.md 文件', success: false }
      }
      
      services?.logger('INSTALL_SKILL_CLAWHUB_EXTRACTED', { skillDir })

      if (!force) {
        // 安全预览
        const preview = await previewSkill(skillDir)
        const securityPreview = buildSecurityPreview(preview)
        
        if (preview.security?.riskLevel === 'critical') {
          await fs.rm(tmpDir, { recursive: true, force: true })
          return { content: securityPreview, success: false }
        }
        
        if (preview.security?.riskLevel === 'high') {
          await fs.rm(tmpDir, { recursive: true, force: true })
          return {
            content: securityPreview + `\n\n⚠️ 该技能风险等级为"高"，不会自动安装。如果你确认信任此技能并希望安装，请回复"安装"或"继续"，我将使用 force=true 强制安装。`,
            success: false,
          }
        }
      }
      
      // 安装
      const skill = await installSkill(skillDir, true)
      await fs.rm(tmpDir, { recursive: true, force: true })
      services?.logger('INSTALL_SKILL_DONE', { id: skill.id, name: skill.name, source: 'clawhub' })

      return {
        content: JSON.stringify({
          message: `技能"${skill.name}"（${skill.id}）从 ClawHub 安装成功，已立即可用。`,
          skill: { id: skill.id, name: skill.name, description: skill.description, version: skill.version, author: skill.author },
        }),
        success: true,
      }
    }

    // GitHub URL / Raw URL / 本地路径
    services?.logger('INSTALL_SKILL_START', { source, force })

    if (!force) {
      const preview = await previewSkill(source)
      const securityPreview = buildSecurityPreview(preview)
      
      if (preview.security?.riskLevel === 'critical') {
        return { content: securityPreview, success: false }
      }
      
      if (preview.security?.riskLevel === 'high') {
        return {
          content: securityPreview + `\n\n⚠️ 该技能风险等级为"高"，不会自动安装。如果你确认信任此技能并希望安装，请回复"安装"或"继续"，我将使用 force=true 强制安装。`,
          success: false,
        }
      }
    }

    const skill = await installSkill(source, true)
    services?.logger('INSTALL_SKILL_DONE', { id: skill.id, name: skill.name })

    return {
      content: JSON.stringify({
        message: `技能"${skill.name}"（${skill.id}）安装成功，已立即可用。`,
        skill: { id: skill.id, name: skill.name, description: skill.description, version: skill.version, author: skill.author },
      }),
      success: true,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    services?.logger('INSTALL_SKILL_FAIL', { error: msg, source })
    return { content: `Error: 安装技能失败: ${msg}`, success: false }
  }
}

/* ---- 技能卸载工具 ---- */

async function execUninstallSkill(
  args: Record<string, unknown>,
  runtimeContext?: ToolRuntimeContext,
): Promise<ExecResult> {
  const id = String(args.skill_id ?? '').trim()
  if (!id) return { content: 'Error: skill_id is required（要卸载的技能 ID）', success: false }

  const services = runtimeContext?.services

  try {
    await uninstallSkill(id)
    services?.logger('UNINSTALL_SKILL_DONE', { id })

    return {
      content: `<uninstall_skill_result>技能"${id}"已成功卸载并移除。</uninstall_skill_result>`,
      success: true,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    services?.logger('UNINSTALL_SKILL_FAIL', { error: msg, id })

    // 友好的错误提示
    if (msg.includes('not found')) {
      return { content: `Error: 未找到技能"${id}"，请确认技能 ID 是否正确。`, success: false }
    }
    if (msg.includes('builtin')) {
      return { content: `Error: 不能卸载内置技能"${id}"，只能卸载从 ClawHub 或外部安装的技能。`, success: false }
    }

    return { content: `Error: 卸载技能失败: ${msg}`, success: false }
  }
}

async function execBrowserAction(
  action: BrowserActionType,
  args: Record<string, unknown>,
  projectId?: string,
  services?: AgentServices,
  runtimeContext?: ToolRuntimeContext,
  workspace?: string,
): Promise<ExecResult> {
  if (!services?.browser) return { content: 'Error: browser service not available', success: false }

  const appId = args.appId ? String(args.appId) : scopedBrowserAppId(projectId)
  const mergedArgs = appId ? { ...args, appId } : args
  services.logger(`Browser action: ${action} [appId=${appId || 'default'}]`, mergedArgs)
  const result = await services.browser.executeAction({ action, params: mergedArgs }, appId)
  if (result.success) {
    if (action === 'screenshot' && result.data) {
      try {
        const parsed = JSON.parse(result.data)
        const pageInfo = parsed.page ?? {}
        const screenshotDataUrl = parsed.screenshot || parsed.dataUrl

        let screenshotPath = ''
        let cloudUrl: string | undefined
        if (screenshotDataUrl) {
          if (services.mcp) {
            try {
              screenshotPath = await services.mcp.saveScreenshot(screenshotDataUrl, appId || 'default', workspace)
            } catch (err) {
              services.logger('SCREENSHOT_SAVE_FAIL', { error: err instanceof Error ? err.message : String(err) })
            }
          }

          try {
            cloudUrl = await uploadScreenshotToCloud(screenshotDataUrl, services) || undefined
          } catch (err) {
            services.logger('BROWSER_SCREENSHOT_UPLOAD_FAIL', { error: err instanceof Error ? err.message : String(err) })
            // 重试一次
            try {
              cloudUrl = await uploadScreenshotToCloud(screenshotDataUrl, services) || undefined
              services.logger('BROWSER_SCREENSHOT_UPLOAD_RETRY_OK')
            } catch (retryErr) {
              services.logger('BROWSER_SCREENSHOT_UPLOAD_RETRY_FAIL', { error: retryErr instanceof Error ? retryErr.message : String(retryErr) })
            }
          }
        }

        return {
          content: JSON.stringify({
            screenshotPath: screenshotPath || undefined,
            cloudUrl: cloudUrl || undefined,
            title: pageInfo.title,
            url: pageInfo.url,
            viewport: pageInfo.viewport,
            visibleElements: pageInfo.elements ?? [],
            hint: cloudUrl
              ? '截图已上传到云存储。如需分析截图内容，请调用 analyze_image 工具，image 参数传 cloudUrl。'
              : screenshotPath
              ? '截图已保存到本地。如需分析截图内容，请调用 analyze_image 工具。'
              : undefined,
          }, null, 2),
          success: true,
        }
      } catch {
        return { content: result.data ?? '截图成功', success: true }
      }
    }
    return { content: result.data ?? '操作成功', success: true }
  }
  return { content: `浏览器操作失败: ${result.error}`, success: false }
}

async function execBrowserGetConsoleLogs(args: Record<string, unknown>, projectId?: string, services?: AgentServices): Promise<ExecResult> {
  if (!services?.browser) return { content: 'Error: browser service not available', success: false }

  const appId = args.appId ? String(args.appId) : (scopedBrowserAppId(projectId) ?? 'default')
  const limit = Number.isFinite(Number(args.limit)) ? Number(args.limit) : undefined
  const onlyErrors = args.onlyErrors === true
  const devOnly = args.devOnly !== false
  const includeCandidates = args.includeCandidates !== false
  const clearAfterRead = args.clearAfterRead !== false
  const levels = Array.isArray(args.levels)
    ? args.levels
      .map((v) => String(v))
      .filter((v): v is 'log' | 'info' | 'warn' | 'error' | 'debug' => ['log', 'info', 'warn', 'error', 'debug'].includes(v))
    : undefined

  const snapshot = services.browser.getConsoleSnapshot({
    appId,
    limit,
    levels,
    onlyErrors,
    devOnly,
    includeCandidates,
    clearAfterRead,
  })

  return { content: JSON.stringify(snapshot, null, 2), success: true }
}

/* ------------------------------------------------------------------ */
/*  MCP 工具执行器                                                      */
/* ------------------------------------------------------------------ */

async function execMcpCall(args: Record<string, unknown>, signal?: AbortSignal, services?: AgentServices, workspace?: string): Promise<ExecResult> {
  const serverId = String(args.server_id ?? '').trim()
  const toolName = String(args.tool_name ?? '').trim()
  const toolArgs = (args.arguments ?? {}) as Record<string, unknown>

  if (!serverId) return { content: 'Error: server_id is required', success: false }
  if (!toolName) return { content: 'Error: tool_name is required', success: false }
  if (signal?.aborted) throw makeAbortError()

  if (!services?.mcp) return { content: 'Error: MCP service not available', success: false }

  try {
    const result = await services.mcp.callTool(serverId, toolName, toolArgs)

    const texts: string[] = []
    for (const item of result.content ?? []) {
      if (item.type === 'text' && item.text) {
        texts.push(item.text)
      } else if (item.type === 'image' && item.data) {
        try {
          const imgPath = await services.mcp.saveScreenshot(`data:image/png;base64,${item.data}`, undefined, workspace)
          texts.push(`[图片已保存: ${imgPath}]`)
        } catch {
          texts.push('[图片数据接收成功但保存失败]')
        }
      } else if (item.type === 'resource') {
        texts.push(`[Resource: ${JSON.stringify(item)}]`)
      }
    }

    const content = texts.join('\n') || '(MCP 工具返回空结果)'
    return { content, success: !result.isError }
  } catch (err) {
    return { content: `MCP 调用失败: ${err instanceof Error ? err.message : String(err)}`, success: false }
  }
}

async function execMcpListTools(services?: AgentServices): Promise<ExecResult> {
  if (!services?.mcp) {
    return { content: '当前没有已启用的 MCP 服务器或没有可用工具。', success: true }
  }

  const mcpTools = services.mcp.getActiveTools()

  if (mcpTools.length === 0) {
    return {
      content: '当前没有已启用的 MCP 服务器或没有可用工具。请在设置中启用 MCP 服务器并配置 API Key。',
      success: true,
    }
  }

  const groups: Record<string, Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>> = {}
  for (const tool of mcpTools) {
    if (!groups[tool.serverId]) groups[tool.serverId] = []
    groups[tool.serverId].push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })
  }

  const lines: string[] = ['已启用的 MCP 工具列表：', '']
  for (const [serverId, tools] of Object.entries(groups)) {
    lines.push(`## 服务器: ${serverId}`)
    for (const tool of tools) {
      lines.push(`- **${tool.name}**: ${tool.description ?? '(无描述)'}`)
      if (tool.inputSchema?.properties) {
        const props = tool.inputSchema.properties as Record<string, { type?: string; description?: string }>
        const required = (tool.inputSchema.required ?? []) as string[]
        for (const [key, val] of Object.entries(props)) {
          const req = required.includes(key) ? ' (必需)' : ' (可选)'
          lines.push(`  - \`${key}\` (${val.type ?? 'any'}${req}): ${val.description ?? ''}`)
        }
      }
    }
    lines.push('')
  }

  lines.push('使用 mcp_call 工具来调用上述工具，传入 server_id、tool_name 和 arguments。')

  return { content: lines.join('\n'), success: true }
}

/* ------------------------------------------------------------------ */
/*  电脑使用执行器                                                     */
/* ------------------------------------------------------------------ */

async function execDesktopScreenshot(
  args: Record<string, unknown>,
  logScope?: string,
  services?: AgentServices,
  runtimeContext?: ToolRuntimeContext,
  workspace?: string,
): Promise<ExecResult> {
  const rawWidth = args.width
  const rawHeight = args.height
  const width = rawWidth === undefined ? undefined : Number(rawWidth)
  const height = rawHeight === undefined ? undefined : Number(rawHeight)
  const displayId = typeof args.displayId === 'string' ? args.displayId : undefined
  const appId = typeof args.appId === 'string' && args.appId.trim() ? args.appId.trim() : 'desktop'

  if ((width !== undefined && !Number.isFinite(width)) || (height !== undefined && !Number.isFinite(height))) {
    return { content: 'Error: width/height must be numbers', success: false }
  }
  if ((width !== undefined && width <= 0) || (height !== undefined && height <= 0)) {
    return { content: 'Error: width/height must be positive', success: false }
  }

  if (!services?.desktop) return { content: 'Error: desktop service not available', success: false }

  // macOS 屏幕录制权限检查
  if (await services.desktop.checkScreenRecordingPermission() === 'denied') {
    services.desktop.openScreenRecordingSettings()
    return {
      content: 'Error: Screen Recording permission is denied. Please allow Taco AI in System Settings > Privacy & Security > Screen Recording, then restart the app.',
      success: false,
    }
  }

  try {
    const result = await services.desktop.captureScreen({
      width: width !== undefined && Number.isFinite(width) ? width : undefined,
      height: height !== undefined && Number.isFinite(height) ? height : undefined,
      displayId,
      appId,
      workspacePath: workspace,
    })

    services.logger('DESKTOP_SCREENSHOT_RESULT', {
      success: true,
      displayId: result.displayId,
      screenshotPath: result.screenshotPath,
      width: result.width,
      height: result.height,
      displayWidth: result.displayWidth,
      displayHeight: result.displayHeight,
      displayBoundsX: result.displayBoundsX,
      displayBoundsY: result.displayBoundsY,
      displayScaleFactor: result.displayScaleFactor,
      dataUrlLength: typeof result.dataUrl === 'string' ? result.dataUrl.length : 0,
    }, logScope)

    // 上传截图到云存储，以便手机端可以预览
    let cloudUrl: string | undefined
    if (services) {
      try {
        cloudUrl = await uploadScreenshotToCloud(result.dataUrl, services) || undefined
      } catch (err) {
        services.logger('DESKTOP_SCREENSHOT_UPLOAD_FAIL', { error: err instanceof Error ? err.message : String(err) })
        // 重试一次
        try {
          cloudUrl = await uploadScreenshotToCloud(result.dataUrl, services) || undefined
          services.logger('DESKTOP_SCREENSHOT_UPLOAD_RETRY_OK')
        } catch (retryErr) {
          services.logger('DESKTOP_SCREENSHOT_UPLOAD_RETRY_FAIL', { error: retryErr instanceof Error ? retryErr.message : String(retryErr) })
        }
      }
    }

    return {
      success: true,
      content: JSON.stringify({
        displayId: result.displayId,
        screenshotPath: result.screenshotPath,
        cloudUrl: cloudUrl || undefined,
        width: result.width,
        height: result.height,
        displayWidth: result.displayWidth,
        displayHeight: result.displayHeight,
        displayBoundsX: result.displayBoundsX,
        displayBoundsY: result.displayBoundsY,
        displayScaleFactor: result.displayScaleFactor,
        hint: cloudUrl
          ? '截图已上传到云存储。如需分析截图内容，请调用 analyze_image 工具，image 参数传 cloudUrl。'
          : '截图已保存到本地。如需分析截图内容，请调用 analyze_image 工具，image 参数传 data URL。',
      }),
    }
  } catch (err) {
    return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, success: false }
  }
}

async function execDesktopAction(args: Record<string, unknown>, signal?: AbortSignal, logScope?: string, services?: AgentServices): Promise<ExecResult> {
  const rawAction = String(args.action ?? '').trim()
  if (!rawAction) return { content: 'Error: action is required', success: false }

  const ACTION_ALIASES: Record<string, { action: string; impliedClicks?: number }> = {
    INPUT: { action: 'type' },
    TYPE_TEXT: { action: 'type' },
    TYPE: { action: 'type' },
    KEY_PRESS: { action: 'key' },
    KEYPRESS: { action: 'key' },
    PRESS: { action: 'key' },
    DOUBLE_CLICK: { action: 'click', impliedClicks: 2 },
    RIGHT_CLICK: { action: 'click' },
    SCROLL_UP: { action: 'scroll' },
    SCROLL_DOWN: { action: 'scroll' },
    SCROLL_LEFT: { action: 'scroll' },
    SCROLL_RIGHT: { action: 'scroll' },
  }
  const normalizedAlias = ACTION_ALIASES[rawAction.toUpperCase()]
    ?? (['move', 'click', 'mouse_down', 'drag', 'scroll', 'type', 'key'].includes(rawAction.toLowerCase())
      ? { action: rawAction.toLowerCase() }
      : null)
  if (!normalizedAlias) {
    return {
      content: `Error: unsupported action "${rawAction}". Supported actions: move/click/mouse_down/drag/scroll/type/key`,
      success: false,
    }
  }
  const action = normalizedAlias.action

  let dx = Number.isFinite(Number(args.dx)) ? Number(args.dx) : undefined
  let dy = Number.isFinite(Number(args.dy)) ? Number(args.dy) : undefined
  const direction = typeof args.direction === 'string' ? args.direction.toLowerCase() : ''
  if (action === 'scroll' && (dx === undefined || dy === undefined) && direction) {
    const rawAmount = args.amount
    let amount = 240
    if (typeof rawAmount === 'number' && Number.isFinite(rawAmount)) amount = rawAmount
    if (typeof rawAmount === 'string') {
      const lower = rawAmount.toLowerCase()
      if (lower === 'small') amount = 160
      else if (lower === 'medium') amount = 320
      else if (lower === 'large') amount = 520
      else if (Number.isFinite(Number(lower))) amount = Number(lower)
    }
    switch (direction) {
      case 'up': dy = -amount; dx = 0; break
      case 'down': dy = amount; dx = 0; break
      case 'left': dx = -amount; dy = 0; break
      case 'right': dx = amount; dy = 0; break
    }
  }

  const rawKey = typeof args.key === 'string' ? args.key.trim() : ''
  let parsedKey: { key?: string; modifiers?: Array<'cmd' | 'ctrl' | 'alt' | 'shift'> } = { key: rawKey || undefined }
  if (rawKey && rawKey.includes('+')) {
    const parts = rawKey.split('+').map(p => p.trim().toLowerCase())
    const keyPart = parts.pop()
    const mods: Array<'cmd' | 'ctrl' | 'alt' | 'shift'> = []
    for (const p of parts) {
      if (p === 'cmd' || p === 'command' || p === 'meta' || p === 'super' || p === 'win') mods.push('cmd')
      else if (p === 'ctrl' || p === 'control') mods.push('ctrl')
      else if (p === 'alt' || p === 'option') mods.push('alt')
      else if (p === 'shift') mods.push('shift')
    }
    parsedKey = { key: keyPart, modifiers: mods.length > 0 ? mods : undefined }
  }

  const explicitModifiers = Array.isArray(args.modifiers)
    ? (args.modifiers as string[]).filter((m): m is 'cmd' | 'ctrl' | 'alt' | 'shift' =>
        ['cmd', 'command', 'meta', 'super', 'win', 'ctrl', 'control', 'alt', 'option', 'shift'].includes(String(m).toLowerCase()))
      .map((m) => {
        const lower = String(m).toLowerCase()
        if (['cmd', 'command', 'meta', 'super', 'win'].includes(lower)) return 'cmd' as const
        if (['ctrl', 'control'].includes(lower)) return 'ctrl' as const
        if (['alt', 'option'].includes(lower)) return 'alt' as const
        return 'shift' as const
      })
    : undefined

  const mergedModifiersSet = new Set<'cmd' | 'ctrl' | 'alt' | 'shift'>([
    ...(parsedKey.modifiers ?? []),
    ...(explicitModifiers ?? []),
  ])

  let clicks: number | undefined = undefined
  const double = Boolean(args.double)
  if (double) clicks = 2
  if (Number.isFinite(Number(args.clicks))) clicks = Number(args.clicks)
  if (Number.isFinite(Number(args.clickCount))) clicks = Number(args.clickCount)
  if (clicks === undefined && normalizedAlias.impliedClicks !== undefined) clicks = normalizedAlias.impliedClicks

  const textCandidates = [args.text, args.input, args.value, args.content, args.message]
  const text = textCandidates.find((t): t is string => typeof t === 'string' && t.trim().length > 0) ?? undefined

  const pickNumberArg = (keys: string[]): number | undefined => {
    for (const key of keys) {
      const n = Number(args[key])
      if (Number.isFinite(n)) return n
    }
    return undefined
  }

  const payload = {
    action: action as 'move' | 'click' | 'mouse_down' | 'drag' | 'scroll' | 'type' | 'key',
    x: pickNumberArg(['x', 'fromX', 'startX', 'from_x', 'start_x']),
    y: pickNumberArg(['y', 'fromY', 'startY', 'from_y', 'start_y']),
    toX: pickNumberArg(['toX', 'endX', 'targetX', 'to_x', 'end_x', 'target_x', 'x2']),
    toY: pickNumberArg(['toY', 'endY', 'targetY', 'to_y', 'end_y', 'target_y', 'y2']),
    steps: Number.isFinite(Number(args.steps)) ? Math.max(2, Math.round(Number(args.steps))) : undefined,
    duration_ms: Number.isFinite(Number(args.duration_ms))
      ? Math.max(40, Math.round(Number(args.duration_ms)))
      : (Number.isFinite(Number(args.durationMs)) ? Math.max(40, Math.round(Number(args.durationMs))) : undefined),
    release: (Object.prototype.hasOwnProperty.call(args, 'release') || Object.prototype.hasOwnProperty.call(args, 'keepDown'))
      ? !parseBool(args.keepDown) && parseBool(args.release ?? true)
      : undefined,
    button: typeof args.button === 'string' ? (args.button as 'left' | 'right' | 'middle') : undefined,
    clicks,
    dx,
    dy,
    text,
    key: parsedKey.key ?? (typeof args.key === 'string' ? args.key.trim() : undefined),
    modifiers: mergedModifiersSet.size > 0 ? [...mergedModifiersSet] : undefined,
    delay_ms: Number.isFinite(Number(args.delay_ms)) ? Number(args.delay_ms) : undefined,
  }

  if (!services?.desktop) return { content: 'Error: desktop service not available', success: false }

  services.logger('DESKTOP_ACTION_REQUEST', {
    action: payload.action,
    x: payload.x,
    y: payload.y,
    toX: payload.toX,
    toY: payload.toY,
    steps: payload.steps,
    duration_ms: payload.duration_ms,
    release: payload.release,
    button: payload.button,
    clicks: payload.clicks,
    dx: payload.dx,
    dy: payload.dy,
    key: payload.key,
    textLength: payload.text ? payload.text.length : 0,
  }, logScope)

  const result = await services.desktop.call(payload, signal)
  services.logger('DESKTOP_ACTION_RESULT', {
    ok: result.ok,
    error: result.error,
    message: result.message,
    cursorBefore: result.cursorBefore ?? null,
    cursorAfter: result.cursorAfter ?? null,
    target: (Number.isFinite(payload.x) && Number.isFinite(payload.y))
      ? { x: Number(payload.x), y: Number(payload.y) }
      : null,
    targetOffsetAfter: (
      Number.isFinite(payload.x) &&
      Number.isFinite(payload.y) &&
      result.cursorAfter &&
      Number.isFinite(result.cursorAfter.x) &&
      Number.isFinite(result.cursorAfter.y)
    ) ? {
      dx: Number(result.cursorAfter.x) - Number(payload.x),
      dy: Number(result.cursorAfter.y) - Number(payload.y),
    } : null,
  }, logScope)

  if (!result.ok) {
    return { content: `Error: ${result.error ?? 'desktop action failed'}`, success: false }
  }

  const needsEnter = Boolean(args.needs_enter)
  if (action === 'type' && needsEnter && services.desktop) {
    const enterResult = await services.desktop.call({ action: 'key', key: 'enter' }, signal)
    if (!enterResult.ok) {
      return { content: `Error: ${enterResult.error ?? 'enter key failed'}`, success: false }
    }
    return { content: JSON.stringify({ ...result, followUp: enterResult }), success: true }
  }

  return { content: JSON.stringify(result), success: true }
}

function parseBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'y'
  }
  if (typeof value === 'number') return value !== 0
  return false
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/** 异步执行一批 tool calls，返回结果。workspace 为安全边界。 */
export async function executeToolCalls(
  toolCalls: ToolCall[],
  workspace: string,
  signal?: AbortSignal,
  logScope?: string,
  projectId?: string,
  runtimeContext?: ToolRuntimeContext,
): Promise<ToolResult[]> {
  const results: ToolResult[] = []
  const services = runtimeContext?.services

  for (const tc of toolCalls) {
    if (signal?.aborted) break
    const normalizedName = normalizeToolName(tc.function.name)
    if (runtimeContext?.allowedToolNames && !runtimeContext.allowedToolNames.has(normalizedName)) {
      results.push({
        tool_call_id: tc.id,
        name: tc.function.name,
        content: `Error: Tool is not enabled for current task: ${normalizedName}.`,
        success: false,
      })
      continue
    }
    let args: Record<string, unknown> = {}
    try {
      args = JSON.parse(tc.function.arguments)
    } catch {
      results.push({
        tool_call_id: tc.id,
        name: tc.function.name,
        content: `Error: Invalid JSON arguments: ${tc.function.arguments}`,
        success: false,
      })
      continue
    }

    services?.logger('TOOL_CALL', { id: tc.id, name: tc.function.name, arguments: args, workspace }, logScope)

    let result: ExecResult & { fileChange?: FileChange }
    try {
      result = await executeTool(tc.function.name, args, workspace, signal, projectId, logScope, runtimeContext)
    } catch (err) {
      if (isAbortError(err)) break
      const msg = err instanceof Error ? err.message : String(err)
      result = { content: `Error: ${msg}`, success: false }
    }

    services?.logger('TOOL_RESULT', { id: tc.id, name: tc.function.name, success: result.success, content: result.content }, logScope)

    results.push({
      tool_call_id: tc.id,
      name: tc.function.name,
      ...result,
    })
  }

  return results
}

export { assessToolCallsRisk }
export type { RiskInfo, RiskCategory, RiskLevel }
export { setBrowserAutoApproved, setDesktopAutoApproved, setAutoApproveCategories, getAutoApproveCategories, isBrowserAutoApproved, isDesktopAutoApproved } from './risk'
export { getWorkspaceTree } from './workspace-tree'
export { buildAllowedToolNamesForRequest } from './registry'
