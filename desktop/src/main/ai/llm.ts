/**
 * LLM 客户端 - 向后兼容 re-export
 *
 * 实际代码已迁移到 services/llm/llm-client.ts
 */

export * from '../services/llm/llm-client'
export { parseMessagesToStandard, adaptMessagesForProvider } from '../services/llm'
