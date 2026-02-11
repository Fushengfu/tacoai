/**
 * IPC Handler 注册
 *
 * 将所有 ipcMain handler 集中管理，main.ts 只需调用 registerIpcHandlers() 即可。
 */

import { BrowserWindow, Notification, dialog, ipcMain, shell } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { exec } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { watch as fsWatch, type FSWatcher } from 'node:fs'
import * as nodePath from 'node:path'
import { IpcChannel, editorCommands } from '../shared/ipc'
import type { AppNotifyPayload, ChatSendPayload, ChatStreamPayload, AgentStreamPayload, AgentConfirmPayload, EditorId, ProjectNote, McpServerInfo, GuiPlusConfig } from '../shared/ipc'
import { setBrowserAutoApproved, setAutoApproveCategories } from './tools'
import type { RiskCategory } from './tools'
import type { ProviderKey, ProviderOverrides } from './llm'
import { requestChatCompletion, requestChatCompletionStream } from './llm'
import { runAgent, resolveConfirm } from './agent'
import { gitLog, gitCommit, gitRollback, gitCommitFiles } from './git'
import { initSkills, listSkills, installSkill, uninstallSkill, toggleSkill } from './skills'
import { listNotes, saveNote, deleteNote } from './notes'
import { initMcp, listMcpServers, saveMcpServer, removeMcpServer, toggleMcpServer, saveScreenshot } from './mcp'
import { getGuiPlusConfig, saveGuiPlusConfig } from './gui-plus'
import { getLogDir } from './logger'
import { log } from './logger'
import { handleTerminalSpawn, handleTerminalInput, handleTerminalResize, handleTerminalKill } from './terminal'
import { openExternalBrowser, closeExternalBrowser, navigateExternalBrowser, focusExternalBrowser } from './browser'

/* ------------------------------------------------------------------ */
/*  Handlers                                                           */
/* ------------------------------------------------------------------ */

function buildLogScope(projectId?: string, workspace?: string): string | undefined {
  if (projectId && projectId.trim()) return `project:${projectId.trim()}`
  if (workspace && workspace.trim()) return `workspace:${nodePath.resolve(workspace.trim())}`
  return undefined
}

/** 非流式：renderer invoke → main handle → 返回完整回复 */
async function handleChatSend(_event: IpcMainInvokeEvent, payload: ChatSendPayload) {
  const logScope = buildLogScope(payload.projectId, undefined)
  return await requestChatCompletion(
    payload.provider as ProviderKey,
    payload.messages,
    payload.overrides as ProviderOverrides | undefined,
    undefined,
    logScope,
  )
}

/** 流式：renderer send → main on → 逐块 send 回 renderer */
async function handleChatStream(event: IpcMainEvent, payload: ChatStreamPayload) {
  const { requestId, provider, messages, overrides, projectId, workspace } = payload
  const logScope = buildLogScope(projectId, workspace)
  const abortController = new AbortController()
  chatAbortControllers.set(requestId, abortController)

  try {
    for await (const chunk of requestChatCompletionStream(
      provider as ProviderKey,
      messages,
      overrides as ProviderOverrides | undefined,
      abortController.signal,
      logScope,
    )) {
      if (event.sender.isDestroyed()) return
      event.sender.send(IpcChannel.CHAT_CHUNK, { requestId, chunk, done: false })
    }
    if (!event.sender.isDestroyed()) {
      event.sender.send(IpcChannel.CHAT_CHUNK, { requestId, chunk: '', done: true })
    }
  } catch (error) {
    const aborted = abortController.signal.aborted || (error instanceof Error && error.name === 'AbortError')
    if (aborted) {
      if (!event.sender.isDestroyed()) {
        event.sender.send(IpcChannel.CHAT_CHUNK, { requestId, chunk: '', done: true })
      }
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
  } finally {
    chatAbortControllers.delete(requestId)
  }
}

async function handleGuiPlusGet(): Promise<GuiPlusConfig> {
  return await getGuiPlusConfig()
}

async function handleGuiPlusSave(_event: IpcMainInvokeEvent, config: GuiPlusConfig): Promise<void> {
  await saveGuiPlusConfig(config)
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

/* ── Chat abort 管理 ── */
/** 当前正在运行的 chat 流式 AbortController 集合：requestId → AbortController */
const chatAbortControllers = new Map<string, AbortController>()

/* ── Agent abort 管理 ── */
/** 当前正在运行的 agent AbortController 集合：requestId → AbortController */
const agentAbortControllers = new Map<string, AbortController>()

/** Agent 流式：renderer send → main on → 多轮工具调用循环 → 逐事件推送 */
async function handleAgentStream(event: IpcMainEvent, payload: AgentStreamPayload) {
  const { requestId, provider, messages, overrides, workspace, maxTokens, images, projectId } = payload
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
        const pathList = savedPaths.map((p, i) => savedPaths.length > 1 ? `  ${i + 1}. ${p}` : p).join('\n')
        const hint = `\n\n[用户附带了${savedPaths.length > 1 ? ` ${savedPaths.length} 张` : ''}图片]\n图片路径:\n${pathList}\n如需分析图片，可先调用 mcp_list_tools 查看 minimax 下 understand_image 的最新 inputSchema，再使用 mcp_call 传入参数。`
        messages[lastUserIdx] = {
          ...messages[lastUserIdx],
          content: messages[lastUserIdx].content + hint,
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
  '__pycache__', '.cache', 'coverage', '.idea',
])

import type { FileTreeEntry } from '../shared/ipc'

async function readWorkspaceTree(
  dir: string, basePath = '', depth = 0, maxDepth = 10,
): Promise<FileTreeEntry[]> {
  if (depth > maxDepth) return []
  let entries: Awaited<ReturnType<typeof fs.readdir>>
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch { return [] }

  const result: FileTreeEntry[] = []
  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry.name)) continue
    const relPath = basePath ? `${basePath}/${entry.name}` : entry.name

    if (entry.isDirectory()) {
      const children = await readWorkspaceTree(
        nodePath.join(dir, entry.name), relPath, depth + 1, maxDepth,
      )
      result.push({ name: entry.name, path: relPath, isDirectory: true, children })
    } else {
      result.push({ name: entry.name, path: relPath, isDirectory: false })
    }
  }
  // 排序：目录在前，文件在后，各自按名称排序
  result.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return result
}

/* ------------------------------------------------------------------ */
/*  Workspace watcher — 监听工作区文件系统变化并通知渲染进程                */
/* ------------------------------------------------------------------ */

let activeWatcher: FSWatcher | null = null
let activeWatchPath: string | null = null
let watchDebounce: ReturnType<typeof setTimeout> | null = null

function startWatching(cwd: string, win: BrowserWindow) {
  stopWatching()
  activeWatchPath = cwd
  try {
    activeWatcher = fsWatch(cwd, { recursive: true }, (_eventType, filename) => {
      // 过滤掉不需要关注的目录变化
      if (filename) {
        const top = filename.toString().split(/[/\\]/)[0]
        if (EXCLUDED_DIRS.has(top)) return
      }
      // 防抖：多次变化合并为一次通知
      if (watchDebounce) clearTimeout(watchDebounce)
      watchDebounce = setTimeout(() => {
        watchDebounce = null
        if (!win.isDestroyed()) {
          win.webContents.send(IpcChannel.WORKSPACE_CHANGED)
        }
      }, 500)
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

/** 读取文件内容，返回文本内容或标记为二进制 */
async function handleFileRead(
  _event: IpcMainInvokeEvent, filePath: string,
): Promise<{ content: string | null; size: number; isBinary: boolean }> {
  const stat = await fs.stat(filePath)
  const size = stat.size

  // 超过 5MB 不读取内容
  if (size > 5 * 1024 * 1024) {
    return { content: null, size, isBinary: true }
  }

  const buf = Buffer.from(await fs.readFile(filePath))
  if (isBinaryBuffer(buf)) {
    return { content: null, size, isBinary: true }
  }

  return { content: buf.toString('utf-8'), size, isBinary: false }
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
  ipcMain.handle(IpcChannel.APP_NOTIFY, handleAppNotify)
  ipcMain.handle(IpcChannel.GUI_PLUS_GET, handleGuiPlusGet)
  ipcMain.handle(IpcChannel.GUI_PLUS_SAVE, handleGuiPlusSave)
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
  ipcMain.handle(IpcChannel.WORKSPACE_TREE, (_e, cwd: string) => readWorkspaceTree(cwd))

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
  ipcMain.handle(IpcChannel.GIT_COMMIT, (_e, cwd: string, msg: string) => gitCommit(cwd, msg))
  ipcMain.handle(IpcChannel.GIT_ROLLBACK, (_e, cwd: string, hash: string) => gitRollback(cwd, hash))
  ipcMain.handle(IpcChannel.GIT_COMMIT_FILES, (_e, cwd: string, hash: string) => gitCommitFiles(cwd, hash))

  // 窗口手动拖拽
  ipcMain.on(IpcChannel.WINDOW_DRAG_START, handleWindowDragStart)
  ipcMain.on(IpcChannel.WINDOW_DRAGGING, handleWindowDragging)
  ipcMain.on(IpcChannel.WINDOW_DRAG_END, handleWindowDragEnd)
  ipcMain.on(IpcChannel.WINDOW_TOGGLE_MAXIMIZE, handleWindowToggleMaximize)

  // Skills 管理
  initSkills().catch((err) => console.error('Skills 初始化失败:', err))
  ipcMain.handle(IpcChannel.SKILLS_LIST, () => listSkills())
  ipcMain.handle(IpcChannel.SKILLS_INSTALL, (_e, source: string) => installSkill(source))
  ipcMain.handle(IpcChannel.SKILLS_UNINSTALL, (_e, id: string) => uninstallSkill(id))
  ipcMain.handle(IpcChannel.SKILLS_TOGGLE, (_e, id: string, enabled: boolean) => toggleSkill(id, enabled))

  // 项目笔记/记忆
  ipcMain.handle(IpcChannel.NOTES_LIST, (_e, workspace: string, projectId?: string) => listNotes(workspace, projectId))
  ipcMain.handle(IpcChannel.NOTES_SAVE, (_e, workspace: string, note: ProjectNote, projectId?: string) => saveNote(workspace, note, projectId))
  ipcMain.handle(IpcChannel.NOTES_DELETE, (_e, workspace: string, noteId: string, projectId?: string) => deleteNote(workspace, noteId, projectId))

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
}
