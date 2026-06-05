/**
 * Agent 事件类型
 *
 * Agent 循环中通过 callback 向调用方推送的所有事件类型。
 * 独立文件避免 context-compressor 与 agent-loop 之间的循环依赖。
 */

import type { ToolCall, ToolResult, RiskInfo } from '../../tools'
import type { TokenUsage } from '../../ai/llm'
import type { PlanStepStatus } from '../../../shared/ipc'

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
