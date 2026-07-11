/**
 * 截图路径提取工具函数
 * 
 * 从 Agent 消息内容中提取截图路径的工具函数
 */

import type { ChatMsg } from '../types'
import { normalizeSlashPath } from './path-utils'

/** 规范化截图路径 */
function normalizeScreenshotPath(raw: unknown): string | null {
  const text = String(raw ?? '').trim()
  if (!text) return null
  if (text.startsWith('/')) return text
  if (/^[a-zA-Z]:[\\/]/.test(text)) return text
  if (text.startsWith('\\\\')) return text
  return null
}

/** 从工具结果内容中提取截图路径 */
export function extractScreenshotPathsFromContent(content: string): string[] {
  const paths = new Set<string>()
  const text = String(content ?? '')
  if (!text) return []

  try {
    const parsed = JSON.parse(text) as { screenshotPath?: unknown; screenshotPaths?: unknown }
    if (Array.isArray(parsed?.screenshotPaths)) {
      for (const p of parsed.screenshotPaths) {
        const normalized = normalizeScreenshotPath(p)
        if (normalized) paths.add(normalized)
      }
    }
    const single = normalizeScreenshotPath(parsed?.screenshotPath)
    if (single) paths.add(single)
  } catch {
    // ignore non-json tool results
  }

  const regex = /"screenshotPath"\s*:\s*"([^"]+)"/g
  let match: RegExpExecArray | null = null
  while ((match = regex.exec(text)) !== null) {
    const normalized = normalizeScreenshotPath(match[1])
    if (normalized) paths.add(normalized)
  }
  return Array.from(paths)
}

/** 从聊天消息中收集所有截图路径 */
export function collectMessageScreenshotPaths(msg: ChatMsg): string[] {
  const paths = new Set<string>()
  if (msg.agentSteps) {
    for (const step of msg.agentSteps) {
      for (const result of step.toolResults) {
        for (const p of extractScreenshotPathsFromContent(result.content)) {
          paths.add(p)
        }
      }
    }
  }
  return Array.from(paths)
}
