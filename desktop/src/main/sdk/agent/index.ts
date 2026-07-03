/**
 * Agent SDK — 统一入口
 *
 * 封装了完整的 Agent 能力：多轮工具调用、上下文压缩、记忆回放、
 * 技能系统、Git 自动操作、流式事件推送。
 *
 * 使用方法：
 * ```ts
 * import { createAgent } from './sdk/agent'
 *
 * const agent = createAgent({
 *   provider: 'openai',
 *   workspace: '/path/to/project',
 *   projectId: 'my-project',
 *   onEvent: (event) => console.log(event),
 * })
 *
 * await agent.sendMessage('帮我重构这个文件')
 * agent.stop()
 * ```
 */

// ─── 核心入口 ──────────────────────────────────────────────────────────────

export { runAgent, bootstrapAgentMemory } from './loop'
export { createAgent } from './create-agent'
export type { AgentInstance, AgentConfig, AgentStatus } from './create-agent'

// ─── 类型导出 ──────────────────────────────────────────────────────────────

export type { AgentEvent } from './types'
export type { ChatMessage, ProviderOverrides, TokenUsage, ProviderKey } from './llm/client'
export type { ToolCall, ToolResult, ToolDefinition, FileChange } from './tools/definitions'
export type { RiskInfo, RiskLevel, RiskCategory, AuthLevel } from './tools/risk'

// ─── 错误处理 ──────────────────────────────────────────────────────────────

export { resolveConfirm, resolveRetry, isAbortError } from './error-handler'

// ─── 奖励评分 ──────────────────────────────────────────────────────────────

export { applyRewardScore } from './reward'

// ─── 上下文压缩 ────────────────────────────────────────────────────────────

export { compactLine, maskSensitiveText, summarizeRunCommand, extractIdentifiers, truncateToolResultForContext } from './context/compressor'

// ─── 完成校验 ──────────────────────────────────────────────────────────────

export { validateCompletionClaim } from './context/builder'
