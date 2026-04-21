/**
 * 项目笔记/记忆系统
 *
 * 分层设计：
 * 1) 手工项目笔记（notes）: 规则、约定、配置等长期知识
 * 2) 任务执行记忆（memory）: 每轮任务的结构化执行摘要
 *
 * 注入策略：
 * - 不再把全部笔记原样注入
 * - 每轮按用户问题做“相关性召回 + 预算裁剪”
 * - 仅将高相关记忆注入 [BACKGROUND_CONTEXT]
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { app } from 'electron'
import type { ProjectNote, ProjectTaskMemory, MemoryScopeStats, MemoryScopeExportResult } from '../../shared/ipc'
import type { ChatMessage } from '../ai/llm'
import { requestChatCompletion, requestStreamWithTools } from '../ai/llm'
import type { ProviderKey, ProviderOverrides } from '../ai/llm'
import type { ToolDefinition } from '../tools'
import { log } from '../system/logger'
import {
  initMemoryDb,
  hasAnyProjectNotes,
  listProjectNotesForScope,
  replaceProjectNotes,
  importProjectNotes,
  hasAnyTaskMemories,
  listTaskMemoriesByTier,
  replaceTaskMemoriesByTier,
  importTaskMemoriesByTier,
  hasAnyMemorySnapshots,
  listMemorySnapshotsForScope,
  replaceMemorySnapshots,
  importMemorySnapshots,
  isMemoryDbEmpty,
  insertMemoryMaintainRun,
  countMemoryMaintainRuns,
  getMemoryDbInfo,
  resolveChatStoreMessageSeqRange,
} from './memory-db'

/* ------------------------------------------------------------------ */
/*  存储路径                                                            */
/* ------------------------------------------------------------------ */

function resolveHomeDir(): string {
  try {
    const electronHome = app.getPath('home')
    if (electronHome && electronHome.trim()) return electronHome.trim()
  } catch {
    // ignore: fallback to env/os
  }
  const envHome = (process.env.HOME || process.env.USERPROFILE || '').trim()
  if (envHome) return envHome
  const osHome = (os.homedir() || '').trim()
  if (osHome) return osHome
  return process.cwd()
}

const TACO_HOME = path.join(resolveHomeDir(), '.taco')
const NOTES_DIR = path.join(TACO_HOME, 'notes')
const MEMORY_DIR = path.join(TACO_HOME, 'memory')
const MEMORY_ARCHIVE_DIR = path.join(TACO_HOME, 'memory-archive')
const SNAPSHOT_DIR = path.join(TACO_HOME, 'memory-snapshots')
const MEMORY_EXPORT_DIR = path.join(TACO_HOME, 'exports')

/** 将工作空间路径转为稳定的文件名 hash */
function workspaceHash(workspace: string): string {
  return createHash('sha256').update(path.resolve(workspace)).digest('hex').slice(0, 16)
}

function projectScope(projectId: string): string {
  return 'project-' + createHash('sha256').update(projectId).digest('hex').slice(0, 16)
}

function resolveScope(workspace: string, projectId?: string): string {
  if (projectId && projectId.trim()) return projectScope(projectId.trim())
  if (workspace && workspace.trim()) return workspaceHash(workspace)
  return 'global'
}

/** 获取指定作用域的笔记文件路径 */
function notesFilePath(workspace: string, projectId?: string): string {
  return path.join(NOTES_DIR, `${resolveScope(workspace, projectId)}.json`)
}

/** 获取指定作用域的任务记忆文件路径 */
function memoryFilePath(workspace: string, projectId?: string): string {
  return path.join(MEMORY_DIR, `${resolveScope(workspace, projectId)}.json`)
}

/** 获取指定作用域的任务记忆归档文件路径（长期记忆） */
function memoryArchiveFilePath(workspace: string, projectId?: string): string {
  return path.join(MEMORY_ARCHIVE_DIR, `${resolveScope(workspace, projectId)}.json`)
}

/** 获取指定作用域的记忆压缩快照文件路径 */
function snapshotFilePath(workspace: string, projectId?: string): string {
  return path.join(SNAPSHOT_DIR, `${resolveScope(workspace, projectId)}.json`)
}

/* ------------------------------------------------------------------ */
/*  通用读写                                                            */
/* ------------------------------------------------------------------ */

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function readJsonArray<T>(filePath: string): Promise<T[]> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

/* ------------------------------------------------------------------ */
/*  手工项目笔记（notes）                                                */
/* ------------------------------------------------------------------ */

const LEGACY_AUTO_TASK_LOG_NOTE_ID = 'auto-task-log'
const LEGACY_AUTO_TASK_LOG_NOTE_TITLE = '任务执行日志（自动）'

function isLegacyTaskLogNote(note: ProjectNote): boolean {
  const id = String(note.id || '')
  const title = String(note.title || '')
  return id === LEGACY_AUTO_TASK_LOG_NOTE_ID || title === LEGACY_AUTO_TASK_LOG_NOTE_TITLE
}

function sortNotesAsc(notes: ProjectNote[]): ProjectNote[] {
  return [...notes].sort((a, b) => {
    const ta = Date.parse(a.updatedAt || a.createdAt || '')
    const tb = Date.parse(b.updatedAt || b.createdAt || '')
    const safeA = Number.isFinite(ta) ? ta : 0
    const safeB = Number.isFinite(tb) ? tb : 0
    if (safeA !== safeB) return safeA - safeB
    return String(a.id).localeCompare(String(b.id))
  })
}

function normalizeNoteCategory(input: unknown): ProjectNote['category'] {
  const category = String(input ?? '').trim()
  if (category === 'convention' || category === 'credential' || category === 'architecture' || category === 'config' || category === 'other') {
    return category
  }
  return 'other'
}

function normalizeProjectNoteEntry(raw: Partial<ProjectNote>, index: number): ProjectNote {
  const now = new Date().toISOString()
  const createdAtRaw = normalizeIso(raw.createdAt)
  const updatedAtRaw = normalizeIso(raw.updatedAt)
  const createdAt = createdAtRaw || updatedAtRaw || now
  const updatedAt = updatedAtRaw || createdAt
  const title = shortText(String(raw.title ?? '').trim(), 280) || '未命名笔记'
  const content = shortText(String(raw.content ?? '').trim(), 24000)
  const rawId = String(raw.id || '').trim()
  const stableId = rawId || `note-legacy-${createHash('sha1').update(`${title}|${createdAt}|${index}`).digest('hex').slice(0, 12)}`
  return {
    id: stableId,
    title,
    content,
    category: normalizeNoteCategory(raw.category),
    createdAt,
    updatedAt,
  }
}

async function loadRawNotes(workspace: string, projectId?: string): Promise<ProjectNote[]> {
  await ensureNoteScopeReady(workspace, projectId)
  return listProjectNotesForScope({ workspace, projectId }).map((item, index) => normalizeProjectNoteEntry(item, index))
}

async function saveRawNotes(workspace: string, notes: ProjectNote[], projectId?: string): Promise<void> {
  await ensureNoteScopeReady(workspace, projectId)
  replaceProjectNotes(
    { workspace, projectId },
    notes.map((item, index) => normalizeProjectNoteEntry(item, index)),
  )
}

/** 列出指定工作空间的手工笔记（自动任务日志不在此列表展示） */
export async function listNotes(workspace: string, projectId?: string): Promise<ProjectNote[]> {
  const notes = await loadRawNotes(workspace, projectId)
  return sortNotesAsc(notes.filter((note) => !isLegacyTaskLogNote(note)))
}

/** 保存手工笔记（新增或更新） */
export async function saveNote(workspace: string, note: ProjectNote, projectId?: string): Promise<ProjectNote> {
  const notes = await loadRawNotes(workspace, projectId)
  const now = new Date().toISOString()
  const nextNote: ProjectNote = {
    ...note,
    title: String(note.title ?? '').trim(),
    content: String(note.content ?? '').trim(),
    category: note.category || 'other',
    createdAt: note.createdAt || now,
    updatedAt: now,
  }

  const idx = notes.findIndex((item) => item.id === nextNote.id)
  if (idx >= 0) notes[idx] = nextNote
  else notes.push(nextNote)

  await saveRawNotes(workspace, notes, projectId)
  return nextNote
}

/** 删除手工笔记 */
export async function deleteNote(workspace: string, noteId: string, projectId?: string): Promise<void> {
  const notes = await loadRawNotes(workspace, projectId)
  const filtered = notes.filter((item) => item.id !== noteId)
  await saveRawNotes(workspace, filtered, projectId)
}

/* ------------------------------------------------------------------ */
/*  任务执行记忆（memory）                                               */
/* ------------------------------------------------------------------ */

export type TaskMemoryEntry = ProjectTaskMemory

type TaskLogSourceRefInput = {
  sessionId?: string
  userMessageId?: string
  assistantMessageId?: string
  messageIds?: string[]
}

type TaskLogInput = {
  goal: string
  userQuery?: string
  userAssetsBlock?: string
  intentType?: string
  intentSummary?: string
  intentGoal?: string
  summary: string
  outcome: 'success' | 'aborted' | 'error'
  tools?: string[]
  changedFiles?: string[]
  identifiers?: string[]
  evidenceFacts?: string[]
  failures?: string[]
  sourceRef?: TaskLogSourceRefInput
}

export type MemoryMaintainOptions = {
  provider?: ProviderKey
  overrides?: ProviderOverrides
  usageTotalTokens?: number
  maxTokens?: number
  signal?: AbortSignal
  logScope?: string
}

export type MemorySnapshotEntry = {
  id: string
  summary: string
  sourceMessageCount: number
  usageTotalTokens?: number
  maxTokens?: number
  createdAt: string
  updatedAt: string
}

type SnapshotLogInput = {
  summary: string
  sourceMessageCount: number
  usageTotalTokens?: number
  maxTokens?: number
}

const TASK_MEMORY_MAX_ENTRIES = 400
const TASK_MEMORY_ARCHIVE_MAX_ENTRIES = 6000
const TASK_MEMORY_TOTAL_MAX_ENTRIES = TASK_MEMORY_MAX_ENTRIES + TASK_MEMORY_ARCHIVE_MAX_ENTRIES
const TASK_MEMORY_SUMMARY_MAX_CHARS = 1200
const TASK_MEMORY_CORE_MAX_CHARS = 560
const TASK_MEMORY_ASSISTANT_RESULT_MAX_CHARS = 4200
const TASK_MEMORY_REPLAY_RESULT_MAX_CHARS = 1800
const TASK_MEMORY_USER_ASSETS_MAX_CHARS = 3000
const MEMORY_SNAPSHOT_MAX_ENTRIES = 120
const MEMORY_SNAPSHOT_SUMMARY_MAX_CHARS = 5600

const MEMORY_META_PREFIX = /^(用户问题|用户意图|意图来源|意图目标|意图|结果|动作|文件|异常)[:：]/u
const MEMORY_MAINTAIN_RATIO = 0.8
const MEMORY_MAINTAIN_MIN_INTERVAL_MS = 90 * 1000
const memoryMaintainLastRunAtByScope = new Map<string, number>()
const memoryMaintainInFlightByScope = new Set<string>()

function normalizeStringList(value: unknown, max = 120): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((x) => String(x ?? '').trim()).filter(Boolean))].slice(0, max)
}

function normalizeTaskLogSourceRef(value: TaskLogSourceRefInput | undefined): TaskLogSourceRefInput {
  if (!value || typeof value !== 'object') return {}
  const sessionId = shortText(String(value.sessionId || '').trim(), 120)
  const userMessageId = shortText(String(value.userMessageId || '').trim(), 180)
  const assistantMessageId = shortText(String(value.assistantMessageId || '').trim(), 180)
  const messageIds = normalizeStringList(value.messageIds, 200)
  const mergedMessageIds = [...new Set([userMessageId, assistantMessageId, ...messageIds].filter(Boolean))]
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(userMessageId ? { userMessageId } : {}),
    ...(assistantMessageId ? { assistantMessageId } : {}),
    ...(mergedMessageIds.length > 0 ? { messageIds: mergedMessageIds } : {}),
  }
}

function normalizeOutcome(value: unknown): TaskMemoryEntry['outcome'] {
  const outcome = String(value ?? '').trim()
  if (outcome === 'success' || outcome === 'aborted' || outcome === 'error') return outcome
  return 'success'
}

function normalizeIso(input: unknown): string {
  const text = String(input ?? '').trim()
  const ts = Date.parse(text)
  if (Number.isFinite(ts)) return new Date(ts).toISOString()
  return ''
}

const PSEUDO_TOOL_CALL_BLOCK_PATTERNS = [
  /<minimax:tool_call\b[^>]*>[\s\S]*?<\/minimax:tool_call>/gi,
  /<invoke\b[^>]*>[\s\S]*?<\/invoke>/gi,
]

const PSEUDO_TOOL_CALL_INLINE_PATTERNS = [
  /\[(?:\/)?TOOL_CALL[^\]]*\]/gi,
  /<\/?minimax:tool_call\b[^>]*>/gi,
  /<\/?invoke\b[^>]*>/gi,
  /<\/?parameter\b[^>]*>/gi,
]

export function stripPseudoToolCallArtifacts(input: string): string {
  let output = String(input ?? '')
  for (const pattern of PSEUDO_TOOL_CALL_BLOCK_PATTERNS) {
    output = output.replace(pattern, '\n')
  }
  for (const pattern of PSEUDO_TOOL_CALL_INLINE_PATTERNS) {
    output = output.replace(pattern, ' ')
  }
  return output
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function stripMemoryMetaLines(text: string): string {
  const lines = String(text ?? '').replace(/\r/g, '').split('\n')
  const out: string[] = []
  let inCodeFence = false

  for (const rawLine of lines) {
    const trimmed = rawLine.trim()
    if (trimmed.startsWith('```')) {
      inCodeFence = !inCodeFence
      out.push(rawLine.trimEnd())
      continue
    }

    if (!inCodeFence) {
      if (!trimmed) {
        out.push('')
        continue
      }
      if (/^处理[:：]/u.test(trimmed)) {
        const payload = trimmed.replace(/^处理[:：]\s*/u, '').trim()
        if (payload) out.push(payload)
        continue
      }
      if (MEMORY_META_PREFIX.test(trimmed)) {
        continue
      }
    }

    out.push(rawLine.trimEnd())
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function normalizeTaskMemoryEntry(raw: Partial<TaskMemoryEntry>, index: number): TaskMemoryEntry {
  const now = new Date().toISOString()
  const goal = shortText(String(raw.goal || raw.userQuery || '(未记录目标)'), 800)
  const userQueryRaw = String(raw.userQuery || goal)
  const userQuery = shortText(extractUserQueryText(userQueryRaw) || goal, 800)
  const userAssetsBlockRaw = String(raw.userAssetsBlock || '')
  const userAssetsBlock = shortText(
    stripControlChars(userAssetsBlockRaw || extractUserAssetsBlock(userQueryRaw)),
    TASK_MEMORY_USER_ASSETS_MAX_CHARS,
  )
  const intentType = shortText(String(raw.intentType || ''), 48) || 'other'
  const intentSummary = shortText(String(raw.intentSummary || ''), 280)
  const intentGoal = shortText(String(raw.intentGoal || goal), 220)
  const assistantResult = buildAssistantResultBody(String(raw.assistantResult || raw.summary || ''))
  const compactSummary = shortText(
    String(raw.summary || '').trim() || `处理: ${extractCoreSummary(assistantResult || goal)}`,
    TASK_MEMORY_SUMMARY_MAX_CHARS,
  )
  const sourceSessionId = shortText(String((raw as Record<string, unknown>).sourceSessionId || ''), 120)
  const sourceUserMessageId = shortText(String((raw as Record<string, unknown>).sourceUserMessageId || ''), 180)
  const sourceAssistantMessageId = shortText(String((raw as Record<string, unknown>).sourceAssistantMessageId || ''), 180)
  const sourceMessageIds = normalizeStringList((raw as Record<string, unknown>).sourceMessageIds, 200)
  const sourceStartSeqNum = Number((raw as Record<string, unknown>).sourceStartSeq)
  const sourceEndSeqNum = Number((raw as Record<string, unknown>).sourceEndSeq)
  const sourceStartSeq = Number.isFinite(sourceStartSeqNum) ? Math.floor(sourceStartSeqNum) : undefined
  const sourceEndSeq = Number.isFinite(sourceEndSeqNum) ? Math.floor(sourceEndSeqNum) : undefined

  const createdAtRaw = normalizeIso(raw.createdAt)
  const updatedAtRaw = normalizeIso(raw.updatedAt)
  const createdAt = createdAtRaw || updatedAtRaw || now
  const updatedAt = updatedAtRaw || createdAt

  const rawId = String(raw.id || '').trim()
  const stableId = rawId || `task-legacy-${createHash('sha1').update(`${goal}|${createdAt}|${index}`).digest('hex').slice(0, 12)}`

  return {
    id: stableId,
    userQuery,
    ...(userAssetsBlock ? { userAssetsBlock } : {}),
    goal,
    intentType,
    intentSummary,
    intentGoal,
    assistantResult,
    summary: compactSummary,
    outcome: normalizeOutcome(raw.outcome),
    tools: normalizeStringList(raw.tools, 120),
    changedFiles: normalizeStringList(raw.changedFiles, 160),
    identifiers: normalizeStringList(raw.identifiers, 160),
    evidenceFacts: normalizeStringList((raw as Record<string, unknown>).evidenceFacts, 2000),
    ...(sourceSessionId ? { sourceSessionId } : {}),
    ...(sourceUserMessageId ? { sourceUserMessageId } : {}),
    ...(sourceAssistantMessageId ? { sourceAssistantMessageId } : {}),
    ...(sourceMessageIds.length > 0 ? { sourceMessageIds } : {}),
    ...(typeof sourceStartSeq === 'number' ? { sourceStartSeq } : {}),
    ...(typeof sourceEndSeq === 'number' ? { sourceEndSeq } : {}),
    failures: normalizeStringList(raw.failures, 32),
    ...(normalizeIso((raw as Record<string, unknown>).deletedAt) ? { deletedAt: normalizeIso((raw as Record<string, unknown>).deletedAt) } : {}),
    ...(shortText(String((raw as Record<string, unknown>).deletedReason || ''), 220) ? { deletedReason: shortText(String((raw as Record<string, unknown>).deletedReason || ''), 220) } : {}),
    ...(shortText(String((raw as Record<string, unknown>).mergedIntoId || ''), 80) ? { mergedIntoId: shortText(String((raw as Record<string, unknown>).mergedIntoId || ''), 80) } : {}),
    createdAt,
    updatedAt,
  }
}

function isSoftDeletedMemory(item: TaskMemoryEntry): boolean {
  const ts = Date.parse(String((item as Record<string, unknown>).deletedAt || ''))
  return Number.isFinite(ts) && ts > 0
}

const noteScopeReadyByScope = new Set<string>()
const taskMemoryScopeReadyByScope = new Set<string>()
const snapshotScopeReadyByScope = new Set<string>()
let legacyMemoryDbBootstrapDone = false
let legacyMemoryDbBootstrapPromise: Promise<void> | null = null

function legacyScopeKeyFromFilePath(filePath: string): string {
  return path.basename(filePath, path.extname(filePath))
}

function legacyDbScope(scopeKey: string): { workspace: string; scopeKey: string } {
  return {
    workspace: '',
    scopeKey,
  }
}

async function listLegacyScopeKeys(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => path.join(dirPath, entry.name))
      .map(legacyScopeKeyFromFilePath)
  } catch {
    return []
  }
}

async function ensureLegacyMemoryDbBootstrap(): Promise<void> {
  if (legacyMemoryDbBootstrapDone) return
  if (legacyMemoryDbBootstrapPromise) {
    await legacyMemoryDbBootstrapPromise
    return
  }

  legacyMemoryDbBootstrapPromise = (async () => {
    initMemoryDb()
    if (!isMemoryDbEmpty()) {
      legacyMemoryDbBootstrapDone = true
      return
    }

    const scopeKeys = new Set<string>([
      ...(await listLegacyScopeKeys(NOTES_DIR)),
      ...(await listLegacyScopeKeys(MEMORY_DIR)),
      ...(await listLegacyScopeKeys(MEMORY_ARCHIVE_DIR)),
      ...(await listLegacyScopeKeys(SNAPSHOT_DIR)),
    ])

    if (scopeKeys.size <= 0) {
      legacyMemoryDbBootstrapDone = true
      return
    }

    let importedNoteCount = 0
    let importedActiveCount = 0
    let importedArchiveCount = 0
    let importedSnapshotCount = 0

    for (const scopeKey of Array.from(scopeKeys).sort()) {
      const scopeRef = legacyDbScope(scopeKey)
      const [legacyNotes, legacyActive, legacyArchive, legacySnapshots] = await Promise.all([
        readJsonArray<ProjectNote>(path.join(NOTES_DIR, `${scopeKey}.json`)),
        readJsonArray<TaskMemoryEntry>(path.join(MEMORY_DIR, `${scopeKey}.json`)),
        readJsonArray<TaskMemoryEntry>(path.join(MEMORY_ARCHIVE_DIR, `${scopeKey}.json`)),
        readJsonArray<MemorySnapshotEntry>(path.join(SNAPSHOT_DIR, `${scopeKey}.json`)),
      ])

      const normalizedNotes = legacyNotes.map((item, index) => normalizeProjectNoteEntry(item, index))
      const normalizedActive = legacyActive.map((item, index) => normalizeTaskMemoryEntry(item, index))
      const normalizedArchive = legacyArchive.map((item, index) => normalizeTaskMemoryEntry(item, index))
      const normalizedSnapshots = legacySnapshots.map((item, index) => normalizeMemorySnapshotEntry(item, index))

      if (normalizedNotes.length > 0) {
        importProjectNotes(scopeRef, normalizedNotes)
        importedNoteCount += normalizedNotes.length
      }
      if (normalizedActive.length > 0) {
        importTaskMemoriesByTier(scopeRef, normalizedActive, 'active')
        importedActiveCount += normalizedActive.length
      }
      if (normalizedArchive.length > 0) {
        importTaskMemoriesByTier(scopeRef, normalizedArchive, 'archive')
        importedArchiveCount += normalizedArchive.length
      }
      if (normalizedSnapshots.length > 0) {
        importMemorySnapshots(scopeRef, normalizedSnapshots)
        importedSnapshotCount += normalizedSnapshots.length
      }
    }

    log('LEGACY_MEMORY_DB_BOOTSTRAP_DONE', {
      scopeCount: scopeKeys.size,
      importedNoteCount,
      importedActiveCount,
      importedArchiveCount,
      importedSnapshotCount,
    })
    legacyMemoryDbBootstrapDone = true
  })().finally(() => {
    legacyMemoryDbBootstrapPromise = null
  })

  await legacyMemoryDbBootstrapPromise
}

async function ensureNoteScopeReady(workspace: string, projectId?: string): Promise<void> {
  const scope = resolveScope(workspace, projectId)
  if (noteScopeReadyByScope.has(scope)) return
  await ensureLegacyMemoryDbBootstrap()
  initMemoryDb()

  const primaryFile = notesFilePath(workspace, projectId)
  const primaryExists = await pathExists(primaryFile)
  const legacyNotes = primaryExists
    ? (await readJsonArray<ProjectNote>(primaryFile)).map((item, index) => normalizeProjectNoteEntry(item, index))
    : []

  if (legacyNotes.length > 0) {
    if (!hasAnyProjectNotes({ workspace, projectId })) {
      importProjectNotes({ workspace, projectId }, legacyNotes)
      log('PROJECT_NOTES_DB_SCOPE_MIGRATED', {
        scope,
        noteCount: legacyNotes.length,
      })
    }
  }

  noteScopeReadyByScope.add(scope)
}

async function ensureTaskMemoryScopeReady(workspace: string, projectId?: string): Promise<void> {
  const scope = resolveScope(workspace, projectId)
  if (taskMemoryScopeReadyByScope.has(scope)) return
  await ensureLegacyMemoryDbBootstrap()
  initMemoryDb()

  const primaryFile = memoryFilePath(workspace, projectId)
  const primaryExists = await pathExists(primaryFile)
  const legacyActive = primaryExists
    ? (await readJsonArray<TaskMemoryEntry>(primaryFile)).map((item, index) => normalizeTaskMemoryEntry(item, index))
    : []

  const archiveFile = memoryArchiveFilePath(workspace, projectId)
  const archiveExists = await pathExists(archiveFile)
  const legacyArchive = archiveExists
    ? (await readJsonArray<TaskMemoryEntry>(archiveFile)).map((item, index) => normalizeTaskMemoryEntry(item, index))
    : []

  if (legacyActive.length > 0 || legacyArchive.length > 0) {
    if (!hasAnyTaskMemories({ workspace, projectId })) {
      importTaskMemoriesByTier({ workspace, projectId }, legacyActive, 'active')
      importTaskMemoriesByTier({ workspace, projectId }, legacyArchive, 'archive')
      log('TASK_MEMORY_DB_SCOPE_MIGRATED', {
        scope,
        activeCount: legacyActive.length,
        archiveCount: legacyArchive.length,
      })
    }
  }

  taskMemoryScopeReadyByScope.add(scope)
}

async function ensureSnapshotScopeReady(workspace: string, projectId?: string): Promise<void> {
  const scope = resolveScope(workspace, projectId)
  if (snapshotScopeReadyByScope.has(scope)) return
  await ensureLegacyMemoryDbBootstrap()
  initMemoryDb()

  const primaryFile = snapshotFilePath(workspace, projectId)
  const primaryExists = await pathExists(primaryFile)
  const legacySnapshots = primaryExists
    ? (await readJsonArray<MemorySnapshotEntry>(primaryFile)).map((item, index) => normalizeMemorySnapshotEntry(item, index))
    : []

  if (legacySnapshots.length > 0) {
    if (!hasAnyMemorySnapshots({ workspace, projectId })) {
      importMemorySnapshots({ workspace, projectId }, legacySnapshots)
      log('MEMORY_SNAPSHOT_DB_SCOPE_MIGRATED', {
        scope,
        snapshotCount: legacySnapshots.length,
      })
    }
  }

  snapshotScopeReadyByScope.add(scope)
}

async function loadTaskMemories(workspace: string, projectId?: string): Promise<TaskMemoryEntry[]> {
  await ensureTaskMemoryScopeReady(workspace, projectId)
  return listTaskMemoriesByTier({ workspace, projectId }, 'active').map((item, index) => normalizeTaskMemoryEntry(item, index))
}

async function loadTaskMemoryArchive(workspace: string, projectId?: string): Promise<TaskMemoryEntry[]> {
  await ensureTaskMemoryScopeReady(workspace, projectId)
  return listTaskMemoriesByTier({ workspace, projectId }, 'archive').map((item, index) => normalizeTaskMemoryEntry(item, index))
}

async function saveTaskMemories(workspace: string, items: TaskMemoryEntry[], projectId?: string): Promise<void> {
  await ensureTaskMemoryScopeReady(workspace, projectId)
  replaceTaskMemoriesByTier({ workspace, projectId }, items, 'active')
}

async function saveTaskMemoryArchive(workspace: string, items: TaskMemoryEntry[], projectId?: string): Promise<void> {
  await ensureTaskMemoryScopeReady(workspace, projectId)
  replaceTaskMemoriesByTier({ workspace, projectId }, items, 'archive')
}

function taskMemoryTs(item: TaskMemoryEntry): number {
  const updated = Date.parse(item.updatedAt || '')
  if (Number.isFinite(updated)) return updated
  const created = Date.parse(item.createdAt || '')
  if (Number.isFinite(created)) return created
  return 0
}

function sortTaskMemoriesByTimeAsc(items: TaskMemoryEntry[]): TaskMemoryEntry[] {
  return [...items].sort((a, b) => {
    const ta = taskMemoryTs(a)
    const tb = taskMemoryTs(b)
    if (ta !== tb) return ta - tb
    return String(a.id).localeCompare(String(b.id))
  })
}

function mergeTaskMemoryById(items: TaskMemoryEntry[]): TaskMemoryEntry[] {
  const byId = new Map<string, TaskMemoryEntry>()
  for (const item of items) {
    const id = String(item.id || '').trim()
    if (!id) continue
    const prev = byId.get(id)
    if (!prev) {
      byId.set(id, item)
      continue
    }
    if (taskMemoryTs(item) >= taskMemoryTs(prev)) byId.set(id, item)
  }
  return sortTaskMemoriesByTimeAsc(Array.from(byId.values()))
}

async function loadTaskMemoriesForRecall(workspace: string, projectId?: string): Promise<TaskMemoryEntry[]> {
  const [active, archived] = await Promise.all([
    loadTaskMemories(workspace, projectId),
    loadTaskMemoryArchive(workspace, projectId),
  ])
  const merged = archived.length === 0 ? sortTaskMemoriesByTimeAsc(active) : mergeTaskMemoryById([...archived, ...active])
  return merged.filter((item) => !isSoftDeletedMemory(item))
}

/** 列出任务执行记忆（按时间倒序） */
export async function listTaskMemories(workspace: string, projectId?: string): Promise<TaskMemoryEntry[]> {
  const items = await loadTaskMemoriesForRecall(workspace, projectId)
  return [...items].sort((a, b) => {
    const ta = Date.parse(a.updatedAt || a.createdAt || '')
    const tb = Date.parse(b.updatedAt || b.createdAt || '')
    const safeA = Number.isFinite(ta) ? ta : 0
    const safeB = Number.isFinite(tb) ? tb : 0
    if (safeB !== safeA) return safeB - safeA
    return String(a.id).localeCompare(String(b.id))
  })
}

/** 删除任务执行记忆 */
export async function deleteTaskMemory(workspace: string, memoryId: string, projectId?: string): Promise<void> {
  const now = new Date().toISOString()
  const [active, archived] = await Promise.all([
    loadTaskMemories(workspace, projectId),
    loadTaskMemoryArchive(workspace, projectId),
  ])
  const softDelete = (item: TaskMemoryEntry): TaskMemoryEntry => {
    if (item.id !== memoryId) return item
    if (isSoftDeletedMemory(item)) return item
    return {
      ...item,
      deletedAt: now,
      deletedReason: 'manual_delete',
      updatedAt: now,
    }
  }
  const nextActive = active.map(softDelete)
  const nextArchive = archived.map(softDelete)
  await Promise.all([
    saveTaskMemories(workspace, nextActive, projectId),
    saveTaskMemoryArchive(workspace, nextArchive, projectId),
  ])
}

function normalizeMemorySnapshotEntry(raw: Partial<MemorySnapshotEntry>, index: number): MemorySnapshotEntry {
  const now = new Date().toISOString()
  const createdAtRaw = normalizeIso(raw.createdAt)
  const updatedAtRaw = normalizeIso(raw.updatedAt)
  const createdAt = createdAtRaw || updatedAtRaw || now
  const updatedAt = updatedAtRaw || createdAt
  const summary = shortText(String(raw.summary || '').trim(), MEMORY_SNAPSHOT_SUMMARY_MAX_CHARS)
  const sourceMessageCountRaw = Number(raw.sourceMessageCount)
  const sourceMessageCount = Number.isFinite(sourceMessageCountRaw) && sourceMessageCountRaw >= 0
    ? Math.floor(sourceMessageCountRaw)
    : 0
  const rawId = String(raw.id || '').trim()
  const stableId = rawId || `snapshot-legacy-${createHash('sha1').update(`${summary}|${createdAt}|${index}`).digest('hex').slice(0, 12)}`

  return {
    id: stableId,
    summary,
    sourceMessageCount,
    ...(Number.isFinite(Number(raw.usageTotalTokens)) ? { usageTotalTokens: Number(raw.usageTotalTokens) } : {}),
    ...(Number.isFinite(Number(raw.maxTokens)) ? { maxTokens: Number(raw.maxTokens) } : {}),
    createdAt,
    updatedAt,
  }
}

function memorySnapshotTimestamp(item: MemorySnapshotEntry): number {
  const updated = Date.parse(item.updatedAt || '')
  if (Number.isFinite(updated)) return updated
  const created = Date.parse(item.createdAt || '')
  if (Number.isFinite(created)) return created
  return 0
}

async function loadMemorySnapshots(workspace: string, projectId?: string): Promise<MemorySnapshotEntry[]> {
  await ensureSnapshotScopeReady(workspace, projectId)
  return listMemorySnapshotsForScope({ workspace, projectId }).map((item, index) => normalizeMemorySnapshotEntry(item, index))
}

async function saveMemorySnapshots(workspace: string, items: MemorySnapshotEntry[], projectId?: string): Promise<void> {
  await ensureSnapshotScopeReady(workspace, projectId)
  replaceMemorySnapshots({ workspace, projectId }, items)
}

function latestIso(values: Array<string | undefined>): string | undefined {
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

export async function getMemoryScopeStats(workspace: string, projectId?: string): Promise<MemoryScopeStats> {
  await Promise.all([
    ensureNoteScopeReady(workspace, projectId),
    ensureTaskMemoryScopeReady(workspace, projectId),
    ensureSnapshotScopeReady(workspace, projectId),
  ])

  const [notes, activeTaskMemories, archivedTaskMemories, snapshots] = await Promise.all([
    listNotes(workspace, projectId),
    loadTaskMemories(workspace, projectId),
    loadTaskMemoryArchive(workspace, projectId),
    loadMemorySnapshots(workspace, projectId),
  ])
  const dbInfo = getMemoryDbInfo()
  const allTaskMemories = [...activeTaskMemories, ...archivedTaskMemories]
  const visibleActiveTaskMemories = activeTaskMemories.filter((item) => !isSoftDeletedMemory(item))
  const visibleArchivedTaskMemories = archivedTaskMemories.filter((item) => !isSoftDeletedMemory(item))
  const deletedTaskMemories = allTaskMemories.filter(isSoftDeletedMemory).length

  return {
    scope: resolveScope(workspace, projectId),
    dbPath: dbInfo.dbPath,
    dbSizeBytes: dbInfo.dbSizeBytes,
    manualNotes: notes.length,
    activeTaskMemories: visibleActiveTaskMemories.length,
    archivedTaskMemories: visibleArchivedTaskMemories.length,
    deletedTaskMemories,
    snapshots: snapshots.length,
    maintainRuns: countMemoryMaintainRuns({ workspace, projectId }),
    ...(latestIso(notes.map((item) => item.updatedAt || item.createdAt)) ? { latestNoteUpdatedAt: latestIso(notes.map((item) => item.updatedAt || item.createdAt)) } : {}),
    ...(latestIso(allTaskMemories.map((item) => item.updatedAt || item.createdAt)) ? { latestTaskMemoryUpdatedAt: latestIso(allTaskMemories.map((item) => item.updatedAt || item.createdAt)) } : {}),
    ...(latestIso(snapshots.map((item) => item.updatedAt || item.createdAt)) ? { latestSnapshotUpdatedAt: latestIso(snapshots.map((item) => item.updatedAt || item.createdAt)) } : {}),
  }
}

export async function exportMemoryScope(workspace: string, projectId?: string): Promise<MemoryScopeExportResult> {
  await Promise.all([
    ensureNoteScopeReady(workspace, projectId),
    ensureTaskMemoryScopeReady(workspace, projectId),
    ensureSnapshotScopeReady(workspace, projectId),
  ])

  const [notes, activeTaskMemories, archivedTaskMemories, snapshots, stats] = await Promise.all([
    listNotes(workspace, projectId),
    loadTaskMemories(workspace, projectId),
    loadTaskMemoryArchive(workspace, projectId),
    loadMemorySnapshots(workspace, projectId),
    getMemoryScopeStats(workspace, projectId),
  ])

  await fs.mkdir(MEMORY_EXPORT_DIR, { recursive: true })
  const exportedAt = new Date().toISOString()
  const scope = resolveScope(workspace, projectId)
  const filePath = path.join(MEMORY_EXPORT_DIR, `memory-export-${scope}-${Date.now()}.json`)
  const payload = {
    exportedAt,
    workspace,
    ...(projectId ? { projectId } : {}),
    stats,
    notes,
    activeTaskMemories,
    archivedTaskMemories,
    snapshots,
  }
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8')

  return {
    filePath,
    exportedAt,
    manualNotes: notes.length,
    activeTaskMemories: activeTaskMemories.length,
    archivedTaskMemories: archivedTaskMemories.length,
    snapshots: snapshots.length,
  }
}

export async function recordMemorySnapshot(workspace: string, input: SnapshotLogInput, projectId?: string): Promise<MemorySnapshotEntry> {
  const now = new Date().toISOString()
  const summary = shortText(String(input.summary ?? '').trim(), MEMORY_SNAPSHOT_SUMMARY_MAX_CHARS)
  if (!summary) {
    throw new Error('recordMemorySnapshot requires non-empty summary')
  }
  const sourceMessageCountRaw = Number(input.sourceMessageCount)
  const sourceMessageCount = Number.isFinite(sourceMessageCountRaw) && sourceMessageCountRaw >= 0
    ? Math.floor(sourceMessageCountRaw)
    : 0
  const item: MemorySnapshotEntry = {
    id: `snapshot-${Date.now()}-${randomUUID().slice(0, 8)}`,
    summary,
    sourceMessageCount,
    ...(Number.isFinite(Number(input.usageTotalTokens)) ? { usageTotalTokens: Number(input.usageTotalTokens) } : {}),
    ...(Number.isFinite(Number(input.maxTokens)) ? { maxTokens: Number(input.maxTokens) } : {}),
    createdAt: now,
    updatedAt: now,
  }

  const current = await loadMemorySnapshots(workspace, projectId)
  const merged = [...current, item].slice(-MEMORY_SNAPSHOT_MAX_ENTRIES)
  await saveMemorySnapshots(workspace, merged, projectId)
  return item
}

function shortText(input: string, max: number): string {
  const text = String(input ?? '').replace(/\r/g, '').trim()
  if (!text) return ''
  return text.length <= max ? text : `${text.slice(0, max)}...`
}

function compactJoin(items: string[], limit: number): string {
  const cleaned = [...new Set(items.map((x) => String(x || '').trim()).filter(Boolean))]
  if (cleaned.length === 0) return ''
  if (cleaned.length <= limit) return cleaned.join('、')
  return `${cleaned.slice(0, limit).join('、')} 等${cleaned.length}项`
}

function extractCoreSummary(summary: string): string {
  const raw = stripPseudoToolCallArtifacts(
    stripInternalContextTags(String(summary ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '')),
  ).trim()
  if (!raw) return ''

  const marker = '处理总结:'
  const base = raw.includes(marker) ? raw.slice(raw.indexOf(marker) + marker.length) : raw
  const lines = base
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^用户问题[:：]/.test(line))
    .filter((line) => !/^用户意图[:：]/.test(line))
    .filter((line) => !/^意图来源[:：]/.test(line))
    .filter((line) => !/^意图目标[:：]/.test(line))

  if (lines.length === 0) return shortText(base, TASK_MEMORY_CORE_MAX_CHARS)
  return shortText(lines.slice(0, 8).join('；'), TASK_MEMORY_CORE_MAX_CHARS)
}

function normalizeEvidenceFacts(items: string[] | undefined, limit = 12): string[] {
  const cleaned = [...new Set((items ?? [])
    .map((item) => stripControlChars(String(item ?? '').replace(/\r/g, '').trim()))
    .filter(Boolean))]
  return cleaned.slice(0, limit)
}

function extractStructuredFactLines(summary: string): string[] {
  const cleaned = stripPseudoToolCallArtifacts(stripInternalContextTags(String(summary ?? '')))
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/\r/g, '')
    .trim()
  if (!cleaned) return []

  const lines = cleaned.split('\n').map((line) => line.trim())
  const facts: string[] = []
  let inFacts = false

  for (const line of lines) {
    if (!line) {
      if (inFacts) break
      continue
    }

    if (/^关键事实[:：]\s*$/u.test(line)) {
      inFacts = true
      continue
    }

    if (/^关键事实[:：]/u.test(line)) {
      inFacts = true
      const inlineFact = line.replace(/^关键事实[:：]\s*/u, '').replace(/^[-*•]\s*/, '').trim()
      if (inlineFact) facts.push(inlineFact)
      continue
    }

    if (!inFacts) continue

    if (/^(?:[-*•]\s+|\d+\.\s+)/.test(line)) {
      facts.push(line.replace(/^(?:[-*•]\s+|\d+\.\s+)/, '').trim())
      continue
    }

    if (/^[\u4e00-\u9fa5A-Za-z][^:：]{0,30}[:：]\s*/.test(line)) break
    facts.push(line)
  }

  return normalizeEvidenceFacts(facts, 12)
}

function buildAssistantResultBody(summary: string, evidenceFacts?: string[]): string {
  const cleaned = stripPseudoToolCallArtifacts(stripInternalContextTags(String(summary ?? '')))
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/\r/g, '')
    .trim()
  if (!cleaned) return ''

  // 兼容「处理总结:」模板，优先保留实际处理结果正文
  const marker = '处理总结:'
  const base = cleaned.includes(marker) ? cleaned.slice(cleaned.indexOf(marker) + marker.length).trim() : cleaned

  const compact = stripMemoryMetaLines(base)
  const normalizedFacts = normalizeEvidenceFacts(evidenceFacts, 12)
  const factLines = normalizedFacts.filter((fact) => !(compact || base).includes(fact))
  const factBlock = factLines.length > 0
    ? `\n\n关键事实:\n${factLines.map((fact) => `- ${fact}`).join('\n')}`
    : ''

  return shortText(`${compact || base}${factBlock}`.trim(), TASK_MEMORY_ASSISTANT_RESULT_MAX_CHARS)
}

function buildCompactMemorySummary(input: TaskLogInput): string {
  const intentType = shortText(input.intentType || '', 48) || 'other'
  const intentSummary = shortText(input.intentSummary || '', 160)
  const core = extractCoreSummary(input.summary)
  const toolText = compactJoin(input.tools ?? [], 4)
  const fileText = compactJoin(input.changedFiles ?? [], 4)
  const factText = compactJoin(normalizeEvidenceFacts(input.evidenceFacts, 6), 3)
  const failureText = compactJoin((input.failures ?? []).slice(0, 3), 2)
  const outcomeText = input.outcome === 'success'
    ? '成功'
    : input.outcome === 'aborted'
      ? '中止'
      : '失败'

  const lines = [
    `意图: ${intentType}${intentSummary ? ` | ${intentSummary}` : ''}`,
    `结果: ${outcomeText}`,
    core ? `处理: ${core}` : '',
    toolText ? `动作: ${toolText}` : '',
    fileText ? `文件: ${fileText}` : '',
    factText ? `关键事实: ${factText}` : '',
    failureText ? `异常: ${failureText}` : '',
  ].filter(Boolean)

  return shortText(lines.join('\n'), TASK_MEMORY_SUMMARY_MAX_CHARS)
}

function normalizeHistoricalField(input: string, max: number): string {
  return shortText(
    stripControlChars(
      stripPseudoToolCallArtifacts(stripInternalContextTags(String(input ?? '')))
        .replace(/\r/g, '')
        .replace(/\n+/g, '；')
        .trim(),
    ),
    max,
  )
}

function extractHistoricalFollowUpHint(summary: string): string {
  const cleaned = stripPseudoToolCallArtifacts(stripInternalContextTags(String(summary ?? '')))
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/\r/g, '')
    .trim()
  if (!cleaned) return ''

  const lines = cleaned
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const pattern = /(是否需要|要不要|需不需要|还需要|如果需要|如需|需要我|继续吗|是否继续|可继续|要我继续|让我继续|\?|？)/i

  let candidate = ''
  for (const line of lines) {
    if (pattern.test(line)) candidate = line
  }
  return normalizeHistoricalField(candidate, 220)
}

function buildHistoricalTaskResultBlock(item: TaskMemoryEntry): string {
  const lines = ['[HISTORICAL_TASK_RESULT]']
  lines.push(`outcome: ${item.outcome}`)

  const intentType = normalizeHistoricalField(String(item.intentType || ''), 48)
  if (intentType) lines.push(`intent_type: ${intentType}`)

  const tools = compactJoin(item.tools ?? [], 6)
  if (tools) lines.push(`tools: ${tools}`)

  const changedFiles = compactJoin(item.changedFiles ?? [], 6)
  if (changedFiles) lines.push(`changed_files: ${changedFiles}`)

  const identifiers = compactJoin(item.identifiers ?? [], 6)
  if (identifiers) lines.push(`identifiers: ${identifiers}`)

  const sourceSessionId = normalizeHistoricalField(String(item.sourceSessionId || ''), 120)
  if (sourceSessionId) lines.push(`source_session_id: ${sourceSessionId}`)
  const sourceStartSeq = Number.isFinite(Number(item.sourceStartSeq)) ? Math.floor(Number(item.sourceStartSeq)) : undefined
  const sourceEndSeq = Number.isFinite(Number(item.sourceEndSeq)) ? Math.floor(Number(item.sourceEndSeq)) : undefined
  if (typeof sourceStartSeq === 'number' || typeof sourceEndSeq === 'number') {
    lines.push(`source_seq_range: ${typeof sourceStartSeq === 'number' ? sourceStartSeq : '?'}-${typeof sourceEndSeq === 'number' ? sourceEndSeq : '?'}`)
  }

  const failures = compactJoin((item.failures ?? []).slice(0, 3), 3)
  if (failures) lines.push(`failures: ${failures}`)

  const factLines = item.evidenceFacts.length > 0
    ? item.evidenceFacts
    : extractStructuredFactLines(String(item.assistantResult || ''))
  if (factLines.length > 0) {
    lines.push('key_facts:')
    for (const fact of factLines) {
      lines.push(`- ${normalizeHistoricalField(fact, TASK_MEMORY_REPLAY_RESULT_MAX_CHARS)}`)
    }
  }

  const summary = normalizeHistoricalField(
    extractCoreSummary(String(item.summary || item.assistantResult || item.goal)) || String(item.summary || item.goal),
    TASK_MEMORY_REPLAY_RESULT_MAX_CHARS,
  )
  if (summary) lines.push(`summary: ${summary}`)

  const followUpHint = extractHistoricalFollowUpHint(String(item.assistantResult || ''))
  if (followUpHint) lines.push(`follow_up_hint: ${followUpHint}`)

  lines.push('[/HISTORICAL_TASK_RESULT]')
  return lines.join('\n')
}

/**
 * 每轮任务结束后写入任务记忆（独立存储，不污染手工笔记列表）
 */
export async function recordTaskLog(workspace: string, input: TaskLogInput, projectId?: string): Promise<TaskMemoryEntry> {
  const now = new Date().toISOString()
  const evidenceFacts = normalizeEvidenceFacts(input.evidenceFacts, 2000)
  const assistantResult = buildAssistantResultBody(input.summary, evidenceFacts)
  const compactSummary = buildCompactMemorySummary(input)
  const normalizedUserQuery = extractUserQueryText(input.userQuery || input.goal)
  const normalizedUserAssetsBlock = shortText(
    stripControlChars(String(input.userAssetsBlock || extractUserAssetsBlock(input.userQuery || input.goal || ''))),
    TASK_MEMORY_USER_ASSETS_MAX_CHARS,
  )
  const normalizedSourceRef = normalizeTaskLogSourceRef(input.sourceRef)
  let sourceMessageIds = normalizedSourceRef.messageIds ?? []
  let sourceStartSeq: number | undefined
  let sourceEndSeq: number | undefined
  if (normalizedSourceRef.sessionId && sourceMessageIds.length > 0) {
    const resolved = resolveChatStoreMessageSeqRange(normalizedSourceRef.sessionId, sourceMessageIds)
    if (resolved.resolvedMessageIds.length > 0) {
      sourceMessageIds = [...new Set([...sourceMessageIds, ...resolved.resolvedMessageIds])]
    }
    if (typeof resolved.startSeq === 'number') sourceStartSeq = resolved.startSeq
    if (typeof resolved.endSeq === 'number') sourceEndSeq = resolved.endSeq
  }
  const item: TaskMemoryEntry = {
    id: `task-${Date.now()}-${randomUUID().slice(0, 8)}`,
    userQuery: shortText(normalizedUserQuery || input.goal, 800),
    ...(normalizedUserAssetsBlock ? { userAssetsBlock: normalizedUserAssetsBlock } : {}),
    goal: shortText(input.goal, 800),
    intentType: shortText(input.intentType || '', 48) || 'other',
    intentSummary: shortText(input.intentSummary || '', 280),
    intentGoal: shortText(input.intentGoal || input.goal, 220),
    assistantResult,
    summary: compactSummary,
    outcome: input.outcome,
    tools: [...new Set((input.tools ?? []).map((x) => String(x).trim()).filter(Boolean))],
    changedFiles: [...new Set((input.changedFiles ?? []).map((x) => String(x).trim()).filter(Boolean))],
    identifiers: [...new Set((input.identifiers ?? []).map((x) => String(x).trim()).filter(Boolean))],
    evidenceFacts,
    ...(normalizedSourceRef.sessionId ? { sourceSessionId: normalizedSourceRef.sessionId } : {}),
    ...(normalizedSourceRef.userMessageId ? { sourceUserMessageId: normalizedSourceRef.userMessageId } : {}),
    ...(normalizedSourceRef.assistantMessageId ? { sourceAssistantMessageId: normalizedSourceRef.assistantMessageId } : {}),
    ...(sourceMessageIds.length > 0 ? { sourceMessageIds } : {}),
    ...(typeof sourceStartSeq === 'number' ? { sourceStartSeq } : {}),
    ...(typeof sourceEndSeq === 'number' ? { sourceEndSeq } : {}),
    failures: [...new Set((input.failures ?? []).map((x) => String(x).trim()).filter(Boolean))].slice(0, 24),
    createdAt: now,
    updatedAt: now,
  }

  const current = await loadTaskMemories(workspace, projectId)

  // 近似去重：短时间内完全相同目标+总结+结果，视为同一条，更新而不重复堆积
  const duplicateIdx = current.findIndex((entry) =>
    !isSoftDeletedMemory(entry) &&
    (entry.userQuery ?? '') === (item.userQuery ?? '') &&
    (entry.userAssetsBlock ?? '') === (item.userAssetsBlock ?? '') &&
    entry.goal === item.goal &&
    entry.summary === item.summary &&
    (entry.assistantResult ?? '') === (item.assistantResult ?? '') &&
    entry.outcome === item.outcome &&
    Math.abs(Date.parse(entry.updatedAt || entry.createdAt || '') - Date.now()) <= 10 * 60 * 1000
  )

  if (duplicateIdx >= 0) {
    const duplicate = current[duplicateIdx]
    const mergedSourceMessageIds = [...new Set([...(duplicate.sourceMessageIds ?? []), ...(item.sourceMessageIds ?? [])].filter(Boolean))]
    const mergedSourceStartSeq = [duplicate.sourceStartSeq, item.sourceStartSeq].filter((x) => typeof x === 'number').sort((a, b) => Number(a) - Number(b))[0]
    const mergedSourceEndSeq = [duplicate.sourceEndSeq, item.sourceEndSeq].filter((x) => typeof x === 'number').sort((a, b) => Number(b) - Number(a))[0]
    current[duplicateIdx] = {
      ...duplicate,
      ...item,
      id: duplicate.id,
      createdAt: duplicate.createdAt,
      updatedAt: now,
      ...(mergedSourceMessageIds.length > 0 ? { sourceMessageIds: mergedSourceMessageIds } : {}),
      ...(typeof mergedSourceStartSeq === 'number' ? { sourceStartSeq: mergedSourceStartSeq } : {}),
      ...(typeof mergedSourceEndSeq === 'number' ? { sourceEndSeq: mergedSourceEndSeq } : {}),
      ...(!item.sourceSessionId && duplicate.sourceSessionId ? { sourceSessionId: duplicate.sourceSessionId } : {}),
      ...(!item.sourceUserMessageId && duplicate.sourceUserMessageId ? { sourceUserMessageId: duplicate.sourceUserMessageId } : {}),
      ...(!item.sourceAssistantMessageId && duplicate.sourceAssistantMessageId ? { sourceAssistantMessageId: duplicate.sourceAssistantMessageId } : {}),
    }
    await saveTaskMemories(workspace, current, projectId)
    return current[duplicateIdx]
  }

  const merged = sortTaskMemoriesByTimeAsc([...current, item])
  if (merged.length <= TASK_MEMORY_MAX_ENTRIES) {
    await saveTaskMemories(workspace, merged, projectId)
    return item
  }

  const overflowCount = Math.max(0, merged.length - TASK_MEMORY_MAX_ENTRIES)
  const overflow = merged.slice(0, overflowCount)
  const keepActive = merged.slice(overflowCount)
  const archive = await loadTaskMemoryArchive(workspace, projectId)
  const mergedArchive = mergeTaskMemoryById([...archive, ...overflow])
  const trimmedArchive = mergedArchive.length > TASK_MEMORY_ARCHIVE_MAX_ENTRIES
    ? mergedArchive.slice(-TASK_MEMORY_ARCHIVE_MAX_ENTRIES)
    : mergedArchive

  await Promise.all([
    saveTaskMemories(workspace, keepActive, projectId),
    saveTaskMemoryArchive(workspace, trimmedArchive, projectId),
  ])
  return item
}

type MemoryConsolidationPatch = {
  goal?: string
  intentType?: string
  intentSummary?: string
  intentGoal?: string
  summary?: string
  assistantResult?: string
  outcome?: 'success' | 'aborted' | 'error'
  tools?: string[]
  changedFiles?: string[]
  identifiers?: string[]
  failures?: string[]
}

type MemoryConsolidationAction = {
  target_id?: string
  source_ids?: string[]
  merged_record?: MemoryConsolidationPatch
}

type MemoryConsolidationDecision = {
  merge_actions: MemoryConsolidationAction[]
  drop_ids: string[]
  keep_ids: string[]
}

function safeParseObjectFromText(raw: string): Record<string, unknown> | null {
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

function normalizeConsolidationDecision(value: unknown): MemoryConsolidationDecision | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const obj = value as Record<string, unknown>
  const mergeRaw = Array.isArray(obj.merge_actions) ? obj.merge_actions : []
  const mergeActions: MemoryConsolidationAction[] = mergeRaw
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    .map((item) => item as MemoryConsolidationAction)
    .slice(0, 200)
  const dropIds = normalizeStringArray(obj.drop_ids, 1200)
  const keepIds = normalizeStringArray(obj.keep_ids, 1200)
  return {
    merge_actions: mergeActions,
    drop_ids: dropIds,
    keep_ids: keepIds,
  }
}

function applyConsolidationPatch(base: TaskMemoryEntry, patch: MemoryConsolidationPatch | undefined, now: string): TaskMemoryEntry {
  if (!patch || typeof patch !== 'object') return { ...base, updatedAt: now }
  const next: TaskMemoryEntry = { ...base, updatedAt: now }
  const goal = shortText(String(patch.goal || '').trim(), 800)
  const intentType = shortText(String(patch.intentType || '').trim(), 48)
  const intentSummary = shortText(String(patch.intentSummary || '').trim(), 280)
  const intentGoal = shortText(String(patch.intentGoal || '').trim(), 220)
  const summaryRaw = String(patch.summary || '').trim()
  const assistantResultRaw = String(patch.assistantResult || '').trim()
  if (goal) next.goal = goal
  if (intentType) next.intentType = intentType
  if (intentSummary) next.intentSummary = intentSummary
  if (intentGoal) next.intentGoal = intentGoal
  if (summaryRaw) next.summary = shortText(summaryRaw, TASK_MEMORY_SUMMARY_MAX_CHARS)
  if (assistantResultRaw) next.assistantResult = buildAssistantResultBody(assistantResultRaw)
  if (patch.outcome === 'success' || patch.outcome === 'aborted' || patch.outcome === 'error') {
    next.outcome = patch.outcome
  }
  if (Array.isArray(patch.tools)) next.tools = normalizeStringList(patch.tools, 120)
  if (Array.isArray(patch.changedFiles)) next.changedFiles = normalizeStringList(patch.changedFiles, 160)
  if (Array.isArray(patch.identifiers)) next.identifiers = normalizeStringList(patch.identifiers, 160)
  if (Array.isArray(patch.failures)) next.failures = normalizeStringList(patch.failures, 32)
  delete (next as Record<string, unknown>).deletedAt
  delete (next as Record<string, unknown>).deletedReason
  delete (next as Record<string, unknown>).mergedIntoId
  return next
}

function repartitionTaskMemories(items: TaskMemoryEntry[]): { active: TaskMemoryEntry[]; archive: TaskMemoryEntry[] } {
  let all = sortTaskMemoriesByTimeAsc(items)
  if (all.length > TASK_MEMORY_TOTAL_MAX_ENTRIES) {
    let overflow = all.length - TASK_MEMORY_TOTAL_MAX_ENTRIES
    const kept: TaskMemoryEntry[] = []
    for (const item of all) {
      if (overflow > 0 && isSoftDeletedMemory(item)) {
        overflow--
        continue
      }
      kept.push(item)
    }
    if (overflow > 0) {
      all = kept.slice(overflow)
    } else {
      all = kept
    }
  }

  if (all.length <= TASK_MEMORY_MAX_ENTRIES) {
    return { active: all, archive: [] }
  }

  const active = all.slice(-TASK_MEMORY_MAX_ENTRIES)
  const archiveRaw = all.slice(0, -TASK_MEMORY_MAX_ENTRIES)
  const archive = archiveRaw.length > TASK_MEMORY_ARCHIVE_MAX_ENTRIES
    ? archiveRaw.slice(-TASK_MEMORY_ARCHIVE_MAX_ENTRIES)
    : archiveRaw
  return { active, archive }
}

function shouldRunMemoryMaintain(scope: string, options?: MemoryMaintainOptions): { run: boolean; reason: string } {
  const usage = typeof options?.usageTotalTokens === 'number' && Number.isFinite(options.usageTotalTokens) && options.usageTotalTokens > 0
    ? options.usageTotalTokens
    : undefined
  const max = typeof options?.maxTokens === 'number' && Number.isFinite(options.maxTokens) && options.maxTokens > 0
    ? options.maxTokens
    : undefined
  if (!usage || !max) return { run: false, reason: 'missing_usage_or_budget' }
  const ratio = usage / max
  if (ratio < MEMORY_MAINTAIN_RATIO) return { run: false, reason: `ratio_lt_${MEMORY_MAINTAIN_RATIO}` }
  if (memoryMaintainInFlightByScope.has(scope)) return { run: false, reason: 'in_flight' }
  const now = Date.now()
  const last = memoryMaintainLastRunAtByScope.get(scope) ?? 0
  if (now - last < MEMORY_MAINTAIN_MIN_INTERVAL_MS) return { run: false, reason: 'cooldown' }
  return { run: true, reason: `ratio_${ratio.toFixed(3)}` }
}

/**
 * 在高上下文压力下触发“全量记忆交给 AI 判定”的整理：
 * - AI 返回 merge/drop/keep 的 ID 决策
 * - 主进程仅按 ID 执行更新和软删除
 */
export async function maintainTaskMemoriesByAI(
  workspace: string,
  projectId: string | undefined,
  options?: MemoryMaintainOptions,
): Promise<{ applied: boolean; merged: number; dropped: number; total: number; reason: string }> {
  const provider = options?.provider
  if (!workspace || !workspace.trim()) return { applied: false, merged: 0, dropped: 0, total: 0, reason: 'empty_workspace' }
  if (!provider) return { applied: false, merged: 0, dropped: 0, total: 0, reason: 'missing_provider' }

  const scope = resolveScope(workspace, projectId)
  const gate = shouldRunMemoryMaintain(scope, options)
  if (!gate.run) return { applied: false, merged: 0, dropped: 0, total: 0, reason: gate.reason }
  memoryMaintainInFlightByScope.add(scope)
  try {

    const [active, archive] = await Promise.all([
      loadTaskMemories(workspace, projectId),
      loadTaskMemoryArchive(workspace, projectId),
    ])
    const all = mergeTaskMemoryById([...archive, ...active])
    const candidates = all.filter((item) => !isSoftDeletedMemory(item))
    if (candidates.length <= 1) {
      return { applied: false, merged: 0, dropped: 0, total: candidates.length, reason: 'insufficient_candidates' }
    }
    const protectedRecentIds = new Set(
      sortTaskMemoriesByTimeAsc(candidates)
        .slice(-Math.min(3, candidates.length))
        .map((item) => item.id),
    )

    const payload = {
      workspace: path.resolve(workspace),
      project_id: (projectId ?? '').trim(),
      rules: [
        '你必须基于全量记忆进行判定，不要省略。',
        '只能使用 memories 里已存在的 id，禁止虚构 id。',
        'merge_actions 表示 source_ids 合并进 target_id，target_id 必须保留。',
        'drop_ids 表示可淘汰记忆 id。',
        'keep_ids 表示保留不动记忆 id。',
        '同一个 id 不能同时出现在 merge/drop/keep 的冲突位置。',
        '禁止删除最近的连续上下文记忆；最新的 3 条记忆必须保留。',
        '输出必须是 JSON 对象，不要输出解释文本。',
      ],
      output_schema: {
        merge_actions: [{ target_id: 'string', source_ids: ['string'], merged_record: { summary: 'string', assistantResult: 'string' } }],
        drop_ids: ['string'],
        keep_ids: ['string'],
      },
      memories: candidates.map((item) => ({
        id: item.id,
        userQuery: item.userQuery || '',
        userAssetsBlock: item.userAssetsBlock || '',
        goal: item.goal,
        intentType: item.intentType || '',
        intentSummary: item.intentSummary || '',
        intentGoal: item.intentGoal || '',
        summary: item.summary,
        assistantResult: item.assistantResult || '',
        outcome: item.outcome,
        tools: item.tools,
        changedFiles: item.changedFiles,
        identifiers: item.identifiers,
        failures: item.failures,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      })),
    }

    const messages: ChatMessage[] = [
    {
      role: 'system',
      content: '你是记忆整理器。请根据输入记忆输出严格 JSON：merge_actions/drop_ids/keep_ids。禁止输出 JSON 之外内容。',
    },
    {
      role: 'user',
      content: JSON.stringify(payload),
    },
  ]

    let parsedDecision: MemoryConsolidationDecision | null = null
    try {
      const raw = await requestChatCompletion(provider, messages, options?.overrides, options?.signal, options?.logScope)
      const parsed = safeParseObjectFromText(raw)
      parsedDecision = normalizeConsolidationDecision(parsed)
      if (!parsedDecision) {
        log('TASK_MEMORY_MAINTAIN_PARSE_FAIL', { reason: 'invalid_json', raw: shortText(raw, 1200) }, options?.logScope)
        return { applied: false, merged: 0, dropped: 0, total: candidates.length, reason: 'invalid_json' }
      }
    } catch (err) {
      log('TASK_MEMORY_MAINTAIN_AI_FAIL', { error: err instanceof Error ? err.message : String(err) }, options?.logScope)
      return { applied: false, merged: 0, dropped: 0, total: candidates.length, reason: 'ai_fail' }
    }

    const byId = new Map<string, TaskMemoryEntry>()
    for (const item of all) byId.set(item.id, item)
    const now = new Date().toISOString()
    const mergedSources = new Set<string>()
    const keptTargets = new Set<string>()
    const explicitKeepIds = new Set(normalizeStringArray(parsedDecision.keep_ids, 1200))
    let mergedCount = 0
    let droppedCount = 0

  for (const action of parsedDecision.merge_actions) {
    const targetId = String(action.target_id || '').trim()
    if (!targetId) continue
    const target = byId.get(targetId)
    if (!target || isSoftDeletedMemory(target)) continue
    const sourceIds = normalizeStringArray(action.source_ids, 240)
      .filter((id) => id !== targetId)
      .filter((id) => !mergedSources.has(id))
      .filter((id) => !protectedRecentIds.has(id))
      .filter((id) => {
        const item = byId.get(id)
        return Boolean(item && !isSoftDeletedMemory(item))
      })
    if (sourceIds.length === 0) continue

    const nextTarget = applyConsolidationPatch(target, action.merged_record, now)
    byId.set(targetId, nextTarget)
    keptTargets.add(targetId)
    for (const sid of sourceIds) {
      const src = byId.get(sid)
      if (!src || isSoftDeletedMemory(src)) continue
      byId.set(sid, {
        ...src,
        deletedAt: now,
        deletedReason: `ai_merge_into:${targetId}`,
        mergedIntoId: targetId,
        updatedAt: now,
      })
      mergedSources.add(sid)
      mergedCount++
    }
  }

    const dropIds = new Set(normalizeStringArray(parsedDecision.drop_ids, 1200))
    for (const id of dropIds) {
      if (mergedSources.has(id) || keptTargets.has(id) || explicitKeepIds.has(id) || protectedRecentIds.has(id)) continue
    const item = byId.get(id)
    if (!item || isSoftDeletedMemory(item)) continue
    byId.set(id, {
      ...item,
      deletedAt: now,
      deletedReason: 'ai_drop',
      updatedAt: now,
    })
    droppedCount++
    }

    const remaining = Array.from(byId.values()).filter((item) => !isSoftDeletedMemory(item))
    if (remaining.length <= 0) {
      log('TASK_MEMORY_MAINTAIN_ABORT_ALL_DELETED', {
        total: candidates.length,
        mergeActions: parsedDecision.merge_actions.length,
        dropIds: parsedDecision.drop_ids.length,
        keepIds: parsedDecision.keep_ids.length,
      }, options?.logScope)
      return { applied: false, merged: 0, dropped: 0, total: candidates.length, reason: 'guard_all_deleted' }
    }

    if (mergedCount <= 0 && droppedCount <= 0) {
      memoryMaintainLastRunAtByScope.set(scope, Date.now())
      return { applied: false, merged: 0, dropped: 0, total: candidates.length, reason: 'no_changes' }
    }

    const repartitioned = repartitionTaskMemories(Array.from(byId.values()))
    await Promise.all([
      saveTaskMemories(workspace, repartitioned.active, projectId),
      saveTaskMemoryArchive(workspace, repartitioned.archive, projectId),
    ])
    insertMemoryMaintainRun(
      { workspace, projectId },
      {
        usageTotalTokens: options?.usageTotalTokens,
        maxTokens: options?.maxTokens,
        pressureRatio: (typeof options?.usageTotalTokens === 'number' && typeof options?.maxTokens === 'number' && options.maxTokens > 0)
          ? options.usageTotalTokens / options.maxTokens
          : undefined,
        totalCandidates: candidates.length,
        mergedCount,
        droppedCount,
        reason: gate.reason,
        decisionJson: JSON.stringify(parsedDecision),
      },
    )
    memoryMaintainLastRunAtByScope.set(scope, Date.now())
    log('TASK_MEMORY_MAINTAIN_APPLIED', {
      total: candidates.length,
      mergeActions: parsedDecision.merge_actions.length,
      mergedCount,
      droppedCount,
      keepIds: parsedDecision.keep_ids.length,
      protectedRecentIds: [...protectedRecentIds],
      repartitionActive: repartitioned.active.length,
      repartitionArchive: repartitioned.archive.length,
    }, options?.logScope)
    return { applied: true, merged: mergedCount, dropped: droppedCount, total: candidates.length, reason: gate.reason }
  } finally {
    memoryMaintainInFlightByScope.delete(scope)
  }
}

/* ------------------------------------------------------------------ */
/*  召回注入                                                            */
/* ------------------------------------------------------------------ */

type RecallSource = 'note' | 'task' | 'snapshot'

type RecallCandidate = {
  source: RecallSource
  id: string
  title: string
  text: string
  timestamp: number
  data: ProjectNote | TaskMemoryEntry | MemorySnapshotEntry
  score: number
  reason: string[]
}

export type RecalledItem = {
  source: RecallSource
  id: string
  title: string
  score: number
  reason: string[]
  data: Record<string, unknown>
}

export type RecallMeta = {
  mode: 'normal' | 'high_pressure'
  usageTotalTokens?: number
  maxTokens?: number
  pressureRatio?: number
  intentSource?: 'llm' | 'heuristic'
  intentType?: string
  intentSummary?: string
  intentGoal?: string
  candidateCount: number
  selectedCount: number
  budgetChars: number
  droppedByBudget: number
  selectionMethod?: 'tool_call' | 'heuristic'
  toolSelectionReason?: string
  toolSelectedCount?: number
}

export type RecallDebugCandidate = {
  key: string
  source: RecallSource
  id: string
  title: string
  score: number
  reason: string[]
  selected: boolean
  droppedByBudget: boolean
}

type BuildBackgroundContextOptions = {
  usageTotalTokens?: number
  maxTokens?: number
  reason?: 'initial' | 'post_compress'
  provider?: ProviderKey
  overrides?: ProviderOverrides
  /**
   * 记忆候选筛选模式：
   * - heuristic: 仅本地启发式，不额外发起 LLM 工具调用（默认）
   * - tool_call: 使用结构化 tool call 进行候选重排
   */
  recallSelectionMode?: 'heuristic' | 'tool_call'
  signal?: AbortSignal
  logScope?: string
}

type BuildBackgroundContextConversationOptions = BuildBackgroundContextOptions & {
  replayMode?: 'full' | 'compact'
}

function stripControlChars(input: string): string {
  return String(input ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
}

const USER_ASSETS_BLOCK_CAPTURE_REGEX = /\[USER_ASSETS\]([\s\S]*?)\[\/USER_ASSETS\]/i
const USER_ASSETS_BLOCK_STRIP_REGEX = /\s*\[USER_ASSETS\][\s\S]*?\[\/USER_ASSETS\]\s*/gi

function stripUserAssetsBlock(input: string): string {
  return String(input ?? '')
    .replace(USER_ASSETS_BLOCK_STRIP_REGEX, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function extractUserAssetsBlock(input: string): string {
  const raw = String(input ?? '')
  const wrapped = raw.match(USER_ASSETS_BLOCK_CAPTURE_REGEX)
  if (!wrapped || !wrapped[1]) return ''
  return stripControlChars(wrapped[1]).trim()
}

function extractUserQueryText(input: string): string {
  const raw = stripUserAssetsBlock(input)
  const wrapped = raw.match(/\[USER_QUERY\]([\s\S]*?)\[\/USER_QUERY\]/i)
  if (wrapped && wrapped[1]) return wrapped[1].trim()
  return raw.trim()
}

function wrapUserQueryText(input: string, assetsOverride?: string): string {
  const plain = extractUserQueryText(input)
  const inferredAssets = extractUserAssetsBlock(input)
  const assetsBlock = stripControlChars(String(assetsOverride ?? inferredAssets)).trim()
  if (!assetsBlock) return `[USER_QUERY]\n${plain}\n[/USER_QUERY]`
  return [
    '[USER_QUERY]',
    plain,
    '[/USER_QUERY]',
    '',
    '[USER_ASSETS]',
    assetsBlock,
    '[/USER_ASSETS]',
  ].join('\n')
}

const INTERNAL_CONTEXT_BLOCK_TAGS = [
  'CURRENT_TASK_SUMMARY',
  'HISTORICAL_TASK_RESULT',
  'HISTORICAL_PENDING_STATE',
  'MEMORY_SNAPSHOT',
  'BACKGROUND_CONTEXT',
  'SKILLS_CATALOG',
  'SKILL_ALLOWED_TOOLS',
  'SKILL_RESOURCES',
  'USER_QUERY',
  'USER_ASSETS',
  'RUNTIME_TOOL_PROMPT',
]

const INTERNAL_CONTEXT_ATTR_BLOCK_TAGS = [
  'SKILL_DETAIL',
  'SKILL_RESOURCE',
]

const INTERNAL_CONTEXT_TAG_NAME_RULES: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\bCURRENT_TASK_SUMMARY\b/g, replacement: '当前任务续跑摘要' },
  { pattern: /\bHISTORICAL_TASK_RESULT\b/g, replacement: '历史任务总结' },
  { pattern: /\bHISTORICAL_PENDING_STATE\b/g, replacement: '历史待继续状态' },
  { pattern: /\bMEMORY_SNAPSHOT\b/g, replacement: '历史记忆快照' },
  { pattern: /\bSKILLS_CATALOG\b/g, replacement: '技能目录' },
  { pattern: /\bSKILL_DETAIL\b/g, replacement: '技能详情' },
  { pattern: /\bSKILL_RESOURCE\b/g, replacement: '技能资源' },
]

export function stripInternalContextTags(input: string): string {
  let output = String(input ?? '')

  output = output.replace(/<!--TACO_RUNTIME_TOOL_PROMPT_START-->[\s\S]*?<!--TACO_RUNTIME_TOOL_PROMPT_END-->/gi, '')
  output = output.replace(/<!--TACO_RUNTIME_TOOL_PROMPT_START-->[\s\S]*$/gi, '')
  output = output.replace(/<!--TACO_RUNTIME_TOOL_PROMPT_END-->/gi, '')

  for (const tag of INTERNAL_CONTEXT_ATTR_BLOCK_TAGS) {
    output = output.replace(new RegExp(`\\[${tag}[^\\]]*\\][\\s\\S]*?\\[\\/${tag}\\]`, 'gi'), '')
  }
  for (const tag of INTERNAL_CONTEXT_BLOCK_TAGS) {
    output = output.replace(new RegExp(`\\[${tag}\\][\\s\\S]*?\\[\\/${tag}\\]`, 'gi'), '')
  }

  for (const tag of INTERNAL_CONTEXT_ATTR_BLOCK_TAGS) {
    output = output.replace(new RegExp(`\\[${tag}[^\\]]*\\][\\s\\S]*$`, 'gi'), '')
  }
  for (const tag of INTERNAL_CONTEXT_BLOCK_TAGS) {
    output = output.replace(new RegExp(`\\[${tag}\\][\\s\\S]*$`, 'gi'), '')
  }

  output = output.replace(/\[(?:\/)?(?:CURRENT_TASK_SUMMARY|HISTORICAL_TASK_RESULT|HISTORICAL_PENDING_STATE|MEMORY_SNAPSHOT|BACKGROUND_CONTEXT|SKILLS_CATALOG|SKILL_ALLOWED_TOOLS|SKILL_RESOURCES|USER_QUERY|USER_ASSETS|RUNTIME_TOOL_PROMPT|SKILL_DETAIL|SKILL_RESOURCE)[^\]]*\]/gi, '')

  for (const rule of INTERNAL_CONTEXT_TAG_NAME_RULES) {
    output = output.replace(rule.pattern, rule.replacement)
  }

  return output.replace(/\n{3,}/g, '\n\n')
}

function daysAgoScore(ts: number): number {
  if (!Number.isFinite(ts) || ts <= 0) return 0
  const days = Math.max(0, (Date.now() - ts) / (24 * 60 * 60 * 1000))
  if (days <= 1) return 16
  if (days <= 3) return 12
  if (days <= 7) return 8
  if (days <= 30) return 4
  return 0
}

function tokenize(text: string): string[] {
  const lower = String(text ?? '').toLowerCase()
  const set = new Set<string>()

  const en = lower.match(/[a-z0-9_./:-]{2,}/g) ?? []
  en.forEach((token) => set.add(token))

  const zh = lower.match(/[\u4e00-\u9fff]{2,}/g) ?? []
  zh.forEach((token) => set.add(token))

  return Array.from(set).slice(0, 120)
}

function scoreByTokenOverlap(queryTokens: string[], targetText: string): { score: number; hits: string[] } {
  if (queryTokens.length === 0) return { score: 0, hits: [] }
  const text = targetText.toLowerCase()
  const hits: string[] = []
  for (const token of queryTokens) {
    if (!token || token.length < 2) continue
    if (text.includes(token)) hits.push(token)
  }
  const uniqueHits = Array.from(new Set(hits))
  const score = uniqueHits.length * 7 + (uniqueHits.length > 0 ? Math.min(20, Math.round((uniqueHits.length / queryTokens.length) * 20)) : 0)
  return { score, hits: uniqueHits.slice(0, 12) }
}

function estimateBudgetChars(maxTokens?: number, usageTotalTokens?: number): { budgetChars: number; mode: 'normal' | 'high_pressure'; ratio?: number } {
  if (typeof maxTokens !== 'number' || !Number.isFinite(maxTokens) || maxTokens <= 0) {
    return { budgetChars: 12000, mode: 'normal' }
  }
  const usage = (typeof usageTotalTokens === 'number' && Number.isFinite(usageTotalTokens) && usageTotalTokens > 0)
    ? usageTotalTokens
    : undefined
  if (!usage) return { budgetChars: 12000, mode: 'normal' }

  const ratio = usage / maxTokens
  if (ratio >= 0.8) return { budgetChars: 4500, mode: 'high_pressure', ratio }
  if (ratio >= 0.6) return { budgetChars: 8000, mode: 'normal', ratio }
  return { budgetChars: 12000, mode: 'normal', ratio }
}

function toCandidateKey(source: RecallSource, id: string): string {
  return `${source}:${id}`
}

function normalizeStringArray(value: unknown, limit = 24): string[] {
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

function safeParseObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    return null
  } catch {
    return null
  }
}

type RecallSelectionIndexItem = {
  key: string
  source: RecallSource
  title: string
  digest: string
  updatedAt: string
  scoreHint: number
}

const RECALL_SELECTION_TOOL_NAME = 'select_background_memory'
const recallSelectionTools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: RECALL_SELECTION_TOOL_NAME,
      description: '从记忆索引中选择与当前用户问题最相关的背景记忆条目 key 列表（严格结构化返回）。',
      parameters: {
        type: 'object',
        properties: {
          selected_item_keys: {
            type: 'array',
            items: { type: 'string' },
            description: '按优先级排序的记忆条目 key 列表（格式: source:id）',
          },
          reason: {
            type: 'string',
            description: '简要说明选择依据（可选）',
          },
        },
        required: ['selected_item_keys'],
      },
    },
  },
]

async function selectRecallCandidatesByTool(
  userQuery: string,
  indexItems: RecallSelectionIndexItem[],
  options?: BuildBackgroundContextOptions,
): Promise<{ selectedKeys: string[]; reason?: string } | null> {
  const provider = options?.provider
  if (!provider || indexItems.length === 0) return null

  const safeUserQuery = extractUserQueryText(userQuery)
  const payload = {
    user_query: safeUserQuery,
    memory_index: indexItems,
    rules: [
      '仅返回与当前用户问题强相关的 key',
      '如果无相关项也必须调用工具，selected_item_keys 可为空数组',
      '优先保留能够补全上下文链路的最近条目',
      '禁止返回不存在的 key',
    ],
  }
  const promptMessages: ChatMessage[] = [
    {
      role: 'system',
      content: [
        '你是记忆召回选择器。',
        `你必须调用工具 ${RECALL_SELECTION_TOOL_NAME} 返回结构化结果。`,
        '不要输出任何普通文本答案。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify(payload, null, 2),
    },
  ]

  let seenToolCall = false
  let selectedKeys: string[] = []
  let selectedReason = ''

  try {
    for await (const event of requestStreamWithTools(
      provider,
      promptMessages,
      options?.overrides,
      { tools: recallSelectionTools, toolChoice: 'required' },
      options?.signal,
      options?.logScope,
    )) {
      if (event.type !== 'tool_calls') continue
      const target = event.toolCalls.find((call) => call.function.name === RECALL_SELECTION_TOOL_NAME)
      if (!target) continue
      seenToolCall = true
      const parsed = safeParseObject(target.function.arguments)
      if (!parsed) continue
      selectedKeys = normalizeStringArray(parsed.selected_item_keys ?? parsed.selectedItemKeys, 24)
      selectedReason = shortText(String(parsed.reason ?? ''), 260)
      break
    }
  } catch (err) {
    log('BACKGROUND_CONTEXT_TOOL_SELECTION_FAIL', { error: err instanceof Error ? err.message : String(err) }, options?.logScope)
    return null
  }

  if (!seenToolCall) return null
  return { selectedKeys, ...(selectedReason ? { reason: selectedReason } : {}) }
}

function toText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function inferIntentTypeByQuery(query: string): string {
  const text = String(query ?? '').trim().toLowerCase()
  if (!text) return 'other'

  const patterns: Array<{ type: string; words: string[] }> = [
    { type: 'debug', words: ['报错', '错误', '异常', '排查', '调试', 'debug', 'error', 'bug', '失败', 'trace', '崩溃'] },
    { type: 'implement', words: ['实现', '新增', '开发', '编写', '添加', 'create', 'implement', 'build', '完成功能'] },
    { type: 'refactor', words: ['重构', '优化', '整理', '抽离', 'refactor', 'optimize', 'cleanup', '性能'] },
    { type: 'ops', words: ['删除', '重命名', '移动', '部署', '发布', '配置', '运行', '执行', '删除文件', 'remove', 'delete', 'rm ', 'mv ', 'deploy'] },
    { type: 'qa', words: ['是什么', '为什么', '怎么', '如何', '请解释', '是否', '吗', '?', '？', 'what', 'why', 'how', 'can you'] },
  ]

  for (const row of patterns) {
    if (row.words.some((word) => text.includes(word))) return row.type
  }
  return 'other'
}

function isLikelyFollowUpQuery(query: string): boolean {
  const text = String(query ?? '').trim()
  if (!text) return false
  if (text.length > 64) return false
  const inferred = inferIntentTypeByQuery(text)
  // “other”或非常短的补充信息，通常是接续上文意图（如“xxx 文件”）
  if (inferred === 'other') return true
  return text.length <= 20 && inferred !== 'qa'
}

function toRecalledItem(candidate: RecallCandidate): RecalledItem {
  if (candidate.source === 'note') {
    const note = candidate.data as ProjectNote
    return {
      source: 'note',
      id: note.id,
      title: note.title,
      score: candidate.score,
      reason: candidate.reason,
      data: {
        category: note.category,
        content: note.content,
        updatedAt: note.updatedAt,
      },
    }
  }
  if (candidate.source === 'snapshot') {
    const snapshot = candidate.data as MemorySnapshotEntry
    return {
      source: 'snapshot',
      id: snapshot.id,
      title: '上下文压缩快照',
      score: candidate.score,
      reason: candidate.reason,
      data: {
        summary: snapshot.summary,
        sourceMessageCount: snapshot.sourceMessageCount,
        usageTotalTokens: snapshot.usageTotalTokens ?? null,
        maxTokens: snapshot.maxTokens ?? null,
        createdAt: snapshot.createdAt,
        updatedAt: snapshot.updatedAt,
      },
    }
  }
  const task = candidate.data as TaskMemoryEntry
  return {
    source: 'task',
    id: task.id,
    title: shortText(task.goal, 120) || '任务记忆',
    score: candidate.score,
    reason: candidate.reason,
    data: {
      userQuery: task.userQuery || task.goal,
      userAssetsBlock: task.userAssetsBlock || '',
      intentType: task.intentType || 'other',
      intentSummary: task.intentSummary || '',
      intentGoal: task.intentGoal || task.goal,
      goal: task.goal,
      assistantResult: task.assistantResult || '',
      summary: task.summary,
      outcome: task.outcome,
      tools: task.tools,
      changedFiles: task.changedFiles,
      identifiers: task.identifiers,
      failures: task.failures,
      updatedAt: task.updatedAt,
    },
  }
}

function recalledItemTimestamp(item: RecalledItem): number {
  const data = item.data as Record<string, unknown>
  const updatedAt = toText(data.updatedAt) || toText(data.createdAt)
  const ts = Date.parse(updatedAt)
  return Number.isFinite(ts) ? ts : 0
}

async function recallBackgroundContext(
  workspace: string,
  projectId: string | undefined,
  userQuery: string,
  options?: BuildBackgroundContextOptions,
): Promise<{ notes: ProjectNote[]; taskMemories: TaskMemoryEntry[]; snapshots: MemorySnapshotEntry[]; recalled: RecalledItem[]; meta: RecallMeta; debugCandidates: RecallDebugCandidate[] }> {
  const manualNotes = (await listNotes(workspace, projectId))
    .map((note) => ({
      ...note,
      title: stripControlChars(note.title),
      content: stripControlChars(note.content),
    }))
  const taskMemories = (await loadTaskMemoriesForRecall(workspace, projectId))
    .map((task) => ({
      ...task,
      userQuery: stripControlChars(task.userQuery || ''),
      userAssetsBlock: stripControlChars(task.userAssetsBlock || ''),
      intentType: stripControlChars(task.intentType || ''),
      intentSummary: stripControlChars(task.intentSummary || ''),
      intentGoal: stripControlChars(task.intentGoal || ''),
      goal: stripControlChars(task.goal),
      assistantResult: stripControlChars(task.assistantResult || ''),
      summary: stripControlChars(task.summary),
      tools: (task.tools ?? []).map((x) => stripControlChars(x)),
      changedFiles: (task.changedFiles ?? []).map((x) => stripControlChars(x)),
      identifiers: (task.identifiers ?? []).map((x) => stripControlChars(x)),
      failures: (task.failures ?? []).map((x) => stripControlChars(x)),
    }))
  const snapshots = (await loadMemorySnapshots(workspace, projectId))
    .map((snapshot) => ({
      ...snapshot,
      summary: stripControlChars(snapshot.summary),
    }))

  const query = extractUserQueryText(userQuery)
  const queryTokens = tokenize(query)
  const hasQueryTokens = queryTokens.length > 0

  const candidates: RecallCandidate[] = []
  const allCandidates = new Map<string, RecallCandidate>()
  const noteFallbackCandidates: RecallCandidate[] = []
  const taskFallbackCandidates: RecallCandidate[] = []
  const snapshotFallbackCandidates: RecallCandidate[] = []
  let intentSource: 'llm' | 'heuristic' = 'heuristic'
  let intentType = inferIntentTypeByQuery(query)
  let intentSummary = shortText(query, 220)
  let intentGoal = shortText(query, 220)

  for (const note of manualNotes) {
    const noteText = `${note.title}\n${note.content}\n${note.category}`.toLowerCase()
    const overlap = scoreByTokenOverlap(queryTokens, noteText)
    const timestamp = Date.parse(note.updatedAt || note.createdAt || '')
    const candidate: RecallCandidate = {
      source: 'note',
      id: note.id,
      title: note.title,
      text: noteText,
      timestamp,
      data: note,
      score: 36 + overlap.score + daysAgoScore(timestamp),
      reason: overlap.hits.length > 0 ? [`命中关键词: ${overlap.hits.join(', ')}`] : ['兜底候选：项目基础笔记'],
    }
    allCandidates.set(toCandidateKey(candidate.source, candidate.id), candidate)
    if (hasQueryTokens && overlap.hits.length > 0) {
      candidates.push(candidate)
    } else {
      noteFallbackCandidates.push(candidate)
    }
  }

  for (const task of taskMemories) {
    const taskText = `${task.userQuery || ''}\n${task.userAssetsBlock || ''}\n${task.intentType || ''}\n${task.intentSummary || ''}\n${task.intentGoal || ''}\n${task.goal}\n${task.assistantResult || ''}\n${task.summary}\n${task.tools.join('\n')}\n${task.changedFiles.join('\n')}\n${task.identifiers.join('\n')}\n${task.failures.join('\n')}`.toLowerCase()
    const overlap = scoreByTokenOverlap(queryTokens, taskText)
    const timestamp = Date.parse(task.updatedAt || task.createdAt || '')
    // 任务记忆仅在命中当前问题关键词时参与注入，避免无关历史污染本轮上下文。
    if (!hasQueryTokens || overlap.hits.length === 0) {
      const candidate: RecallCandidate = {
        source: 'task',
        id: task.id,
        title: shortText(task.goal, 120),
        text: taskText,
        timestamp,
        data: task,
        score: 14 + daysAgoScore(timestamp),
        reason: ['兜底候选：最近任务记忆（未命中关键词）'],
      }
      allCandidates.set(toCandidateKey(candidate.source, candidate.id), candidate)
      taskFallbackCandidates.push(candidate)
      continue
    }
    const evidenceBonus = Math.min(18, task.changedFiles.length * 2 + task.tools.length)
    const score = 18 + overlap.score + evidenceBonus + daysAgoScore(timestamp)
    const reason = [`命中关键词: ${overlap.hits.join(', ')}`, `执行证据: ${task.tools.length}个工具/${task.changedFiles.length}个文件`]
    const candidate: RecallCandidate = {
      source: 'task',
      id: task.id,
      title: shortText(task.goal, 120),
      text: taskText,
      timestamp,
      data: task,
      score,
      reason,
    }
    allCandidates.set(toCandidateKey(candidate.source, candidate.id), candidate)
    candidates.push(candidate)
  }

  for (const snapshot of snapshots) {
    const snapshotText = `${snapshot.summary}`.toLowerCase()
    const overlap = scoreByTokenOverlap(queryTokens, snapshotText)
    const timestamp = Date.parse(snapshot.updatedAt || snapshot.createdAt || '')
    const baseScore = 20 + daysAgoScore(timestamp)
    const candidate: RecallCandidate = {
      source: 'snapshot',
      id: snapshot.id,
      title: '上下文压缩快照',
      text: snapshotText,
      timestamp,
      data: snapshot,
      score: baseScore + overlap.score,
      reason: overlap.hits.length > 0
        ? [`命中关键词: ${overlap.hits.join(', ')}`]
        : ['兜底候选：历史上下文压缩快照'],
    }
    allCandidates.set(toCandidateKey(candidate.source, candidate.id), candidate)
    if (hasQueryTokens && overlap.hits.length > 0) {
      candidates.push(candidate)
    } else {
      snapshotFallbackCandidates.push(candidate)
    }
  }

  // 不再为每轮提问额外发起“意图理解请求”；仅保留本地启发式意图继承。
  const shouldCarryFromHistory = isLikelyFollowUpQuery(query) || intentType === 'other'
  if (shouldCarryFromHistory && taskMemories.length > 0) {
    const recent = [...taskMemories]
      .sort((a, b) => {
        const ta = Date.parse(a.updatedAt || a.createdAt || '')
        const tb = Date.parse(b.updatedAt || b.createdAt || '')
        return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0)
      })
      .find((task) => (task.intentType && task.intentType !== 'other') || task.goal)

    if (recent) {
      const inheritedType = shortText(toText(recent.intentType), 48)
      const inheritedSummary = shortText(toText(recent.intentSummary), 220)
      const inheritedGoal = shortText(toText(recent.intentGoal || recent.goal), 220)

      if (inheritedType && (intentType === 'other' || isLikelyFollowUpQuery(query))) {
        intentType = inheritedType
      }
      if (inheritedSummary && isLikelyFollowUpQuery(query)) {
        intentSummary = shortText(`延续上轮意图：${inheritedSummary}`, 220)
      }
      if (inheritedGoal && (isLikelyFollowUpQuery(query) || !intentGoal)) {
        intentGoal = inheritedGoal
      }

      const recentCandidate = allCandidates.get(toCandidateKey('task', recent.id))
      if (recentCandidate) {
        candidates.push({
          ...recentCandidate,
          score: recentCandidate.score + 48,
          reason: ['延续最近任务记忆的上下文意图'],
        })
      }
    }
  }

  // 若没有命中候选，优先兜底注入最近任务记忆，避免 BACKGROUND_CONTEXT 为空。
  if (candidates.length === 0 && taskFallbackCandidates.length > 0) {
    taskFallbackCandidates.sort((a, b) => {
      const ta = Number.isFinite(a.timestamp) ? a.timestamp : 0
      const tb = Number.isFinite(b.timestamp) ? b.timestamp : 0
      if (tb !== ta) return tb - ta
      return b.score - a.score
    })
    for (const candidate of taskFallbackCandidates.slice(0, 2)) {
      candidates.push({
        ...candidate,
        score: Math.min(candidate.score, 22),
        reason: ['兜底注入：最近任务记忆（未命中关键词）'],
      })
    }
  }

  // 若仍没有命中候选，再兜底注入最近基础笔记。
  if (candidates.length === 0 && noteFallbackCandidates.length > 0) {
    noteFallbackCandidates.sort((a, b) => {
      const ta = Number.isFinite(a.timestamp) ? a.timestamp : 0
      const tb = Number.isFinite(b.timestamp) ? b.timestamp : 0
      if (tb !== ta) return tb - ta
      return b.score - a.score
    })
    for (const candidate of noteFallbackCandidates.slice(0, 2)) {
      candidates.push({
        ...candidate,
        score: Math.min(candidate.score, 20),
        reason: ['兜底注入：最近项目基础笔记（未命中关键词）'],
      })
    }
  }

  // 若仍无候选，兜底注入最近压缩快照。
  if (candidates.length === 0 && snapshotFallbackCandidates.length > 0) {
    snapshotFallbackCandidates.sort((a, b) => {
      const ta = Number.isFinite(a.timestamp) ? a.timestamp : 0
      const tb = Number.isFinite(b.timestamp) ? b.timestamp : 0
      if (tb !== ta) return tb - ta
      return b.score - a.score
    })
    for (const candidate of snapshotFallbackCandidates.slice(0, 2)) {
      candidates.push({
        ...candidate,
        score: Math.min(candidate.score, 24),
        reason: ['兜底注入：最近上下文压缩快照（未命中关键词）'],
      })
    }
  }

  const dedupedCandidateMap = new Map<string, RecallCandidate>()
  for (const candidate of candidates) {
    const key = toCandidateKey(candidate.source, candidate.id)
    const prev = dedupedCandidateMap.get(key)
    if (!prev || candidate.score > prev.score) dedupedCandidateMap.set(key, candidate)
  }
  candidates.length = 0
  candidates.push(...dedupedCandidateMap.values())

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return (Number.isFinite(b.timestamp) ? b.timestamp : 0) - (Number.isFinite(a.timestamp) ? a.timestamp : 0)
  })

  let selectionMethod: 'tool_call' | 'heuristic' = 'heuristic'
  let toolSelectionReason = ''
  let toolSelectedCount = 0

  const shouldUseToolSelection = options?.recallSelectionMode === 'tool_call'

  if (candidates.length > 0 && shouldUseToolSelection && options?.provider) {
    const topForSelection = candidates.slice(0, 80)
    const selectionIndex: RecallSelectionIndexItem[] = topForSelection.map((candidate) => {
      const key = toCandidateKey(candidate.source, candidate.id)
      const data = candidate.data as Record<string, unknown>
      const digest = candidate.source === 'note'
        ? shortText(`${toText(data.category)} ${toText(data.content)}`, 220)
        : candidate.source === 'snapshot'
          ? shortText(toText(data.summary), 220)
          : shortText(`${toText(data.goal)} ${toText(data.summary)} ${toText((data.changedFiles as string[] | undefined)?.join('、') || '')}`, 240)
      return {
        key,
        source: candidate.source,
        title: shortText(candidate.title, 80) || '记忆条目',
        digest,
        updatedAt: toText(data.updatedAt) || toText(data.createdAt),
        scoreHint: candidate.score,
      }
    })

    const toolSelection = await selectRecallCandidatesByTool(query, selectionIndex, options)
    if (toolSelection) {
      const selectedByTool = normalizeStringArray(toolSelection.selectedKeys, 24)
      const selectedSet = new Set(selectedByTool)
      const candidateMap = new Map<string, RecallCandidate>(
        candidates.map((candidate) => [toCandidateKey(candidate.source, candidate.id), candidate]),
      )
      const reordered: RecallCandidate[] = []
      for (const key of selectedByTool) {
        const item = candidateMap.get(key)
        if (item) reordered.push(item)
      }
      if (reordered.length > 0) {
        const rest = candidates.filter((candidate) => !selectedSet.has(toCandidateKey(candidate.source, candidate.id)))
        candidates.length = 0
        candidates.push(...reordered, ...rest)
        selectionMethod = 'tool_call'
        toolSelectedCount = reordered.length
        toolSelectionReason = toolSelection.reason || ''
      } else if (selectedByTool.length === 0) {
        // 工具显式返回空选中：允许“无相关记忆”继续执行
        candidates.length = 0
        selectionMethod = 'tool_call'
        toolSelectedCount = 0
        toolSelectionReason = toolSelection.reason || ''
      }
    }
  }

  const pressure = estimateBudgetChars(options?.maxTokens, options?.usageTotalTokens)
  const selected: RecalledItem[] = []
  const selectedKeys = new Set<string>()
  const droppedByBudgetKeys = new Set<string>()
  let usedChars = 0
  let droppedByBudget = 0

  for (const candidate of candidates) {
    const key = `${candidate.source}:${candidate.id}`
    const item = toRecalledItem(candidate)
    const size = JSON.stringify(item).length
    const fits = usedChars + size <= pressure.budgetChars
    if (!fits && selected.length > 0) {
      droppedByBudget++
      droppedByBudgetKeys.add(key)
      continue
    }
    selected.push(item)
    selectedKeys.add(key)
    usedChars += size
    if (selected.length >= 12) break
  }

  // 注入给模型的背景记忆按时间正序（旧 -> 新）排列，避免倒序造成上下文理解偏差。
  selected.sort((a, b) => {
    const ta = recalledItemTimestamp(a)
    const tb = recalledItemTimestamp(b)
    if (ta !== tb) return ta - tb
    const ka = `${a.source}:${a.id}`
    const kb = `${b.source}:${b.id}`
    return ka.localeCompare(kb)
  })

  const recalledNoteIds = new Set(selected.filter((item) => item.source === 'note').map((item) => item.id))
  const recalledNotes = manualNotes.filter((item) => recalledNoteIds.has(item.id))
  const debugCandidates: RecallDebugCandidate[] = candidates.slice(0, 120).map((candidate) => {
    const key = `${candidate.source}:${candidate.id}`
    return {
      key,
      source: candidate.source,
      id: candidate.id,
      title: candidate.title,
      score: candidate.score,
      reason: candidate.reason,
      selected: selectedKeys.has(key),
      droppedByBudget: droppedByBudgetKeys.has(key),
    }
  })

  return {
    notes: recalledNotes,
    taskMemories,
    snapshots,
    recalled: selected,
    debugCandidates,
    meta: {
      mode: pressure.mode,
      usageTotalTokens: options?.usageTotalTokens,
      maxTokens: options?.maxTokens,
      pressureRatio: pressure.ratio,
      intentSource,
      intentType,
      intentSummary,
      intentGoal,
      candidateCount: candidates.length,
      selectedCount: selected.length,
      budgetChars: pressure.budgetChars,
      droppedByBudget,
      selectionMethod,
      ...(selectionMethod === 'tool_call' ? { toolSelectionReason } : {}),
      ...(selectionMethod === 'tool_call' ? { toolSelectedCount } : {}),
    },
  }
}

function taskMemoryTimestamp(item: TaskMemoryEntry): number {
  const updated = Date.parse(item.updatedAt || '')
  if (Number.isFinite(updated)) return updated
  const created = Date.parse(item.createdAt || '')
  if (Number.isFinite(created)) return created
  return 0
}

function sortTaskMemoriesAsc(items: TaskMemoryEntry[]): TaskMemoryEntry[] {
  return [...items].sort((a, b) => {
    const ta = taskMemoryTimestamp(a)
    const tb = taskMemoryTimestamp(b)
    if (ta !== tb) return ta - tb
    return String(a.id).localeCompare(String(b.id))
  })
}

function sortMemorySnapshotsAsc(items: MemorySnapshotEntry[]): MemorySnapshotEntry[] {
  return [...items].sort((a, b) => {
    const ta = memorySnapshotTimestamp(a)
    const tb = memorySnapshotTimestamp(b)
    if (ta !== tb) return ta - tb
    return String(a.id).localeCompare(String(b.id))
  })
}

function estimateReplayBudgetChars(maxTokens?: number, replayMode: 'full' | 'compact' = 'full'): number {
  const defaultBudget = replayMode === 'compact' ? 9000 : 32000
  if (typeof maxTokens !== 'number' || !Number.isFinite(maxTokens) || maxTokens <= 0) {
    return defaultBudget
  }
  const ratio = replayMode === 'compact' ? 0.12 : 0.3
  const approxChars = Math.floor(maxTokens * 3.4 * ratio)
  const min = replayMode === 'compact' ? 5000 : 12000
  const max = replayMode === 'compact' ? 32000 : 110000
  return Math.max(min, Math.min(max, approxChars))
}

function extractReplayAssistantResult(item: TaskMemoryEntry): string {
  const block = buildHistoricalTaskResultBlock(item)
  return block.trim() ? block : ''
}

export async function buildBackgroundContextConversationMessages(
  workspace: string,
  userQuery: string,
  projectId?: string,
  options?: BuildBackgroundContextConversationOptions,
): Promise<{
  messages: ChatMessage[]
  notes: ProjectNote[]
  recalled: RecalledItem[]
  replayedSnapshots: MemorySnapshotEntry[]
  replayedTaskMemories: TaskMemoryEntry[]
  droppedSnapshotReplayCount: number
  droppedReplayCount: number
  recallMeta: RecallMeta
  recallDebug: RecallDebugCandidate[]
}> {
  const recalled = await recallBackgroundContext(workspace, projectId, userQuery, options)
  const replayMode = options?.replayMode ?? (options?.reason === 'post_compress' ? 'compact' : 'full')
  const replayBudgetChars = estimateReplayBudgetChars(options?.maxTokens, replayMode)
  const safeUserQuery = extractUserQueryText(userQuery)
  const userAssetsBlock = extractUserAssetsBlock(userQuery)
  const forceEmptyReplay = recalled.meta.selectionMethod === 'tool_call' && recalled.meta.toolSelectedCount === 0

  const selectedSnapshotIds = new Set(recalled.recalled.filter((item) => item.source === 'snapshot').map((item) => item.id))

  const orderedTaskMemories = sortTaskMemoriesAsc(recalled.taskMemories)
  const orderedSnapshots = sortMemorySnapshotsAsc(recalled.snapshots)

  const taskCandidates = forceEmptyReplay
    ? []
    : orderedTaskMemories
  const snapshotCandidates = forceEmptyReplay
    ? []
    : (selectedSnapshotIds.size > 0
      ? orderedSnapshots.filter((item) => selectedSnapshotIds.has(item.id))
      : orderedSnapshots.slice(-(replayMode === 'compact' ? 1 : 2)))

  const selectedSnapshotsFromEnd: MemorySnapshotEntry[] = []
  let droppedSnapshotReplayCount = 0
  let usedChars = safeUserQuery.length + (userAssetsBlock ? userAssetsBlock.length + 32 : 0)
  const snapshotLimit = replayMode === 'compact' ? 2 : 4
  for (let i = snapshotCandidates.length - 1; i >= 0; i--) {
    if (selectedSnapshotsFromEnd.length >= snapshotLimit) {
      droppedSnapshotReplayCount++
      continue
    }
    const item = snapshotCandidates[i]
    const summary = shortText(item.summary, replayMode === 'compact' ? 900 : 1800)
    if (!summary) continue
    const blockSize = summary.length + 64
    if (usedChars + blockSize > replayBudgetChars && selectedSnapshotsFromEnd.length > 0) {
      droppedSnapshotReplayCount++
      continue
    }
    selectedSnapshotsFromEnd.push({ ...item, summary })
    usedChars += blockSize
  }
  const replayedSnapshots = selectedSnapshotsFromEnd.reverse()

  const selectedFromEnd: TaskMemoryEntry[] = []
  let droppedReplayCount = 0

  const compactLimit = replayMode === 'compact' ? 8 : Number.POSITIVE_INFINITY

  for (let i = taskCandidates.length - 1; i >= 0; i--) {
    if (selectedFromEnd.length >= compactLimit) {
      droppedReplayCount++
      continue
    }
    const item = taskCandidates[i]
    const userText = String(item.userQuery || item.goal || '').trim()
    const userAssets = String(item.userAssetsBlock || '').trim()
    const assistantText = extractReplayAssistantResult(item)
    if (!userText && !assistantText && !userAssets) continue
    const pairSize = userText.length + assistantText.length + userAssets.length + 48
    if (usedChars + pairSize > replayBudgetChars && selectedFromEnd.length > 0) {
      droppedReplayCount++
      continue
    }
    selectedFromEnd.push(item)
    usedChars += pairSize
  }

  const replayedTaskMemories = selectedFromEnd.reverse()
  const messages: ChatMessage[] = []
  for (const item of replayedSnapshots) {
    messages.push({
      role: 'assistant',
      content: `[MEMORY_SNAPSHOT]\n${item.summary}\n[/MEMORY_SNAPSHOT]`,
    })
  }
  for (const item of replayedTaskMemories) {
    const userText = String(item.userQuery || item.goal || '').trim()
    const userAssets = String(item.userAssetsBlock || '').trim()
    const assistantText = extractReplayAssistantResult(item)
    if (userText || userAssets) {
      messages.push({
        role: 'user',
        content: wrapUserQueryText(userText || item.goal || '(附件相关请求)', userAssets),
      })
    }
    if (assistantText) messages.push({ role: 'assistant', content: assistantText })
  }
  messages.push({ role: 'user', content: wrapUserQueryText(userQuery) })

  return {
    messages,
    notes: recalled.notes,
    recalled: recalled.recalled,
    replayedSnapshots,
    replayedTaskMemories,
    droppedSnapshotReplayCount,
    droppedReplayCount,
    recallMeta: recalled.meta,
    recallDebug: recalled.debugCandidates,
  }
}

/**
 * 仅做“意图分析”并返回结构化结果，不生成注入文本。
 * 用于每轮结束后把用户问题+意图写入任务记忆。
 */
export async function inferIntentFromBackground(
  workspace: string,
  userQuery: string,
  projectId?: string,
  options?: BuildBackgroundContextOptions,
): Promise<Pick<RecallMeta, 'intentSource' | 'intentType' | 'intentSummary' | 'intentGoal'>> {
  const recalled = await recallBackgroundContext(workspace, projectId, userQuery, options)
  return {
    intentSource: recalled.meta.intentSource,
    intentType: recalled.meta.intentType,
    intentSummary: recalled.meta.intentSummary,
    intentGoal: recalled.meta.intentGoal,
  }
}
