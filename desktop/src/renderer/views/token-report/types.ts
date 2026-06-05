/**
 * Token报表工具函数和类型定义
 */

export type TokenReportEntry = {
  date: string
  threadId: string
  threadTitle: string
  model: string
  provider: string
  inputTokens: number
  outputTokens: number
  hitTokens: number
  missTokens: number
  totalTokens: number
  turns: number
  timestamp: number
}

export type ViewMode = 'daily' | 'model' | 'task' | 'daily-model'

/** 模型定价配置 (每1M tokens的价格,单位: 元) */
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'deepseek-chat': { input: 1.0, output: 5.0 },
  'deepseek-reasoner': { input: 2.0, output: 8.0 },
  'gpt-4': { input: 30.0, output: 60.0 },
  'gpt-4o': { input: 5.0, output: 15.0 },
  'claude-3-5-sonnet': { input: 3.0, output: 15.0 },
  'qwen-plus': { input: 0.8, output: 2.0 },
  'qwen-max': { input: 2.0, output: 6.0 },
  'default': { input: 1.0, output: 3.0 },
}

export function calculateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model.toLowerCase()] || MODEL_PRICING['default']
  const inputCost = (inputTokens / 1_000_000) * pricing.input
  const outputCost = (outputTokens / 1_000_000) * pricing.output
  return inputCost + outputCost
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`
  return tokens.toString()
}

export function formatCost(cost: number): string {
  return `¥${cost.toFixed(4)}`
}

export function formatDate(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
