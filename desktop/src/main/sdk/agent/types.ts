/**
 * Agent SDK 类型定义
 *
 * Agent 领域类型和事件类型。SDK 内部定义，外部按需从 SDK 引用。
 * 独立文件避免 context-compressor 与 agent-loop 之间的循环依赖。
 */

import type { ToolCall, ToolResult, RiskInfo } from './tools'
import type { TokenUsage } from './llm/client'

/* ------------------------------------------------------------------ */
/*  SDK Domain Types                                                   */
/* ------------------------------------------------------------------ */

/** 计划步骤状态 */
export type PlanStepStatus = 'pending' | 'in_progress' | 'done' | 'failed'

/** 笔记分类 */
export type NoteCategory = 'convention' | 'credential' | 'architecture' | 'config' | 'other'

/** 项目笔记 */
export type ProjectNote = {
  id: string
  title: string
  content: string
  category: NoteCategory
  createdAt: string
  updatedAt: string
}

/** 任务执行记忆 */
export type ProjectTaskMemory = {
  id: string
  userQuery: string
  userAssetsBlock?: string
  assistantResult: string
  outcome: 'success' | 'aborted' | 'error'
  tools: string[]
  changedFiles: string[]
  fileDiffs: Array<{
    path: string
    oldContent: string | null
    newContent: string | null
  }>
  failures: string[]
  sourceSessionId?: string
  sourceUserMessageId?: string
  sourceAssistantMessageId?: string
  sourceMessageIds?: string[]
  sourceStartSeq?: number
  sourceEndSeq?: number
  deletedAt?: string
  deletedReason?: string
  mergedIntoId?: string
  createdAt: string
  updatedAt: string
}

/** 记忆范围统计 */
export type MemoryScopeStats = {
  scope: string
  dbPath: string
  dbSizeBytes: number
  manualNotes: number
  activeTaskMemories: number
  archivedTaskMemories: number
  deletedTaskMemories: number
  snapshots: number
  maintainRuns: number
  latestNoteUpdatedAt?: string
  latestTaskMemoryUpdatedAt?: string
  latestSnapshotUpdatedAt?: string
}

/** 记忆范围导出结果 */
export type MemoryScopeExportResult = {
  filePath: string
  exportedAt: string
  manualNotes: number
  activeTaskMemories: number
  archivedTaskMemories: number
  snapshots: number
}

/** Skill 定义 */
export type SkillInfo = {
  id: string
  name: string
  description: string
  version: string
  author: string
  source: 'builtin' | 'local' | 'remote'
  sourceUrl?: string
  enabled: boolean
  instructions: string
  tools?: string[]
  resources?: string[]
  tags?: string[]
  category?: string
  homepage?: string
  license?: string
}

/** Skill 预览信息 */
export type SkillPreview = {
  id: string
  name: string
  description: string
  version: string
  author: string
  category?: string
  tags?: string[]
  homepage?: string
  license?: string
  tools?: string[]
  resources?: string[]
  requiresBins?: string[]
  requiresEnv?: string[]
  sourceUrl: string
  security?: {
    riskLevel: 'low' | 'medium' | 'high' | 'critical'
    warnings: string[]
  }
}

/** 浏览器使用操作类型 */
export type BrowserActionType =
  | 'navigate'
  | 'screenshot'
  | 'click'
  | 'type'
  | 'scroll'
  | 'hover'
  | 'keypress'
  | 'drag'
  | 'select'
  | 'get_content'
  | 'wait'
  | 'evaluate'
  | 'get_info'

/** LLM 提供商 ID */
export type ProviderId = 'deepseek' | 'kimi' | 'minimax' | 'glm' | 'qwen' | 'mimo' | 'anthropic' | 'openai' | (string & {})

/* ------------------------------------------------------------------ */
/*  Agent Events                                                       */
/* ------------------------------------------------------------------ */

export type AgentEvent =
  | { type: 'text'; content: string }
  | { type: 'reasoning'; content: string }
  | { type: 'tool_calls'; toolCalls: ToolCall[]; thinking?: string }
  | { type: 'system_notice'; title: string; message?: string }
  | { type: 'confirm'; confirmId: string; toolCalls: ToolCall[]; risks: RiskInfo[] }
  | { type: 'tool_results'; results: ToolResult[] }
  | { type: 'git_commit'; hash: string; message: string }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'plan_init'; summary: string; steps: Array<{ index: number; title: string; content: string }>; reasoning?: string }
  | { type: 'plan_progress'; stepIndex: number; status: PlanStepStatus; note?: string }
  | {
      type: 'retry_confirm'
      retryId: string
      errorType: 'network' | 'timeout' | 'empty_response' | 'interrupted'
      errorMessage: string
      round: number
    }
  | { type: 'done'; finalText?: string }
  | { type: 'error'; message: string }
