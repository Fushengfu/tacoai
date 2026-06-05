/**
 * Agent 循环 - Barrel File（向后兼容）
 *
 * 实际代码已迁移到 services/agent/agent-loop.ts
 * error-handler 在 services/agent/error-handler.ts
 * agent 类型定义在 services/agent/agent-types.ts
 */

export { runAgent } from '../services/agent/agent-loop'
export { resolveConfirm, resolveRetry, isAbortError } from '../services/agent/error-handler'
export type { AgentEvent } from '../services/agent/agent-types'
