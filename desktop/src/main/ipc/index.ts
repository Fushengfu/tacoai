/**
 * IPC Handler 注册 - 组装文件
 *
 * 将所有 ipcMain handler 集中管理，main.ts 只需调用 registerIpcHandlers() 即可。
 * 各领域 handler 已拆分到独立模块：
 * - chat-handlers.ts: Chat/Agent 流式处理、聊天存储、通知、配置
 * - bridge-handlers.ts: Bridge 跨端桥接
 */

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { exec } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as fsSync from 'node:fs'
import { watch as fsWatch, type Dirent, type FSWatcher } from 'node:fs'
import * as nodePath from 'node:path'
import { IpcChannel, editorCommands } from '../../shared/ipc'
import type {
  EditorId,
  ProjectNote,
  McpServerInfo,
  BridgeStatusPayload,
} from '../../shared/ipc'
import type { RiskCategory } from '../tools'
import { setBrowserAutoApproved, setAutoApproveCategories } from '../tools'
import { uploadDataUrlToStorage, resolveUploadConfig } from '../ai/llm'
import type { IpcUploadConfig } from '../../shared/ipc'
import { gitLog, gitCommit, gitRollback, gitCommitFiles, gitStatus, gitFileChange, gitStageFiles, gitStageAll } from '../project/git'
import { initSkills, listSkills, installSkill, uninstallSkill, toggleSkill, refreshSkills } from '../project/skills'
import { listNotes, listTaskMemories, saveNote, deleteNote, deleteTaskMemory, getMemoryScopeStats, exportMemoryScope } from '../data/notes'
import { initMcp, listMcpServers, saveMcpServer, removeMcpServer, toggleMcpServer } from '../automation/mcp'
import { getLogDir } from '../system/logger'
import { log, logError } from '../system/logger'
import { handleTerminalSpawn, handleTerminalInput, handleTerminalResize, handleTerminalKill } from '../system/terminal'
import { openExternalBrowser, closeExternalBrowser, navigateExternalBrowser, focusExternalBrowser } from '../automation/browser'
import { loadUploadConfigFromDb, saveUploadConfigToDb } from '../data/memory-db'
import { checkAndPromptForUpdate, getLastUpdateCheckResult } from '../system/app-updater'
import { getBridgeManager } from '../bridge/bridge-manager'
import type { FileTreeEntry } from '../../shared/ipc'

// Import from split modules
import {
  chatAbortControllers,
  agentAbortControllers,
  handleChatSend,
  handleChatStream,
  handleChatAbort,
  handleAgentStream,
  handleAgentConfirm,
  handleAgentAbort,
  handleRendererError,
  handleChatStoreList,
  handleChatStoreLoadPage,
  handleChatStoreSave,
  handleChatStoreDeleteSession,
  handleAppNotify,
  handleGuiPlusGet,
  handleGuiPlusSave,
  handleAppStateGet,
  handleAppStateSaveThreads,
  handleAppStateSaveProviders,
  handlePromptConfigGet,
  handlePromptConfigSave,
} from './chat-handlers'

import {
  handleBridgeConnect,
  handleBridgeDisconnect,
  handleBridgeGetStatus,
  handleBridgeRefreshToken,
  setupBridgeStatusForwarding,
  setupBridgeClientConnectedHandler,
  setupBridgeStateSnapshotResponse,
  setupBridgeDataHandler,
} from './bridge-handlers'

/* ------------------------------------------------------------------ */
/*  Member login/register                                              */
/* ------------------------------------------------------------------ */

import { net } from 'electron'

/** 登录请求通过主进程代理，避免渲染进程直接 fetch 时的 CORS 问题 */
async function handleMemberLogin(_event: IpcMainInvokeEvent, payload: { username: string; password: string }) {
  const LOGIN_URL = 'https://agent.bjctykj.com/api/member/login'
  return new Promise((resolve, reject) => {
    const request = net.request({
      method: 'POST',
      url: LOGIN_URL,
    })
    request.setHeader('Content-Type', 'application/json')
    request.on('response', (response) => {
      let body = ''
      response.on('data', (chunk: Buffer) => { body += chunk.toString() })
      response.on('end', () => {
        try {
          const json = JSON.parse(body)
          if (response.statusCode >= 200 && response.statusCode < 300 && json.data) {
            resolve(json.data)
          } else {
            reject(new Error(json.message || json.error || `登录失败 (${response.statusCode})`))
          }
        } catch {
          reject(new Error(`登录失败 (${response.statusCode})`))
        }
      })
    })
    request.on('error', (err) => reject(err))
    request.write(JSON.stringify(payload))
    request.end()
  })
}

async function handleMemberRegister(_event: IpcMainInvokeEvent, payload: { username: string; password: string; nickname?: string }) {
  const REGISTER_URL = 'https://agent.bjctykj.com/api/member/register'
  return new Promise((resolve, reject) => {
    const request = net.request({
      method: 'POST',
      url: REGISTER_URL,
    })
    request.setHeader('Content-Type', 'application/json')
    request.on('response', (response) => {
      let body = ''
      response.on('data', (chunk: Buffer) => { body += chunk.toString() })
      response.on('end', () => {
        try {
          const json = JSON.parse(body)
          if (response.statusCode >= 200 && response.statusCode < 300 && json.data) {
            resolve(json.data)
          } else {
            reject(new Error(json.message || json.error || `注册失败 (${response.statusCode})`))
          }
        } catch {
          reject(new Error(`注册失败 (${response.statusCode})`))
        }
      })
    })
    request.on('error', (err) => reject(err))
    request.write(JSON.stringify(payload))
    request.end()
  })
}

/* ------------------------------------------------------------------ */
/*  Directory / file dialogs                                           */
/* ------------------------------------------------------------------ */

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

/** 附件选择对话框 */
async function handleSelectAttachments(event: IpcMainInvokeEvent): Promise<string[]> {
  const win = BrowserWindow.fromWebContents(event.sender)
  const result = await dialog.showOpenDialog(win!, {
    title: '选择附件',
    properties: ['openFile', 'multiSelections'],
  })
  if (result.canceled || result.filePaths.length === 0) return []
  return result.filePaths
}

/** 用编辑器打开文件 */
async function handleOpenInEditor(_event: IpcMainInvokeEvent, filePath: string, editor: EditorId): Promise<void> {
  const entry = editorCommands[editor]
  if (!entry) throw new Error(`Unknown editor: ${editor}`)

  let cmd: string
  if (process.platform === 'darwin') {
    cmd = editor === 'system'
      ? `open "${filePath}"`
      : `open -a "${entry.macApp}" "${filePath}"`
  } else if (process.platform === 'win32') {
    cmd = editor === 'system'
      ? `start "" "${filePath}"`
      : `"${entry.cli}" "${filePath}"`
  } else {
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
/*  Workspace tree                                                     */
/* ------------------------------------------------------------------ */

const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '.DS_Store',
  '__pycache__', '.cache', 'coverage', '.idea', '.vscode',
  '.next', '.nuxt', '.output', '.dart_tool', '.turbo',
  'dist', 'build', 'out', 'target', '.gradle', 'Pods', 'DerivedData',
])

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
/*  Workspace watcher                                                  */
/* ------------------------------------------------------------------ */

let activeWatcher: FSWatcher | null = null
let activeWatchPath: string | null = null
let watchDebounce: ReturnType<typeof setTimeout> | null = null

function startWatching(cwd: string, win: BrowserWindow) {
  stopWatching()
  activeWatchPath = nodePath.resolve(cwd)
  try {
    activeWatcher = fsWatch(activeWatchPath, { recursive: true }, (_eventType, filename) => {
      if (filename) {
        const top = filename.toString().split(/[/\\]/)[0]
        if (EXCLUDED_DIRS.has(top)) return
      }
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
/*  File revert / delete                                               */
/* ------------------------------------------------------------------ */

/** 将文件内容恢复为旧内容 */
async function handleFileRevert(_event: IpcMainInvokeEvent, filePath: string, oldContent: string): Promise<void> {
  try {
    const dir = nodePath.dirname(filePath)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(filePath, oldContent, 'utf-8')
  } catch (err: unknown) {
    throw err
  }
}

/** 删除文件（移到回收站） */
async function handleFileDelete(_event: IpcMainInvokeEvent, filePath: string): Promise<void> {
  try {
    await shell.trashItem(filePath)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
}

/** 删除目录（移到回收站） */
async function handleDirectoryDelete(_event: IpcMainInvokeEvent, dirPath: string): Promise<void> {
  try {
    await shell.trashItem(dirPath)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
}

/* ------------------------------------------------------------------ */
/*  File read / write                                                  */
/* ------------------------------------------------------------------ */

function isBinaryBuffer(buf: Buffer): boolean {
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

async function handleFileRead(
  _event: IpcMainInvokeEvent, filePath: string,
): Promise<{ content: string | null; size: number; isBinary: boolean; dataUrl?: string; truncated?: boolean }> {
  const stat = await fs.stat(filePath)
  const size = stat.size
  const imageMime = imageMimeFromPath(filePath)

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
    const previewLen = Math.min(buf.length, 8192)
    const hexPreview = buf.subarray(0, previewLen).toString('hex')
    const lines: string[] = []
    for (let i = 0; i < hexPreview.length; i += 64) {
      lines.push(hexPreview.slice(i, i + 64))
    }
    const hexText = lines.join('\n')
    const hexDataUrl = `data:text/plain;charset=utf-8,${encodeURIComponent(hexText)}`
    return { content: null, size, isBinary: true, dataUrl: hexDataUrl }
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

async function handleFileWrite(
  _event: IpcMainInvokeEvent, filePath: string, content: string,
): Promise<void> {
  const dir = nodePath.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(filePath, content, 'utf-8')
}

/* ------------------------------------------------------------------ */
/*  Window drag                                                        */
/* ------------------------------------------------------------------ */

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
  ipcMain.handle(IpcChannel.MEMBER_LOGIN, handleMemberLogin)
  ipcMain.handle(IpcChannel.MEMBER_REGISTER, handleMemberRegister)
  ipcMain.handle(IpcChannel.CHAT_SEND, handleChatSend)
  ipcMain.handle(IpcChannel.CHAT_STORE_LIST, handleChatStoreList)
  ipcMain.handle(IpcChannel.CHAT_STORE_LOAD_PAGE, handleChatStoreLoadPage)
  ipcMain.handle(IpcChannel.CHAT_STORE_SAVE, handleChatStoreSave)
  ipcMain.handle(IpcChannel.CHAT_STORE_DELETE_SESSION, handleChatStoreDeleteSession)
  ipcMain.handle(IpcChannel.SELECT_DIRECTORY, handleSelectDirectory)
  ipcMain.handle(IpcChannel.SELECT_ATTACHMENTS, handleSelectAttachments)
  ipcMain.handle(IpcChannel.OPEN_IN_EDITOR, handleOpenInEditor)
  ipcMain.handle(IpcChannel.OPEN_LOG_DIR, (_e, scope?: { projectId?: string; workspace?: string }) => {
    return shell.openPath(getLogDir(buildLogScope(scope?.projectId, scope?.workspace)))
  })
  ipcMain.handle(IpcChannel.APP_GET_VERSION, () => app.getVersion())
  ipcMain.handle(IpcChannel.APP_CHECK_UPDATE, (event, manual?: boolean) =>
    checkAndPromptForUpdate({
      manual: Boolean(manual),
      parentWindow: BrowserWindow.fromWebContents(event.sender),
    })
  )
  ipcMain.handle(IpcChannel.APP_GET_UPDATE_STATUS, () => getLastUpdateCheckResult())
  ipcMain.handle(IpcChannel.APP_NOTIFY, handleAppNotify)
  ipcMain.handle(IpcChannel.APP_RENDERER_ERROR, handleRendererError)
  ipcMain.handle(IpcChannel.GUI_PLUS_GET, handleGuiPlusGet)
  ipcMain.handle(IpcChannel.GUI_PLUS_SAVE, handleGuiPlusSave)
  ipcMain.handle(IpcChannel.APP_STATE_GET, handleAppStateGet)
  ipcMain.handle(IpcChannel.APP_STATE_SAVE_THREADS, handleAppStateSaveThreads)
  ipcMain.handle(IpcChannel.APP_STATE_SAVE_PROVIDERS, handleAppStateSaveProviders)
  ipcMain.handle(IpcChannel.PROMPT_CONFIG_GET, handlePromptConfigGet)
  ipcMain.handle(IpcChannel.PROMPT_CONFIG_SAVE, handlePromptConfigSave)
  ipcMain.handle(IpcChannel.FILE_REVERT, handleFileRevert)
  ipcMain.handle(IpcChannel.FILE_DELETE, handleFileDelete)
  ipcMain.handle(IpcChannel.DIRECTORY_DELETE, handleDirectoryDelete)
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

  // 外部浏览器窗口
  ipcMain.handle(IpcChannel.EXTERNAL_BROWSER_OPEN, (_e, url: string, appId?: string) => {
    console.log(`[IPC] EXTERNAL_BROWSER_OPEN: url="${url}", appId="${appId}"`)
    return openExternalBrowser(url, appId)
  })
  ipcMain.handle(IpcChannel.EXTERNAL_BROWSER_CLOSE, (_e, appId?: string) => closeExternalBrowser(appId))
  ipcMain.handle(IpcChannel.EXTERNAL_BROWSER_NAVIGATE, (_e, url: string, appId?: string) => navigateExternalBrowser(url, appId))
  ipcMain.handle(IpcChannel.EXTERNAL_BROWSER_FOCUS, (_e, appId?: string) => focusExternalBrowser(appId))

  ipcMain.on(IpcChannel.BROWSER_MODE, () => { /* 已统一使用外部浏览器 */ })

  // Bridge 跨端桥接
  ipcMain.on(IpcChannel.BRIDGE_CONNECT, handleBridgeConnect)
  ipcMain.on(IpcChannel.BRIDGE_DISCONNECT, handleBridgeDisconnect)
  ipcMain.handle(IpcChannel.BRIDGE_GET_STATUS, handleBridgeGetStatus)
  ipcMain.on(IpcChannel.BRIDGE_REFRESH_TOKEN, handleBridgeRefreshToken)
  setupBridgeStatusForwarding()
  setupBridgeClientConnectedHandler()
  setupBridgeStateSnapshotResponse()
  setupBridgeDataHandler()

  // 图片上传到云存储
  ipcMain.handle(IpcChannel.IMAGE_UPLOAD, async (_event, payload: { dataUrl: string; fileName: string }) => {
    const { dataUrl, fileName } = payload
    let uploadConfig: IpcUploadConfig | null = null
    
    try {
      const dbConfig = loadUploadConfigFromDb()
      
      if (dbConfig && dbConfig.provider !== 'none') {
        log('UPLOAD_CONFIG_LOADED_FROM_DB', { 
          provider: dbConfig.provider,
          updatedAt: dbConfig.updatedAt
        }, 'ipc')
        
        const config = dbConfig.config as any
        
        if (dbConfig.provider === 'aliyun_oss') {
          uploadConfig = {
            provider: 'aliyun_oss',
            accessKeyId: config.aliyunOss?.accessKeyId || '',
            accessKeySecret: config.aliyunOss?.accessKeySecret || '',
            bucket: config.aliyunOss?.bucket || '',
            endpoint: config.aliyunOss?.endpoint || '',
            objectPrefix: config.aliyunOss?.objectPrefix || '',
            publicBaseUrl: config.aliyunOss?.publicBaseUrl || '',
          }
        } else if (dbConfig.provider === 'qiniu') {
          uploadConfig = {
            provider: 'qiniu',
            accessKey: config.qiniu?.accessKey || '',
            secretKey: config.qiniu?.secretKey || '',
            bucket: config.qiniu?.bucket || '',
            uploadUrl: config.qiniu?.uploadUrl || '',
            publicBaseUrl: config.qiniu?.publicBaseUrl || '',
            objectPrefix: config.qiniu?.objectPrefix || '',
            expiresSeconds: config.qiniu?.expiresSeconds ? Number(config.qiniu.expiresSeconds) : undefined,
          }
        }
      } else {
        log('UPLOAD_CONFIG_DB_EMPTY', {}, 'ipc')
        const configPath = nodePath.join(app.getPath('userData'), 'upload-config.json')
        
        if (fsSync.existsSync(configPath)) {
          const raw = fsSync.readFileSync(configPath, 'utf-8')
          const parsed = JSON.parse(raw)
          log('UPLOAD_CONFIG_LOADED_FROM_FILE', { path: configPath, provider: parsed.provider }, 'ipc')
          saveUploadConfigToDb(parsed.provider, parsed)
          log('UPLOAD_CONFIG_MIGRATED_TO_DB', { provider: parsed.provider }, 'ipc')
          
          const migratedConfig = loadUploadConfigFromDb()
          if (migratedConfig && migratedConfig.provider === 'aliyun_oss') {
            const migratedAny = migratedConfig.config as any
            uploadConfig = {
              provider: 'aliyun_oss',
              accessKeyId: migratedAny.aliyunOss?.accessKeyId || '',
              accessKeySecret: migratedAny.aliyunOss?.accessKeySecret || '',
              bucket: migratedAny.aliyunOss?.bucket || '',
              endpoint: migratedAny.aliyunOss?.endpoint || '',
              objectPrefix: migratedAny.aliyunOss?.objectPrefix || '',
              publicBaseUrl: migratedAny.aliyunOss?.publicBaseUrl || '',
            }
          } else if (migratedConfig && migratedConfig.provider === 'qiniu') {
            const migratedAny = migratedConfig.config as any
            uploadConfig = {
              provider: 'qiniu',
              accessKey: migratedAny.qiniu?.accessKey || '',
              secretKey: migratedAny.qiniu?.secretKey || '',
              bucket: migratedAny.qiniu?.bucket || '',
              uploadUrl: migratedAny.qiniu?.uploadUrl || '',
              publicBaseUrl: migratedAny.qiniu?.publicBaseUrl || '',
              objectPrefix: migratedAny.qiniu?.objectPrefix || '',
              expiresSeconds: migratedAny.qiniu?.expiresSeconds ? Number(migratedAny.qiniu.expiresSeconds) : undefined,
            }
          }
        }
      }
    } catch (err) {
      log('UPLOAD_CONFIG_READ_FAIL', { error: err instanceof Error ? err.message : String(err) }, 'ipc')
    }
    
    if (!uploadConfig) {
      throw new Error('未配置云存储,请在设置中配置阿里云OSS或七牛云')
    }
    
    const publicUrl = await uploadDataUrlToStorage(uploadConfig as any, dataUrl)
    log('IMAGE_UPLOADED_FROM_RENDERER', { fileName, publicUrl }, 'ipc')
    return { publicUrl }
  })
  
  // 保存上传配置到数据库
  ipcMain.handle(IpcChannel.UPLOAD_CONFIG_SAVE, async (_event, config: unknown) => {
    try {
      const configAny = config as any
      const provider = configAny?.provider || 'none'
      saveUploadConfigToDb(provider, configAny)
      log('UPLOAD_CONFIG_SAVED_TO_DB', { provider }, 'ipc')
    } catch (err) {
      log('UPLOAD_CONFIG_SAVE_FAIL', { error: err instanceof Error ? err.message : String(err) }, 'ipc')
      throw err
    }
  })
}

function buildLogScope(projectId?: string, workspace?: string): string | undefined {
  if (projectId && projectId.trim()) return `project:${projectId.trim()}`
  if (workspace && workspace.trim()) return `workspace:${nodePath.resolve(workspace.trim())}`
  return undefined
}
