import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannel } from '../shared/ipc'
import type {
  ChatSendPayload,
  ChatStreamPayload,
  ChatChunkData,
  AgentStreamPayload,
  AgentEventData,
  EditorId,
  TacoApi,
  SystemInfo,
  ProjectNote,
  McpServerInfo,
  ExternalBrowserStatus,
  GuiPlusConfig,
  AppNotifyPayload,
  MobileBridgeConfig,
  MobileBridgeCommandData,
  MobileBridgeContextSnapshot,
  MobileBridgeSelectData,
  MobileBridgeAbortData,
  MobileBridgeConfirmData,
  MobileBridgeNewSessionData,
  MobileBridgeClearSessionData,
  PromptConfig,
} from '../shared/ipc'

// 沙盒化 preload 无法使用 os 模块，用 process 和环境变量替代
const systemInfo: SystemInfo = {
  platform: process.platform,
  arch: process.arch,
  osVersion: `${process.platform} ${(process as unknown as { getSystemVersion?: () => string }).getSystemVersion?.() ?? ''}`.trim(),
  hostname: process.env.HOSTNAME || process.env.COMPUTERNAME || 'unknown',
  homeDir: process.env.HOME || process.env.USERPROFILE || '~',
  shell: process.env.SHELL || process.env.COMSPEC || 'unknown',
  nodeVersion: process.versions.node,
  electronVersion: process.versions.electron ?? 'unknown',
  locale: Intl.DateTimeFormat().resolvedOptions().locale,
}

function resolveAppVersion(): string {
  const prefix = '--taco-version='
  const arg = process.argv.find((item) => item.startsWith(prefix))
  if (!arg) return '0.0.0'
  const value = arg.slice(prefix.length).trim()
  return value || '0.0.0'
}

let appVersion = resolveAppVersion()
void ipcRenderer.invoke(IpcChannel.APP_GET_VERSION)
  .then((version) => {
    if (typeof version === 'string' && version.trim()) {
      appVersion = version.trim()
    }
  })
  .catch(() => {
    // ignore: fallback to launch argument version
  })

const tacoApi: TacoApi = {
  get version() {
    return appVersion
  },
  system: systemInfo,
  shell: {
    openInEditor: (filePath: string, editor: EditorId) =>
      ipcRenderer.invoke(IpcChannel.OPEN_IN_EDITOR, filePath, editor),
    openLogDir: (scope?: { projectId?: string; workspace?: string }) =>
      ipcRenderer.invoke(IpcChannel.OPEN_LOG_DIR, scope),
    notify: (payload: AppNotifyPayload) =>
      ipcRenderer.invoke(IpcChannel.APP_NOTIFY, payload),
  },
  mobileBridge: {
    getConfig: (): Promise<MobileBridgeConfig> =>
      ipcRenderer.invoke(IpcChannel.MOBILE_BRIDGE_GET),
    setConfig: (config: MobileBridgeConfig): Promise<MobileBridgeConfig> =>
      ipcRenderer.invoke(IpcChannel.MOBILE_BRIDGE_SET, config),
    syncContext: (snapshot: MobileBridgeContextSnapshot) =>
      ipcRenderer.send(IpcChannel.MOBILE_BRIDGE_SYNC_CONTEXT, snapshot),
    onCommand: (callback: (data: MobileBridgeCommandData) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: MobileBridgeCommandData) => callback(data)
      ipcRenderer.on(IpcChannel.MOBILE_BRIDGE_COMMAND, handler)
      return () => {
        ipcRenderer.removeListener(IpcChannel.MOBILE_BRIDGE_COMMAND, handler)
      }
    },
    onSelect: (callback: (data: MobileBridgeSelectData) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: MobileBridgeSelectData) => callback(data)
      ipcRenderer.on(IpcChannel.MOBILE_BRIDGE_SELECT, handler)
      return () => {
        ipcRenderer.removeListener(IpcChannel.MOBILE_BRIDGE_SELECT, handler)
      }
    },
    onAbort: (callback: (data: MobileBridgeAbortData) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: MobileBridgeAbortData) => callback(data)
      ipcRenderer.on(IpcChannel.MOBILE_BRIDGE_ABORT, handler)
      return () => {
        ipcRenderer.removeListener(IpcChannel.MOBILE_BRIDGE_ABORT, handler)
      }
    },
    onConfirm: (callback: (data: MobileBridgeConfirmData) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: MobileBridgeConfirmData) => callback(data)
      ipcRenderer.on(IpcChannel.MOBILE_BRIDGE_CONFIRM, handler)
      return () => {
        ipcRenderer.removeListener(IpcChannel.MOBILE_BRIDGE_CONFIRM, handler)
      }
    },
    onNewSession: (callback: (data: MobileBridgeNewSessionData) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: MobileBridgeNewSessionData) => callback(data)
      ipcRenderer.on(IpcChannel.MOBILE_BRIDGE_NEW_SESSION, handler)
      return () => {
        ipcRenderer.removeListener(IpcChannel.MOBILE_BRIDGE_NEW_SESSION, handler)
      }
    },
    onClearSession: (callback: (data: MobileBridgeClearSessionData) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: MobileBridgeClearSessionData) => callback(data)
      ipcRenderer.on(IpcChannel.MOBILE_BRIDGE_CLEAR_SESSION, handler)
      return () => {
        ipcRenderer.removeListener(IpcChannel.MOBILE_BRIDGE_CLEAR_SESSION, handler)
      }
    },
  },
  chat: {
    send: (payload: ChatSendPayload) =>
      ipcRenderer.invoke(IpcChannel.CHAT_SEND, payload),

    stream: (payload: ChatStreamPayload) =>
      ipcRenderer.send(IpcChannel.CHAT_STREAM, payload),

    abort: (requestId: string) =>
      ipcRenderer.send(IpcChannel.CHAT_ABORT, requestId),

    onChunk: (callback: (data: ChatChunkData) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: ChatChunkData) => callback(data)
      ipcRenderer.on(IpcChannel.CHAT_CHUNK, handler)
      return () => {
        ipcRenderer.removeListener(IpcChannel.CHAT_CHUNK, handler)
      }
    }
  },
  agent: {
    stream: (payload: AgentStreamPayload) =>
      ipcRenderer.send(IpcChannel.AGENT_STREAM, payload),

    onEvent: (callback: (data: AgentEventData) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: AgentEventData) => callback(data)
      ipcRenderer.on(IpcChannel.AGENT_EVENT, handler)
      return () => {
        ipcRenderer.removeListener(IpcChannel.AGENT_EVENT, handler)
      }
    },

    confirmResponse: (confirmId: string, approved: boolean) =>
      ipcRenderer.send(IpcChannel.AGENT_CONFIRM, { confirmId, approved }),

    abort: (requestId: string) =>
      ipcRenderer.send(IpcChannel.AGENT_ABORT, requestId),

    setAutoApprove: (categories: string[]) =>
      ipcRenderer.send(IpcChannel.AGENT_AUTO_APPROVE, categories),
  },
  dialog: {
    selectDirectory: () => ipcRenderer.invoke(IpcChannel.SELECT_DIRECTORY),
  },
  workspace: {
    tree: (cwd: string) =>
      ipcRenderer.invoke(IpcChannel.WORKSPACE_TREE, cwd),
    watch: (cwd: string) =>
      ipcRenderer.send(IpcChannel.WORKSPACE_WATCH, cwd),
    unwatch: () =>
      ipcRenderer.send(IpcChannel.WORKSPACE_UNWATCH),
    onChanged: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on(IpcChannel.WORKSPACE_CHANGED, handler)
      return () => {
        ipcRenderer.removeListener(IpcChannel.WORKSPACE_CHANGED, handler)
      }
    },
  },
  file: {
    revert: (filePath: string, oldContent: string) =>
      ipcRenderer.invoke(IpcChannel.FILE_REVERT, filePath, oldContent),
    delete: (filePath: string) =>
      ipcRenderer.invoke(IpcChannel.FILE_DELETE, filePath),
    read: (filePath: string) =>
      ipcRenderer.invoke(IpcChannel.FILE_READ, filePath),
    write: (filePath: string, content: string) =>
      ipcRenderer.invoke(IpcChannel.FILE_WRITE, filePath, content),
  },
  terminal: {
    spawn: (cwd?: string) =>
      ipcRenderer.send(IpcChannel.TERMINAL_SPAWN, { cwd }),

    input: (data: string) =>
      ipcRenderer.send(IpcChannel.TERMINAL_INPUT, data),

    onOutput: (callback: (data: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: string) => callback(data)
      ipcRenderer.on(IpcChannel.TERMINAL_OUTPUT, handler)
      return () => {
        ipcRenderer.removeListener(IpcChannel.TERMINAL_OUTPUT, handler)
      }
    },

    onExit: (callback: (data: { code: number | null }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { code: number | null }) => callback(data)
      ipcRenderer.on(IpcChannel.TERMINAL_EXIT, handler)
      return () => {
        ipcRenderer.removeListener(IpcChannel.TERMINAL_EXIT, handler)
      }
    },

    resize: (cols: number, rows: number) =>
      ipcRenderer.send(IpcChannel.TERMINAL_RESIZE, { cols, rows }),

    kill: () =>
      ipcRenderer.send(IpcChannel.TERMINAL_KILL),
  },
  git: {
    log: (cwd: string) =>
      ipcRenderer.invoke(IpcChannel.GIT_LOG, cwd),

    status: (cwd: string) =>
      ipcRenderer.invoke(IpcChannel.GIT_STATUS, cwd),

    fileChange: (cwd: string, filePath: string) =>
      ipcRenderer.invoke(IpcChannel.GIT_FILE_CHANGE, cwd, filePath),

    commit: (cwd: string, message: string) =>
      ipcRenderer.invoke(IpcChannel.GIT_COMMIT, cwd, message),

    stageFiles: (cwd: string, filePaths: string[]) =>
      ipcRenderer.invoke(IpcChannel.GIT_STAGE_FILES, cwd, filePaths),

    stageAll: (cwd: string) =>
      ipcRenderer.invoke(IpcChannel.GIT_STAGE_ALL, cwd),

    rollback: (cwd: string, hash: string) =>
      ipcRenderer.invoke(IpcChannel.GIT_ROLLBACK, cwd, hash),

    commitFiles: (cwd: string, hash: string) =>
      ipcRenderer.invoke(IpcChannel.GIT_COMMIT_FILES, cwd, hash),
  },
  skills: {
    list: (workspace?: string) =>
      ipcRenderer.invoke(IpcChannel.SKILLS_LIST, workspace),
    install: (source: string) =>
      ipcRenderer.invoke(IpcChannel.SKILLS_INSTALL, source),
    uninstall: (id: string) =>
      ipcRenderer.invoke(IpcChannel.SKILLS_UNINSTALL, id),
    toggle: (id: string, enabled: boolean) =>
      ipcRenderer.invoke(IpcChannel.SKILLS_TOGGLE, id, enabled),
  },
  notes: {
    list: (workspace: string, projectId?: string) =>
      ipcRenderer.invoke(IpcChannel.NOTES_LIST, workspace, projectId),
    listTaskMemories: (workspace: string, projectId?: string) =>
      ipcRenderer.invoke(IpcChannel.NOTES_TASK_MEMORIES_LIST, workspace, projectId),
    deleteTaskMemory: (workspace: string, memoryId: string, projectId?: string) =>
      ipcRenderer.invoke(IpcChannel.NOTES_TASK_MEMORY_DELETE, workspace, memoryId, projectId),
    save: (workspace: string, note: ProjectNote, projectId?: string) =>
      ipcRenderer.invoke(IpcChannel.NOTES_SAVE, workspace, note, projectId),
    delete: (workspace: string, noteId: string, projectId?: string) =>
      ipcRenderer.invoke(IpcChannel.NOTES_DELETE, workspace, noteId, projectId),
  },
  mcp: {
    list: (): Promise<McpServerInfo[]> =>
      ipcRenderer.invoke(IpcChannel.MCP_LIST),
    save: (server: McpServerInfo): Promise<void> =>
      ipcRenderer.invoke(IpcChannel.MCP_SAVE, server),
    remove: (id: string): Promise<void> =>
      ipcRenderer.invoke(IpcChannel.MCP_REMOVE, id),
    toggle: (id: string, enabled: boolean): Promise<void> =>
      ipcRenderer.invoke(IpcChannel.MCP_TOGGLE, id, enabled),
  },
  window: {
    dragStart: (screenX: number, screenY: number) =>
      ipcRenderer.send(IpcChannel.WINDOW_DRAG_START, { screenX, screenY }),

    dragging: (screenX: number, screenY: number) =>
      ipcRenderer.send(IpcChannel.WINDOW_DRAGGING, { screenX, screenY }),

    dragEnd: () =>
      ipcRenderer.send(IpcChannel.WINDOW_DRAG_END),

    toggleMaximize: () =>
      ipcRenderer.send(IpcChannel.WINDOW_TOGGLE_MAXIMIZE),
    minimize: () =>
      ipcRenderer.send(IpcChannel.WINDOW_MINIMIZE),
    close: () =>
      ipcRenderer.send(IpcChannel.WINDOW_CLOSE),
  },
  browser: {
    onOpenUrl: (callback: (url: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, url: string) => callback(url)
      ipcRenderer.on(IpcChannel.OPEN_URL, handler)
      return () => {
        ipcRenderer.removeListener(IpcChannel.OPEN_URL, handler)
      }
    },
    setAutoTakeover: (enabled: boolean) =>
      ipcRenderer.send(IpcChannel.BROWSER_AUTO_TAKEOVER, enabled),
    setDebugMode: (enabled: boolean) =>
      ipcRenderer.send(IpcChannel.BROWSER_DEBUG_MODE, enabled),
    setHiddenMode: (enabled: boolean) =>
      ipcRenderer.send(IpcChannel.BROWSER_HIDDEN_MODE, enabled),
    openExternal: (url: string, appId?: string) =>
      ipcRenderer.invoke(IpcChannel.EXTERNAL_BROWSER_OPEN, url, appId),
    closeExternal: (appId?: string) =>
      ipcRenderer.invoke(IpcChannel.EXTERNAL_BROWSER_CLOSE, appId),
    navigateExternal: (url: string, appId?: string) =>
      ipcRenderer.invoke(IpcChannel.EXTERNAL_BROWSER_NAVIGATE, url, appId),
    focusExternal: (appId?: string) =>
      ipcRenderer.invoke(IpcChannel.EXTERNAL_BROWSER_FOCUS, appId),
    onExternalStatus: (callback: (status: ExternalBrowserStatus) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: ExternalBrowserStatus) => callback(status)
      ipcRenderer.on(IpcChannel.EXTERNAL_BROWSER_STATUS, handler)
      return () => {
        ipcRenderer.removeListener(IpcChannel.EXTERNAL_BROWSER_STATUS, handler)
      }
    },
  },
  guiPlus: {
    getConfig: (): Promise<GuiPlusConfig> =>
      ipcRenderer.invoke(IpcChannel.GUI_PLUS_GET),
    saveConfig: (config: GuiPlusConfig): Promise<void> =>
      ipcRenderer.invoke(IpcChannel.GUI_PLUS_SAVE, config),
  },
  prompt: {
    getConfig: (): Promise<PromptConfig> =>
      ipcRenderer.invoke(IpcChannel.PROMPT_CONFIG_GET),
    saveConfig: (config: PromptConfig): Promise<PromptConfig> =>
      ipcRenderer.invoke(IpcChannel.PROMPT_CONFIG_SAVE, config),
  }
}

contextBridge.exposeInMainWorld('taco', tacoApi)
