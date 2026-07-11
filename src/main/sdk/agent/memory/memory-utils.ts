/**
 * 记忆系统通用工具函数
 *
 * 从 notes.ts 提取的基础工具函数，不依赖其他记忆模块。
 */

import fs from 'node:fs/promises'

/* ------------------------------------------------------------------ */
/*  文本处理                                                             */
/* ------------------------------------------------------------------ */

export function shortText(input: string, max: number): string {
  const text = String(input ?? '').replace(/\r/g, '').trim()
  if (!text) return ''
  return text.length <= max ? text : `${text.slice(0, max)}...`
}

export function stripControlChars(input: string): string {
  return String(input ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
}

export function normalizeStringList(value: unknown, max = 120): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((x) => String(x ?? '').trim()).filter(Boolean))].slice(0, max)
}

export function normalizeStringArray(value: unknown, limit = 24): string[] {
  if (!Array.isArray(value)) return []
  const dedup = new Set<string>()
  for (const item of value) {
    const text = String(item ?? '').trim()
    if (!text) continue
    dedup.add(text)
    if (dedup.size >= limit) break
  }
  return [...dedup]
}

export function compactJoin(items: string[], limit: number): string {
  const cleaned = [...new Set(items.map((x) => String(x || '').trim()).filter(Boolean))]
  if (cleaned.length === 0) return ''
  if (cleaned.length <= limit) return cleaned.join('、')
  return `${cleaned.slice(0, limit).join('、')} 等${cleaned.length}项`
}

export function toText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

export function normalizeIso(input: unknown): string {
  const text = String(input ?? '').trim()
  const ts = Date.parse(text)
  if (Number.isFinite(ts)) return new Date(ts).toISOString()
  return ''
}

export function normalizeOutcome(value: unknown): 'success' | 'aborted' | 'error' {
  const outcome = String(value ?? '').trim()
  if (outcome === 'success' || outcome === 'aborted' || outcome === 'error') return outcome
  return 'success'
}

/* ------------------------------------------------------------------ */
/*  JSON 解析                                                            */
/* ------------------------------------------------------------------ */

export function safeParseObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    return null
  } catch {
    return null
  }
}

export function safeParseObjectFromText(raw: string): Record<string, unknown> | null {
  const direct = safeParseObject(raw.trim())
  if (direct) return direct
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced && fenced[1]) {
    const parsed = safeParseObject(fenced[1].trim())
    if (parsed) return parsed
  }
  const braces = raw.match(/\{[\s\S]*\}/)
  if (braces && braces[0]) {
    const parsed = safeParseObject(braces[0].trim())
    if (parsed) return parsed
  }
  return null
}

/* ------------------------------------------------------------------ */
/*  文件读写                                                             */
/* ------------------------------------------------------------------ */

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

export async function readJsonArray<T>(filePath: string): Promise<T[]> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

/* ------------------------------------------------------------------ */
/*  时间辅助                                                             */
/* ------------------------------------------------------------------ */

export function latestIso(values: Array<string | undefined>): string | undefined {
  let latestTs = 0
  let latestValue = ''
  for (const value of values) {
    const text = String(value || '').trim()
    const ts = Date.parse(text)
    if (Number.isFinite(ts) && ts >= latestTs) {
      latestTs = ts
      latestValue = new Date(ts).toISOString()
    }
  }
  return latestValue || undefined
}
