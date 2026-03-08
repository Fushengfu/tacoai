/**
 * IPC Handler 注册
 *
 * 将所有 ipcMain handler 集中管理，main.ts 只需调用 registerIpcHandlers() 即可。
 */

import { app, BrowserWindow, Notification, dialog, ipcMain, shell } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { exec } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { watch as fsWatch, type Dirent, type FSWatcher } from 'node:fs'
import * as nodePath from 'node:path'
import { IpcChannel, editorCommands } from '../shared/ipc'
import type {
  AppNotifyPayload,
  ChatSendPayload,
  ChatStreamPayload,
  AgentStreamPayload,
  AgentConfirmPayload,
  EditorId,
  ProjectNote,
  McpServerInfo,
  GuiPlusConfig,
  MobileBridgeConfig,
  MobileBridgeContextSnapshot,
  PromptConfig,
} from '../shared/ipc'
import { setBrowserAutoApproved, setAutoApproveCategories } from './tools'
import type { RiskCategory } from './tools'
import type { ProviderKey, ProviderOverrides, TokenUsage } from './llm'
import { requestChatCompletion, requestChatCompletionStream } from './llm'
import { runAgent, resolveConfirm } from './agent'
import { gitLog, gitCommit, gitRollback, gitCommitFiles, gitStatus, gitFileChange, gitStageFiles, gitStageAll } from './git'
import { initSkills, listSkills, installSkill, uninstallSkill, toggleSkill, refreshSkills, buildActiveSkillsCatalogBlock, getActiveSkillEnv, applySkillEnvironment } from './skills'
import { inferIntentFromBackground, listNotes, listTaskMemories, saveNote, deleteNote, deleteTaskMemory, maintainTaskMemoriesByAI, recordTaskLog, stripInternalContextTags, getMemoryScopeStats, exportMemoryScope } from './notes'
import { initMcp, listMcpServers, saveMcpServer, removeMcpServer, toggleMcpServer, saveScreenshot } from './mcp'
import { getGuiPlusConfig, saveGuiPlusConfig } from './gui-plus'
import { getPromptConfig, savePromptConfig } from './prompt-config'
import { getLogDir } from './logger'
import { log } from './logger'
import { applyRewardScore } from './reward-score'
import { handleTerminalSpawn, handleTerminalInput, handleTerminalResize, handleTerminalKill } from './terminal'
import { openExternalBrowser, closeExternalBrowser, navigateExternalBrowser, focusExternalBrowser } from './browser'
import { getMobileBridgeConfig, initMobileBridge, setMobileBridgeConfig, updateMobileBridgeContext } from './mobile-bridge'

/* ------------------------------------------------------------------ */
/*  Handlers                                                           */
/* ------------------------------------------------------------------ */

function buildLogScope(projectId?: string, workspace?: string): string | undefined {
  if (projectId && projectId.trim()) return `project:${projectId.trim()}`
  if (workspace && workspace.trim()) return `workspace:${nodePath.resolve(workspace.trim())}`
  return undefined
}

function cleanupAssistantMemoryText(text: string): string {
  return stripInternalContextTags(String(text ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '')).trim()
}

const USER_ASSETS_BLOCK_REGEX = /\s*\[USER_ASSETS\][\s\S]*?\[\/USER_ASSETS\]\s*/gi
const USER_ASSETS_BLOCK_CAPTURE_REGEX = /\[USER_ASSETS\]([\s\S]*?)\[\/USER_ASSETS\]/i

function stripUserAssetsBlock(content: string): string {
  return String(content ?? '')
    .replace(USER_ASSETS_BLOCK_REGEX, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function buildUserAssetsBlock(imagePaths: string[]): string {
  const lines: string[] = ['[USER_ASSETS]']
  for (const imagePath of imagePaths) {
    lines.push('- type: image')
    lines.push(`  path: ${imagePath}`)
  }
  lines.push('[/USER_ASSETS]')
  return lines.join('\n')
}

function extractUserAssetsBlock(content: string): string {
  const raw = String(content ?? '')
  const wrapped = raw.match(USER_ASSETS_BLOCK_CAPTURE_REGEX)
  if (!wrapped || !wrapped[1]) return ''
  return wrapped[1].trim()
}

function extractUserQueryText(content: string): string {
  const raw = stripUserAssetsBlock(String(content ?? ''))
  const wrapped = raw.match(/\[USER_QUERY\]([\s\S]*?)\[\/USER_QUERY\]/i)
  if (wrapped && wrapped[1]) return wrapped[1].trim()
  return raw.trim()
}

function inferIntentTypeFromQuery(query: string): string {
  const text = String(query ?? '').trim().toLowerCase()
  if (!text) return 'other'
  if (/(报错|错误|异常|排查|调试|debug|error|bug|trace|崩溃)/.test(text)) return 'debug'
  if (/(实现|新增|开发|编写|添加|implement|create|build|功能)/.test(text)) return 'implement'
  if (/(重构|优化|整理|抽离|refactor|optimize|cleanup)/.test(text)) return 'refactor'
  if (/(删除|重命名|移动|部署|发布|配置|运行|执行|remove|delete|rm |mv |deploy)/.test(text)) return 'ops'
  if (/(是什么|为什么|怎么|如何|请解释|是否|吗|\?|？|what|why|how|can you)/.test(text)) return 'qa'
  return 'other'
}

const STREAM_SANITIZE_HOLD_BACK = 24

const USER_VISIBLE_SOURCE_PHRASE_RULES: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /从(?:项目)?历史(?:记录|记忆|信息|上下文)来看/g, replacement: '结合当前上下文来看' },
  { pattern: /根据(?:项目)?历史(?:记录|记忆|信息|上下文)(?:显示|来看|可知|可见)?/g, replacement: '结合当前上下文' },
  { pattern: /基于(?:项目)?历史(?:记录|记忆|信息|上下文)/g, replacement: '结合当前上下文' },
  { pattern: /根据(?:背景|上下文)信息/g, replacement: '结合当前上下文' },
  { pattern: /根据\s*BACKGROUND_CONTEXT/gi, replacement: '结合当前上下文' },
  { pattern: /based on (?:the )?(?:project )?(?:history|historical (?:records?|memory|context))/gi, replacement: 'based on current context' },
  { pattern: /from (?:the )?background context/gi, replacement: 'from current context' },
]

function sanitizeUserFacingText(input: string): string {
  let output = stripInternalContextTags(String(input ?? ''))
  for (const rule of USER_VISIBLE_SOURCE_PHRASE_RULES) {
    output = output.replace(rule.pattern, rule.replacement)
  }
  return output
}

function withActiveSkillsPrompt<T extends { role: string; content?: string }>(messages: T[]): T[] {
  const skillCatalog = buildActiveSkillsCatalogBlock()
  if (!skillCatalog.trim()) return messages

  const systemIdx = messages.findIndex((m) => m.role === 'system')
  if (systemIdx < 0) return messages

  const current = String(messages[systemIdx].content ?? '')
  if (current.includes('[SKILLS_CATALOG]')) return messages

  const next = [...messages]
  next[systemIdx] = { ...next[systemIdx], content: `${current}\n\n${skillCatalog}` }
  return next
}

/** 非流式：renderer invoke → main handle → 返回完整回复 */
async function handleChatSend(_event: IpcMainInvokeEvent, payload: ChatSendPayload) {
  const logScope = buildLogScope(payload.projectId, undefined)
  try {
    await refreshSkills()
  } catch (err) {
    log('SKILLS_REFRESH_FAIL', { error: err instanceof Error ? err.message : String(err) }, logScope)
  }
  const messages = withActiveSkillsPrompt(payload.messages)
  const restoreSkillEnv = applySkillEnvironment(getActiveSkillEnv())
  try {
    const raw = await requestChatCompletion(
      payload.provider as ProviderKey,
      messages,
      payload.overrides as ProviderOverrides | undefined,
      undefined,
      logScope,
    )
    return sanitizeUserFacingText(raw)
  } finally {
    restoreSkillEnv()
  }
}

/** 流式：renderer send → main on → 逐块 send 回 renderer */
async function handleChatStream(event: IpcMainEvent, payload: ChatStreamPayload) {
  const { requestId, provider, overrides, projectId, workspace, maxTokens } = payload
  const logScope = buildLogScope(projectId, workspace)
  try {
    await refreshSkills(workspace)
  } catch (err) {
    log('SKILLS_REFRESH_FAIL', { error: err instanceof Error ? err.message : String(err) }, logScope)
  }
  const messages = withActiveSkillsPrompt(payload.messages)
  const restoreSkillEnv = applySkillEnvironment(getActiveSkillEnv())
  const turnStartedAt = Date.now()
  const abortController = new AbortController()
  let lastUsage: TokenUsage | undefined
  let assistantFullText = ''
  let rawAssistantFullText = ''
  let emittedSanitizedText = ''
  const lastUserGoal = [...messages].reverse().find((m) => m.role === 'user')?.content?.trim() || ''
  const plainUserQuery = extractUserQueryText(lastUserGoal)
  const userAssetsBlock = extractUserAssetsBlock(lastUserGoal)

  async function persistChatTurnMemory(
    outcome: 'success' | 'aborted' | 'error',
    summaryText: string,
    errorMessage?: string,
  ): Promise<void> {
    const cleaned = cleanupAssistantMemoryText(summaryText)
    const summary = (errorMessage
      ? [cleaned, `错误信息: ${errorMessage}`].filter(Boolean).join('\n')
      : cleaned
    ) || (outcome === 'aborted' ? '(用户中止，未产出完整回复)' : '(无最终文本)')

    try {
      let intentType = inferIntentTypeFromQuery(plainUserQuery || lastUserGoal)
      let intentSummary = plainUserQuery || lastUserGoal
      let intentGoal = plainUserQuery || lastUserGoal
      let intentSource: 'llm' | 'heuristic' = 'heuristic'

      try {
        const inferred = await inferIntentFromBackground(
          workspace?.trim() ?? '',
          plainUserQuery || lastUserGoal,
          projectId,
          {
            usageTotalTokens: lastUsage?.totalTokens,
            logScope,
          },
        )
        intentType = inferred.intentType || intentType
        intentSummary = inferred.intentSummary || intentSummary
        intentGoal = inferred.intentGoal || intentGoal
        intentSource = inferred.intentSource || intentSource
      } catch (err) {
        log('CHAT_TASK_MEMORY_INTENT_INFER_FAIL', {
          error: err instanceof Error ? err.message : String(err),
        }, logScope)
      }

      await recordTaskLog(
        workspace?.trim() ?? '',
        {
          goal: plainUserQuery || lastUserGoal || '(未提取到用户提问)',
          userQuery: plainUserQuery || lastUserGoal,
          ...(userAssetsBlock ? { userAssetsBlock } : {}),
          intentType,
          intentSummary,
          intentGoal,
          summary,
          outcome,
          tools: [],
          changedFiles: [],
          identifiers: [],
          failures: errorMessage ? [errorMessage] : [],
        },
        projectId,
      )
      try {
        await maintainTaskMemoriesByAI(workspace?.trim() ?? '', projectId, {
          provider: provider as ProviderKey,
          overrides: overrides as ProviderOverrides | undefined,
          usageTotalTokens: lastUsage?.totalTokens,
          maxTokens,
          logScope,
        })
      } catch (maintainErr) {
        log('CHAT_TASK_MEMORY_MAINTAIN_FAIL', {
          error: maintainErr instanceof Error ? maintainErr.message : String(maintainErr),
        }, logScope)
      }
      log('CHAT_TASK_MEMORY_SAVED', {
        outcome,
        hasGoal: Boolean(plainUserQuery || lastUserGoal),
        intentType,
        intentSource,
        summaryLength: summary.length,
      }, logScope)

      try {
        const scored = await applyRewardScore({
          channel: 'chat',
          outcome,
          workspace,
          projectId,
          requestId,
          failures: errorMessage ? 1 : 0,
          elapsedMs: Math.max(0, Date.now() - turnStartedAt),
        })
        log('REWARD_SCORE_APPLIED', {
          channel: 'chat',
          outcome,
          delta: scored.delta,
          points: scored.state.points,
          debtUsd: scored.state.debtUsd,
          breakdown: scored.entry.breakdown,
        }, logScope)
      } catch (scoreErr) {
        log('REWARD_SCORE_APPLY_FAIL', {
          channel: 'chat',
          error: scoreErr instanceof Error ? scoreErr.message : String(scoreErr),
        }, logScope)
      }
    } catch (err) {
      log('CHAT_TASK_MEMORY_SAVE_FAIL', {
        error: err instanceof Error ? err.message : String(err),
      }, logScope)
    }
  }

  chatAbortControllers.set(requestId, abortController)

  try {
    for await (const chunk of requestChatCompletionStream(
      provider as ProviderKey,
      messages,
      overrides as ProviderOverrides | undefined,
      abortController.signal,
      logScope,
      (usage) => {
        lastUsage = usage
      },
    )) {
      rawAssistantFullText += chunk
      const sanitizedFull = sanitizeUserFacingText(rawAssistantFullText)
      const safeLen = Math.max(0, sanitizedFull.length - STREAM_SANITIZE_HOLD_BACK)
      const visibleText = sanitizedFull.slice(0, safeLen)
      const delta = visibleText.slice(emittedSanitizedText.length)
      emittedSanitizedText = visibleText
      assistantFullText = visibleText
      if (event.sender.isDestroyed()) return
      if (delta) {
        event.sender.send(IpcChannel.CHAT_CHUNK, { requestId, chunk: delta, done: false })
      }
    }
    const finalSanitized = sanitizeUserFacingText(rawAssistantFullText)
    const tailDelta = finalSanitized.slice(emittedSanitizedText.length)
    assistantFullText = finalSanitized
    if (tailDelta && !event.sender.isDestroyed()) {
      event.sender.send(IpcChannel.CHAT_CHUNK, { requestId, chunk: tailDelta, done: false })
    }
    if (!event.sender.isDestroyed()) {
      event.sender.send(IpcChannel.CHAT_CHUNK, { requestId, chunk: '', done: true, usage: lastUsage })
    }
    await persistChatTurnMemory('success', assistantFullText)
  } catch (error) {
    const aborted = abortController.signal.aborted || (error instanceof Error && error.name === 'AbortError')
    if (aborted) {
      if (!event.sender.isDestroyed()) {
        event.sender.send(IpcChannel.CHAT_CHUNK, { requestId, chunk: '', done: true, usage: lastUsage })
      }
      await persistChatTurnMemory('aborted', assistantFullText)
      return
    }
    if (!event.sender.isDestroyed()) {
      event.sender.send(IpcChannel.CHAT_CHUNK, {
        requestId,
        chunk: '',
        done: true,
        error: error instanceof Error ? error.message : 'Stream failed'
      })
    }
    await persistChatTurnMemory('error', assistantFullText, error instanceof Error ? error.message : 'Stream failed')
  } finally {
    chatAbortControllers.delete(requestId)
    restoreSkillEnv()
  }
}

async function handleGuiPlusGet(): Promise<GuiPlusConfig> {
  return await getGuiPlusConfig()
}

async function handleGuiPlusSave(_event: IpcMainInvokeEvent, config: GuiPlusConfig): Promise<void> {
  await saveGuiPlusConfig(config)
}

async function handlePromptConfigGet(): Promise<PromptConfig> {
  return await getPromptConfig()
}

async function handlePromptConfigSave(_event: IpcMainInvokeEvent, config: PromptConfig): Promise<PromptConfig> {
  return await savePromptConfig(config)
}

async function handleAppNotify(_event: IpcMainInvokeEvent, payload: AppNotifyPayload): Promise<boolean> {
  if (!Notification.isSupported()) return false
  const title = payload.title?.trim() || 'Taco AI'
  const body = payload.body?.trim() || '任务执行完成'
  const notification = new Notification({
    title,
    body,
    silent: payload.silent ?? false,
  })
  notification.show()
  return true
}

async function handleMobileBridgeGet(): Promise<MobileBridgeConfig> {
  return await getMobileBridgeConfig()
}

async function handleMobileBridgeSet(_event: IpcMainInvokeEvent, config: MobileBridgeConfig): Promise<MobileBridgeConfig> {
  return await setMobileBridgeConfig(config)
}

function handleMobileBridgeSyncContext(_event: IpcMainEvent, snapshot: MobileBridgeContextSnapshot): void {
  updateMobileBridgeContext(snapshot)
}

/* ── Chat abort 管理 ── */
/** 当前正在运行的 chat 流式 AbortController 集合：requestId → AbortController */
const chatAbortControllers = new Map<string, AbortController>()

/* ── Agent abort 管理 ── */
/** 当前正在运行的 agent AbortController 集合：requestId → AbortController */
const agentAbortControllers = new Map<string, AbortController>()

/** Agent 流式：renderer send → main on → 多轮工具调用循环 → 逐事件推送 */
async function handleAgentStream(event: IpcMainEvent, payload: AgentStreamPayload) {
  const { requestId, provider, messages, overrides, workspace, maxTokens, images, projectId, recallDebug } = payload
  const logScope = buildLogScope(projectId, workspace)

  // ── 图片预处理：保存到本地文件，将路径告知 AI，由 AI 决定如何分析 ──
  if (images && images.length > 0) {
    try {
      const savedPaths: string[] = []
      for (const dataUrl of images) {
        const filePath = await saveScreenshot(dataUrl)
        savedPaths.push(filePath)
        log('IMAGE_SAVED', { filePath }, logScope)
      }

      // 将图片路径注入最后一条用户消息
      const lastUserIdx = messages.length - 1
      if (lastUserIdx >= 0 && messages[lastUserIdx].role === 'user') {
        const originalContent = String(messages[lastUserIdx].content ?? '')
        const baseContent = stripUserAssetsBlock(originalContent)
        const assetsBlock = buildUserAssetsBlock(savedPaths)
        const mergedContent = baseContent ? `${baseContent}\n\n${assetsBlock}` : assetsBlock
        messages[lastUserIdx] = {
          ...messages[lastUserIdx],
          content: mergedContent,
        }
      }
    } catch (imgErr) {
      log('IMAGE_PROCESS_FAIL', { error: imgErr instanceof Error ? imgErr.message : String(imgErr) }, logScope)
    }
  }

  // 创建 AbortController 以支持外部终止
  const abortController = new AbortController()
  agentAbortControllers.set(requestId, abortController)

  try {
    await runAgent(
      provider as ProviderKey,
      messages,
      overrides as ProviderOverrides | undefined,
      workspace,
      (agentEvent) => {
        if (event.sender.isDestroyed()) return
        event.sender.send(IpcChannel.AGENT_EVENT, { requestId, ...agentEvent })
      },
      maxTokens,
      abortController.signal,
      projectId,
      logScope,
      Boolean(recallDebug),
    )
  } finally {
    agentAbortControllers.delete(requestId)
  }
}

/** 终止正在运行的 agent */
function handleAgentAbort(_event: IpcMainEvent, requestId: string) {
  const controller = agentAbortControllers.get(requestId)
  if (controller) {
    controller.abort()
    agentAbortControllers.delete(requestId)
  }
}

/** 终止正在运行的 chat 流式请求 */
function handleChatAbort(_event: IpcMainEvent, requestId: string) {
  const controller = chatAbortControllers.get(requestId)
  if (controller) {
    controller.abort()
    chatAbortControllers.delete(requestId)
  }
}

/** 用户对风险操作的确认/拒绝响应 */
function handleAgentConfirm(_event: IpcMainEvent, payload: AgentConfirmPayload) {
  resolveConfirm(payload.confirmId, payload.approved)
}

/** 目录选择对话框 */
async function handleSelectDirectory(event: IpcMainInvokeEvent): Promise<string | null> {
  const win = BrowserWindow.fromWebContents(event.sender)
  const result = await dialog.showOpenDialog(win!, {
    title: '选择工作空间目录',
    properties: ['openDirectory'],
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
}

/** 用编辑器打开文件 */
async function handleOpenInEditor(_event: IpcMainInvokeEvent, filePath: string, editor: EditorId): Promise<void> {
  const entry = editorCommands[editor]
  if (!entry) throw new Error(`Unknown editor: ${editor}`)

  let cmd: string
  if (process.platform === 'darwin') {
    // macOS: 用 open -a 通过应用名打开，不依赖 CLI 是否在 PATH 中
    cmd = editor === 'system'
      ? `open "${filePath}"`
      : `open -a "${entry.macApp}" "${filePath}"`
  } else if (process.platform === 'win32') {
    cmd = editor === 'system'
      ? `start "" "${filePath}"`
      : `"${entry.cli}" "${filePath}"`
  } else {
    // Linux
    cmd = editor === 'system'
      ? `xdg-open "${filePath}"`
      : `${entry.cli} "${filePath}"`
  }

  return new Promise((resolve, reject) => {
    exec(cmd, (err) => {
      if (err) reject(new Error(`打开文件失败: ${err.message}`))
      else resolve()
    })
  })
}

/* ------------------------------------------------------------------ */
/*  Workspace tree — 读取工作空间目录结构                                */
/* ------------------------------------------------------------------ */

const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '.DS_Store',
  '__pycache__', '.cache', 'coverage', '.idea', '.vscode',
  '.next', '.nuxt', '.output', '.dart_tool', '.turbo',
  'dist', 'build', 'out', 'target', '.gradle', 'Pods', 'DerivedData',
])

import type { FileTreeEntry } from '../shared/ipc'

const WORKSPACE_TREE_MAX_DEPTH = 8
const WORKSPACE_TREE_MAX_ENTRIES = 12_000
const WORKSPACE_TREE_MAX_CHILDREN_PER_DIR = 1_500
const WORKSPACE_TREE_CACHE_TTL_MS = 1_500

type WorkspaceTreeReadState = {
  visited: number
  truncated: boolean
}

const workspaceTreeCache = new Map<string, { at: number; tree: FileTreeEntry[] }>()
const workspaceTreeInFlight = new Map<string, Promise<FileTreeEntry[]>>()

async function readWorkspaceTree(
  dir: string,
  basePath = '',
  depth = 0,
  maxDepth = WORKSPACE_TREE_MAX_DEPTH,
  state?: WorkspaceTreeReadState,
): Promise<FileTreeEntry[]> {
  const active = state ?? { visited: 0, truncated: false }
  if (depth > maxDepth || active.truncated) return []
  let entries: Dirent<string>[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true, encoding: 'utf8' })
  } catch { return [] }

  const sortedEntries = entries
    .filter((entry) => !EXCLUDED_DIRS.has(entry.name))
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    .slice(0, WORKSPACE_TREE_MAX_CHILDREN_PER_DIR)

  const result: FileTreeEntry[] = []
  for (const entry of sortedEntries) {
    if (active.truncated) break
    if (active.visited >= WORKSPACE_TREE_MAX_ENTRIES) {
      active.truncated = true
      break
    }
    const relPath = basePath ? `${basePath}/${entry.name}` : entry.name
    active.visited++

    if (entry.isDirectory()) {
      const children = await readWorkspaceTree(
        nodePath.join(dir, entry.name), relPath, depth + 1, maxDepth, active,
      )
      result.push({ name: entry.name, path: relPath, isDirectory: true, children })
    } else {
      result.push({ name: entry.name, path: relPath, isDirectory: false })
    }
  }
  return result
}

async function getWorkspaceTree(cwd: string): Promise<FileTreeEntry[]> {
  const resolved = nodePath.resolve(String(cwd ?? '').trim() || '.')
  const now = Date.now()
  const cached = workspaceTreeCache.get(resolved)
  if (cached && (now - cached.at) <= WORKSPACE_TREE_CACHE_TTL_MS) {
    return cached.tree
  }

  const running = workspaceTreeInFlight.get(resolved)
  if (running) return running

  const state: WorkspaceTreeReadState = { visited: 0, truncated: false }
  const task = readWorkspaceTree(resolved, '', 0, WORKSPACE_TREE_MAX_DEPTH, state)
    .then((tree) => {
      workspaceTreeCache.set(resolved, { at: Date.now(), tree })
      if (state.truncated) {
        log('WORKSPACE_TREE_TRUNCATED', {
          workspace: resolved,
          maxDepth: WORKSPACE_TREE_MAX_DEPTH,
          maxEntries: WORKSPACE_TREE_MAX_ENTRIES,
        })
      }
      return tree
    })
    .finally(() => {
      workspaceTreeInFlight.delete(resolved)
    })

  workspaceTreeInFlight.set(resolved, task)
  return task
}

/* ------------------------------------------------------------------ */
/*  Workspace watcher — 监听工作区文件系统变化并通知渲染进程                */
/* ------------------------------------------------------------------ */

let activeWatcher: FSWatcher | null = null
let activeWatchPath: string | null = null
let watchDebounce: ReturnType<typeof setTimeout> | null = null

function startWatching(cwd: string, win: BrowserWindow) {
  stopWatching()
  activeWatchPath = nodePath.resolve(cwd)
  try {
    activeWatcher = fsWatch(activeWatchPath, { recursive: true }, (_eventType, filename) => {
      // 过滤掉不需要关注的目录变化
      if (filename) {
        const top = filename.toString().split(/[/\\]/)[0]
        if (EXCLUDED_DIRS.has(top)) return
      }
      // 防抖：多次变化合并为一次通知
      if (watchDebounce) clearTimeout(watchDebounce)
      watchDebounce = setTimeout(() => {
        watchDebounce = null
        if (activeWatchPath) workspaceTreeCache.delete(activeWatchPath)
        if (!win.isDestroyed()) {
          win.webContents.send(IpcChannel.WORKSPACE_CHANGED)
        }
      }, 160)
    })
  } catch (err) {
    console.error('工作区文件监听启动失败:', err)
  }
}

function stopWatching() {
  if (watchDebounce) { clearTimeout(watchDebounce); watchDebounce = null }
  if (activeWatcher) { activeWatcher.close(); activeWatcher = null }
  activeWatchPath = null
}

/* ------------------------------------------------------------------ */
/*  File revert / delete — 撤销 Agent 文件变更                          */
/* ------------------------------------------------------------------ */

/** 将文件内容恢复为旧内容（也用于恢复被删除的文件，会自动创建目录） */
async function handleFileRevert(_event: IpcMainInvokeEvent, filePath: string, oldContent: string): Promise<void> {
  try {
    // 确保父目录存在（文件或目录可能已被删除）
    const dir = nodePath.dirname(filePath)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(filePath, oldContent, 'utf-8')
  } catch (err: unknown) {
    // 其他错误正常抛出
    throw err
  }
}

/** 删除文件（撤销新建） */
async function handleFileDelete(_event: IpcMainInvokeEvent, filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath)
  } catch (err: unknown) {
    // 文件不存在时忽略（可能已被手动删除）
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
}

/* ------------------------------------------------------------------ */
/*  File read / write — 读取和写入文件内容                               */
/* ------------------------------------------------------------------ */

/** 检测是否为二进制内容（含 NUL 字节） */
function isBinaryBuffer(buf: Buffer): boolean {
  // 检查前 8192 字节
  const len = Math.min(buf.length, 8192)
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

const FILE_READ_HARD_LIMIT = 5 * 1024 * 1024
const LARGE_TEXT_PREVIEW_BYTES = 1024 * 1024
const LARGE_TEXT_PREVIEW_EXTS = new Set([
  '.log', '.txt', '.md', '.mdx', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.xml', '.csv', '.tsv', '.sql', '.sh', '.bash', '.zsh', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.hpp', '.php', '.rb', '.swift', '.kt', '.kts',
  '.env',
])

function isLargeTextPreviewPath(filePath: string): boolean {
  const ext = nodePath.extname(filePath).toLowerCase()
  if (LARGE_TEXT_PREVIEW_EXTS.has(ext)) return true
  const base = nodePath.basename(filePath).toLowerCase()
  return base === '.env' || base.endsWith('.log')
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

async function readUtf8Tail(filePath: string, size: number, maxBytes: number): Promise<string> {
  const start = Math.max(0, size - maxBytes)
  const length = Math.max(0, size - start)
  if (length === 0) return ''
  const fh = await fs.open(filePath, 'r')
  try {
    const buf = Buffer.alloc(length)
    await fh.read(buf, 0, length, start)
    return buf.toString('utf-8')
  } finally {
    await fh.close()
  }
}

function imageMimeFromPath(filePath: string): string | null {
  const ext = nodePath.extname(filePath).toLowerCase()
  const m: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
  }
  return m[ext] ?? null
}

/** 读取文件内容，返回文本内容或标记为二进制（图片可附带 dataUrl 预览） */
async function handleFileRead(
  _event: IpcMainInvokeEvent, filePath: string,
): Promise<{ content: string | null; size: number; isBinary: boolean; dataUrl?: string; truncated?: boolean }> {
  const stat = await fs.stat(filePath)
  const size = stat.size
  const imageMime = imageMimeFromPath(filePath)

  // 超过 5MB 不读取内容
  if (size > FILE_READ_HARD_LIMIT) {
    if (!imageMime && isLargeTextPreviewPath(filePath)) {
      const preview = await readUtf8Tail(filePath, size, LARGE_TEXT_PREVIEW_BYTES)
      const notice = `[文件较大，已加载尾部预览：${formatBytes(LARGE_TEXT_PREVIEW_BYTES)} / ${formatBytes(size)}]\n\n`
      return { content: `${notice}${preview}`, size, isBinary: false, truncated: true }
    }
    return { content: null, size, isBinary: true }
  }

  const buf = Buffer.from(await fs.readFile(filePath))
  if (isBinaryBuffer(buf)) {
    if (imageMime) {
      return {
        content: null,
        size,
        isBinary: true,
        dataUrl: `data:${imageMime};base64,${buf.toString('base64')}`,
      }
    }
    return { content: null, size, isBinary: true }
  }

  const text = buf.toString('utf-8')
  if (imageMime === 'image/svg+xml') {
    return {
      content: text,
      size,
      isBinary: false,
      dataUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`,
    }
  }
  return { content: text, size, isBinary: false }
}

/** 写入文件内容 */
async function handleFileWrite(
  _event: IpcMainInvokeEvent, filePath: string, content: string,
): Promise<void> {
  // 确保父目录存在
  const dir = nodePath.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(filePath, content, 'utf-8')
}

/* Terminal handlers imported from ./terminal.ts */

/* ------------------------------------------------------------------ */
/*  Window drag — 手动拖拽以支持自定义光标                               */
/* ------------------------------------------------------------------ */

/** 记录每个窗口的拖拽起始偏移 */
const dragState = new Map<number, { offsetX: number; offsetY: number }>()

function handleWindowDragStart(event: IpcMainEvent, pos: { screenX: number; screenY: number }) {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  const [winX, winY] = win.getPosition()
  dragState.set(win.id, {
    offsetX: pos.screenX - winX,
    offsetY: pos.screenY - winY,
  })
}

function handleWindowDragging(event: IpcMainEvent, pos: { screenX: number; screenY: number }) {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  const state = dragState.get(win.id)
  if (!state) return
  win.setPosition(pos.screenX - state.offsetX, pos.screenY - state.offsetY)
}

function handleWindowDragEnd(event: IpcMainEvent) {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  dragState.delete(win.id)
}

function handleWindowToggleMaximize(event: IpcMainEvent) {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  if (win.isMaximized()) win.unmaximize()
  else win.maximize()
}

function handleWindowMinimize(event: IpcMainEvent) {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  win.minimize()
}

function handleWindowClose(event: IpcMainEvent) {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  win.close()
}

/* ------------------------------------------------------------------ */
/*  Registration                                                       */
/* ------------------------------------------------------------------ */

/** 注册全部 IPC handler，应在 app.whenReady() 之后调用一次 */
export function registerIpcHandlers() {
  ipcMain.handle(IpcChannel.CHAT_SEND, handleChatSend)
  ipcMain.handle(IpcChannel.SELECT_DIRECTORY, handleSelectDirectory)
  ipcMain.handle(IpcChannel.OPEN_IN_EDITOR, handleOpenInEditor)
  ipcMain.handle(IpcChannel.OPEN_LOG_DIR, (_e, scope?: { projectId?: string; workspace?: string }) => {
    const logScope = buildLogScope(scope?.projectId, scope?.workspace)
    return shell.openPath(getLogDir(logScope))
  })
  ipcMain.handle(IpcChannel.APP_GET_VERSION, () => app.getVersion())
  ipcMain.handle(IpcChannel.APP_NOTIFY, handleAppNotify)
  ipcMain.handle(IpcChannel.MOBILE_BRIDGE_GET, handleMobileBridgeGet)
  ipcMain.handle(IpcChannel.MOBILE_BRIDGE_SET, handleMobileBridgeSet)
  ipcMain.on(IpcChannel.MOBILE_BRIDGE_SYNC_CONTEXT, handleMobileBridgeSyncContext)
  ipcMain.handle(IpcChannel.GUI_PLUS_GET, handleGuiPlusGet)
  ipcMain.handle(IpcChannel.GUI_PLUS_SAVE, handleGuiPlusSave)
  ipcMain.handle(IpcChannel.PROMPT_CONFIG_GET, handlePromptConfigGet)
  ipcMain.handle(IpcChannel.PROMPT_CONFIG_SAVE, handlePromptConfigSave)
  ipcMain.handle(IpcChannel.FILE_REVERT, handleFileRevert)
  ipcMain.handle(IpcChannel.FILE_DELETE, handleFileDelete)
  ipcMain.handle(IpcChannel.FILE_READ, handleFileRead)
  ipcMain.handle(IpcChannel.FILE_WRITE, handleFileWrite)
  ipcMain.on(IpcChannel.CHAT_STREAM, handleChatStream)
  ipcMain.on(IpcChannel.CHAT_ABORT, handleChatAbort)
  ipcMain.on(IpcChannel.AGENT_STREAM, handleAgentStream)
  ipcMain.on(IpcChannel.AGENT_CONFIRM, handleAgentConfirm)
  ipcMain.on(IpcChannel.AGENT_ABORT, handleAgentAbort)
  ipcMain.on(IpcChannel.AGENT_AUTO_APPROVE, (_e, categories: RiskCategory[]) => {
    setAutoApproveCategories(categories)
  })

  // 终端
  ipcMain.on(IpcChannel.TERMINAL_SPAWN, handleTerminalSpawn)
  ipcMain.on(IpcChannel.TERMINAL_INPUT, handleTerminalInput)
  ipcMain.on(IpcChannel.TERMINAL_RESIZE, handleTerminalResize)
  ipcMain.on(IpcChannel.TERMINAL_KILL, handleTerminalKill)

  // 工作区目录树
  ipcMain.handle(IpcChannel.WORKSPACE_TREE, (_e, cwd: string) => getWorkspaceTree(cwd))

  // 工作区文件监听
  ipcMain.on(IpcChannel.WORKSPACE_WATCH, (e, cwd: string) => {
    const senderWin = BrowserWindow.fromWebContents(e.sender)
    if (senderWin) startWatching(cwd, senderWin)
  })
  ipcMain.on(IpcChannel.WORKSPACE_UNWATCH, () => {
    stopWatching()
  })

  // Git 版本控制
  ipcMain.handle(IpcChannel.GIT_LOG, (_e, cwd: string) => gitLog(cwd))
  ipcMain.handle(IpcChannel.GIT_STATUS, (_e, cwd: string) => gitStatus(cwd))
  ipcMain.handle(IpcChannel.GIT_FILE_CHANGE, (_e, cwd: string, filePath: string) => gitFileChange(cwd, filePath))
  ipcMain.handle(IpcChannel.GIT_COMMIT, (_e, cwd: string, msg: string) => gitCommit(cwd, msg))
  ipcMain.handle(IpcChannel.GIT_STAGE_FILES, (_e, cwd: string, filePaths: string[]) => gitStageFiles(cwd, filePaths))
  ipcMain.handle(IpcChannel.GIT_STAGE_ALL, (_e, cwd: string) => gitStageAll(cwd))
  ipcMain.handle(IpcChannel.GIT_ROLLBACK, (_e, cwd: string, hash: string) => gitRollback(cwd, hash))
  ipcMain.handle(IpcChannel.GIT_COMMIT_FILES, (_e, cwd: string, hash: string) => gitCommitFiles(cwd, hash))

  // 窗口手动拖拽
  ipcMain.on(IpcChannel.WINDOW_DRAG_START, handleWindowDragStart)
  ipcMain.on(IpcChannel.WINDOW_DRAGGING, handleWindowDragging)
  ipcMain.on(IpcChannel.WINDOW_DRAG_END, handleWindowDragEnd)
  ipcMain.on(IpcChannel.WINDOW_TOGGLE_MAXIMIZE, handleWindowToggleMaximize)
  ipcMain.on(IpcChannel.WINDOW_MINIMIZE, handleWindowMinimize)
  ipcMain.on(IpcChannel.WINDOW_CLOSE, handleWindowClose)

  // Skills 管理
  initSkills().catch((err) => console.error('Skills 初始化失败:', err))
  ipcMain.handle(IpcChannel.SKILLS_LIST, (_e, workspace?: string) => listSkills(workspace))
  ipcMain.handle(IpcChannel.SKILLS_INSTALL, (_e, source: string) => installSkill(source))
  ipcMain.handle(IpcChannel.SKILLS_UNINSTALL, (_e, id: string) => uninstallSkill(id))
  ipcMain.handle(IpcChannel.SKILLS_TOGGLE, (_e, id: string, enabled: boolean) => toggleSkill(id, enabled))

  // 项目笔记/记忆
  ipcMain.handle(IpcChannel.NOTES_LIST, (_e, workspace: string, projectId?: string) => listNotes(workspace, projectId))
  ipcMain.handle(IpcChannel.NOTES_TASK_MEMORIES_LIST, (_e, workspace: string, projectId?: string) => listTaskMemories(workspace, projectId))
  ipcMain.handle(IpcChannel.NOTES_TASK_MEMORY_DELETE, (_e, workspace: string, memoryId: string, projectId?: string) => deleteTaskMemory(workspace, memoryId, projectId))
  ipcMain.handle(IpcChannel.NOTES_SAVE, (_e, workspace: string, note: ProjectNote, projectId?: string) => saveNote(workspace, note, projectId))
  ipcMain.handle(IpcChannel.NOTES_DELETE, (_e, workspace: string, noteId: string, projectId?: string) => deleteNote(workspace, noteId, projectId))
  ipcMain.handle(IpcChannel.NOTES_STATS, (_e, workspace: string, projectId?: string) => getMemoryScopeStats(workspace, projectId))
  ipcMain.handle(IpcChannel.NOTES_EXPORT, (_e, workspace: string, projectId?: string) => exportMemoryScope(workspace, projectId))

  // 浏览器全局接管设置
  ipcMain.on(IpcChannel.BROWSER_AUTO_TAKEOVER, (_e, enabled: boolean) => {
    setBrowserAutoApproved(enabled)
  })

  // (浏览器操作结果回收 — 已统一使用外部浏览器，不再需要内嵌模式的 IPC 回调)

  // MCP 管理
  initMcp().catch((err) => console.error('MCP 初始化失败:', err))
  ipcMain.handle(IpcChannel.MCP_LIST, () => listMcpServers())
  ipcMain.handle(IpcChannel.MCP_SAVE, (_e, server: McpServerInfo) =>
    saveMcpServer({
      id: server.id,
      name: server.name,
      description: server.description,
      command: server.command,
      args: server.args,
      env: server.env,
      enabled: server.enabled,
      builtin: server.builtin,
    })
  )
  ipcMain.handle(IpcChannel.MCP_REMOVE, (_e, id: string) => removeMcpServer(id))
  ipcMain.handle(IpcChannel.MCP_TOGGLE, (_e, id: string, enabled: boolean) => toggleMcpServer(id, enabled))

  // ── 外部浏览器窗口 (AppId-based 多窗口管理) ──
  ipcMain.handle(IpcChannel.EXTERNAL_BROWSER_OPEN, (_e, url: string, appId?: string) => {
    console.log(`[IPC] EXTERNAL_BROWSER_OPEN: url="${url}", appId="${appId}"`)
    return openExternalBrowser(url, appId)
  })
  ipcMain.handle(IpcChannel.EXTERNAL_BROWSER_CLOSE, (_e, appId?: string) => closeExternalBrowser(appId))
  ipcMain.handle(IpcChannel.EXTERNAL_BROWSER_NAVIGATE, (_e, url: string, appId?: string) => navigateExternalBrowser(url, appId))
  ipcMain.handle(IpcChannel.EXTERNAL_BROWSER_FOCUS, (_e, appId?: string) => focusExternalBrowser(appId))

  // 浏览器模式同步（保留 IPC 监听以防旧版渲染进程发送，不做处理）
  ipcMain.on(IpcChannel.BROWSER_MODE, () => { /* 已统一使用外部浏览器 */ })

  // 移动端桥接：手机端输入指令 -> 推送到渲染进程按当前会话执行
  initMobileBridge(
    (command) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(IpcChannel.MOBILE_BRIDGE_COMMAND, command)
        }
      }
    },
    (selection) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(IpcChannel.MOBILE_BRIDGE_SELECT, selection)
        }
      }
    },
    (abort) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(IpcChannel.MOBILE_BRIDGE_ABORT, abort)
        }
      }
    },
    (confirm) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(IpcChannel.MOBILE_BRIDGE_CONFIRM, confirm)
        }
      }
    },
    (newSession) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(IpcChannel.MOBILE_BRIDGE_NEW_SESSION, newSession)
        }
      }
    },
    (clearSession) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(IpcChannel.MOBILE_BRIDGE_CLEAR_SESSION, clearSession)
        }
      }
    },
  ).catch((err) => {
    console.error('移动端桥接初始化失败:', err)
  })
}
