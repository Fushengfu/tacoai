/**
 * IPC 通信协议定义
 *
 * 所有 IPC 通道名称、payload 类型、以及暴露给渲染进程的 API 形状
 * 统一在此文件定义，供 main / preload / renderer 三端共享。
 */

/* ------------------------------------------------------------------ */
/*  Channel names                                                      */
/* ------------------------------------------------------------------ */

export const IpcChannel = {
  /** renderer → main (invoke/handle, 非流式请求) */
  CHAT_SEND: 'chat:send',
  /** renderer → main (send/on, 发起流式请求) */
  CHAT_STREAM: 'chat:stream',
  /** renderer → main (send/on, 终止当前 chat 流式请求) */
  CHAT_ABORT: 'chat:abort',
  /** main → renderer (send/on, 流式数据推送) */
  CHAT_CHUNK: 'chat:chunk',

  /** renderer → main (send/on, 发起 agent 流式请求) */
  AGENT_STREAM: 'agent:stream',
  /** main → renderer (send/on, agent 事件推送) */
  AGENT_EVENT: 'agent:event',
  /** renderer → main (send/on, 用户对风险操作的确认响应) */
  AGENT_CONFIRM: 'agent:confirm',
  /** renderer → main (send/on, 终止当前 agent 执行) */
  AGENT_ABORT: 'agent:abort',

  /** renderer → main (invoke/handle, 选择目录对话框) */
  SELECT_DIRECTORY: 'dialog:select-directory',
  /** renderer → main (invoke/handle, 用编辑器打开文件) */
  OPEN_IN_EDITOR: 'shell:open-in-editor',

  /** renderer → main (invoke/handle, 文件撤销/恢复) */
  FILE_REVERT: 'file:revert',
  /** renderer → main (invoke/handle, 删除新建的文件) */
  FILE_DELETE: 'file:delete',
  /** renderer → main (invoke/handle, 读取文件内容) */
  FILE_READ: 'file:read',
  /** renderer → main (invoke/handle, 写入文件内容) */
  FILE_WRITE: 'file:write',

  /** 终端 — renderer ↔ main 双向通信 */
  TERMINAL_SPAWN: 'terminal:spawn',
  TERMINAL_INPUT: 'terminal:input',
  TERMINAL_OUTPUT: 'terminal:output',
  TERMINAL_RESIZE: 'terminal:resize',
  TERMINAL_KILL: 'terminal:kill',
  TERMINAL_EXIT: 'terminal:exit',

  /** 工作区目录树 */
  WORKSPACE_TREE: 'workspace:tree',
  /** renderer → main, 开始监听工作区文件变化 */
  WORKSPACE_WATCH: 'workspace:watch',
  /** renderer → main, 停止监听工作区文件变化 */
  WORKSPACE_UNWATCH: 'workspace:unwatch',
  /** main → renderer, 工作区文件发生变化 */
  WORKSPACE_CHANGED: 'workspace:changed',

  /** Git 版本控制 */
  GIT_LOG: 'git:log',
  GIT_COMMIT: 'git:commit',
  GIT_ROLLBACK: 'git:rollback',
  GIT_COMMIT_FILES: 'git:commit-files',
  GIT_STATUS: 'git:status',
  GIT_FILE_CHANGE: 'git:file-change',
  GIT_STAGE_FILES: 'git:stage-files',
  GIT_STAGE_ALL: 'git:stage-all',

  /** Skills 管理 */
  SKILLS_LIST: 'skills:list',
  SKILLS_INSTALL: 'skills:install',
  SKILLS_UNINSTALL: 'skills:uninstall',
  SKILLS_TOGGLE: 'skills:toggle',

  /** Agent 自动授权分类设置 */
  AGENT_AUTO_APPROVE: 'agent:auto-approve',

  /** 项目笔记/记忆 */
  NOTES_LIST: 'notes:list',
  NOTES_TASK_MEMORIES_LIST: 'notes:task-memories:list',
  NOTES_TASK_MEMORY_DELETE: 'notes:task-memory:delete',
  NOTES_SAVE: 'notes:save',
  NOTES_DELETE: 'notes:delete',

  /** MCP 管理 */
  MCP_LIST: 'mcp:list',
  MCP_SAVE: 'mcp:save',
  MCP_REMOVE: 'mcp:remove',
  MCP_TOGGLE: 'mcp:toggle',

  /** main → renderer, 在内嵌浏览器中打开 URL */
  OPEN_URL: 'app:open-url',

  /** 浏览器自动化（已废弃：统一使用外部 BrowserWindow + CDP） */
  BROWSER_ACTION: 'browser:action',
  /** renderer → main, 设置浏览器全局接管模式 */
  BROWSER_AUTO_TAKEOVER: 'browser:auto-takeover',
  /** renderer → main, 设置浏览器调试模式（是否打开 DevTools） */
  BROWSER_DEBUG_MODE: 'browser:debug-mode',
  /** renderer → main, 设置浏览器隐藏窗口模式（打开时是否隐藏窗口） */
  BROWSER_HIDDEN_MODE: 'browser:hidden-mode',

  /** 外部浏览器窗口 (BrowserWindow 模式) */
  EXTERNAL_BROWSER_OPEN: 'browser:ext-open',
  EXTERNAL_BROWSER_CLOSE: 'browser:ext-close',
  EXTERNAL_BROWSER_NAVIGATE: 'browser:ext-navigate',
  EXTERNAL_BROWSER_FOCUS: 'browser:ext-focus',
  /** main → renderer, 外部浏览器窗口状态变更 */
  EXTERNAL_BROWSER_STATUS: 'browser:ext-status',
  /** renderer → main, 同步浏览器模式设置 */
  BROWSER_MODE: 'browser:mode',

  /** renderer → main, 打开日志目录 */
  OPEN_LOG_DIR: 'app:open-log-dir',
  /** renderer → main, 获取应用版本号（来自 app.getVersion()） */
  APP_GET_VERSION: 'app:get-version',
  /** renderer → main, 触发系统通知 */
  APP_NOTIFY: 'app:notify',
  /** renderer → main, 获取移动端桥接配置 */
  MOBILE_BRIDGE_GET: 'mobile-bridge:get',
  /** renderer → main, 保存移动端桥接配置 */
  MOBILE_BRIDGE_SET: 'mobile-bridge:set',
  /** renderer → main, 同步当前会话上下文到移动端桥接缓存 */
  MOBILE_BRIDGE_SYNC_CONTEXT: 'mobile-bridge:sync-context',
  /** main → renderer, 移动端下发指令 */
  MOBILE_BRIDGE_COMMAND: 'mobile-bridge:command',
  /** main → renderer, 移动端下发会话/模型选择 */
  MOBILE_BRIDGE_SELECT: 'mobile-bridge:select',
  /** main → renderer, 移动端下发停止请求 */
  MOBILE_BRIDGE_ABORT: 'mobile-bridge:abort',
  /** main → renderer, 移动端下发确认响应 */
  MOBILE_BRIDGE_CONFIRM: 'mobile-bridge:confirm',
  /** main → renderer, 移动端请求在当前项目新建会话 */
  MOBILE_BRIDGE_NEW_SESSION: 'mobile-bridge:new-session',
  /** main → renderer, 移动端请求清空会话记录 */
  MOBILE_BRIDGE_CLEAR_SESSION: 'mobile-bridge:clear-session',

  /** GUI-Plus 配置 */
  GUI_PLUS_GET: 'gui-plus:get',
  GUI_PLUS_SAVE: 'gui-plus:save',
  /** Prompt 配置（可选文件覆盖） */
  PROMPT_CONFIG_GET: 'prompt-config:get',
  PROMPT_CONFIG_SAVE: 'prompt-config:save',

  /** 窗口拖拽 — 手动实现以获取自定义光标控制 */
  WINDOW_DRAG_START: 'window:drag-start',
  WINDOW_DRAGGING: 'window:dragging',
  WINDOW_DRAG_END: 'window:drag-end',
  /** renderer → main, 双击顶栏切换最大化 */
  WINDOW_TOGGLE_MAXIMIZE: 'window:toggle-maximize',
  /** renderer → main, 最小化主窗口 */
  WINDOW_MINIMIZE: 'window:minimize',
  /** renderer → main, 关闭主窗口 */
  WINDOW_CLOSE: 'window:close',
} as const

/* ------------------------------------------------------------------ */
/*  Shared primitive types                                             */
/* ------------------------------------------------------------------ */

export type ChatRole = 'system' | 'user' | 'assistant'

export type IpcChatMessage = {
  role: ChatRole
  content: string
  /** 用户消息附带的图片（base64 data URL） */
  images?: string[]
}

export type IpcChatOverrides = Record<
  string,
  {
    baseUrl?: string
    apiKey?: string
    model?: string
    headers?: Record<string, string>
  }
>

/* ------------------------------------------------------------------ */
/*  Payloads (renderer → main)                                         */
/* ------------------------------------------------------------------ */

/** chat:send 请求体 */
export type ChatSendPayload = {
  provider: string
  messages: IpcChatMessage[]
  overrides?: IpcChatOverrides
  /** 项目标识（用于日志隔离） */
  projectId?: string
}

/** chat:stream 请求体 */
export type ChatStreamPayload = {
  requestId: string
  provider: string
  messages: IpcChatMessage[]
  overrides?: IpcChatOverrides
  /** 项目标识（用于日志隔离） */
  projectId?: string
  /** 当前工作空间（用于日志隔离） */
  workspace?: string
}

/* ------------------------------------------------------------------ */
/*  Events (main → renderer)                                           */
/* ------------------------------------------------------------------ */

/** chat:chunk 推送体 */
export type IpcTokenUsage = {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  cachedTokens?: number
}

/** chat:chunk 推送体 */
export type ChatChunkData = {
  requestId: string
  chunk: string
  done: boolean
  error?: string
  usage?: IpcTokenUsage
}

/** agent:stream 请求体 */
export type AgentStreamPayload = {
  requestId: string
  provider: string
  messages: IpcChatMessage[]
  overrides?: IpcChatOverrides
  /** 项目标识（用于项目级笔记和日志隔离） */
  projectId?: string
  /** Agent 工作空间目录 */
  workspace: string
  /** 模型上下文窗口大小（token 数），用于 agent 循环内自动压缩 */
  maxTokens?: number
  /** 是否开启召回调试日志（默认 false） */
  recallDebug?: boolean
  /** 用户附带的图片（base64 data URL），需要通过 MCP 理解后注入消息 */
  images?: string[]
}

/** 工具调用信息 */
export type IpcToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** 文件变更信息 */
export type IpcFileChange = {
  filePath: string
  /** null 表示新建文件 */
  oldContent: string | null
  /** null 表示文件被删除 */
  newContent: string | null
}

/** 工具执行结果 */
export type IpcToolResult = {
  tool_call_id: string
  name: string
  content: string
  success: boolean
  /** write_file 时携带文件变更 */
  fileChange?: IpcFileChange
}

/** 风险信息 */
export type IpcRiskInfo = {
  toolCallId: string
  toolName: string
  level: 'safe' | 'warning' | 'danger'
  reason: string
  detail: string
}

/** agent:event 推送体 */
export type AgentEventData = {
  requestId: string
} & (
  | { type: 'text'; content: string }
  | { type: 'tool_calls'; toolCalls: IpcToolCall[] }
  | { type: 'confirm'; confirmId: string; toolCalls: IpcToolCall[]; risks: IpcRiskInfo[] }
  | { type: 'tool_results'; results: IpcToolResult[] }
  | { type: 'git_commit'; hash: string; message: string }
  | { type: 'usage'; usage: IpcTokenUsage }
  | { type: 'plan_init'; summary: string; steps: string[]; reasoning?: string }
  | { type: 'plan_progress'; stepIndex: number; status: PlanStepStatus; note?: string }
  | { type: 'done' }
  | { type: 'error'; message: string }
)

/** 计划步骤状态 */
export type PlanStepStatus = 'pending' | 'in_progress' | 'done' | 'failed'

/** agent:confirm 用户响应体 */
export type AgentConfirmPayload = {
  confirmId: string
  approved: boolean
}

/* ------------------------------------------------------------------ */
/*  Taco API (暴露给 window.taco 的完整形状)                            */
/* ------------------------------------------------------------------ */

/** 系统环境信息（preload 采集，注入 system prompt） */
export type SystemInfo = {
  platform: string   // e.g. 'darwin', 'win32', 'linux'
  arch: string       // e.g. 'arm64', 'x64'
  osVersion: string  // e.g. 'Darwin 24.1.0'
  hostname: string
  homeDir: string
  shell: string
  nodeVersion: string
  electronVersion: string
  locale: string
}

/** Prompt 配置层 */
export type PromptLayerConfig = {
  /** 所有模式通用追加文本 */
  allExtra?: string
  /** chat 模式追加文本 */
  chatExtra?: string
  /** agent 模式追加文本 */
  agentExtra?: string
  /** chat 模式完整覆盖（可选） */
  chatOverride?: string
  /** agent 模式完整覆盖（可选） */
  agentOverride?: string
}

/** Prompt 配置（存储在 ~/.taco/prompt-config.json） */
export type PromptConfig = {
  version?: number
  common?: PromptLayerConfig
  provider?: Record<string, PromptLayerConfig>
  model?: Record<string, PromptLayerConfig>
  updatedAt?: string
}

/** 支持的编辑器 */
export type EditorId = 'cursor' | 'vscode' | 'webstorm' | 'sublime' | 'system'

/** 编辑器信息映射（macApp 用于 macOS `open -a`，cli 用于 Linux/fallback） */
export const editorCommands: Record<EditorId, { label: string; macApp: string; cli: string }> = {
  cursor:   { label: 'Cursor',       macApp: 'Cursor',              cli: 'cursor' },
  vscode:   { label: 'VS Code',      macApp: 'Visual Studio Code',  cli: 'code' },
  webstorm: { label: 'WebStorm',     macApp: 'WebStorm',            cli: 'webstorm' },
  sublime:  { label: 'Sublime Text', macApp: 'Sublime Text',        cli: 'subl' },
  system:   { label: '系统默认',      macApp: '',                    cli: 'xdg-open' },
}

/** 文件/目录树条目 */
export type FileTreeEntry = {
  name: string
  /** 相对于 workspace 的路径 */
  path: string
  isDirectory: boolean
  children?: FileTreeEntry[]
}

/** Git 工作区状态（按是否已暂存分组） */
export type GitWorkingTreeStatus = {
  staged: string[]
  unstaged: string[]
}

/** Git 文件差异快照（基于 HEAD vs 工作区） */
export type GitFileChange = {
  filePath: string
  oldContent: string | null
  newContent: string | null
}

/* ------------------------------------------------------------------ */
/*  Skills                                                             */
/* ------------------------------------------------------------------ */

/** Skill 定义 */
export type SkillInfo = {
  /** 唯一 ID（如 "code-review", "git-helper"） */
  id: string
  /** 显示名称 */
  name: string
  /** 简短描述 */
  description: string
  /** 版本 */
  version: string
  /** 作者 */
  author: string
  /** 来源：内置 / 本地 / 远程（GitHub URL 等） */
  source: 'builtin' | 'local' | 'remote'
  /** 远程来源时的 URL */
  sourceUrl?: string
  /** 是否启用 */
  enabled: boolean
  /** 注入到 Agent system prompt 的指令内容 */
  instructions: string
}

/* ------------------------------------------------------------------ */
/*  Project Notes (项目笔记/记忆)                                       */
/* ------------------------------------------------------------------ */

/** 笔记分类 */
export type NoteCategory = 'convention' | 'credential' | 'architecture' | 'config' | 'other'

/** 项目笔记 */
export type ProjectNote = {
  /** 唯一 ID */
  id: string
  /** 标题 */
  title: string
  /** 笔记内容 */
  content: string
  /** 分类 */
  category: NoteCategory
  /** 创建时间 (ISO) */
  createdAt: string
  /** 最后更新时间 (ISO) */
  updatedAt: string
}

/** 任务执行记忆 */
export type ProjectTaskMemory = {
  id: string
  /** 本轮用户原始提问（纯文本） */
  userQuery?: string
  /** 本轮用户附件信息（[USER_ASSETS] 内部正文） */
  userAssetsBlock?: string
  goal: string
  /** 意图类型（qa/debug/implement/refactor/ops/other） */
  intentType?: string
  /** 一句话意图摘要 */
  intentSummary?: string
  /** 意图目标描述 */
  intentGoal?: string
  /** 本轮处理结果正文（用于后续上下文重放） */
  assistantResult?: string
  summary: string
  outcome: 'success' | 'aborted' | 'error'
  tools: string[]
  changedFiles: string[]
  identifiers: string[]
  failures: string[]
  createdAt: string
  updatedAt: string
}

/* ------------------------------------------------------------------ */
/*  MCP (Model Context Protocol)                                       */
/* ------------------------------------------------------------------ */

export type McpServerInfo = {
  id: string
  name: string
  description?: string
  command: string
  args: string[]
  env: Record<string, string>
  enabled: boolean
  builtin: boolean
  status: string
  toolCount: number
  error?: string
}

/* ------------------------------------------------------------------ */
/*  Browser Automation (浏览器自动化)                                    */
/* ------------------------------------------------------------------ */

export type BrowserActionType =
  | 'navigate'     // 导航到 URL
  | 'screenshot'   // 截取页面截图
  | 'click'        // 点击元素（CSS 选择器或坐标）
  | 'type'         // 输入文字
  | 'scroll'       // 滚动页面
  | 'hover'        // 鼠标悬停在元素上
  | 'keypress'     // 按下键盘按键（Tab/Escape/Enter/方向键等）
  | 'drag'         // 拖拽元素从一个位置到另一个位置
  | 'select'       // 选择下拉框选项
  | 'get_content'  // 获取页面内容
  | 'wait'         // 等待元素出现
  | 'evaluate'     // 执行任意 JS
  | 'get_info'     // 获取页面信息（URL/标题/viewport等）

export type BrowserActionPayload = {
  action: BrowserActionType
  params: Record<string, unknown>
}

export type BrowserActionResult = {
  success: boolean
  data?: string
  error?: string
}

export type GuiPlusConfig = {
  baseUrl: string
  apiKey: string
  model: string
  minPixels?: number
  maxPixels?: number
  highResolution?: boolean
  includeUsage?: boolean
}

export type AppNotifyPayload = {
  title: string
  body: string
  silent?: boolean
}

export type MobileBridgeConfig = {
  enabled: boolean
  port: number
  token: string
}

export type MobileBridgeCommandData = {
  id: string
  text: string
  receivedAt: number
  remoteAddr?: string
  threadId?: string
  sessionId?: string
  provider?: string
  mode?: 'chat' | 'agent'
}

export type MobileBridgeSelectData = {
  id: string
  receivedAt: number
  remoteAddr?: string
  threadId?: string
  sessionId?: string
  provider?: string
  mode?: 'chat' | 'agent'
}

export type MobileBridgeAbortData = {
  id: string
  receivedAt: number
  remoteAddr?: string
  threadId?: string
  sessionId?: string
}

export type MobileBridgeConfirmData = {
  id: string
  receivedAt: number
  remoteAddr?: string
  threadId?: string
  sessionId?: string
  confirmId: string
  approved: boolean
}

export type MobileBridgeNewSessionData = {
  id: string
  receivedAt: number
  remoteAddr?: string
  threadId?: string
}

export type MobileBridgeClearSessionData = {
  id: string
  receivedAt: number
  remoteAddr?: string
  threadId?: string
  sessionId?: string
}

export type MobileBridgeRiskInfo = {
  toolName: string
  reason: string
  detail: string
  level?: 'safe' | 'warning' | 'danger'
}

export type MobileBridgeFileChange = {
  filePath: string
  oldContent: string | null
  newContent: string | null
}

export type MobileBridgeMessage = {
  id?: string
  role: ChatRole
  content: string
  screenshotPaths?: string[]
  agentSteps?: MobileBridgeAgentStep[]
  activePlan?: MobileBridgeActivePlan
}

export type MobileBridgeProviderOption = {
  id: string
  label: string
}

export type MobileBridgeToolCall = {
  id: string
  name: string
  arguments: string
}

export type MobileBridgeToolResult = {
  tool_call_id: string
  name: string
  content: string
  success: boolean
  fileChange?: MobileBridgeFileChange
}

export type MobileBridgeAgentStep = {
  round: number
  thinking: string
  toolCalls: MobileBridgeToolCall[]
  toolResults: MobileBridgeToolResult[]
  status: 'calling' | 'running' | 'confirm' | 'done'
  risks?: MobileBridgeRiskInfo[]
  confirmId?: string
}

export type MobileBridgePlanStep = {
  text: string
  status: 'pending' | 'in_progress' | 'done' | 'failed'
  note?: string
}

export type MobileBridgeActivePlan = {
  summary: string
  reasoning?: string
  steps: MobileBridgePlanStep[]
}

export type MobileBridgeSessionContext = {
  sessionId: string
  title: string
  messageCount: number
  messages: MobileBridgeMessage[]
  sending: boolean
  queue: string[]
  streamingContent?: string
}

export type MobileBridgeThreadContext = {
  threadId: string
  title: string
  updatedAt: number
  provider?: string
  mode?: string
  workspace?: string
  activeSessionId: string
  sessions: MobileBridgeSessionContext[]
}

export type MobileBridgeContextSnapshot = {
  updatedAt: number
  activeThreadId?: string
  activeSessionId?: string
  activeProvider?: string
  providers?: MobileBridgeProviderOption[]
  threads: MobileBridgeThreadContext[]
}

export type TacoApi = {
  version: string
  system: SystemInfo
  shell: {
    /** 用指定编辑器打开文件 */
    openInEditor: (filePath: string, editor: EditorId) => Promise<void>
    /** 在系统文件管理器中打开日志目录 */
    openLogDir: (scope?: { projectId?: string; workspace?: string }) => Promise<void>
    /** 触发操作系统通知 */
    notify: (payload: AppNotifyPayload) => Promise<boolean>
  }
  mobileBridge: {
    /** 获取移动端桥接配置 */
    getConfig: () => Promise<MobileBridgeConfig>
    /** 保存移动端桥接配置（保存后自动重启监听） */
    setConfig: (config: MobileBridgeConfig) => Promise<MobileBridgeConfig>
    /** 同步当前桌面端会话上下文到主进程桥接缓存 */
    syncContext: (snapshot: MobileBridgeContextSnapshot) => void
    /** 监听移动端下发的文本指令 */
    onCommand: (callback: (data: MobileBridgeCommandData) => void) => () => void
    /** 监听移动端下发的会话/模型选择 */
    onSelect: (callback: (data: MobileBridgeSelectData) => void) => () => void
    /** 监听移动端下发的停止请求 */
    onAbort: (callback: (data: MobileBridgeAbortData) => void) => () => void
    /** 监听移动端下发的确认响应 */
    onConfirm: (callback: (data: MobileBridgeConfirmData) => void) => () => void
    /** 监听移动端下发的新建会话请求 */
    onNewSession: (callback: (data: MobileBridgeNewSessionData) => void) => () => void
    /** 监听移动端下发的清空会话请求 */
    onClearSession: (callback: (data: MobileBridgeClearSessionData) => void) => () => void
  }
  chat: {
    /** 非流式请求，返回完整回复 */
    send: (payload: ChatSendPayload) => Promise<string>
    /** 发起流式请求 */
    stream: (payload: ChatStreamPayload) => void
    /** 终止当前 chat 流式请求 */
    abort: (requestId: string) => void
    /** 监听流式数据块，返回取消订阅函数 */
    onChunk: (callback: (data: ChatChunkData) => void) => () => void
  }
  agent: {
    /** 发起 agent 流式请求（带工具调用） */
    stream: (payload: AgentStreamPayload) => void
    /** 监听 agent 事件，返回取消订阅函数 */
    onEvent: (callback: (data: AgentEventData) => void) => () => void
    /** 用户对风险操作的确认/拒绝响应 */
    confirmResponse: (confirmId: string, approved: boolean) => void
    /** 终止当前正在运行的 agent */
    abort: (requestId: string) => void
    /** 设置自动授权分类（不需要用户确认的操作类型） */
    setAutoApprove: (categories: string[]) => void
  }
  dialog: {
    /** 打开目录选择对话框，返回选中的路径或 null */
    selectDirectory: () => Promise<string | null>
  }
  workspace: {
    /** 读取工作空间目录树 */
    tree: (cwd: string) => Promise<FileTreeEntry[]>
    /** 开始监听工作空间变化 */
    watch: (cwd: string) => void
    /** 停止监听工作空间变化 */
    unwatch: () => void
    /** 监听工作空间变化通知 */
    onChanged: (callback: () => void) => () => void
  }
  file: {
    /** 将文件内容恢复为指定内容（用于撤销 Agent 变更） */
    revert: (filePath: string, oldContent: string) => Promise<void>
    /** 删除文件（用于撤销 Agent 新建的文件） */
    delete: (filePath: string) => Promise<void>
    /** 读取文件内容（文本文件返回内容字符串，二进制文件返回 null；图片可返回 dataUrl 预览） */
    read: (filePath: string) => Promise<{ content: string | null; size: number; isBinary: boolean; dataUrl?: string; truncated?: boolean }>
    /** 写入文件内容 */
    write: (filePath: string, content: string) => Promise<void>
  }
  terminal: {
    /** 创建终端进程 */
    spawn: (cwd?: string) => void
    /** 向终端发送输入（键盘数据） */
    input: (data: string) => void
    /** 监听终端输出数据 */
    onOutput: (callback: (data: string) => void) => () => void
    /** 监听终端退出 */
    onExit: (callback: (data: { code: number | null }) => void) => () => void
    /** 调整终端大小 */
    resize: (cols: number, rows: number) => void
    /** 关闭终端 */
    kill: () => void
  }
  git: {
    /** 获取 Taco 提交历史 */
    log: (cwd: string) => Promise<{ hash: string; shortHash: string; message: string; timestamp: number; fileCount: number }[]>
    /** 获取工作区暂存状态 */
    status: (cwd: string) => Promise<GitWorkingTreeStatus>
    /** 获取某个文件的 Git 差异（HEAD vs 工作区） */
    fileChange: (cwd: string, filePath: string) => Promise<GitFileChange | null>
    /** 手动创建提交 */
    commit: (cwd: string, message: string) => Promise<string | null>
    /** 暂存指定文件 */
    stageFiles: (cwd: string, filePaths: string[]) => Promise<void>
    /** 暂存全部变更 */
    stageAll: (cwd: string) => Promise<void>
    /** 回退到指定提交 */
    rollback: (cwd: string, hash: string) => Promise<void>
    /** 获取某个提交变更的文件列表 */
    commitFiles: (cwd: string, hash: string) => Promise<string[]>
  }
  skills: {
    /** 列出所有已安装的 skills */
    list: () => Promise<SkillInfo[]>
    /** 安装 skill（从 URL 或本地路径） */
    install: (source: string) => Promise<SkillInfo>
    /** 卸载 skill */
    uninstall: (id: string) => Promise<void>
    /** 启用/禁用 skill */
    toggle: (id: string, enabled: boolean) => Promise<void>
  }
  notes: {
    /** 列出指定工作空间的所有笔记 */
    list: (workspace: string, projectId?: string) => Promise<ProjectNote[]>
    /** 列出指定工作空间的任务执行记忆 */
    listTaskMemories: (workspace: string, projectId?: string) => Promise<ProjectTaskMemory[]>
    /** 删除任务执行记忆 */
    deleteTaskMemory: (workspace: string, memoryId: string, projectId?: string) => Promise<void>
    /** 保存笔记（新增或更新） */
    save: (workspace: string, note: ProjectNote, projectId?: string) => Promise<ProjectNote>
    /** 删除笔记 */
    delete: (workspace: string, noteId: string, projectId?: string) => Promise<void>
  }
  window: {
    /** 开始拖拽窗口（传入鼠标屏幕坐标） */
    dragStart: (screenX: number, screenY: number) => void
    /** 拖拽中，更新窗口位置 */
    dragging: (screenX: number, screenY: number) => void
    /** 拖拽结束 */
    dragEnd: () => void
    /** 双击顶栏切换最大化/还原 */
    toggleMaximize: () => void
    /** 最小化窗口 */
    minimize: () => void
    /** 关闭窗口 */
    close: () => void
  }
  mcp: {
    /** 列出所有 MCP 服务器 */
    list: () => Promise<McpServerInfo[]>
    /** 保存（添加/更新）MCP 服务器 */
    save: (server: McpServerInfo) => Promise<void>
    /** 删除 MCP 服务器 */
    remove: (id: string) => Promise<void>
    /** 启用/禁用 MCP 服务器 */
    toggle: (id: string, enabled: boolean) => Promise<void>
  }
  browser: {
    /** 监听主进程发来的打开 URL 事件 */
    onOpenUrl: (callback: (url: string) => void) => () => void
    /** 设置浏览器全局接管模式 */
    setAutoTakeover: (enabled: boolean) => void
    /** 设置浏览器调试模式（打开时自动开启 DevTools） */
    setDebugMode: (enabled: boolean) => void
    /** 设置浏览器隐藏窗口模式（打开时隐藏窗口） */
    setHiddenMode: (enabled: boolean) => void
    /** 外部浏览器：打开独立窗口（可指定 appId） */
    openExternal: (url: string, appId?: string) => Promise<void>
    /** 外部浏览器：关闭独立窗口（可指定 appId） */
    closeExternal: (appId?: string) => Promise<void>
    /** 外部浏览器：在已有窗口中导航到新 URL（可指定 appId） */
    navigateExternal: (url: string, appId?: string) => Promise<void>
    /** 外部浏览器：聚焦/显示已有窗口（不重新加载，可指定 appId） */
    focusExternal: (appId?: string) => Promise<void>
    /** 监听外部浏览器状态变化 (opened/closed/navigated) */
    onExternalStatus: (callback: (status: ExternalBrowserStatus) => void) => () => void
  }
  guiPlus: {
    getConfig: () => Promise<GuiPlusConfig>
    saveConfig: (config: GuiPlusConfig) => Promise<void>
  }
  prompt: {
    /** 读取 prompt 配置（文件缺失时返回默认空配置） */
    getConfig: () => Promise<PromptConfig>
    /** 保存 prompt 配置 */
    saveConfig: (config: PromptConfig) => Promise<PromptConfig>
  }
}

/** 浏览器模式 */
export type BrowserMode = 'embedded' | 'external'

/** 浏览器控制台日志级别 */
export type BrowserConsoleLevel = 'log' | 'warn' | 'error' | 'info' | 'debug' | 'network'

/** 外部浏览器状态事件 */
export type ExternalBrowserStatus = {
  type: 'opened' | 'closed' | 'navigated' | 'title-changed' | 'console'
  url?: string
  title?: string
  /** 浏览器实例标识 */
  appId?: string
  /** console 事件专用字段 */
  consoleLevel?: BrowserConsoleLevel
  consoleMessage?: string
  /** console 来源 URL 和行号 */
  consoleSource?: string
  consoleLine?: number
}
