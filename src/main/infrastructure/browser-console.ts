/**
 * 浏览器控制台日志采集模块
 * - 页面 console.error/warn/log 拦截
 * - 开发者页面错误识别 + 打分排序
 * - 按 appId 隔离存储 + 限流
 */

import type { BrowserConsoleLevel } from '../../shared/ipc-types'

/* ------------------------------------------------------------------ */
/*  类型定义                                                           */
/* ------------------------------------------------------------------ */

export type BrowserConsoleEntry = {
  id: number
  appId: string
  level: BrowserConsoleLevel
  message: string
  source?: string
  line?: number
  pageUrl?: string
  timestamp: number
  fromDevEnv: boolean
}

export type BrowserConsoleCandidate = BrowserConsoleEntry & {
  weight: number
  fingerprint: string
}

/* ------------------------------------------------------------------ */
/*  常量                                                               */
/* ------------------------------------------------------------------ */

const DEV_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1'])
const MAX_CONSOLE_LOGS_PER_APP = 500
const MAX_CONSOLE_CANDIDATES_PER_APP = 3

/* ------------------------------------------------------------------ */
/*  模块级状态                                                         */
/* ------------------------------------------------------------------ */

const browserConsoleLogsByAppId = new Map<string, BrowserConsoleEntry[]>()
const browserConsoleCandidatesByAppId = new Map<string, BrowserConsoleCandidate[]>()
let browserConsoleSeq = 0

/* ------------------------------------------------------------------ */
/*  工具函数                                                           */
/* ------------------------------------------------------------------ */

function isPrivateIpv4(hostname: string): boolean {
  const m = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  if (a === 10) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return false
}

export function isDevBrowserUrl(rawUrl?: string): boolean {
  if (!rawUrl) return false
  if (rawUrl.startsWith('webpack://') || rawUrl.startsWith('vite://')) return true
  try {
    const u = new URL(rawUrl)
    const host = u.hostname.toLowerCase()
    if (DEV_HOSTS.has(host)) return true
    if (host.endsWith('.localhost') || host.endsWith('.local')) return true
    if (isPrivateIpv4(host)) return true
    return false
  } catch {
    return false
  }
}

function scoreBrowserError(entry: BrowserConsoleEntry): number {
  let score = 0
  const msg = entry.message || ''
  if (entry.level === 'error') score += 50
  if (msg.startsWith('[页面加载失败]')) score += 60
  if (/Uncaught|Unhandled/i.test(msg)) score += 45
  if (/TypeError|ReferenceError|SyntaxError|RangeError/i.test(msg)) score += 35
  if (/CORS|ERR_|Failed to fetch|NetworkError/i.test(msg)) score += 25
  return score
}

/* ------------------------------------------------------------------ */
/*  公共 API                                                           */
/* ------------------------------------------------------------------ */

export function rememberBrowserConsole(entry: Omit<BrowserConsoleEntry, 'id' | 'timestamp' | 'fromDevEnv'>) {
  const fromDevEnv = isDevBrowserUrl(entry.pageUrl) || isDevBrowserUrl(entry.source)
  const normalized: BrowserConsoleEntry = {
    ...entry,
    id: ++browserConsoleSeq,
    timestamp: Date.now(),
    fromDevEnv,
  }

  const prev = browserConsoleLogsByAppId.get(entry.appId) ?? []
  const next = [...prev, normalized]
  browserConsoleLogsByAppId.set(
    entry.appId,
    next.length > MAX_CONSOLE_LOGS_PER_APP ? next.slice(-MAX_CONSOLE_LOGS_PER_APP) : next
  )

  const isFatal =
    normalized.level === 'error' &&
    (normalized.message.startsWith('[页面加载失败]') ||
      normalized.message.includes('Uncaught') ||
      normalized.message.includes('TypeError') ||
      normalized.message.includes('ReferenceError') ||
      normalized.message.includes('SyntaxError') ||
      normalized.message.includes('CORS') ||
      normalized.message.includes('ERR_'))
  if (!isFatal || !fromDevEnv) return

  const weight = scoreBrowserError(normalized)
  const fingerprint =
    `${normalized.appId}|${normalized.level}|${normalized.message}|${normalized.source ?? ''}|${normalized.line ?? ''}`
  const candidate: BrowserConsoleCandidate = { ...normalized, weight, fingerprint }
  const deduped = (browserConsoleCandidatesByAppId.get(entry.appId) ?? []).filter(
    (item) => item.fingerprint !== fingerprint
  )
  const ranked = [...deduped, candidate]
    .sort((a, b) => b.weight - a.weight || b.timestamp - a.timestamp)
    .slice(0, MAX_CONSOLE_CANDIDATES_PER_APP)
  browserConsoleCandidatesByAppId.set(entry.appId, ranked)
}

export function getBrowserConsoleSnapshot(options?: {
  appId?: string
  limit?: number
  levels?: BrowserConsoleLevel[]
  onlyErrors?: boolean
  devOnly?: boolean
  includeCandidates?: boolean
  clearAfterRead?: boolean
}) {
  const appId = (options?.appId || 'default').trim() || 'default'
  const limit = Math.max(1, Math.min(200, Number(options?.limit ?? 50)))
  const allowLevels =
    options?.levels && options.levels.length > 0 ? new Set(options.levels) : null
  const onlyErrors = options?.onlyErrors === true
  const devOnly = options?.devOnly !== false
  const includeCandidates = options?.includeCandidates !== false
  const clearAfterRead = options?.clearAfterRead === true

  const all = browserConsoleLogsByAppId.get(appId) ?? []
  let logs = all
  if (devOnly) logs = logs.filter((item) => item.fromDevEnv)
  if (onlyErrors) logs = logs.filter((item) => item.level === 'error')
  if (allowLevels) logs = logs.filter((item) => allowLevels.has(item.level))
  logs = logs.slice(-limit)

  const candidates = includeCandidates
    ? (browserConsoleCandidatesByAppId.get(appId) ?? []).filter(
        (item) => !devOnly || item.fromDevEnv
      )
    : []

  if (clearAfterRead) {
    const consumedIds = new Set<number>([
      ...logs.map((item) => item.id),
      ...candidates.map((item) => item.id),
    ])
    if (consumedIds.size > 0) {
      const remainedLogs = all.filter((item) => !consumedIds.has(item.id))
      if (remainedLogs.length > 0) browserConsoleLogsByAppId.set(appId, remainedLogs)
      else browserConsoleLogsByAppId.delete(appId)

      const allCandidates = browserConsoleCandidatesByAppId.get(appId) ?? []
      const remainedCandidates = allCandidates.filter((item) => !consumedIds.has(item.id))
      if (remainedCandidates.length > 0)
        browserConsoleCandidatesByAppId.set(appId, remainedCandidates)
      else browserConsoleCandidatesByAppId.delete(appId)
    }
  }

  return {
    appId,
    totalStored: all.length,
    returned: logs.length,
    filters: {
      limit,
      onlyErrors,
      devOnly,
      levels: allowLevels ? Array.from(allowLevels) : undefined,
      clearAfterRead,
    },
    logs,
    topCandidates: candidates,
  }
}
