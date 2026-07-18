/**
 * 工具执行器 - 文件操作（read/write/edit/delete/list/find）
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import type { FileChange } from './definitions'
import { readActiveSkillDetail, readActiveSkillResource } from '../skills/service'
import { getWorkspaceTree } from './workspace-tree'
import {
  resolveSafe,
  resolveSmartPath,
  toPosixPath,
  clampNumber,
  type ExecResult,
  type ToolRuntimeContext,
} from './exec-utils'

/* ------------------------------------------------------------------ */
/*  read_file                                                          */
/* ------------------------------------------------------------------ */

export async function execReadFile(args: Record<string, unknown>, workspace: string): Promise<ExecResult> {
  const filePath = String(args.path ?? '')
  if (!filePath) return { content: 'Error: path is required', success: false }
  const rawStartLine = Number(args.startLine)
  const rawEndLine = Number(args.endLine)
  const rawMaxChars = Number(args.maxChars)

  const check = await resolveSmartPath(workspace, filePath, 'file', { allowOutsideWorkspaceRead: true })
  if ('error' in check) return { content: check.error, success: false }
  const resolved = check.resolved
  const correctedNote = check.corrected ? `[自动纠正路径: "${filePath}" → "${check.corrected.split('\n')[0]}"]\n` : ''

  try {
    const stat = await fs.stat(resolved)
    if (!stat.isFile()) return { content: `Error: Not a file: ${resolved}`, success: false }
    if (stat.size > 1024 * 1024) return { content: `Error: File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB), max 1MB`, success: false }
    const fullContent = await fs.readFile(resolved, 'utf-8')
    const lines = fullContent.split('\n')
    const totalLines = lines.length

    const DEFAULT_MAX_CHARS = 24000
    const HARD_MAX_CHARS = 28000
    const maxChars = Number.isFinite(rawMaxChars) && rawMaxChars > 0
      ? Math.min(Math.floor(rawMaxChars), HARD_MAX_CHARS)
      : DEFAULT_MAX_CHARS

    let startLine = Number.isFinite(rawStartLine) && rawStartLine > 0 ? Math.floor(rawStartLine) : 1
    let endLine = Number.isFinite(rawEndLine) && rawEndLine > 0 ? Math.floor(rawEndLine) : totalLines
    startLine = Math.max(1, Math.min(startLine, Math.max(1, totalLines)))
    endLine = Math.max(startLine, Math.min(endLine, Math.max(1, totalLines)))

    let actualEndLine = endLine
    let chunk = lines.slice(startLine - 1, endLine).join('\n')
    let truncatedByChars = false
    if (chunk.length > maxChars) {
      truncatedByChars = true
      let acc = ''
      actualEndLine = startLine - 1
      for (let i = startLine - 1; i < endLine; i++) {
        const line = lines[i] ?? ''
        const next = acc ? `${acc}\n${line}` : line
        if (next.length > maxChars) {
          if (!acc) {
            acc = next.slice(0, maxChars)
            actualEndLine = i + 1
          }
          break
        }
        acc = next
        actualEndLine = i + 1
      }
      chunk = acc
    }

    const hasRemainingBefore = startLine > 1
    const hasRemainingAfter = actualEndLine < totalLines
    const partial = hasRemainingBefore || hasRemainingAfter || truncatedByChars

    const nextStartLine = Math.min(totalLines, actualEndLine + 1)
    const nextEndLine = Math.min(totalLines, nextStartLine + 199)
    const prevEndLine = startLine - 1
    const prevStartLine = Math.max(1, prevEndLine - 199)

    const meta: string[] = [
      `[read_file] path: ${resolved}`,
      `[read_file] lines: ${startLine}-${actualEndLine}/${totalLines}`,
      `[read_file] chars: ${chunk.length}/${fullContent.length}`,
      `[read_file] partial: ${partial ? 'yes' : 'no'}`,
    ]
    if (hasRemainingBefore) {
      meta.push(`[read_file] previous_chunk_hint: read_file(path="${filePath}", startLine=${prevStartLine}, endLine=${prevEndLine})`)
    }
    if (hasRemainingAfter) {
      meta.push(`[read_file] next_chunk_hint: read_file(path="${filePath}", startLine=${nextStartLine}, endLine=${nextEndLine})`)
    }

    const guidance = partial
      ? '\n\n[提示] 当前仅返回文件的部分内容。继续编码前，请按需调用 read_file 的 startLine/endLine 分块读取剩余范围。'
      : ''

    return {
      content: correctedNote + meta.join('\n') + '\n\n' + chunk + guidance,
      success: true,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { content: `Error: File not found: ${resolved}`, success: false }
    }
    throw err
  }
}

/* ------------------------------------------------------------------ */
/*  read_skill / read_skill_resource                                   */
/* ------------------------------------------------------------------ */

export async function execReadSkill(args: Record<string, unknown>, runtimeContext?: ToolRuntimeContext): Promise<ExecResult> {
  const skillId = String(args.skill_id ?? '').trim()
  if (!skillId) return { content: 'Error: skill_id is required', success: false }

  const detail = readActiveSkillDetail(skillId)
  if (!detail) {
    return {
      content: `Error: Skill not found or not enabled for current request: ${skillId}`,
      success: false,
    }
  }

  return { content: detail.content, success: true }
}

export async function execReadSkillResource(args: Record<string, unknown>, runtimeContext?: ToolRuntimeContext): Promise<ExecResult> {
  const skillId = String(args.skill_id ?? '').trim()
  const resourcePath = String(args.resource_path ?? '').trim()
  if (!skillId) return { content: 'Error: skill_id is required', success: false }
  if (!resourcePath) return { content: 'Error: resource_path is required', success: false }

  const detail = await readActiveSkillResource(skillId, resourcePath)
  if (!detail) {
    return {
      content: `Error: Skill resource not found or not allowed: ${skillId}/${resourcePath}`,
      success: false,
    }
  }

  return {
    content: [
      `[SKILL_RESOURCE skill_id="${skillId}" path="${resourcePath}"]`,
      detail.content,
      '[/SKILL_RESOURCE]',
    ].join('\n'),
    success: true,
  }
}

/* ------------------------------------------------------------------ */
/*  write_file                                                         */
/* ------------------------------------------------------------------ */

export async function execWriteFile(args: Record<string, unknown>, workspace: string): Promise<ExecResult & { fileChange?: FileChange }> {
  const filePath = String(args.path ?? '')
  const fileContent = String(args.content ?? '')
  if (!filePath) return { content: 'Error: path is required', success: false }
  const check = resolveSafe(workspace, filePath)
  if ('error' in check) return { content: check.error, success: false }
  const resolved = check.resolved

  let oldContent: string | null = null
  try {
    const stat = await fs.stat(resolved)
    if (stat.isFile()) {
      oldContent = await fs.readFile(resolved, 'utf-8')
    }
  } catch {
    // 文件不存在 → 新建
  }

  const dir = path.dirname(resolved)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(resolved, fileContent, 'utf-8')

  const relPath = toPosixPath(path.relative(workspace, resolved))
  return {
    content: `File written: ${resolved} (${fileContent.length} chars)`,
    success: true,
    fileChange: { filePath: relPath, oldContent, newContent: fileContent },
  }
}

/* ------------------------------------------------------------------ */
/*  edit_file                                                          */
/* ------------------------------------------------------------------ */

function countTextOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let start = 0
  while (true) {
    const idx = haystack.indexOf(needle, start)
    if (idx < 0) break
    count += 1
    start = idx + needle.length
  }
  return count
}

export async function execEditFile(args: Record<string, unknown>, workspace: string): Promise<ExecResult & { fileChange?: FileChange }> {
  const filePath = String(args.path ?? '')
  const oldText = String(args.oldText ?? '')
  const newText = String(args.newText ?? '')
  const replaceAll = Boolean(args.replaceAll ?? false)
  const expectedRaw = Number(args.expectedOccurrences)

  if (!filePath) return { content: 'Error: path is required', success: false }
  if (!oldText) return { content: 'Error: oldText is required and cannot be empty', success: false }

  const check = resolveSafe(workspace, filePath)
  if ('error' in check) return { content: check.error, success: false }
  const resolved = check.resolved

  let oldContent: string
  try {
    const stat = await fs.stat(resolved)
    if (!stat.isFile()) return { content: `Error: Not a file: ${resolved}`, success: false }
    oldContent = await fs.readFile(resolved, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { content: `Error: File not found: ${resolved}`, success: false }
    }
    throw err
  }

  let lineEnding = '\n'
  if (oldContent.includes('\r\n')) {
    lineEnding = '\r\n'
  } else if (oldContent.includes('\r')) {
    lineEnding = '\r'
  }

  const normalizeLineEndings = (s: string) => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const normalizedContent = normalizeLineEndings(oldContent)
  const normalizedOldText = normalizeLineEndings(oldText)
  const normalizedNewText = normalizeLineEndings(newText)

  const occurrences = countTextOccurrences(normalizedContent, normalizedOldText)
  if (occurrences === 0) {
    return { content: `Error: oldText not found in file: ${resolved}`, success: false }
  }
  if (Number.isFinite(expectedRaw) && expectedRaw >= 0 && occurrences !== Math.floor(expectedRaw)) {
    return {
      content: `Error: expectedOccurrences mismatch for ${resolved}, expected=${Math.floor(expectedRaw)}, actual=${occurrences}`,
      success: false,
    }
  }

  const replacedCount = replaceAll ? occurrences : 1
  let newContent = replaceAll
    ? normalizedContent.split(normalizedOldText).join(normalizedNewText)
    : normalizedContent.replace(normalizedOldText, normalizedNewText)

  if (newContent === normalizedContent) {
    return { content: `Error: edit produced no changes for ${resolved}`, success: false }
  }

  if (lineEnding !== '\n') {
    newContent = newContent.replace(/\n/g, lineEnding)
  }

  await fs.writeFile(resolved, newContent, 'utf-8')

  const relPath = toPosixPath(path.relative(workspace, resolved))
  return {
    content: `File edited: ${resolved} (replaced ${replacedCount} occurrence${replacedCount > 1 ? 's' : ''})`,
    success: true,
    fileChange: { filePath: relPath, oldContent, newContent },
  }
}

/* ------------------------------------------------------------------ */
/*  delete_file                                                        */
/* ------------------------------------------------------------------ */

export async function execDeleteFile(args: Record<string, unknown>, workspace: string): Promise<ExecResult & { fileChange?: FileChange }> {
  const filePath = String(args.path ?? '')
  if (!filePath) return { content: 'Error: path is required', success: false }
  const check = resolveSafe(workspace, filePath)
  if ('error' in check) return { content: check.error, success: false }
  const resolved = check.resolved

  let oldContent: string | null = null
  try {
    const stat = await fs.stat(resolved)
    if (!stat.isFile()) return { content: `Error: Not a file: ${resolved}`, success: false }
    oldContent = await fs.readFile(resolved, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { content: `Error: File not found: ${resolved}`, success: false }
    }
    throw err
  }

  await fs.rm(resolved, { force: true })

  const relPath = toPosixPath(path.relative(workspace, resolved))
  return {
    content: `File deleted: ${resolved}`,
    success: true,
    fileChange: { filePath: relPath, oldContent, newContent: null },
  }
}

/* ------------------------------------------------------------------ */
/*  list_dir                                                           */
/* ------------------------------------------------------------------ */

export async function execListDirectory(args: Record<string, unknown>, workspace: string): Promise<ExecResult> {
  const rawPath = String(args.path ?? '').trim() || '.'
  const maxDepth = clampNumber(args.maxDepth, 1, 12, 4)
  const includeFiles = args.includeFiles !== false && args.showFiles !== false
  const includeHidden = Boolean(args.includeHidden)
  const maxEntries = clampNumber(args.maxEntries, 200, 10000, 4000)

  const check = await resolveSmartPath(workspace, rawPath, 'directory')
  if ('error' in check) return { content: check.error, success: false }
  const resolved = check.resolved
  const correctedNote = check.corrected ? `[自动纠正路径: "${rawPath}" → "${check.corrected.split('\n')[0]}"]\n` : ''

  const tree = await getWorkspaceTree(resolved, {
    maxDepth,
    includeFiles,
    includeHidden,
    maxEntries,
  })

  const relPath = rawPath === '.' ? '.' : toPosixPath(path.relative(workspace, resolved))
  const header = `[list_dir] path: ${resolved} (relative: ${relPath})\n`
  const stats = `目录: ${tree.stats.directoryCount}, 文件: ${tree.stats.fileCount}, 行数: ${tree.stats.lineCount}`
  const truncated = tree.truncated ? '\n[提示] 目录条目过多，已截断显示。' : ''

  return {
    content: correctedNote + header + stats + truncated + '\n\n' + tree.text,
    success: true,
  }
}

/* ------------------------------------------------------------------ */
/*  find_file                                                          */
/* ------------------------------------------------------------------ */

let minimatchCache: ((path: string, pattern: string) => boolean) | null = null
function requireMinimatch(): ((path: string, pattern: string) => boolean) | null {
  if (minimatchCache) return minimatchCache
  try {
    const mod = require('minimatch')
    minimatchCache = mod.minimatch
    return minimatchCache
  } catch {
    return null
  }
}

export async function execFindFile(args: Record<string, unknown>, workspace: string): Promise<ExecResult> {
  const pattern = String(args.pattern ?? '').trim()
  if (!pattern) return { content: 'Error: pattern is required', success: false }

  const directory = String(args.directory ?? '').trim() || '.'
  const type = String(args.type ?? 'file')
  const mode = String(args.mode ?? 'auto')
  const includeHidden = Boolean(args.includeHidden)
  const maxResults = clampNumber(args.maxResults, 1, 200, 50)

  const check = await resolveSmartPath(workspace, directory, 'directory')
  if ('error' in check) return { content: check.error, success: false }
  const resolved = check.resolved
  const correctedNote = check.corrected ? `[自动纠正路径: "${directory}" → "${check.corrected.split('\n')[0]}"]\n` : ''

  const tree = await getWorkspaceTree(resolved, {
    maxDepth: 12,
    includeFiles: true,
    includeHidden,
    maxEntries: 10000,
  })

  const entries = tree.entries
  const filtered = entries.filter((entry) => {
    if (type === 'directory' && entry.kind !== 'directory') return false
    if (type === 'file' && entry.kind !== 'file') return false

    const name = entry.name
    const relPath = entry.path

    if (mode === 'exact') {
      return name === pattern || relPath === pattern
    }
    if (mode === 'glob') {
      const minimatch = requireMinimatch()
      if (minimatch) return minimatch(name, pattern) || minimatch(relPath, pattern)
      return name.includes(pattern) || relPath.includes(pattern)
    }
    const lowerPattern = pattern.toLowerCase()
    const lowerName = name.toLowerCase()
    const lowerPath = relPath.toLowerCase()
    let pi = 0
    for (let i = 0; i < lowerName.length && pi < lowerPattern.length; i++) {
      if (lowerName[i] === lowerPattern[pi]) pi++
    }
    if (pi === lowerPattern.length) return true
    return lowerPath.includes(lowerPattern)
  }).slice(0, maxResults)

  if (filtered.length === 0) {
    return { content: correctedNote + `No files found matching "${pattern}"`, success: true }
  }

  const lines = filtered.map((e) => `${e.kind === 'directory' ? '[D]' : '[F]'} ${e.path}`)
  return {
    content: correctedNote + `Found ${filtered.length} result(s) for "${pattern}":\n\n` + lines.join('\n'),
    success: true,
  }
}
