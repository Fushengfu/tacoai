/**
 * 手工项目笔记 CRUD
 *
 * 负责笔记的加载、保存、删除、列表展示。
 */

import { createHash } from 'node:crypto'
import path from 'node:path'
import type { ProjectNote } from '../../../shared/ipc'

type MemoryScope = {
  workspace: string
  projectId?: string
  scopeKey?: string
}

import {
  hasAnyProjectNotes,
  listProjectNotesForScope,
  replaceProjectNotes,
  importProjectNotes,
} from '../../data/memory-db'
import { TACO_HOME, projectScope, workspaceHash } from '../../../shared/paths'
import { shortText, normalizeIso, pathExists, readJsonArray } from '../memory/memory-utils'

/* ------------------------------------------------------------------ */
/*  常量 & 路径                                                           */
/* ------------------------------------------------------------------ */

const NOTES_DIR = path.join(TACO_HOME, 'notes')
const LEGACY_AUTO_TASK_LOG_NOTE_ID = 'auto-task-log'
const LEGACY_AUTO_TASK_LOG_NOTE_TITLE = '任务执行日志（自动）'

/* ------------------------------------------------------------------ */
/*  路径解析                                                             */
/* ------------------------------------------------------------------ */

function resolveScope(workspace: string, projectId?: string): string {
  if (projectId && projectId.trim()) return projectScope(projectId.trim())
  if (workspace && workspace.trim()) return workspaceHash(workspace)
  return 'global'
}

function notesFilePath(workspace: string, projectId?: string): string {
  return path.join(NOTES_DIR, `${resolveScope(workspace, projectId)}.json`)
}

/* ------------------------------------------------------------------ */
/*  标准化                                                               */
/* ------------------------------------------------------------------ */

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

export function normalizeProjectNoteEntry(raw: Partial<ProjectNote>, index: number): ProjectNote {
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

/* ------------------------------------------------------------------ */
/*  CRUD                                                                 */
/* ------------------------------------------------------------------ */

async function loadRawNotes(workspace: string, projectId?: string): Promise<ProjectNote[]> {
  return listProjectNotesForScope({ workspace, projectId }).map((item, index) => normalizeProjectNoteEntry(item, index))
}

async function saveRawNotes(workspace: string, notes: ProjectNote[], projectId?: string): Promise<void> {
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
/*  遗留迁移辅助                                                          */
/* ------------------------------------------------------------------ */

export async function loadLegacyNotes(workspace: string, projectId?: string): Promise<ProjectNote[]> {
  const primaryFile = notesFilePath(workspace, projectId)
  const primaryExists = await pathExists(primaryFile)
  if (!primaryExists) return []
  return (await readJsonArray<ProjectNote>(primaryFile)).map((item, index) => normalizeProjectNoteEntry(item, index))
}

export async function importLegacyNotesIfEmpty(scopeRef: MemoryScope, legacyNotes: ProjectNote[]): Promise<void> {
  if (legacyNotes.length > 0 && !hasAnyProjectNotes(scopeRef)) {
    importProjectNotes(scopeRef, legacyNotes)
  }
}
