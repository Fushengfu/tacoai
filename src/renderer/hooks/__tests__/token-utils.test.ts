import { describe, it, expect } from 'vitest'
import {
  toFiniteTokenCount,
  normalizeProjectTokenStatsMap,
  mergeUsageSnapshot,
  resolveUsageTotalTokens,
  usageToAggregate,
  diffUsageAggregate,
  hasUsageDelta,
  applyUsageDeltaToProjectStats,
} from '../token-utils'
import type { ProjectTokenStats, TokenUsageSnapshot } from '../token-utils'

/* ================================================================== */
/*  toFiniteTokenCount                                                  */
/* ================================================================== */

describe('toFiniteTokenCount', () => {
  it('正整数正常返回', () => {
    expect(toFiniteTokenCount(100)).toBe(100)
    expect(toFiniteTokenCount(0)).toBe(0)
  })

  it('浮点数取整', () => {
    expect(toFiniteTokenCount(99.9)).toBe(99)
  })

  it('负数返回 undefined', () => {
    expect(toFiniteTokenCount(-1)).toBeUndefined()
  })

  it('NaN 返回 undefined', () => {
    expect(toFiniteTokenCount(NaN)).toBeUndefined()
  })

  it('Infinity 返回 undefined', () => {
    expect(toFiniteTokenCount(Infinity)).toBeUndefined()
  })

  it('字符串数字正常转换', () => {
    expect(toFiniteTokenCount('42')).toBe(42)
  })

  it('非数字字符串返回 undefined', () => {
    expect(toFiniteTokenCount('abc')).toBeUndefined()
  })

  it('null 转为 0，undefined 返回 undefined', () => {
    expect(toFiniteTokenCount(null)).toBe(0) // Number(null) = 0
    expect(toFiniteTokenCount(undefined)).toBeUndefined()
  })
})

/* ================================================================== */
/*  normalizeProjectTokenStatsMap                                       */
/* ================================================================== */

describe('normalizeProjectTokenStatsMap', () => {
  it('空对象返回空对象', () => {
    expect(normalizeProjectTokenStatsMap({})).toEqual({})
  })

  it('正常数据完整映射', () => {
    const raw = {
      thread1: {
        inputTokens: 100,
        outputTokens: 50,
        hitTokens: 30,
        missTokens: 70,
        totalTokens: 150,
        turns: 5,
        updatedAt: 1700000000000,
      },
    }
    const result = normalizeProjectTokenStatsMap(raw)
    expect(result['thread1']).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      hitTokens: 30,
      missTokens: 70,
      totalTokens: 150,
      turns: 5,
      updatedAt: 1700000000000,
    })
  })

  it('缺失字段补 0', () => {
    const raw = { t1: { inputTokens: 42 } }
    const result = normalizeProjectTokenStatsMap(raw)
    const stats = result['t1']
    expect(stats.inputTokens).toBe(42)
    expect(stats.outputTokens).toBe(0)
    expect(stats.hitTokens).toBe(0)
    expect(stats.missTokens).toBe(0)
    expect(stats.totalTokens).toBe(0)
    expect(stats.turns).toBe(0)
  })

  it('跳过空 key 的条目', () => {
    const raw = { '  ': { inputTokens: 1 } }
    expect(normalizeProjectTokenStatsMap(raw)).toEqual({})
  })

  it('跳过非对象值', () => {
    const raw = { t1: 'not-an-object' }
    expect(normalizeProjectTokenStatsMap(raw)).toEqual({})
  })

  it('updatedAt 缺失时默认当前时间戳', () => {
    const before = Date.now()
    const raw = { t1: { inputTokens: 10 } }
    const result = normalizeProjectTokenStatsMap(raw)
    expect(result['t1'].updatedAt).toBeGreaterThanOrEqual(before)
  })
})

/* ================================================================== */
/*  mergeUsageSnapshot                                                  */
/* ================================================================== */

describe('mergeUsageSnapshot', () => {
  it('prev 为 null 且 next 有效时返回 next', () => {
    const next: TokenUsageSnapshot = { promptTokens: 100, completionTokens: 50 }
    const result = mergeUsageSnapshot(null, next)
    expect(result).toEqual({ promptTokens: 100, completionTokens: 50 })
  })

  it('next 覆盖 prev 同名字段', () => {
    const prev: TokenUsageSnapshot = { promptTokens: 100, totalTokens: 200 }
    const next: TokenUsageSnapshot = { promptTokens: 150 }
    const result = mergeUsageSnapshot(prev, next)
    expect(result?.promptTokens).toBe(150)
    expect(result?.totalTokens).toBe(200) // 未被覆盖，保留
  })

  it('next 为 undefined 返回 prev', () => {
    const prev: TokenUsageSnapshot = { totalTokens: 300 }
    expect(mergeUsageSnapshot(prev, undefined)).toEqual(prev)
  })

  it('next 全部字段为空时保留 prev', () => {
    const prev: TokenUsageSnapshot = { totalTokens: 100 }
    const next: TokenUsageSnapshot = {}
    expect(mergeUsageSnapshot(prev, next)).toEqual(prev)
  })
})

/* ================================================================== */
/*  resolveUsageTotalTokens                                             */
/* ================================================================== */

describe('resolveUsageTotalTokens', () => {
  it('totalTokens 存在时直接返回', () => {
    expect(resolveUsageTotalTokens({ totalTokens: 500 })).toBe(500)
  })

  it('totalTokens 不存在时由 prompt + completion 计算', () => {
    expect(resolveUsageTotalTokens({ promptTokens: 300, completionTokens: 200 })).toBe(500)
  })

  it('prompt + completion 为 0 返回 undefined', () => {
    expect(resolveUsageTotalTokens({ promptTokens: 0, completionTokens: 0 })).toBeUndefined()
  })

  it('null 返回 undefined', () => {
    expect(resolveUsageTotalTokens(null)).toBeUndefined()
  })
})

/* ================================================================== */
/*  usageToAggregate                                                    */
/* ================================================================== */

describe('usageToAggregate', () => {
  it('完整快照正确转换', () => {
    const usage: TokenUsageSnapshot = {
      promptTokens: 1000,
      completionTokens: 300,
      cachedTokens: 400,
      totalTokens: 1300,
    }
    const agg = usageToAggregate(usage)
    expect(agg.inputTokens).toBe(1000)
    expect(agg.outputTokens).toBe(300)
    expect(agg.hitTokens).toBe(400)
    expect(agg.missTokens).toBe(600) // prompt - cached
    expect(agg.totalTokens).toBe(1300)
  })

  it('无 totalTokens 时自动计算', () => {
    const usage: TokenUsageSnapshot = { promptTokens: 500, completionTokens: 200 }
    const agg = usageToAggregate(usage)
    expect(agg.totalTokens).toBe(700)
  })

  it('cachedTokens 不超过 promptTokens', () => {
    const usage: TokenUsageSnapshot = { promptTokens: 100, cachedTokens: 999 }
    const agg = usageToAggregate(usage)
    expect(agg.hitTokens).toBe(100)
    expect(agg.missTokens).toBe(0)
  })

  it('null 返回全零', () => {
    const agg = usageToAggregate(null)
    expect(agg).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      hitTokens: 0,
      missTokens: 0,
      totalTokens: 0,
    })
  })
})

/* ================================================================== */
/*  diffUsageAggregate                                                  */
/* ================================================================== */

describe('diffUsageAggregate', () => {
  it('正确计算差值', () => {
    const next = {
      inputTokens: 200,
      outputTokens: 80,
      hitTokens: 50,
      missTokens: 150,
      totalTokens: 280,
    }
    const prev = {
      inputTokens: 100,
      outputTokens: 30,
      hitTokens: 20,
      missTokens: 80,
      totalTokens: 130,
    }
    const delta = diffUsageAggregate(next, prev)
    expect(delta.inputTokens).toBe(100)
    expect(delta.outputTokens).toBe(50)
    expect(delta.hitTokens).toBe(30)
    expect(delta.missTokens).toBe(70)
    expect(delta.totalTokens).toBe(150)
  })

  it('next 小于 prev 时差值归零（不出现负值）', () => {
    const next = { inputTokens: 50, outputTokens: 10, hitTokens: 5, missTokens: 45, totalTokens: 60 }
    const prev = { inputTokens: 100, outputTokens: 20, hitTokens: 10, missTokens: 90, totalTokens: 120 }
    const delta = diffUsageAggregate(next, prev)
    expect(delta.inputTokens).toBe(0)
    expect(delta.outputTokens).toBe(0)
    expect(delta.totalTokens).toBe(0)
  })
})

/* ================================================================== */
/*  hasUsageDelta                                                       */
/* ================================================================== */

describe('hasUsageDelta', () => {
  it('有差异返回 true', () => {
    expect(hasUsageDelta({ inputTokens: 10, outputTokens: 0, hitTokens: 0, missTokens: 0, totalTokens: 10 })).toBe(true)
  })

  it('全零返回 false', () => {
    expect(hasUsageDelta({ inputTokens: 0, outputTokens: 0, hitTokens: 0, missTokens: 0, totalTokens: 0 })).toBe(false)
  })
})

/* ================================================================== */
/*  applyUsageDeltaToProjectStats                                       */
/* ================================================================== */

describe('applyUsageDeltaToProjectStats', () => {
  const base: ProjectTokenStats = {
    inputTokens: 1000,
    outputTokens: 500,
    hitTokens: 200,
    missTokens: 800,
    totalTokens: 1500,
    turns: 10,
    updatedAt: 1700000000000,
  }

  it('正确累加 delta', () => {
    const delta = {
      inputTokens: 100,
      outputTokens: 50,
      hitTokens: 30,
      missTokens: 70,
      totalTokens: 150,
    }
    const result = applyUsageDeltaToProjectStats(base, delta, false)
    expect(result.inputTokens).toBe(1100)
    expect(result.outputTokens).toBe(550)
    expect(result.totalTokens).toBe(1650)
    expect(result.turns).toBe(10) // incrementTurn=false
  })

  it('incrementTurn=true 时 turns +1', () => {
    const delta = { inputTokens: 0, outputTokens: 0, hitTokens: 0, missTokens: 0, totalTokens: 0 }
    const result = applyUsageDeltaToProjectStats(base, delta, true)
    expect(result.turns).toBe(11)
  })

  it('updatedAt 更新为当前时间', () => {
    const before = Date.now()
    const delta = { inputTokens: 0, outputTokens: 0, hitTokens: 0, missTokens: 0, totalTokens: 0 }
    const result = applyUsageDeltaToProjectStats(base, delta, false)
    expect(result.updatedAt).toBeGreaterThanOrEqual(before)
  })
})
