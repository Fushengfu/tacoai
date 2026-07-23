/**
 * Agent 循环 - 工具函数与常量
 *
 * 提取自 loop.ts，包含纯函数、常量、bootstrap 逻辑，
 * 不持有任何模块级可变状态。
 */

import { createHash } from 'node:crypto'
import type { AgentServices } from '../services'
import { setLLMLogger } from '../llm/client'
import { setCompressorLogger } from '../context/compressor'
import { setMaintainLogger } from '../memory/memory-maintain'
import { setMemoryMigrationLogger, setMemoryMigrationDatabase, setMemoryMigrationNotes } from '../memory/memory-migration'
import { setMemoryStatsDatabase, setMemoryStatsNotes } from '../memory/memory-stats'
import { setMemoryStoreDatabase } from '../memory/store'
import { setSnapshotStore } from '../memory/snapshot'
import { setMemoryRecallLogger, setMemoryRecallNotes } from '../memory/memory-recall'
import { setSkillsServiceLogger } from '../skills/service'
import { setErrorHandlerLogger } from '../error-handler'
import {
  sanitizeContextArtifacts,
  sanitizeUserFacingText,
  sanitizeReasoningForContext,
  sanitizeReplayRawText,
} from '../shared/sanitize'

/* ------------------------------------------------------------------ */
/*  常量                                                               */
/* ------------------------------------------------------------------ */

export const MAX_TOOL_ROUNDS = 1000
export const AGENT_LOOP_TIMEOUT_MS = 24 * 60 * 60 * 1000

export const AUTO_RETRY_BASE_DELAY_MS = 1000
export const AUTO_RETRY_MAX_DELAY_MS = 16000

export const STREAM_SANITIZE_HOLD_BACK = 24

/* ------------------------------------------------------------------ */
/*  确认等待机制（从 error-handler.ts 重导出）                           */
/* ------------------------------------------------------------------ */

export { resolveConfirm, resolveRetry, isAbortError } from '../error-handler'

/* ------------------------------------------------------------------ */
/*  纯工具函数                                                         */
/* ------------------------------------------------------------------ */

/** 简单的异步等待 */
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function safeParseObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    return null
  } catch {
    return null
  }
}

export function extractThinkingFromAssistantRawText(rawText: string): string {
  const text = String(rawText ?? '')
  if (!text.trim()) return ''
  const matches = [...text.matchAll(/<think\b[^>]*>([\s\S]*?)<\/think>/gi)]
  if (matches.length > 0) {
    const merged = matches.map((m) => String(m[1] || '').trim()).filter(Boolean).join('\n\n')
    return sanitizeContextArtifacts(merged).trim()
  }
  const openTag = text.search(/<think\b[^>]*>/i)
  if (openTag >= 0) {
    const tagEnd = text.indexOf('>', openTag)
    if (tagEnd >= 0) {
      return sanitizeContextArtifacts(text.slice(tagEnd + 1)).trim()
    }
  }
  return ''
}

export function buildAssistantContextContent(rawText: string, sanitizedText: string, rawReasoning: string): string {
  const replayRawText = sanitizeReplayRawText(rawText)
  const visibleText = sanitizeUserFacingText(sanitizedText).trim()
  const reasoning = sanitizeReasoningForContext(rawReasoning).trim()
  const primaryText = replayRawText || visibleText

  if (primaryText && reasoning) {
    if (/<think\b/i.test(primaryText)) return primaryText
    return `<think>\n${reasoning}\n</think>\n\n${primaryText}`.trim()
  }
  if (primaryText) return primaryText
  if (reasoning) return `思考：${reasoning}`
  return ''
}

/* ------------------------------------------------------------------ */
/*  bootstrapAgentMemory                                               */
/* ------------------------------------------------------------------ */

/**
 * 初始化 Agent 子模块的模块级状态（Logger、Database、Notes 等）。
 * 必须在任何 memory 相关 IPC handler 被调用前执行。
 * 可重复调用（幂等），内部 setter 纯赋值操作。
 */
export function bootstrapAgentMemory(services: AgentServices): void {
  if (services.logger) {
    setLLMLogger(services.logger)
    setCompressorLogger(services.logger)
    setMaintainLogger(services.logger)
    setMemoryMigrationLogger(services.logger)
    setMemoryRecallLogger(services.logger)
    setErrorHandlerLogger(services.logger)
    setSkillsServiceLogger(services.logger)
  }
  if (services.snapshotStore) {
    setSnapshotStore(services.snapshotStore)
  }
  if (services.database) {
    setMemoryMigrationDatabase(services.database)
    setMemoryStatsDatabase(services.database)
    setMemoryStoreDatabase(services.database)
  }
  if (services.notes) {
    setMemoryMigrationNotes(services.notes)
    setMemoryStatsNotes(services.notes)
    setMemoryRecallNotes(services.notes)
  }
}
