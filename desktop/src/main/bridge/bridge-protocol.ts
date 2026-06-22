/**
 * Taco 跨端桥接协议定义（新版：会员登录 + 扫码配对）
 *
 * Desktop (Host) 通过会员登录获取 token，连接 WebSocket Relay 后生成配对码。
 * Mobile (Client) 扫码获取配对码，使用同一 token 连接 Relay 与 Host 配对。
 */

/* ------------------------------------------------------------------ */
/*  Relay → Host/Client 消息                                           */
/* ------------------------------------------------------------------ */

/** 配对码（Host 连接成功后收到） */
export interface BridgePairingCode {
  type: 'pairing_code'
  /** 6 位数字配对码 */
  code: string
  timestamp: number
}

/** Client 连接通知（Host 收到） */
export interface BridgeClientConnected {
  type: 'client_connected'
  message: string
  timestamp: number
}

/** Client 断开通知（Host 收到） */
export interface BridgeClientDisconnected {
  type: 'client_disconnected'
  message: string
  timestamp: number
}

/** Host 断开通知（Client 收到） */
export interface BridgeHostDisconnected {
  type: 'host_disconnected'
  timestamp: number
}

/** 连接成功（Client 收到） */
export interface BridgeConnected {
  type: 'connected'
  message: string
  timestamp: number
}

/** 错误消息 */
export interface BridgeError {
  type: 'error'
  message: string
}

/** Ping（心跳） */
export interface BridgePing {
  type: 'ping'
  timestamp: number
}

/* ------------------------------------------------------------------ */
/*  Host → Client 桥接消息（通过 Relay 转发）                           */
/* ------------------------------------------------------------------ */

/** 完整会话状态快照 */
export interface BridgeState {
  type: 'bridge:state'
  messageId?: string
  priority?: BridgeMessagePriority
  messages: BridgeChatMessage[]
  activeAgentRequestId?: string
  threadId?: string
  workspace?: string
  modelLabel?: string
  modelConfigId?: string
  threadTitle?: string
  projectTitle?: string
  tokenUsage?: BridgeTokenUsage
  /** 快照生成时间戳，用于判断快照新旧（毫秒） */
  timestamp?: number
}

/** Agent 步骤信息 */
export interface BridgeAgentStep {
  round: number
  systemTitle?: string
  systemDetail?: string
  thinking: string
  toolCalls: BridgeToolCall[]
  toolResults: BridgeToolResult[]
  status: 'calling' | 'running' | 'confirm' | 'done'
  risks?: BridgeRiskInfo[]
  confirmId?: string
}

/** 计划步骤信息 */
export interface BridgePlanStepInfo {
  text: string
  status: 'pending' | 'in_progress' | 'done' | 'failed'
  note?: string
}

/** 活跃的执行计划 */
export interface BridgeActivePlan {
  summary: string
  reasoning?: string
  steps: BridgePlanStepInfo[]
  startedAt?: number
  endedAt?: number
}

/** 单轮任务耗时 */
export interface BridgeTaskTiming {
  startedAt: number
  endedAt?: number
  durationMs?: number
}

/** 对话消息 */
export interface BridgeChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  hasImages?: boolean
  streaming?: boolean
  /** Agent 执行步骤 */
  agentSteps?: BridgeAgentStep[]
  /** 是否已对 agentSteps 做了轻量化（按需加载标记） */
  agentStepsTruncated?: boolean
  /** 活跃的执行计划 */
  activePlan?: BridgeActivePlan
  /** 单轮任务耗时 */
  taskTiming?: BridgeTaskTiming
}

/** 用户消息同步 */
export interface BridgeChatUserMessage {
  type: 'bridge:chat-user-message'
  messageId: string
  priority?: BridgeMessagePriority
  content: string
  images?: string[]
  threadId?: string
  timestamp: number
}

/** 流式文本增量 */
export interface BridgeChatDelta {
  type: 'bridge:chat-delta'
  messageId: string
  priority?: BridgeMessagePriority
  delta: string
  done: boolean
  threadId?: string
}

/** Agent 执行事件 */
export interface BridgeAgentEvent {
  type: 'bridge:agent-event'
  requestId: string
  event: BridgeAgentEventData
}

export type BridgeAgentEventData =
  | { type: 'text'; content: string }
  | { type: 'reasoning'; content: string }
  | { type: 'tool_calls'; toolCalls: BridgeToolCall[]; thinking?: string }
  | { type: 'system_notice'; title: string; message?: string }
  | { type: 'confirm'; confirmId: string; toolCalls: BridgeToolCall[]; risks: BridgeRiskInfo[] }
  | { type: 'tool_results'; results: BridgeToolResult[] }
  | { type: 'plan_init'; summary: string; steps: Array<{ text: string }>; reasoning?: string }
  | { type: 'plan_progress'; stepIndex: number; status: 'pending' | 'in_progress' | 'done' | 'failed'; note?: string }
  | { type: 'usage'; usage: BridgeTokenUsage }
  | { type: 'done'; finalText?: string }
  | { type: 'error'; message: string }

export interface BridgeToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface BridgeRiskInfo {
  toolCallId: string
  toolName: string
  level: 'safe' | 'warning' | 'danger'
  reason: string
  detail: string
}

/** 文件变更信息（write_file / edit_file / delete_file 时携带） */
export interface BridgeFileChange {
  filePath: string
  /** null 表示新建文件 */
  oldContent: string | null
  /** null 表示文件被删除 */
  newContent: string | null
}

export interface BridgeToolResult {
  tool_call_id: string
  name: string
  content: string
  success: boolean
  /** 文件变更（write_file / edit_file / delete_file 时携带） */
  fileChange?: BridgeFileChange
}

export interface BridgeTokenUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  cachedTokens?: number
}

/** 文件变更通知 */
export interface BridgeFilesChanged {
  type: 'bridge:files-changed'
  files: string[]
  timestamp: number
}

/** 确认已处理通知（Host → Client，桌面端确认/拒绝后通知移动端清除弹窗） */
export interface BridgeAgentConfirmResolved {
  type: 'bridge:agent-confirm-resolved'
  confirmId: string
  approved: boolean
}

/** 心跳 */
export interface BridgeHeartbeat {
  type: 'heartbeat'
  timestamp: number
}

/** 消息优先级 */
export type BridgeMessagePriority = 'critical' | 'high' | 'normal' | 'low'

/** ACK 确认消息（确保关键消息送达） */
export interface BridgeAck {
  type: 'bridge:ack'
  /** 被确认的消息 ID */
  messageId: string
  /** 原始消息类型 */
  originalType: string
  /** 接收时间戳 */
  receivedAt: number
}

/** 消息重传请求（未收到 ACK 时请求重传） */
export interface BridgeRetransmitRequest {
  type: 'bridge:retransmit-request'
  /** 需要重传的消息 ID */
  messageId: string
}

/* ------------------------------------------------------------------ */
/*  Client → Host 指令（通过 Relay 转发）                               */
/* ------------------------------------------------------------------ */

/** 发送用户消息 */
export interface BridgeChatSend {
  type: 'bridge:chat-send'
  content: string
  images?: string[]
}

/** Agent 确认/拒绝响应 */
export interface BridgeAgentConfirm {
  type: 'bridge:agent-confirm'
  confirmId: string
  approved: boolean
}

/** 终止 Agent */
export interface BridgeAgentAbort {
  type: 'bridge:agent-abort'
  requestId: string
}

/* ------------------------------------------------------------------ */
/*  Client → Host 数据查询指令（请求/响应模式）                          */
/* ------------------------------------------------------------------ */

/** 请求项目列表 */
export interface BridgeGetProjects {
  type: 'bridge:get-projects'
  requestId: string
}

/** 返回项目列表 */
export interface BridgeProjects {
  type: 'bridge:projects'
  requestId: string
  projects: BridgeProjectInfo[]
  activeThreadId?: string
}

export interface BridgeProjectInfo {
  id: string
  title: string
  workspace?: string
  sessions: BridgeSessionInfo[]
  activeSessionId?: string
  modelConfigId?: string
}

export interface BridgeSessionInfo {
  id: string
  title: string
  createdAt: number
}

/** 请求工作区目录树 */
export interface BridgeGetWorkspaceTree {
  type: 'bridge:get-workspace-tree'
  requestId: string
  path: string
}

/** 返回目录树 */
export interface BridgeWorkspaceTree {
  type: 'bridge:workspace-tree'
  requestId: string
  tree: BridgeFileTreeEntry[]
}

export interface BridgeFileTreeEntry {
  name: string
  path: string
  isDirectory: boolean
  children?: BridgeFileTreeEntry[]
}

/** 请求读取文件 */
export interface BridgeFileRead {
  type: 'bridge:file-read'
  requestId: string
  path: string
}

/** 返回文件内容 */
export interface BridgeFileContent {
  type: 'bridge:file-content'
  requestId: string
  /** 文本内容，二进制为 null */
  content: string | null
  size: number
  isBinary: boolean
  /** 图片的 base64 dataUrl */
  dataUrl?: string
  truncated?: boolean
}

/** 请求写入文件 */
export interface BridgeFileWrite {
  type: 'bridge:file-write'
  requestId: string
  path: string
  content: string
}

/** 文件写入结果 */
export interface BridgeFileWritten {
  type: 'bridge:file-written'
  requestId: string
  success: boolean
  error?: string
}

/* ------------------------------------------------------------------ */
/*  Union 类型                                                         */
/* ------------------------------------------------------------------ */

/** Relay 下发的控制消息 */
export type BridgeControlMessage =
  | BridgePairingCode
  | BridgeClientConnected
  | BridgeClientDisconnected
  | BridgeHostDisconnected
  | BridgeConnected
  | BridgeError
  | BridgePing

/** Host → Client 的所有消息 */
export type BridgeHostMessage =
  | BridgeState
  | BridgeChatUserMessage
  | BridgeChatDelta
  | BridgeAgentEvent
  | BridgeAgentConfirmResolved
  | BridgeFilesChanged
  | BridgeHeartbeat
  | BridgeProjects
  | BridgeWorkspaceTree
  | BridgeFileContent
  | BridgeFileWritten
  | BridgeProjectSwitched
  | BridgeProjectStates
  | BridgeAck

/** Client → Host 的所有消息 */
export type BridgeClientMessage =
  | BridgeChatSend
  | BridgeAgentConfirm
  | BridgeAgentAbort
  | BridgeRetryResponse
  | BridgeHeartbeat
  | BridgeGetProjects
  | BridgeGetWorkspaceTree
  | BridgeFileRead
  | BridgeFileWrite
  | BridgeSwitchProject
  | BridgeRequestState
  | BridgeAck
  | BridgeRetransmitRequest
  | BridgeGetModels
  | BridgeSwitchModel
  | BridgeLoadOlderMessages
  | BridgePollTaskStatus
  | BridgeGetMessageDetail
  | BridgeGetStepDetail

/** 移动端重试确认响应 */
export interface BridgeRetryResponse {
  type: 'bridge:retry-response'
  retryId: string
  shouldRetry: boolean
}

/** 移动端主动请求当前状态快照（连接/重连后使用） */
export interface BridgeRequestState {
  type: 'bridge:request-state'
  /** 请求 ID，用于匹配响应 */
  requestId: string
}

/** 请求切换项目 */
export interface BridgeSwitchProject {
  type: 'bridge:switch-project'
  projectId: string
  sessionId?: string
}

/** 项目切换结果通知 */
export interface BridgeProjectSwitched {
  type: 'bridge:project-switched'
  projectId: string
  sessionId?: string
  workspace?: string
  modelConfigId?: string
  threadTitle?: string
}

/** 项目状态推送（Host 主动推送，无需 Client 请求） */
export interface BridgeProjectStates {
  type: 'bridge:project-states'
  states: BridgeProjectState[]
  activeThreadId?: string
  timestamp: number
}

export interface BridgeProjectState {
  id: string
  title: string
  workspace?: string
  isProcessing: boolean
  activeTaskId?: string
  lastActivityAt: number
  modelConfigId?: string
  // 新增：最后一条消息的状态（用于移动端侧边栏和消息气泡显示）
  lastMessageId?: string        // 最后一条消息 ID
  lastMessageRole?: string      // 最后一条消息角色（user/assistant）
  lastMessageHasContent?: boolean  // 最后一条消息是否有内容
  lastMessageIsStreaming?: boolean  // 最后一条消息是否正在流式输出
  lastMessageHasPlan?: boolean     // 最后一条消息是否有执行计划
}

/** 获取模型列表 */
export interface BridgeGetModels {
  type: 'bridge:get-models'
  requestId?: string
}

/** 切换模型 */
export interface BridgeSwitchModel {
  type: 'bridge:switch-model'
  modelConfigId: string
  requestId?: string
}

/** 加载更早消息 */
export interface BridgeLoadOlderMessages {
  type: 'bridge:load-older-messages'
  sessionId: string
  beforeSeq?: number
  limit?: number
  requestId?: string
}

/** 轮询任务状态 */
export interface BridgePollTaskStatus {
  type: 'bridge:poll-task-status'
  sessionId?: string
  requestId?: string
}

/** 按需加载消息详情（手机端展开历史消息时请求完整 agentSteps） */
export interface BridgeGetMessageDetail {
  type: 'bridge:get-message-detail'
  sessionId: string
  messageId: string
  requestId?: string
}

/** 按需加载步骤详情（手机端展开单个步骤时请求完整 heavy 字段） */
export interface BridgeGetStepDetail {
  type: 'bridge:get-step-detail'
  sessionId: string
  messageId: string
  stepRound: number
  requestId?: string
}

/** 所有 WebSocket 消息 */
export type BridgeMessage = BridgeControlMessage | BridgeHostMessage | BridgeClientMessage

/* ------------------------------------------------------------------ */
/*  连接状态                                                           */
/* ------------------------------------------------------------------ */

export type BridgeConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'

export interface BridgeStatus {
  status: BridgeConnectionStatus
  clientCount: number
  error?: string
  tokenExpired?: boolean
}

/* ------------------------------------------------------------------ */
/*  会员登录                                                           */
/* ------------------------------------------------------------------ */

export interface MemberLoginRequest {
  username: string
  password: string
}

export interface MemberLoginResponse {
  token: string
  member: {
    id: number
    username: string
    nickname: string
    avatar: string
    balance: number
    points: number
    level: number
    status: number
  }
}

/* ------------------------------------------------------------------ */
/*  Relay Server 配置                                                  */
/* ------------------------------------------------------------------ */

/** 默认 Relay 服务器地址 */
export const DEFAULT_RELAY_URL = 'wss://aisocket.bjctykj.com/ws'

/** 心跳间隔（毫秒） */
export const HEARTBEAT_INTERVAL_MS = 30_000

/** 心跳超时（毫秒） */
export const HEARTBEAT_TIMEOUT_MS = 90_000

/** 重连间隔（毫秒） */
export const RECONNECT_INTERVAL_MS = 3_000

/** 最大重连次数 */
export const MAX_RECONNECT_ATTEMPTS = 10
