/**
 * 工具执行引擎
 *
 * 包含所有工具的执行器函数、路径解析、命令执行、文件操作等。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { exec, execFile } from 'node:child_process'
import { desktopCapturer, systemPreferences, screen, nativeImage, shell } from 'electron'
import { log } from '../system/logger'
import { executeBrowserAction, getBrowserConsoleSnapshot } from '../automation/browser'
import type { BrowserActionType } from '../../shared/ipc'
import { saveScreenshot, getActiveMcpTools, callMcpTool } from '../automation/mcp'
import { fileToDataUrl, getGuiPlusConfig, runGuiPlus } from '../automation/gui-plus'
import { callDesktopService } from '../automation/desktop-service'
import { getAllowedToolsForSkills, readActiveSkillDetail, readActiveSkillResource } from '../project/skills'
import { normalizeToolName, toolDefinitions, type ToolCall, type ToolResult, type FileChange } from './definitions'
import { assessToolCallsRisk, type RiskInfo, type RiskCategory, type RiskLevel } from './risk-assessor'
import { mapGuiPlusCoordinates, extractGuiPlusPoint, compactGuiPlusParsed, compactGuiPlusMapped, getGuiPlusScopeKey, normalizeDesktopAction, parseDesktopKeyCombo, normalizeDesktopModifiers, resolveDesktopClicks, pickDesktopInputText, pendingGuiPlusClickGuardByScope, lastGuiPlusClickByImagePath, desktopScreenshotMetaByPath } from './gui-plus-coords'
import { getWorkspaceTree } from './workspace-tree'
import { resolveUploadConfig, uploadDataUrlToStorage } from '../ai/llm'
import { loadUploadConfigFromDb } from '../data/memory-db'

// 上传截图到云存储
async function uploadScreenshotToCloud(dataUrl: string): Promise<string | null> {
  try {
    const dbConfig = loadUploadConfigFromDb()
    if (!dbConfig || dbConfig.provider === 'none') {
      log('SCREENSHOT_UPLOAD_SKIP', { reason: 'no_upload_config' })
      return null
    }
    
    const uploadConfig = resolveUploadConfig(dbConfig.config as any)
    if (!uploadConfig) {
      log('SCREENSHOT_UPLOAD_SKIP', { reason: 'invalid_upload_config' })
      return null
    }
    
    const cloudUrl = await uploadDataUrlToStorage(uploadConfig, dataUrl)
    log('SCREENSHOT_UPLOADED', { cloudUrl })
    return cloudUrl
  } catch (err) {
    log('SCREENSHOT_UPLOAD_FAIL', { error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

type DesktopScreenshotMeta = {
  screenshotPath: string
  screenshotWidth: number
  screenshotHeight: number
  displayId: string
  displayWidth: number
  displayHeight: number
  displayBoundsX: number
  displayBoundsY: number
  displayScaleFactor: number
}

type ExecResult = { content: string; success: boolean }

type ToolRuntimeContext = {
  allowedToolNames?: Set<string>
  activatedSkillIds?: Set<string>
}

const ALWAYS_AVAILABLE_TOOL_NAMES = [
  'read_file',
  'write_file',
  'edit_file',
  'list_dir',
  'run_command',
  'delete_file',
  'propose_plan',
  'update_plan_progress',
  'find_file',
  'read_skill',
  'read_skill_resource',
  'save_note',
  'delete_note',
  'mcp_list_tools',
  'mcp_call',
]

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

function isPathWithinWorkspace(workspace: string, targetPath: string): boolean {
  const normalizedWs = path.normalize(workspace)
  const normalizedTarget = path.normalize(targetPath)
  return normalizedTarget === normalizedWs || normalizedTarget.startsWith(`${normalizedWs}${path.sep}`)
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
    if (testResolved.startsWith(normalizedWs)) {
      cleaned = without
    }
  }

  cleaned = cleaned.replace(/\/+$/, '')
  if (!cleaned) cleaned = '.'

  const resolved = path.resolve(workspace, cleaned)
  const normalized = path.normalize(resolved)
  if (!normalized.startsWith(normalizedWs)) {
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

  if (!path.normalize(bestResolved).startsWith(path.normalize(workspace))) {
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
          if (err) {
            reject(err)
            return
          }
          resolve(stdout ?? '')
        })
      })
      const parsed = parseNulSeparatedEnv(output)
      if (Object.keys(parsed).length > 0) {
        log('RUN_COMMAND_ENV_READY', { mode: attempt.mode, shell, envKeys: Object.keys(parsed).length })
        return parsed
      }
    } catch (err) {
      log('RUN_COMMAND_ENV_LOAD_FAIL', {
        mode: attempt.mode,
        shell,
        error: err instanceof Error ? err.message : String(err),
      })
    }
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
      case 'save_note':
        return await execSaveNote(args, workspace, projectId)
      case 'delete_note':
        return await execDeleteNote(args, workspace, projectId)
      /* ---- 浏览器自动化 ---- */
      case 'browser_navigate':
        return await execBrowserAction('navigate', args, projectId)
      case 'browser_screenshot':
        return await execBrowserAction('screenshot', args, projectId)
      case 'desktop_screenshot':
        return await execDesktopScreenshot(args, logScope)
      case 'browser_click':
        return await execBrowserAction('click', args, projectId)
      case 'browser_type':
        return await execBrowserAction('type', args, projectId)
      case 'browser_scroll':
        return await execBrowserAction('scroll', args, projectId)
      case 'browser_get_content':
        return await execBrowserAction('get_content', args, projectId)
      case 'browser_wait':
        return await execBrowserAction('wait', args, projectId)
      case 'browser_evaluate':
        return await execBrowserAction('evaluate', args, projectId)
      case 'browser_get_info':
        return await execBrowserAction('get_info', args, projectId)
      case 'browser_get_console_logs':
        return await execBrowserGetConsoleLogs(args, projectId)
      case 'browser_hover':
        return await execBrowserAction('hover', args, projectId)
      case 'browser_keypress':
        return await execBrowserAction('keypress', args, projectId)
      case 'browser_drag':
        return await execBrowserAction('drag', args, projectId)
      case 'browser_select':
        return await execBrowserAction('select', args, projectId)
      case 'gui_plus_analyze':
        return await execGuiPlusAnalyze(args, signal, logScope)
      case 'desktop_action':
        return await execDesktopAction(args, signal, logScope)
      /* ---- MCP ---- */
      case 'mcp_call':
        return await execMcpCall(args, signal)
      case 'mcp_list_tools':
        return await execMcpListTools()
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

  runtimeContext?.activatedSkillIds?.add(skillId)
  return { content: detail.content, success: true }
}

async function execReadSkillResource(args: Record<string, unknown>, runtimeContext?: ToolRuntimeContext): Promise<ExecResult> {
  const skillId = String(args.skill_id ?? '').trim()
  const resourcePath = String(args.resource_path ?? '').trim()
  if (!skillId) return { content: 'Error: skill_id is required', success: false }
  if (!resourcePath) return { content: 'Error: resource_path is required', success: false }
  if (!runtimeContext?.activatedSkillIds?.has(skillId)) {
    return {
      content: `Error: Skill is not activated in current task: ${skillId}. You must call read_skill first.`,
      success: false,
    }
  }

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

  const occurrences = countTextOccurrences(oldContent, oldText)
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
  const newContent = replaceAll
    ? oldContent.split(oldText).join(newText)
    : oldContent.replace(oldText, newText)

  if (newContent === oldContent) {
    return { content: `Error: edit produced no changes for ${resolved}`, success: false }
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

  await fs.unlink(resolved)

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
    // fuzzy (default)
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

/* ------------------------------------------------------------------ */
/*  项目笔记工具                                                        */
/* ------------------------------------------------------------------ */

async function execSaveNote(args: Record<string, unknown>, workspace: string, projectId?: string): Promise<ExecResult> {
  const title = String(args.title ?? '').trim()
  const content = String(args.content ?? '').trim()
  const category = String(args.category ?? 'other') as import('../../shared/ipc').NoteCategory
  if (!title) return { content: 'Error: title is required', success: false }
  if (!content) return { content: 'Error: content is required', success: false }

  const { saveNote } = await import('../data/notes')
  const id = `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const now = new Date().toISOString()
  const saved = await saveNote(workspace, {
    id,
    title,
    content,
    category,
    createdAt: now,
    updatedAt: now,
  }, projectId)
  return { content: `项目笔记已保存：「${saved.title}」(${saved.id})`, success: true }
}

async function execDeleteNote(args: Record<string, unknown>, workspace: string, projectId?: string): Promise<ExecResult> {
  const noteId = String(args.noteId ?? '').trim()
  if (!noteId) return { content: 'Error: noteId is required', success: false }

  const { deleteNote } = await import('../data/notes')
  await deleteNote(workspace, noteId, projectId)
  return { content: `项目笔记已删除：${noteId}`, success: true }
}

/* ------------------------------------------------------------------ */
/*  浏览器自动化执行器                                                    */
/* ------------------------------------------------------------------ */

function scopedBrowserAppId(projectId?: string): string | undefined {
  const raw = String(projectId ?? '').trim()
  if (!raw) return undefined
  const safe = raw.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 64)
  return safe ? `project-${safe}` : undefined
}

async function execBrowserAction(
  action: BrowserActionType,
  args: Record<string, unknown>,
  projectId?: string,
): Promise<ExecResult> {
  const appId = args.appId ? String(args.appId) : scopedBrowserAppId(projectId)
  const mergedArgs = appId ? { ...args, appId } : args
  log(`Browser action: ${action} [appId=${appId || 'default'}]`, mergedArgs)
  const result = await executeBrowserAction({ action, params: mergedArgs }, appId)
  if (result.success) {
    if (action === 'screenshot' && result.data) {
      try {
        const parsed = JSON.parse(result.data)
        const pageInfo = parsed.page ?? {}
        const screenshotDataUrl = parsed.screenshot || parsed.dataUrl

        let screenshotPath = ''
        let cloudUrl: string | undefined
        if (screenshotDataUrl) {
          try {
            screenshotPath = await saveScreenshot(screenshotDataUrl, appId || 'default')
          } catch (err) {
            log('SCREENSHOT_SAVE_FAIL', { error: err instanceof Error ? err.message : String(err) })
          }
          
          // 上传到云存储
          try {
            cloudUrl = await uploadScreenshotToCloud(screenshotDataUrl) || undefined
          } catch (err) {
            log('BROWSER_SCREENSHOT_UPLOAD_FAIL', { error: err instanceof Error ? err.message : String(err) })
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
              ? '截图已上传到云存储，可直接使用 cloudUrl 访问图片'
              : screenshotPath
              ? '截图已保存到本地'
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

async function execBrowserGetConsoleLogs(args: Record<string, unknown>, projectId?: string): Promise<ExecResult> {
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

  const snapshot = getBrowserConsoleSnapshot({
    appId,
    limit,
    levels,
    onlyErrors,
    devOnly,
    includeCandidates,
    clearAfterRead,
  })

  return {
    content: JSON.stringify(snapshot, null, 2),
    success: true,
  }
}

/* ------------------------------------------------------------------ */
/*  MCP 工具执行器                                                      */
/* ------------------------------------------------------------------ */

async function execMcpCall(args: Record<string, unknown>, signal?: AbortSignal): Promise<ExecResult> {
  const serverId = String(args.server_id ?? '').trim()
  const toolName = String(args.tool_name ?? '').trim()
  const toolArgs = (args.arguments ?? {}) as Record<string, unknown>

  if (!serverId) return { content: 'Error: server_id is required', success: false }
  if (!toolName) return { content: 'Error: tool_name is required', success: false }
  if (signal?.aborted) throw makeAbortError()

  try {
    const result = await callMcpTool(serverId, toolName, toolArgs)

    const texts: string[] = []
    for (const item of result.content ?? []) {
      if (item.type === 'text' && item.text) {
        texts.push(item.text)
      } else if (item.type === 'image' && item.data) {
        try {
          const imgPath = await saveScreenshot(`data:image/png;base64,${item.data}`)
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

async function execMcpListTools(): Promise<ExecResult> {
  const mcpTools = getActiveMcpTools()

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

function openMacScreenRecordingSettings(): void {
  if (process.platform !== 'darwin') return
  try {
    const maybeOpen = (systemPreferences as unknown as {
      openSystemPreferences?: (pane: string, section?: string) => void
    }).openSystemPreferences
    if (typeof maybeOpen === 'function') {
      maybeOpen('privacy', 'ScreenRecording')
      return
    }
  } catch {
    // ignore
  }
  void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture').catch(() => {})
}

async function execDesktopScreenshot(args: Record<string, unknown>, logScope?: string): Promise<ExecResult> {
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

  if (process.platform === 'darwin') {
    try {
      const status = systemPreferences.getMediaAccessStatus?.('screen')
      if (status && status !== 'granted') {
        openMacScreenRecordingSettings()
        return {
          content:
            `Error: Screen Recording permission is ${status}. ` +
            'Please allow Taco AI in System Settings > Privacy & Security > Screen Recording, then restart the app.',
          success: false,
        }
      }
    } catch {
      // ignore permission check failures
    }
  }

  const displays = screen.getAllDisplays()
  const targetDisplay = displayId
    ? displays.find((d) => String(d.id) === displayId)
    : screen.getPrimaryDisplay()
  const display = targetDisplay ?? displays[0]
  if (!display) {
    return { content: 'Error: no display found', success: false }
  }

  const targetWidth = width ?? display.size.width
  const targetHeight = height ?? display.size.height

  log('DESKTOP_SCREENSHOT_REQUEST', {
    args,
    resolved: {
      displayId,
      width: targetWidth,
      height: targetHeight,
      appId,
      displayWidth: display.size.width,
      displayHeight: display.size.height,
    },
  }, logScope)

  let sources: Electron.DesktopCapturerSource[]
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.max(1, Math.floor(targetWidth)), height: Math.max(1, Math.floor(targetHeight)) },
      fetchWindowIcons: false,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (process.platform === 'darwin') {
      openMacScreenRecordingSettings()
    }
    return {
      content: `Error: Failed to get sources. ${msg}\n` +
        'If you are on macOS, enable Screen Recording permission for Taco AI in System Settings > Privacy & Security > Screen Recording, then restart the app.',
      success: false,
    }
  }

  if (sources.length === 0) {
    return { content: 'Error: no screen sources available', success: false }
  }

  const source = displayId
    ? sources.find((s) => s.display_id === displayId)
    : sources.find((s) => String(display.id) === s.display_id) ?? sources[0]

  if (!source) {
    return { content: `Error: displayId not found: ${displayId}`, success: false }
  }

  const dataUrl = source.thumbnail.toDataURL()
  const screenshotPath = await saveScreenshot(dataUrl, appId)
  const size = source.thumbnail.getSize()
  
  // 上传到云存储
  const cloudUrl = await uploadScreenshotToCloud(dataUrl)

  const payload = {
    displayId: source.display_id,
    screenshotPath,
    cloudUrl: cloudUrl || undefined,  // 添加cloudUrl字段
    width: size.width,
    height: size.height,
    displayWidth: display.size.width,
    displayHeight: display.size.height,
    displayBoundsX: display.bounds.x,
    displayBoundsY: display.bounds.y,
    displayScaleFactor: display.scaleFactor,
  }

  desktopScreenshotMetaByPath.set(screenshotPath, {
    screenshotPath,
    screenshotWidth: size.width,
    screenshotHeight: size.height,
    displayId: source.display_id,
    displayWidth: display.size.width,
    displayHeight: display.size.height,
    displayBoundsX: display.bounds.x,
    displayBoundsY: display.bounds.y,
    displayScaleFactor: display.scaleFactor,
  })

  log('DESKTOP_SCREENSHOT_RESULT', {
    success: true,
    displayId: payload.displayId,
    screenshotPath: payload.screenshotPath,
    width: payload.width,
    height: payload.height,
    displayWidth: payload.displayWidth,
    displayHeight: payload.displayHeight,
    displayBoundsX: payload.displayBoundsX,
    displayBoundsY: payload.displayBoundsY,
    displayScaleFactor: payload.displayScaleFactor,
    dataUrlLength: typeof dataUrl === 'string' ? dataUrl.length : 0,
  }, logScope)

  return {
    success: true,
    content: JSON.stringify(payload),
  }
}

async function execGuiPlusAnalyze(args: Record<string, unknown>, signal?: AbortSignal, logScope?: string): Promise<ExecResult> {
  const instruction = String(args.instruction ?? '').trim()
  if (!instruction) return { content: 'Error: instruction is required', success: false }

  const imageDataUrl = typeof args.imageDataUrl === 'string' ? args.imageDataUrl : ''
  const imagePath = typeof args.imagePath === 'string' ? args.imagePath : ''

  let dataUrl = imageDataUrl
  if (!dataUrl && imagePath) {
    try {
      dataUrl = await fileToDataUrl(imagePath)
    } catch (err) {
      return { content: `Error: failed to read imagePath (${imagePath}): ${String(err)}`, success: false }
    }
  }
  if (!dataUrl) return { content: 'Error: imageDataUrl or imagePath is required', success: false }

  const config = await getGuiPlusConfig()
  const reqMinPixels = args.minPixels !== undefined ? Number(args.minPixels) : undefined
  const reqMaxPixels = args.maxPixels !== undefined ? Number(args.maxPixels) : undefined
  const configMinPixels = Number.isFinite(config.minPixels) ? Number(config.minPixels) : undefined
  const configMaxPixels = Number.isFinite(config.maxPixels) ? Number(config.maxPixels) : undefined
  const effectiveMinPixels = Number.isFinite(reqMinPixels) ? Number(reqMinPixels) : configMinPixels
  const effectiveMaxPixels = Number.isFinite(reqMaxPixels) ? Number(reqMaxPixels) : configMaxPixels

  log('GUI_PLUS_REQUEST', {
    instruction,
    imagePath: imagePath || undefined,
    imageDataUrlLength: dataUrl ? dataUrl.length : 0,
    requestMinPixels: Number.isFinite(reqMinPixels) ? reqMinPixels : undefined,
    requestMaxPixels: Number.isFinite(reqMaxPixels) ? reqMaxPixels : undefined,
    effectiveMinPixels,
    effectiveMaxPixels,
    highResolution: Boolean(config.highResolution),
  }, logScope)

  const result = await runGuiPlus(config, instruction, dataUrl, {
    minPixels: effectiveMinPixels,
    maxPixels: effectiveMaxPixels,
    signal,
    logScope,
  })

  if (result.usage) {
    log('GUI_PLUS_USAGE', {
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      totalTokens: result.usage.totalTokens,
      cachedTokens: result.usage.cachedTokens,
    }, logScope)
  }

  const parsedObj = (result.parsed && typeof result.parsed === 'object')
    ? (result.parsed as { action?: string; parameters?: Record<string, unknown>; thought?: unknown })
    : null
  const extractedPoint = extractGuiPlusPoint(parsedObj?.parameters ?? {})
  const mapped = mapGuiPlusCoordinates(
    result.parsed,
    dataUrl,
    imagePath,
    {
      minPixels: effectiveMinPixels,
      maxPixels: effectiveMaxPixels,
      highResolution: config.highResolution,
    }
  )

  const scopeKey = getGuiPlusScopeKey(logScope)
  const parsedAction = typeof parsedObj?.action === 'string' ? parsedObj.action.toUpperCase() : ''
  let unstableClick = false
  let unstableReason: string | undefined
  if (parsedAction === 'CLICK' && mapped && imagePath) {
    const prev = lastGuiPlusClickByImagePath.get(imagePath)
    if (prev) {
      const distance = Math.hypot(mapped.x - prev.x, mapped.y - prev.y)
      const diagonal = Math.hypot(mapped.originalWidth, mapped.originalHeight)
      const threshold = Math.max(160, diagonal * 0.12)
      if (distance > threshold) {
        unstableClick = true
        unstableReason = `same image click drift ${distance.toFixed(1)}px exceeds threshold ${threshold.toFixed(1)}px`
      }
    }
    lastGuiPlusClickByImagePath.set(imagePath, {
      imagePath,
      x: mapped.x,
      y: mapped.y,
      timestamp: Date.now(),
    })
  }
  if (parsedAction === 'CLICK' && mapped) {
    pendingGuiPlusClickGuardByScope.set(scopeKey, {
      x: mapped.x,
      y: mapped.y,
      unstable: unstableClick,
      reason: unstableReason,
      imagePath: imagePath || undefined,
      timestamp: Date.now(),
    })
  } else {
    pendingGuiPlusClickGuardByScope.delete(scopeKey)
  }

  const rawX = extractedPoint?.x
  const rawY = extractedPoint?.y
  if (mapped || rawX !== undefined || rawY !== undefined || unstableClick) {
    log('GUI_PLUS_COORD_MAP', {
      action: parsedObj?.action ?? null,
      rawX,
      rawY,
      rawSource: extractedPoint?.source,
      unstableClick,
      unstableReason,
      mapped: mapped ?? null,
    }, logScope)
  }

  const warnings: string[] = []
  if (extractedPoint?.source === 'x_array') {
    warnings.push('GUI-Plus returned coordinates as parameters.x array; auto-converted to x/y')
  } else if (extractedPoint?.source === 'xyxy_center') {
    warnings.push('GUI-Plus returned coordinates as [x1,y1,x2,y2]; auto-converted to center point')
  }
  if (unstableClick && unstableReason) warnings.push(`Unstable click candidate: ${unstableReason}`)

  const payload = {
    parsed: compactGuiPlusParsed(result.parsed),
    mapped: compactGuiPlusMapped(mapped),
    rawLength: result.raw.length,
    ...(warnings.length ? { warnings } : {}),
    ...(unstableClick ? { requiresRecheck: true } : {}),
  }

  log('GUI_PLUS_RESULT', {
    parsed: payload.parsed,
    rawLength: result.raw.length,
    usage: result.usage ?? null,
    mapped: payload.mapped ?? null,
    warnings,
    requiresRecheck: unstableClick,
  }, logScope)

  return {
    success: true,
    content: JSON.stringify(payload),
  }
}

async function execDesktopAction(args: Record<string, unknown>, signal?: AbortSignal, logScope?: string): Promise<ExecResult> {
  const rawAction = String(args.action ?? '').trim()
  if (!rawAction) return { content: 'Error: action is required', success: false }
  const normalizedAction = normalizeDesktopAction(rawAction)
  if (!normalizedAction) {
    return {
      content: `Error: unsupported action "${rawAction}". Supported actions: move/click/mouse_down/drag/scroll/type/key`,
      success: false,
    }
  }
  const action = normalizedAction.action

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

  const parsedKeyCombo = parseDesktopKeyCombo(typeof args.key === 'string' ? args.key : '')
  const explicitModifiers = normalizeDesktopModifiers(args.modifiers)
  const mergedModifiersSet = new Set<'cmd' | 'ctrl' | 'alt' | 'shift'>([
    ...(parsedKeyCombo.modifiers ?? []),
    ...(explicitModifiers ?? []),
  ])
  const clicks = resolveDesktopClicks(args, action, normalizedAction.impliedClicks)
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
    text: pickDesktopInputText(args),
    key: parsedKeyCombo.key ?? (typeof args.key === 'string' ? args.key.trim() : undefined),
    modifiers: mergedModifiersSet.size > 0 ? [...mergedModifiersSet] : undefined,
    delay_ms: Number.isFinite(Number(args.delay_ms)) ? Number(args.delay_ms) : undefined,
  }

  const scopeKey = getGuiPlusScopeKey(logScope)
  const guard = pendingGuiPlusClickGuardByScope.get(scopeKey)
  if (
    action === 'click' &&
    guard &&
    Date.now() - guard.timestamp < 60_000 &&
    Number.isFinite(payload.x) &&
    Number.isFinite(payload.y)
  ) {
    const distance = Math.hypot(Number(payload.x) - guard.x, Number(payload.y) - guard.y)
    if (distance <= 8 && guard.unstable) {
      log('DESKTOP_ACTION_BLOCKED', {
        reason: 'unstable_gui_plus_click',
        guard,
        payload,
      }, logScope)
      return {
        content: `Error: blocked unstable GUI click candidate (${guard.reason ?? 'coordinate drift too large'}). Please take a new screenshot and re-analyze before clicking.`,
        success: false,
      }
    }
    if (distance <= 8 && !guard.unstable) {
      pendingGuiPlusClickGuardByScope.delete(scopeKey)
    }
  }

  log('DESKTOP_ACTION_REQUEST', {
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
    guiClickGuard: guard ?? null,
  }, logScope)

  const result = await callDesktopService(payload, signal)
  log('DESKTOP_ACTION_RESULT', {
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
  if (action === 'type' && needsEnter) {
    const enterResult = await callDesktopService({ action: 'key', key: 'enter' }, signal)
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

  for (const tc of toolCalls) {
    if (signal?.aborted) break
    const normalizedName = normalizeToolName(tc.function.name)
    if (runtimeContext?.allowedToolNames && !runtimeContext.allowedToolNames.has(normalizedName)) {
      results.push({
        tool_call_id: tc.id,
        name: tc.function.name,
        content: `Error: Tool is not enabled for current task: ${normalizedName}. If this tool belongs to a skill, call read_skill first and continue in the next round.`,
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

    log('TOOL_CALL', { id: tc.id, name: tc.function.name, arguments: args, workspace }, logScope)

    let result: ExecResult & { fileChange?: FileChange }
    try {
      result = await executeTool(tc.function.name, args, workspace, signal, projectId, logScope, runtimeContext)
    } catch (err) {
      if (isAbortError(err)) break
      const msg = err instanceof Error ? err.message : String(err)
      result = { content: `Error: ${msg}`, success: false }
    }

    log('TOOL_RESULT', { id: tc.id, name: tc.function.name, success: result.success, content: result.content }, logScope)

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
export { setBrowserAutoApproved, setDesktopAutoApproved, setAutoApproveCategories, getAutoApproveCategories, isBrowserAutoApproved, isDesktopAutoApproved } from './risk-assessor'
export { getWorkspaceTree } from './workspace-tree'
export { buildAllowedToolNamesForRequest } from './registry'
