/**
 * IPC 协议类型定义
 *
 * 所有 IPC 通信的 payload 类型、事件类型、领域类型等。
 * 供 main / preload / renderer 三端共享。
 *
 * 部分 SDK 领域类型（PlanStepStatus、SkillInfo、ProjectNote 等）
 * 来自 Agent SDK，此处 re-export 以保持外部兼容。
 */

import type { PlanStepStatus, BrowserActionType } from '../main/sdk/agent/types'

/* ------------------------------------------------------------------ */
/*  Shared primitive types                                             */
/* ------------------------------------------------------------------ */

export type ChatRole = 'system' | 'user' | 'assistant'

/**
 * IPC 聊天消息类型 - 统一使用标准 content 数组格式
 * 
 * 前端始终发送此格式，后端根据 provider 转换
 * 
 * content 数组支持的类型：
 * - text: 文本
 * - image_url: 图片
 * - video_url: 视频
 * - audio_url: 音频
 * 
 * 非媒体文件使用 [FILE]path[/FILE] 标签包裹在文本中
 */
export type IpcChatMessage = {
  role: ChatRole
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
    | { type: 'video_url'; video_url: { url: string } }
    | { type: 'audio_url'; audio_url: { url: string } }
  > | string
}

export type IpcChatOverrides = Record<
  string,
  {
    baseUrl?: string
    apiKey?: string
    model?: string
    temperature?: number
    maxTokens?: number
    headers?: Record<string, string>
  }
>

/* ------------------------------------------------------------------ */
/*  Payloads (renderer → main)                                         */
/* ------------------------------------------------------------------ */

/** chat:send 请求体 */
export type ImageUploadPayload = {
  dataUrl: string
  fileName: string
}

/** chat:send 请求体（已废弃，仅保留类型定义） */
export type ChatSendPayload = {
  provider: string
  messages: IpcChatMessage[]
  overrides?: IpcChatOverrides
  /** 项目标识（用于日志隔离） */
  projectId?: string
}

/** chat:stream 请求体（已废弃，仅保留类型定义） */
export type ChatStreamPayload = {
  requestId: string
  provider: string
  messages: IpcChatMessage[]
  overrides?: IpcChatOverrides
  /** 项目标识（用于日志隔离） */
  projectId?: string
  /** 当前工作空间（用于日志隔离） */
  workspace?: string
  /** 上下文窗口大小（token 数），用于记忆整理阈值判定 */
  contextLength?: number
  /** 会话 ID（通常等于 threadId），用于任务记忆指向原始会话 */
  sessionId?: string
  /** 本轮用户消息 ID（用于任务记忆定位原始提问） */
  sourceUserMessageId?: string
  /** 本轮助手消息 ID（用于任务记忆定位处理结果） */
  sourceAssistantMessageId?: string
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
  /** 上下文窗口大小（token 数），用于 agent 循环内自动压缩 */
  contextLength?: number
  /** 是否开启召回调试日志（默认 false） */
  recallDebug?: boolean
  /**
   * @deprecated 图片信息现在直接在 messages 的 content 数组中传递
   * 保留此字段仅为向后兼容，新代码不应使用
   */
  images?: string[]
  /** 会话 ID（通常等于 threadId），用于任务记忆指向原始会话 */
  sessionId?: string
  /** 本轮用户消息 ID（用于任务记忆定位原始提问） */
  sourceUserMessageId?: string
  /** 本轮助手消息 ID（用于任务记忆定位处理结果） */
  sourceAssistantMessageId?: string
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
  | { type: 'reasoning'; content: string }
  | { type: 'tool_calls'; toolCalls: IpcToolCall[]; thinking?: string }
  | { type: 'system_notice'; title: string; message?: string }
  | { type: 'confirm'; confirmId: string; toolCalls: IpcToolCall[]; risks: IpcRiskInfo[] }
  | { type: 'retry_confirm'; retryId: string; errorType: 'network' | 'timeout' | 'empty_response' | 'interrupted'; errorMessage: string; round: number }
  | { type: 'tool_results'; results: IpcToolResult[] }
  | { type: 'git_commit'; hash: string; message: string }
  | { type: 'usage'; usage: IpcTokenUsage }
  | { type: 'plan_init'; summary: string; steps: Array<{ index: number; title: string; content: string }>; reasoning?: string }
  | { type: 'plan_progress'; stepIndex: number; status: PlanStepStatus; note?: string }
  | { type: 'done'; finalText?: string }
  | { type: 'error'; message: string }
)

/** agent:event-chunk 推送体（用于超大事件分块传输） */
export type AgentEventChunkData = {
  requestId: string
  chunkId: string
  index: number
  total: number
  payloadChunk: string
}

/** 计划步骤状态 */
export type { PlanStepStatus } from '../main/sdk/agent/types'

/** agent:confirm 用户响应体 */
export type AgentConfirmPayload = {
  confirmId: string
  approved: boolean
}

/** 桥接连接状态 */
export type BridgeConnectionStatusType = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'

/** main → renderer 桥接状态推送 */
export type BridgeStatusPayload = {
  status: BridgeConnectionStatusType
  clientCount: number
  error?: string
  tokenExpired?: boolean
}

/* ------------------------------------------------------------------ */
/*  System                                                             */
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

/* ------------------------------------------------------------------ */
/*  Editor                                                             */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  File / Workspace / Git                                              */
/* ------------------------------------------------------------------ */

/** 文件/目录树条目 */
export type FileTreeEntry = {
  name: string
  /** 相对于 workspace 的路径（使用 / 分隔符） */
  path: string
  /** 绝对路径（平台原生分隔符） */
  absPath: string
  isDirectory: boolean
  children?: FileTreeEntry[]
}

/** Git 工作区状态（按是否已暂存分组） */
export type GitWorkingTreeStatus = {
  staged: string[]
  unstaged: string[]
  /** 每个文件的 porcelain 状态码：M=已修改 A=新增暂存 D=已删除 ?=未跟踪 R=重命名 C=已复制 */
  fileStatuses: Record<string, string>
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

/** Skill 定义 & 预览 — 来自 Agent SDK */
export type { SkillInfo, SkillPreview, ClawHubSearchResult } from '../main/sdk/agent/types'

/** Skill 安装进度 */
export type InstallProgress = {
  step: 'fetching_meta' | 'downloading_resources' | 'installing' | 'done' | 'failed'
  message: string
  current?: number
  total?: number
}

/** Skill 更新信息 */
export type SkillUpdateInfo = {
  hasUpdate: boolean
  currentVersion: string
  latestVersion: string
  sourceUrl: string
}

/* ------------------------------------------------------------------ */
/*  Project Notes (项目笔记/记忆)                                       */
/* ------------------------------------------------------------------ */

/** 项目笔记 & 记忆 — 来自 Agent SDK */
export type { NoteCategory, ProjectNote, ProjectTaskMemory, MemoryScopeStats, MemoryScopeExportResult } from '../main/sdk/agent/types'

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
/*  Browser Use (浏览器使用)                                    */
/* ------------------------------------------------------------------ */

export type { BrowserActionType } from '../main/sdk/agent/types'

export type BrowserActionPayload = {
  action: BrowserActionType
  params: Record<string, unknown>
}

export type BrowserActionResult = {
  success: boolean
  data?: string
  error?: string
}

/* ------------------------------------------------------------------ */
/*  Application State Types                                             */
/* ------------------------------------------------------------------ */

export type AppNotifyPayload = {
  title: string
  body: string
  silent?: boolean
}

export type AppUpdateCheckResult = {
  success: boolean
  checkedAt: number
  currentVersion: string
  hasUpdate: boolean
  latestVersion?: string
  latestVersionCode?: string
  releaseNotes?: string
  downloadUrl?: string
  forceUpdate?: boolean
  /** 用户是否点击了下载 */
  downloadTriggered?: boolean
  /** 提示信息（错误或状态） */
  message?: string
}

export type RendererErrorPayload = {
  source: string
  message: string
  stack?: string
  componentStack?: string
  projectId?: string
  workspace?: string
  metadata?: Record<string, unknown>
}

/** 手机端 APK 下载信息 */
export type MobileApkInfo = {
  downloadUrl: string
  version?: string
}

export type ChatStoreSessionSnapshot = {
  projectId: string
  sessionId: string
  workspace?: string
  updatedAt: number
  messages: unknown[]
}

export type ChatStoreSessionSummary = {
  projectId: string
  sessionId: string
  workspace?: string
  updatedAt: number
  messageCount: number
}

export type ChatStoreSessionPage = {
  projectId: string
  sessionId: string
  workspace?: string
  updatedAt: number
  totalCount: number
  startSeq?: number
  endSeq?: number
  messages: unknown[]
}

export type ChatStoreSessionPatch = {
  projectId: string
  sessionId: string
  workspace?: string
  updatedAt: number
  fromSeq: number
  messages: unknown[]
}

export type AppStateProviderId = 'deepseek' | 'kimi' | 'minimax' | 'glm' | 'qwen' | 'mimo' | 'anthropic' | 'openai' | (string & {})

export type AppStateModelConfig = {
  id: string
  /** 底层 provider 类型（请求路由） */
  provider: AppStateProviderId
  /** 卡片显示名（可自定义） */
  name: string
  baseUrl: string
  apiKey: string
  model: string
  /** 上下文窗口大小（token 数） */
  contextLength: string
  temperature?: string
  supportsVision?: boolean
  supportsReasoning?: boolean
  createdAt?: number
  updatedAt?: number
}

export type AppStateSession = {
  id: string
  title: string
  createdAt: number
}

export type AppStateThread = {
  id: string
  title: string
  titleLocked?: boolean
  updatedAt: number
  /** 绑定的模型配置记录 ID */
  modelConfigId?: string
  /** 兼容历史字段（已弃用） */
  provider?: AppStateProviderId
  mode?: 'agent'
  workspace?: string
  projectRules?: string
  sessions: AppStateSession[]
  activeSessionId: string
}

export type AppStateThreadsPayload = {
  threads: AppStateThread[]
  activeThreadId: string
}

export type AppStateProvidersPayload = {
  modelConfigs: AppStateModelConfig[]
  activeModelConfigId: string
}

export type AppStateSnapshot = {
  version: number
  updatedAt?: string
  threadsState: AppStateThreadsPayload
  providersState: AppStateProvidersPayload
}

/* ------------------------------------------------------------------ */
/*  Gateway Model Types                                                 */
/* ------------------------------------------------------------------ */

/** 网关模型列表项（与 AppStateModelConfig 字段对齐） */
export type GatewayModelItem = {
  id: string
  provider: string
  name: string
  baseUrl: string
  model: string
  apiKey: string
  maxTokens: string
  temperature: string
  contextLength: number
  supportsVision: boolean
  supportsReasoning?: boolean
  displayName: string
  description: string
  sortOrder: number
  source: 'system' | 'custom'
}

/** 网关模型列表响应 */
export type GatewayModelsResponse = {
  data: GatewayModelItem[]
  object: string
}

/* ------------------------------------------------------------------ */
/*  Browser Types                                                       */
/* ------------------------------------------------------------------ */

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
