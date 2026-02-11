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
  if (cached) return cached
  const dir = path.join(app.getPath('userData'), 'logs', key)
  fs.mkdirSync(dir, { recursive: true })
  logDirs.set(key, dir)
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
