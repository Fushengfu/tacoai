export type ThreadMode = 'chat' | 'agent'
export type ThemeMode = 'dark' | 'ocean' | 'graphite'

/** 项目内的一个会话 */
export type Session = {
  id: string
  title: string
  createdAt: number
}

/** 项目（左侧栏条目），一个项目可包含多个会话 */
export type Thread = {
  id: string
  title: string
  /** 用户手动改名后锁定，自动命名不再覆盖 */
  titleLocked?: boolean
  updatedAt: number
  /** 该项目使用的模型 */
  provider?: ProviderId
  /** 会话模式：chat（纯聊天）或 agent（带工具调用） */
  mode?: ThreadMode
  /** Agent 模式的工作空间目录 */
  workspace?: string
  /** 当前项目的自定义规则，会自动注入到 system prompt */
  projectRules?: string
  /** 项目内的所有会话 */
  sessions: Session[]
  /** 当前激活的会话 ID */
  activeSessionId: string
}

/** 工具调用信息（展示用） */
export type ToolCallInfo = {
  id: string
  name: string
  arguments: string
}

/** 文件变更审核状态 */
export type FileChangeStatus = 'pending' | 'accepted' | 'rejected'

/** 文件变更类型 */
export type FileChangeType = 'create' | 'modify' | 'delete'

/** 文件变更信息（展示用） */
export type FileChangeInfo = {
  filePath: string
  /** null 表示新建文件（之前不存在） */
  oldContent: string | null
  /** null 表示文件被删除 */
  newContent: string | null
}

/** 工具执行结果（展示用） */
export type ToolResultInfo = {
  tool_call_id: string
  name: string
  content: string
  success: boolean
  /** write_file 时携带文件变更 */
  fileChange?: FileChangeInfo
}

/** 风险信息（展示用） */
export type RiskInfo = {
  toolCallId: string
  toolName: string
  level: 'safe' | 'warning' | 'danger'
  reason: string
  detail: string
}

/**
 * Agent 模式的一个执行步骤
 * 一个步骤 = AI 思考文本 + 工具调用 + 工具结果
 */
export type AgentStep = {
  /** 步骤序号（从 1 开始） */
  round: number
  /** AI 在调用工具前的思考/推理文本（可为空） */
  thinking: string
  /** 该步骤的工具调用列表 */
  toolCalls: ToolCallInfo[]
  /** 工具执行结果 */
  toolResults: ToolResultInfo[]
  /** 步骤状态: confirm 表示等待用户确认 */
  status: 'calling' | 'running' | 'confirm' | 'done'
  /** 需要确认时的风险信息 */
  risks?: RiskInfo[]
  /** 确认请求 ID */
  confirmId?: string
}

/** 计划步骤信息（实时追踪用） */
export type PlanStepInfo = {
  text: string
  status: 'pending' | 'in_progress' | 'done' | 'failed'
  note?: string
}

/** 活跃的执行计划（实时追踪用） */
export type ActivePlan = {
  summary: string
  reasoning?: string
  steps: PlanStepInfo[]
  /** 计划开始时间（毫秒时间戳） */
  startedAt?: number
  /** 计划结束时间（毫秒时间戳） */
  endedAt?: number
}

/** 单轮任务耗时（从用户发起到本轮 assistant 完成/失败/停止） */
export type TaskTiming = {
  startedAt: number
  endedAt?: number
  durationMs?: number
}

/** 用户附带的图片 */
export type AttachedImage = {
  /** 唯一 ID */
  id: string
  /** base64 data URL（如 data:image/png;base64,...） */
  dataUrl: string
  /** 文件名（展示用） */
  name: string
}

export type ChatMsg = {
  id: string
  role: 'system' | 'user' | 'assistant'
  content: string
  /** 用户消息附带的图片 */
  images?: AttachedImage[]
  /** Agent 模式：执行步骤（思考 + 工具调用 + 结果），只在最终 assistant 消息上 */
  agentSteps?: AgentStep[]
  /** Agent 完成后自动提交的 Git commit hash（用于版本回退） */
  gitCommitHash?: string
  /** 活跃的执行计划（实时追踪步骤状态） */
  activePlan?: ActivePlan
  /** 单轮任务耗时（仅 assistant 消息） */
  taskTiming?: TaskTiming
  /** 兼容旧数据 */
  toolCalls?: ToolCallInfo[]
  toolResults?: ToolResultInfo[]
}

export type ProviderId = 'deepseek' | 'kimi' | 'minimax' | 'glm'

export type ProviderForm = {
  baseUrl: string
  apiKey: string
  model: string
  maxTokens: string
}

export type ProviderForms = Record<ProviderId, ProviderForm>

export type GuiPlusForm = {
  baseUrl: string
  apiKey: string
  model: string
  minPixels: string
  maxPixels: string
  highResolution: boolean
  includeUsage: boolean
}

export type QueuedMessage = {
  id: string
  content: string
}

/**
 * Git 版本提交记录
 * 由本地 Git 仓库管理，Agent 每次文件变更自动提交
 */
export type GitVersionCommit = {
  /** Git commit hash（完整） */
  hash: string
  /** Git commit hash（短） */
  shortHash: string
  /** 提交摘要 */
  message: string
  /** 提交时间（Unix 秒） */
  timestamp: number
  /** 变更文件数量 */
  fileCount: number
  /** 展开时加载的变更文件列表 */
  files?: string[]
}
