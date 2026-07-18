export type ProjectTokenStats = {
  inputTokens: number
  outputTokens: number
  hitTokens: number
  missTokens: number
  totalTokens: number
  turns: number
  updatedAt: number
}

/** 本轮次任务循环累计 token 统计 */
export type RunTokenStats = {
  inputTokens: number
  hitTokens: number
  outputTokens: number
}

export type TokenUsageSnapshot = {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  cachedTokens?: number
}

type UsageAggregate = {
  inputTokens: number
  outputTokens: number
  hitTokens: number
  missTokens: number
  totalTokens: number
}

export function toFiniteTokenCount(value: unknown): number | undefined {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return undefined
  return Math.floor(n)
}

export function normalizeProjectTokenStatsMap(raw: Record<string, unknown>): Record<string, ProjectTokenStats> {
  const out: Record<string, ProjectTokenStats> = {}
  for (const [threadId, value] of Object.entries(raw ?? {})) {
    if (!threadId.trim() || !value || typeof value !== 'object') continue
    const obj = value as Record<string, unknown>
    const inputTokens = toFiniteTokenCount(obj.inputTokens) ?? 0
    const outputTokens = toFiniteTokenCount(obj.outputTokens) ?? 0
    const hitTokens = toFiniteTokenCount(obj.hitTokens) ?? 0
    const missTokens = toFiniteTokenCount(obj.missTokens) ?? 0
    const totalTokens = toFiniteTokenCount(obj.totalTokens) ?? 0
    const turns = toFiniteTokenCount(obj.turns) ?? 0
    const updatedAt = toFiniteTokenCount(obj.updatedAt) ?? Date.now()
    out[threadId] = { inputTokens, outputTokens, hitTokens, missTokens, totalTokens, turns, updatedAt }
  }
  return out
}

export function mergeUsageSnapshot(
  prev: TokenUsageSnapshot | null,
  next: TokenUsageSnapshot | undefined,
): TokenUsageSnapshot | null {
  if (!next || typeof next !== 'object') return prev
  const promptTokens = toFiniteTokenCount(next.promptTokens)
  const completionTokens = toFiniteTokenCount(next.completionTokens)
  const totalTokens = toFiniteTokenCount(next.totalTokens)
  const cachedTokens = toFiniteTokenCount(next.cachedTokens)

  const merged: TokenUsageSnapshot = { ...(prev ?? {}) }
  if (promptTokens !== undefined) merged.promptTokens = promptTokens
  if (completionTokens !== undefined) merged.completionTokens = completionTokens
  if (totalTokens !== undefined) merged.totalTokens = totalTokens
  if (cachedTokens !== undefined) merged.cachedTokens = cachedTokens

  const hasAny =
    merged.promptTokens !== undefined
    || merged.completionTokens !== undefined
    || merged.totalTokens !== undefined
    || merged.cachedTokens !== undefined
  return hasAny ? merged : prev
}

export function resolveUsageTotalTokens(usage: TokenUsageSnapshot | null): number | undefined {
  if (!usage) return undefined
  if (usage.totalTokens !== undefined) return usage.totalTokens
  const prompt = usage.promptTokens ?? 0
  const completion = usage.completionTokens ?? 0
  const fallback = prompt + completion
  return fallback > 0 ? fallback : undefined
}

export function usageToAggregate(usage: TokenUsageSnapshot | null): UsageAggregate {
  if (!usage) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      hitTokens: 0,
      missTokens: 0,
      totalTokens: 0,
    }
  }
  const prompt = usage.promptTokens ?? 0
  const completion = usage.completionTokens ?? 0
  const cached = Math.min(prompt, usage.cachedTokens ?? 0)
  const miss = Math.max(0, prompt - cached)
  const total = resolveUsageTotalTokens(usage) ?? (prompt + completion)
  return {
    inputTokens: Math.max(0, prompt),
    outputTokens: Math.max(0, completion),
    hitTokens: Math.max(0, cached),
    missTokens: Math.max(0, miss),
    totalTokens: Math.max(0, total),
  }
}

export function diffUsageAggregate(next: UsageAggregate, prev: UsageAggregate): UsageAggregate {
  return {
    inputTokens: Math.max(0, next.inputTokens - prev.inputTokens),
    outputTokens: Math.max(0, next.outputTokens - prev.outputTokens),
    hitTokens: Math.max(0, next.hitTokens - prev.hitTokens),
    missTokens: Math.max(0, next.missTokens - prev.missTokens),
    totalTokens: Math.max(0, next.totalTokens - prev.totalTokens),
  }
}

export function hasUsageDelta(delta: UsageAggregate): boolean {
  return delta.inputTokens > 0
    || delta.outputTokens > 0
    || delta.hitTokens > 0
    || delta.missTokens > 0
    || delta.totalTokens > 0
}

export function applyUsageDeltaToProjectStats(base: ProjectTokenStats, delta: UsageAggregate, incrementTurn: boolean): ProjectTokenStats {
  return {
    inputTokens: base.inputTokens + delta.inputTokens,
    outputTokens: base.outputTokens + delta.outputTokens,
    hitTokens: base.hitTokens + delta.hitTokens,
    missTokens: base.missTokens + delta.missTokens,
    totalTokens: base.totalTokens + delta.totalTokens,
    turns: base.turns + (incrementTurn ? 1 : 0),
    updatedAt: Date.now(),
  }
}
