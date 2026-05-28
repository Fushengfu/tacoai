/**
 * IPC Handler 注册 - 组装文件
 *
 * 将所有 ipcMain handler 集中管理，main.ts 只需调用 registerIpcHandlers() 即可。
 * 各领域 handler 已拆分到独立模块：
 * - chat-handlers.ts: Chat/Agent 流式处理、聊天存储、通知、配置
 * - bridge-handlers.ts: Bridge 跨端桥接
 * - member-handlers.ts: 会员登录/注册
 * - gateway-handlers.ts: AI 网关模型列表
 * - file-handlers.ts: 文件读写/删除/选择对话框/打开编辑器
 * - workspace-handlers.ts: 工作区目录树和文件监听
 * - window-handlers.ts: 窗口拖拽/最小化/最大化/关闭
 * - upload-handlers.ts: 图片上传到云存储
 */

import { app, BrowserWindow, ipcMain, shell } from 'electron'
import type { IpcMainEvent } from 'electron'
import { IpcChannel } from '../../shared/ipc'
import type {
  EditorId,
  ProjectNote,
  McpServerInfo,
  BridgeStatusPayload,
} from '../../shared/ipc'
import type { RiskCategory } from '../tools'
import { setBrowserAutoApproved, setAutoApproveCategories } from '../tools'
import { gitLog, gitCommit, gitRollback, gitCommitFiles, gitStatus, gitFileChange, gitStageFiles, gitStageAll } from '../project/git'
import { initSkills, listSkills, installSkill, uninstallSkill, toggleSkill, refreshSkills } from '../project/skills'
import { listNotes, listTaskMemories, saveNote, deleteNote, deleteTaskMemory, getMemoryScopeStats, exportMemoryScope } from '../data/notes'
import { initMcp, listMcpServers, saveMcpServer, removeMcpServer, toggleMcpServer } from '../automation/mcp'
import { getLogDir } from '../system/logger'
import { log } from '../system/logger'
import { handleTerminalSpawn, handleTerminalInput, handleTerminalResize, handleTerminalKill } from '../system/terminal'
import { openExternalBrowser, closeExternalBrowser, navigateExternalBrowser, focusExternalBrowser } from '../automation/browser'
import { checkAndPromptForUpdate, getLastUpdateCheckResult } from '../system/app-updater'
import type { FileTreeEntry } from '../../shared/ipc'

// Import from split modules
import {
  agentAbortControllers,
  handleAgentStream,
  handleAgentConfirm,
  handleAgentRetryResponse,
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
} from './handlers/chat-handlers'

import {
  handleBridgeConnect,
  handleBridgeDisconnect,
  handleBridgeGetStatus,
  handleBridgeRefreshToken,
  setupBridgeStatusForwarding,
  setupBridgeClientConnectedHandler,
  setupBridgeStateSnapshotResponse,
  setupBridgeDataHandler,
} from './handlers/bridge-handlers'

import {
  handleMemberLogin,
  handleMemberRegister,
} from './handlers/member-handlers'

import {
  handleGatewayGetModels,
} from './handlers/gateway-handlers'

import {
  handleSelectDirectory,
  handleSelectAttachments,
  handleOpenInEditor,
  handleFileRevert,
  handleFileDelete,
  handleDirectoryDelete,
  handleFileRead,
  handleFileWrite,
} from './handlers/file-handlers'

import {
  handleWorkspaceTree,
  handleWorkspaceWatch,
  handleWorkspaceUnwatch,
} from './handlers/workspace-handlers'

import {
  handleWindowDragStart,
  handleWindowDragging,
  handleWindowDragEnd,
  handleWindowToggleMaximize,
  handleWindowMinimize,
  handleWindowClose,
} from './handlers/window-handlers'

import {
  handleImageUpload,
  handleUploadConfigSave,
} from './handlers/upload-handlers'

/* ------------------------------------------------------------------ */
/*  Registration                                                       */
/* ------------------------------------------------------------------ */

/** 注册全部 IPC handler，应在 app.whenReady() 之后调用一次 */
export function registerIpcHandlers() {
  // Member
  ipcMain.handle(IpcChannel.MEMBER_LOGIN, handleMemberLogin)
  ipcMain.handle(IpcChannel.MEMBER_REGISTER, handleMemberRegister)

  // Gateway
  ipcMain.handle(IpcChannel.GATEWAY_GET_MODELS, handleGatewayGetModels)

  // Chat / Agent
  ipcMain.handle(IpcChannel.CHAT_STORE_LIST, handleChatStoreList)
  ipcMain.handle(IpcChannel.CHAT_STORE_LOAD_PAGE, handleChatStoreLoadPage)
  ipcMain.handle(IpcChannel.CHAT_STORE_SAVE, handleChatStoreSave)
  ipcMain.handle(IpcChannel.CHAT_STORE_DELETE_SESSION, handleChatStoreDeleteSession)
  ipcMain.on(IpcChannel.AGENT_STREAM, handleAgentStream)
  ipcMain.on(IpcChannel.AGENT_CONFIRM, handleAgentConfirm)
  ipcMain.on(IpcChannel.AGENT_RETRY_RESPONSE, handleAgentRetryResponse)
  ipcMain.on(IpcChannel.AGENT_ABORT, handleAgentAbort)
  ipcMain.on(IpcChannel.AGENT_AUTO_APPROVE, (_e, categories: RiskCategory[]) => {
    setAutoApproveCategories(categories)
  })

  // File dialogs
  ipcMain.handle(IpcChannel.SELECT_DIRECTORY, handleSelectDirectory)
  ipcMain.handle(IpcChannel.SELECT_ATTACHMENTS, handleSelectAttachments)
  ipcMain.handle(IpcChannel.OPEN_IN_EDITOR, handleOpenInEditor)

  // File operations
  ipcMain.handle(IpcChannel.FILE_REVERT, handleFileRevert)
  ipcMain.handle(IpcChannel.FILE_DELETE, handleFileDelete)
  ipcMain.handle(IpcChannel.DIRECTORY_DELETE, handleDirectoryDelete)
  ipcMain.handle(IpcChannel.FILE_READ, handleFileRead)
  ipcMain.handle(IpcChannel.FILE_WRITE, handleFileWrite)

  // Workspace
  ipcMain.handle(IpcChannel.WORKSPACE_TREE, handleWorkspaceTree)
  ipcMain.on(IpcChannel.WORKSPACE_WATCH, handleWorkspaceWatch)
  ipcMain.on(IpcChannel.WORKSPACE_UNWATCH, handleWorkspaceUnwatch)

  // Window
  ipcMain.on(IpcChannel.WINDOW_DRAG_START, handleWindowDragStart)
  ipcMain.on(IpcChannel.WINDOW_DRAGGING, handleWindowDragging)
  ipcMain.on(IpcChannel.WINDOW_DRAG_END, handleWindowDragEnd)
  ipcMain.on(IpcChannel.WINDOW_TOGGLE_MAXIMIZE, handleWindowToggleMaximize)
  ipcMain.on(IpcChannel.WINDOW_MINIMIZE, handleWindowMinimize)
  ipcMain.on(IpcChannel.WINDOW_CLOSE, handleWindowClose)

  // App
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

  // Terminal
  ipcMain.on(IpcChannel.TERMINAL_SPAWN, handleTerminalSpawn)
  ipcMain.on(IpcChannel.TERMINAL_INPUT, handleTerminalInput)
  ipcMain.on(IpcChannel.TERMINAL_RESIZE, handleTerminalResize)
  ipcMain.on(IpcChannel.TERMINAL_KILL, handleTerminalKill)

  // Git
  ipcMain.handle(IpcChannel.GIT_LOG, (_e, cwd: string) => gitLog(cwd))
  ipcMain.handle(IpcChannel.GIT_STATUS, (_e, cwd: string) => gitStatus(cwd))
  ipcMain.handle(IpcChannel.GIT_FILE_CHANGE, (_e, cwd: string, filePath: string) => gitFileChange(cwd, filePath))
  ipcMain.handle(IpcChannel.GIT_COMMIT, (_e, cwd: string, msg: string) => gitCommit(cwd, msg))
  ipcMain.handle(IpcChannel.GIT_STAGE_FILES, (_e, cwd: string, filePaths: string[]) => gitStageFiles(cwd, filePaths))
  ipcMain.handle(IpcChannel.GIT_STAGE_ALL, (_e, cwd: string) => gitStageAll(cwd))
  ipcMain.handle(IpcChannel.GIT_ROLLBACK, (_e, cwd: string, hash: string) => gitRollback(cwd, hash))
  ipcMain.handle(IpcChannel.GIT_COMMIT_FILES, (_e, cwd: string, hash: string) => gitCommitFiles(cwd, hash))

  // Skills
  initSkills().catch((err) => console.error('Skills 初始化失败:', err))
  ipcMain.handle(IpcChannel.SKILLS_LIST, (_e, workspace?: string) => listSkills(workspace))
  ipcMain.handle(IpcChannel.SKILLS_INSTALL, (_e, source: string) => installSkill(source))
  ipcMain.handle(IpcChannel.SKILLS_UNINSTALL, (_e, id: string) => uninstallSkill(id))
  ipcMain.handle(IpcChannel.SKILLS_TOGGLE, (_e, id: string, enabled: boolean) => toggleSkill(id, enabled))

  // Notes / Memory
  ipcMain.handle(IpcChannel.NOTES_LIST, (_e, workspace: string, projectId?: string) => listNotes(workspace, projectId))
  ipcMain.handle(IpcChannel.NOTES_TASK_MEMORIES_LIST, (_e, workspace: string, projectId?: string) => listTaskMemories(workspace, projectId))
  ipcMain.handle(IpcChannel.NOTES_TASK_MEMORY_DELETE, (_e, workspace: string, memoryId: string, projectId?: string) => deleteTaskMemory(workspace, memoryId, projectId))
  ipcMain.handle(IpcChannel.NOTES_SAVE, (_e, workspace: string, note: ProjectNote, projectId?: string) => saveNote(workspace, note, projectId))
  ipcMain.handle(IpcChannel.NOTES_DELETE, (_e, workspace: string, noteId: string, projectId?: string) => deleteNote(workspace, noteId, projectId))
  ipcMain.handle(IpcChannel.NOTES_STATS, (_e, workspace: string, projectId?: string) => getMemoryScopeStats(workspace, projectId))
  ipcMain.handle(IpcChannel.NOTES_EXPORT, (_e, workspace: string, projectId?: string) => exportMemoryScope(workspace, projectId))

  // Browser auto takeover
  ipcMain.on(IpcChannel.BROWSER_AUTO_TAKEOVER, (_e, enabled: boolean) => {
    setBrowserAutoApproved(enabled)
  })

  // MCP
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

  // External browser
  ipcMain.handle(IpcChannel.EXTERNAL_BROWSER_OPEN, (_e, url: string, appId?: string) => {
    console.log(`[IPC] EXTERNAL_BROWSER_OPEN: url="${url}", appId="${appId}"`)
    return openExternalBrowser(url, appId)
  })
  ipcMain.handle(IpcChannel.EXTERNAL_BROWSER_CLOSE, (_e, appId?: string) => closeExternalBrowser(appId))
  ipcMain.handle(IpcChannel.EXTERNAL_BROWSER_NAVIGATE, (_e, url: string, appId?: string) => navigateExternalBrowser(url, appId))
  ipcMain.handle(IpcChannel.EXTERNAL_BROWSER_FOCUS, (_e, appId?: string) => focusExternalBrowser(appId))

  ipcMain.on(IpcChannel.BROWSER_MODE, () => { /* 已统一使用外部浏览器 */ })

  // Bridge
  ipcMain.on(IpcChannel.BRIDGE_CONNECT, handleBridgeConnect)
  ipcMain.on(IpcChannel.BRIDGE_DISCONNECT, handleBridgeDisconnect)
  ipcMain.handle(IpcChannel.BRIDGE_GET_STATUS, handleBridgeGetStatus)
  ipcMain.on(IpcChannel.BRIDGE_REFRESH_TOKEN, handleBridgeRefreshToken)
  setupBridgeStatusForwarding()
  setupBridgeClientConnectedHandler()
  setupBridgeStateSnapshotResponse()
  setupBridgeDataHandler()

  // Upload
  ipcMain.handle(IpcChannel.IMAGE_UPLOAD, handleImageUpload)
  ipcMain.handle(IpcChannel.UPLOAD_CONFIG_SAVE, handleUploadConfigSave)
}

function buildLogScope(projectId?: string, workspace?: string): string | undefined {
  if (projectId && projectId.trim()) return `project:${projectId.trim()}`
  if (workspace && workspace.trim()) return `workspace:${workspace.trim()}`
  return undefined
}
