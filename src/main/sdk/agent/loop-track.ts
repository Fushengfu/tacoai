/**
 * Agent 循环 - 证据追踪
 *
 * 包含工具调用输入/输出的追踪逻辑、文件变更记录、记忆证据收集。
 * 所有函数通过参数接收状态对象，不持有模块级可变状态。
 */

import path from 'node:path'
import type { ToolCall, ToolResult } from './tools'
import { compactLine, summarizeRunCommand, extractIdentifiers } from './context/compressor'

/* ------------------------------------------------------------------ */
/*  路径处理                                                           */
/* ------------------------------------------------------------------ */

export function toWorkspaceRelativeFactPath(workspace: string, value: string): string {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  const normalized = raw.replace(/\\/g, '/')
  if (!workspace || !workspace.trim()) return normalized
  try {
    const ws = path.normalize(workspace)
    const target = path.normalize(raw)
    if (path.isAbsolute(target) && (target === ws || target.startsWith(`${ws}${path.sep}`))) {
      const rel = path.relative(ws, target).replace(/\\/g, '/')
      return rel || '.'
    }
  } catch {
    return normalized
  }
  return normalized
}

export function shortMemoryFactText(value: string): string {
  const text = String(value ?? '').replace(/\r/g, '').replace(/\s+/g, ' ').trim()
  return text
}

/* ------------------------------------------------------------------ */
/*  工具调用输入追踪                                                   */
/* ------------------------------------------------------------------ */

export interface TrackState {
  changedFiles: Set<string>
  touchedFiles: Set<string>
  touchedIdentifiers: Set<string>
  failureLogs: string[]
  successfulRunCommandCount: number
  runCommandSummaryByToolCallId: Map<string, string>
  toolInputContextByToolCallId: Map<string, { path?: string; query?: string; pattern?: string; type?: string }>
  successfulRunCommandSummaries: string[]
  memoryEvidenceFacts: string[]
  hasFileChanges: boolean
  toolUsageCount: Map<string, number>
}

export function createTrackState(): TrackState {
  return {
    changedFiles: new Set(),
    touchedFiles: new Set(),
    touchedIdentifiers: new Set(),
    failureLogs: [],
    successfulRunCommandCount: 0,
    runCommandSummaryByToolCallId: new Map(),
    toolInputContextByToolCallId: new Map(),
    successfulRunCommandSummaries: [],
    memoryEvidenceFacts: [],
    hasFileChanges: false,
    toolUsageCount: new Map(),
  }
}

export function pushMemoryEvidenceFact(state: TrackState, value: string) {
  const fact = shortMemoryFactText(value)
  if (!fact) return
  if (state.memoryEvidenceFacts.includes(fact)) return
  state.memoryEvidenceFacts.push(fact)
}

import { safeParseObject } from './loop-utils'

export function trackToolCallsInputs(state: TrackState, calls: ToolCall[]) {
  const { toolUsageCount, runCommandSummaryByToolCallId, toolInputContextByToolCallId, touchedFiles, touchedIdentifiers } = state

  for (const tc of calls) {
    const name = tc.function.name
    if (!name || name === 'save_note' || name === 'delete_note') continue
    const current = toolUsageCount.get(name) ?? 0
    toolUsageCount.set(name, current + 1)

    const args = safeParseObject(tc.function.arguments)
    if (!args) continue
    if (name === 'run_command') {
      const command = typeof args.command === 'string' ? args.command : ''
      const summary = summarizeRunCommand(command)
      if (summary) runCommandSummaryByToolCallId.set(tc.id, summary)
    }
    if (name === 'read_file') {
      const requestedPath = typeof args.path === 'string' ? args.path.trim() : ''
      if (requestedPath) toolInputContextByToolCallId.set(tc.id, { path: requestedPath })
    } else if (name === 'codebase_search') {
      const query = typeof args.query === 'string'
        ? args.query.trim()
        : typeof args.pattern === 'string'
          ? args.pattern.trim()
          : ''
      const requestedPath = typeof args.path === 'string'
        ? args.path.trim()
        : typeof args.directory === 'string'
          ? args.directory.trim()
          : ''
      toolInputContextByToolCallId.set(tc.id, { query, path: requestedPath })
    } else if (name === 'find_file') {
      const pattern = typeof args.pattern === 'string' ? args.pattern.trim() : ''
      const requestedPath = typeof args.directory === 'string' ? args.directory.trim() : ''
      const type = typeof args.type === 'string' ? args.type.trim() : ''
      toolInputContextByToolCallId.set(tc.id, { pattern, path: requestedPath, type })
    } else if (name === 'list_dir') {
      const requestedPath = typeof args.path === 'string' ? args.path.trim() : ''
      if (requestedPath) toolInputContextByToolCallId.set(tc.id, { path: requestedPath })
    }
    const pathKeys = ['path', 'filePath', 'cwd']
    for (const key of pathKeys) {
      const value = args[key]
      if (typeof value === 'string' && value.trim()) touchedFiles.add(value.trim())
    }
    if (name === 'write_file' || name === 'edit_file') {
      const oldText = typeof args.oldText === 'string' ? args.oldText : ''
      const newText = typeof args.newText === 'string' ? args.newText : ''
      for (const id of extractIdentifiers(oldText)) touchedIdentifiers.add(id)
      for (const id of extractIdentifiers(newText)) touchedIdentifiers.add(id)
    }
  }
}

/* ------------------------------------------------------------------ */
/*  搜索结果收集                                                       */
/* ------------------------------------------------------------------ */

export function collectSearchMatchRefs(workspace: string, content: string, limit = 3): string[] {
  const refs: string[] = []
  for (const rawLine of String(content ?? '').split('\n')) {
    const line = rawLine.trim()
    const match = line.match(/^([^:\n]+):(\d+)(?::|-)/)
    if (!match) continue
    const ref = `${toWorkspaceRelativeFactPath(workspace, match[1])}:${match[2]}`
    if (!ref || refs.includes(ref)) continue
    refs.push(ref)
    if (refs.length >= limit) break
  }
  return refs
}

export function collectFindResultPaths(workspace: string, content: string, limit = 3): string[] {
  const refs: string[] = []
  for (const rawLine of String(content ?? '').split('\n')) {
    const line = rawLine.trim()
    const match = line.match(/^\[(?:F|D)\]\s+(.+?)(?:\/)?$/)
    if (!match) continue
    const ref = toWorkspaceRelativeFactPath(workspace, match[1])
    if (!ref || refs.includes(ref)) continue
    refs.push(ref)
    if (refs.length >= limit) break
  }
  return refs
}

export function buildReadFileFact(workspace: string, content: string, requestedPath?: string): string {
  const metaPathMatch = String(content ?? '').match(/\[read_file\]\s+path:\s*(.+)/)
  const resolvedPath = toWorkspaceRelativeFactPath(workspace, metaPathMatch?.[1] || requestedPath || '')
  if (!resolvedPath) return ''
  const withoutMeta = String(content ?? '').replace(/^\[read_file\][^\n]*\n?/gm, '')
  const hintMarker = '\n[提示]'
  const hintIndex = withoutMeta.indexOf(hintMarker)
  const body = (hintIndex >= 0 ? withoutMeta.slice(0, hintIndex) : withoutMeta).trim()
  const identifiers = extractIdentifiers(body).slice(0, 3)
  return identifiers.length > 0
    ? `查看 ${resolvedPath}（涉及 ${identifiers.join('、')}）`
    : `查看 ${resolvedPath}`
}

export function buildFileChangeFact(workspace: string, fileChange: ToolResult['fileChange']): string {
  if (!fileChange?.filePath) return ''
  const relPath = toWorkspaceRelativeFactPath(workspace, fileChange.filePath)
  if (!relPath) return ''
  const action = fileChange.oldContent === null
    ? '新增'
    : fileChange.newContent === null
      ? '删除'
      : '修改'
  const identifiers = extractIdentifiers(`${fileChange.oldContent || ''}\n${fileChange.newContent || ''}`).slice(0, 3)
  return identifiers.length > 0
    ? `${action} ${relPath}（涉及 ${identifiers.join('、')}）`
    : `${action} ${relPath}`
}

/* ------------------------------------------------------------------ */
/*  工具结果追踪                                                       */
/* ------------------------------------------------------------------ */

export function trackToolResultsCore(state: TrackState, workspace: string, results: ToolResult[]) {
  const { changedFiles, toolInputContextByToolCallId, failureLogs } = state

  for (const result of results) {
    if (result.name === 'save_note' || result.name === 'delete_note') continue
    if (result.name === 'run_command' && result.success) {
      state.successfulRunCommandCount++
      const summary = state.runCommandSummaryByToolCallId.get(result.tool_call_id) || ''
      if (summary && !state.successfulRunCommandSummaries.includes(summary)) {
        state.successfulRunCommandSummaries.push(summary)
        if (state.successfulRunCommandSummaries.length > 3) state.successfulRunCommandSummaries.shift()
      }
      if (summary) pushMemoryEvidenceFact(state, `执行验证：${summary}`)
    }
    if (result.fileChange?.filePath) {
      changedFiles.add(result.fileChange.filePath)
      const fileChangeFact = buildFileChangeFact(workspace, result.fileChange)
      if (fileChangeFact) pushMemoryEvidenceFact(state, fileChangeFact)
    }
    if (result.fileChange?.oldContent) {
      for (const id of extractIdentifiers(result.fileChange.oldContent)) state.touchedIdentifiers.add(id)
    }
    if (result.fileChange?.newContent) {
      for (const id of extractIdentifiers(result.fileChange.newContent)) state.touchedIdentifiers.add(id)
    }
    if (result.success) {
      const toolInput = toolInputContextByToolCallId.get(result.tool_call_id)
      if (result.name === 'read_file') {
        const fact = buildReadFileFact(workspace, result.content, toolInput?.path)
        if (fact) pushMemoryEvidenceFact(state, fact)
      } else if (result.name === 'codebase_search') {
        const refs = collectSearchMatchRefs(workspace, result.content, 4)
        if (refs.length > 0) {
          const query = shortMemoryFactText(toolInput?.query || '代码搜索')
          pushMemoryEvidenceFact(state, `搜索 ${query} 命中 ${refs.join('、')}`)
        }
      } else if (result.name === 'find_file') {
        const refs = collectFindResultPaths(workspace, result.content, 4)
        if (refs.length > 0) {
          const label = toolInput?.type === 'directory' ? '定位目录' : '定位文件'
          const pattern = shortMemoryFactText(toolInput?.pattern || '目标路径')
          pushMemoryEvidenceFact(state, `${label} ${pattern}：${refs.join('、')}`)
        }
      } else if (result.name === 'list_dir' && toolInput?.path) {
        pushMemoryEvidenceFact(state, `查看目录 ${toWorkspaceRelativeFactPath(workspace, toolInput.path)}`)
      }
    }
    if (!result.success && failureLogs.length < 12) {
      failureLogs.push(`${result.name}: ${compactLine(result.content, 320)}`)
    }
  }
}

export function trackFileChanges(state: TrackState, results: ToolResult[]) {
  for (const r of results) {
    if (r.fileChange) { state.hasFileChanges = true; break }
  }
}

/* ------------------------------------------------------------------ */
/*  验证步骤判断                                                       */
/* ------------------------------------------------------------------ */

export function isVerificationPlanStep(text: string): boolean {
  const lower = String(text ?? '').trim().toLowerCase()
  if (!lower) return false
  return /(验证|测试|构建|编译|lint|typecheck|校验|检查通过|编译通过|构建通过|test|build|compile|verify|validation)/i.test(lower)
}
