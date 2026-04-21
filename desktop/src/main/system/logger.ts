/**
 * 日志服务
 *
 * 将 AI 请求和响应的原始完整数据记录到本地日志文件。
 * 日志文件按天滚动，按项目隔离存放在 userData/logs/{scope}/ 目录下。
 */

import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { createHash } from 'node:crypto'

/* ------------------------------------------------------------------ */
/*  日志目录                                                            */
/* ------------------------------------------------------------------ */

const logDirs = new Map<string, string>()
const cleanedAtByScope = new Map<string, number>()
const LOG_RETENTION_MS = 24 * 60 * 60 * 1000 // 仅保留最近 24 小时
const CLEANUP_COOLDOWN_MS = 5 * 60 * 1000

function normalizeScope(scope?: string): string {
  if (!scope) return 'global'
  const s = scope.trim()
  if (!s) return 'global'
  // 使用 hash 避免目录名包含非法字符或过长
  return createHash('sha256').update(s).digest('hex').slice(0, 16)
}

function ensureLogDir(scope?: string) {
  const key = normalizeScope(scope)
  const cached = logDirs.get(key)
  const dir = cached ?? path.join(app.getPath('userData'), 'logs', key)
  if (!cached) {
    fs.mkdirSync(dir, { recursive: true })
    logDirs.set(key, dir)
  }
  cleanupExpiredLogs(dir, key)
  return dir
}

function getLogFile(scope?: string): string {
  const date = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  return path.join(ensureLogDir(scope), `taco-${date}.log`)
}

/* ------------------------------------------------------------------ */
/*  写入                                                                */
/* ------------------------------------------------------------------ */

function appendLog(content: string, scope?: string) {
  try {
    fs.appendFileSync(getLogFile(scope), content + '\n', 'utf-8')
  } catch {
    // 写日志失败不应中断主流程
  }
}

function cleanupExpiredLogs(dir: string, scopeKey: string) {
  const now = Date.now()
  const last = cleanedAtByScope.get(scopeKey) ?? 0
  if (now - last < CLEANUP_COOLDOWN_MS) return
  cleanedAtByScope.set(scopeKey, now)

  try {
    const files = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of files) {
      if (!entry.isFile()) continue
      if (!entry.name.startsWith('taco-') || !entry.name.endsWith('.log')) continue
      const filePath = path.join(dir, entry.name)
      let ts = Number.NaN
      const m = entry.name.match(/^taco-(\d{4})-(\d{2})-(\d{2})\.log$/)
      if (m) {
        const y = Number(m[1])
        const mm = Number(m[2]) - 1
        const d = Number(m[3])
        // 文件名日期来自 toISOString()，按 UTC 解析可避免时区导致的提前清理
        ts = Date.UTC(y, mm, d)
      }
      if (!Number.isFinite(ts)) {
        try {
          ts = fs.statSync(filePath).mtimeMs
        } catch {
          continue
        }
      }
      if (now - ts > LOG_RETENTION_MS) {
        try {
          fs.unlinkSync(filePath)
        } catch {
          // ignore cleanup failures
        }
      }
    }
  } catch {
    // ignore cleanup failures
  }
}

/* ------------------------------------------------------------------ */
/*  公开 API                                                            */
/* ------------------------------------------------------------------ */

/**
 * 写入一条日志，原始完整记录，不截断。
 *
 * @param tag   日志标签，如 REQUEST / RESPONSE / ERROR
 * @param data  任意数据，将完整序列化为 JSON 写入
 */
export function log(tag: string, data: unknown, scope?: string) {
  const time = new Date().toISOString()
  const json = JSON.stringify(data, null, 2)
  appendLog(`[${time}] [${tag}]\n${json}\n`, scope)
}

/** 记录通用信息 */
export function logInfo(tag: string, message: string, data?: unknown, scope?: string) {
  const time = new Date().toISOString()
  const extra = data !== undefined ? `\n${JSON.stringify(data, null, 2)}` : ''
  appendLog(`[${time}] [INFO] [${tag}] ${message}${extra}\n`, scope)
}

/** 记录错误 */
export function logError(tag: string, message: string, error?: unknown, scope?: string) {
  const time = new Date().toISOString()
  let errStr = ''
  if (error instanceof Error) {
    errStr = `\n  Message: ${error.message}\n  Stack: ${error.stack}`
  } else if (error !== undefined) {
    errStr = `\n  ${JSON.stringify(error)}`
  }
  appendLog(`[${time}] [ERROR] [${tag}] ${message}${errStr}\n`, scope)
}

/** 获取日志目录路径 */
export function getLogDir(scope?: string): string {
  return ensureLogDir(scope)
}
