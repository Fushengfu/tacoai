/**
 * 项目笔记/记忆系统
 *
 * 持久化存储项目级别的笔记（如代码规范、数据库配置、架构决策等），
 * 在每次 Agent 会话时自动注入到系统提示词中，让 AI 始终了解项目上下文。
 *
 * 存储路径: ~/.taco/notes/{scope}.json
 * scope 优先使用 projectId，不存在时回退 workspaceHash。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { ProjectNote, NoteCategory } from '../shared/ipc'

/* ------------------------------------------------------------------ */
/*  存储路径                                                             */
/* ------------------------------------------------------------------ */

const TACO_HOME = path.join(process.env.HOME || process.env.USERPROFILE || '~', '.taco')
const NOTES_DIR = path.join(TACO_HOME, 'notes')

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

/* ------------------------------------------------------------------ */
/*  持久化读写                                                           */
/* ------------------------------------------------------------------ */

async function ensureDir() {
  await fs.mkdir(NOTES_DIR, { recursive: true })
}

async function loadNotes(workspace: string, projectId?: string): Promise<ProjectNote[]> {
  const primaryPath = notesFilePath(workspace, projectId)
  try {
    const raw = await fs.readFile(primaryPath, 'utf-8')
    return JSON.parse(raw) as ProjectNote[]
  } catch {
    // 兼容历史数据：项目隔离启用前，笔记按 workspace 存储
    if (projectId && workspace && workspace.trim()) {
      try {
        const legacyRaw = await fs.readFile(notesFilePath(workspace), 'utf-8')
        return JSON.parse(legacyRaw) as ProjectNote[]
      } catch {
        return []
      }
    }
    return []
  }
}

async function saveNotes(workspace: string, notes: ProjectNote[], projectId?: string): Promise<void> {
  await ensureDir()
  const filePath = notesFilePath(workspace, projectId)
  await fs.writeFile(filePath, JSON.stringify(notes, null, 2), 'utf-8')
}

/* ------------------------------------------------------------------ */
/*  公共 API                                                            */
/* ------------------------------------------------------------------ */

/** 列出指定工作空间的所有笔记 */
export async function listNotes(workspace: string, projectId?: string): Promise<ProjectNote[]> {
  return loadNotes(workspace, projectId)
}

/** 保存笔记（新增或更新） */
export async function saveNote(workspace: string, note: ProjectNote, projectId?: string): Promise<ProjectNote> {
  const notes = await loadNotes(workspace, projectId)
  const now = new Date().toISOString()

  const existIdx = notes.findIndex((n) => n.id === note.id)
  if (existIdx >= 0) {
    // 更新已有笔记
    notes[existIdx] = { ...note, updatedAt: now }
  } else {
    // 新增笔记
    notes.push({ ...note, createdAt: now, updatedAt: now })
  }

  await saveNotes(workspace, notes, projectId)
  return existIdx >= 0 ? notes[existIdx] : notes[notes.length - 1]
}

/** 删除笔记 */
export async function deleteNote(workspace: string, noteId: string, projectId?: string): Promise<void> {
  const notes = await loadNotes(workspace, projectId)
  const filtered = notes.filter((n) => n.id !== noteId)
  await saveNotes(workspace, filtered, projectId)
}

/* ------------------------------------------------------------------ */
/*  Agent 提示词注入                                                      */
/* ------------------------------------------------------------------ */

/** 分类标签映射 */
const CATEGORY_LABELS: Record<NoteCategory, string> = {
  convention: '代码规范',
  credential: '凭证/账号',
  architecture: '架构设计',
  config: '配置信息',
  other: '其他',
}

/**
 * 获取指定工作空间的所有笔记，格式化为可注入系统提示词的文本。
 * 如果没有笔记则返回空字符串。
 */
export async function getNotesPromptBlock(workspace: string, projectId?: string): Promise<string> {
  const notes = await loadNotes(workspace, projectId)
  if (notes.length === 0) return ''

  // 按分类分组
  const grouped = new Map<NoteCategory, ProjectNote[]>()
  for (const note of notes) {
    const cat = note.category || 'other'
    if (!grouped.has(cat)) grouped.set(cat, [])
    grouped.get(cat)!.push(note)
  }

  const blocks: string[] = []
  for (const [cat, catNotes] of grouped) {
    const label = CATEGORY_LABELS[cat] || cat
    blocks.push(`## ${label}`)
    for (const note of catNotes) {
      blocks.push(`### ${note.title}`)
      blocks.push(note.content)
    }
  }

  return '\n\n# 项目笔记（用户为本项目记录的重要上下文，请始终遵守）\n\n' + blocks.join('\n\n')
}
