/**
 * Workspace IPC Handlers
 *
 * 包含工作区目录树和文件监听相关 IPC handler。
 */

import { BrowserWindow } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import * as fs from 'node:fs/promises'
import { watch as fsWatch, type Dirent, type FSWatcher } from 'node:fs'
import * as nodePath from 'node:path'
import { IpcChannel } from '../../../shared/ipc'
import type { FileTreeEntry } from '../../../shared/ipc'
import { log } from '../../system/logger'

/* ------------------------------------------------------------------ */
/*  Workspace tree                                                     */
/* ------------------------------------------------------------------ */

const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '.DS_Store',
  '__pycache__', '.cache', 'coverage', '.idea', '.vscode',
  '.next', '.nuxt', '.output', '.dart_tool', '.turbo',
  'dist', 'build', 'out', 'target', '.gradle', 'Pods', 'DerivedData',
])

const WORKSPACE_TREE_MAX_DEPTH = 16
const WORKSPACE_TREE_MAX_ENTRIES = 12_000
const WORKSPACE_TREE_MAX_CHILDREN_PER_DIR = 1_500
const WORKSPACE_TREE_CACHE_TTL_MS = 1_500

type WorkspaceTreeReadState = {
  visited: number
  truncated: boolean
}

const workspaceTreeCache = new Map<string, { at: number; tree: FileTreeEntry[] }>()
const workspaceTreeInFlight = new Map<string, Promise<FileTreeEntry[]>>()

async function readWorkspaceTree(
  dir: string,
  basePath = '',
  depth = 0,
  maxDepth = WORKSPACE_TREE_MAX_DEPTH,
  state?: WorkspaceTreeReadState,
): Promise<FileTreeEntry[]> {
  const active = state ?? { visited: 0, truncated: false }
  if (depth > maxDepth || active.truncated) return []
  let entries: Dirent<string>[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true, encoding: 'utf8' })
  } catch { return [] }

  const sortedEntries = entries
    .filter((entry) => !EXCLUDED_DIRS.has(entry.name))
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    .slice(0, WORKSPACE_TREE_MAX_CHILDREN_PER_DIR)

  const result: FileTreeEntry[] = []
  for (const entry of sortedEntries) {
    if (active.truncated) break
    if (active.visited >= WORKSPACE_TREE_MAX_ENTRIES) {
      active.truncated = true
      break
    }
    const relPath = basePath ? `${basePath}/${entry.name}` : entry.name
    active.visited++

    if (entry.isDirectory()) {
      const children = await readWorkspaceTree(
        nodePath.join(dir, entry.name), relPath, depth + 1, maxDepth, active,
      )
      result.push({ name: entry.name, path: relPath, absPath: nodePath.join(dir, entry.name), isDirectory: true, children })
    } else {
      result.push({ name: entry.name, path: relPath, absPath: nodePath.join(dir, entry.name), isDirectory: false })
    }
  }
  return result
}

async function getWorkspaceTree(cwd: string): Promise<FileTreeEntry[]> {
  const resolved = nodePath.resolve(String(cwd ?? '').trim() || '.')
  const now = Date.now()
  const cached = workspaceTreeCache.get(resolved)
  if (cached && (now - cached.at) <= WORKSPACE_TREE_CACHE_TTL_MS) {
    return cached.tree
  }

  const running = workspaceTreeInFlight.get(resolved)
  if (running) return running

  const state: WorkspaceTreeReadState = { visited: 0, truncated: false }
  const task = readWorkspaceTree(resolved, '', 0, WORKSPACE_TREE_MAX_DEPTH, state)
    .then((tree) => {
      workspaceTreeCache.set(resolved, { at: Date.now(), tree })
      if (state.truncated) {
        log('WORKSPACE_TREE_TRUNCATED', {
          workspace: resolved,
          maxDepth: WORKSPACE_TREE_MAX_DEPTH,
          maxEntries: WORKSPACE_TREE_MAX_ENTRIES,
        })
      }
      return tree
    })
    .finally(() => {
      workspaceTreeInFlight.delete(resolved)
    })

  workspaceTreeInFlight.set(resolved, task)
  return task
}

/* ------------------------------------------------------------------ */
/*  Workspace watcher                                                  */
/* ------------------------------------------------------------------ */

let activeWatcher: FSWatcher | null = null
let activeWatchPath: string | null = null
let watchDebounce: ReturnType<typeof setTimeout> | null = null

export function startWatching(cwd: string, win: BrowserWindow) {
  stopWatching()
  activeWatchPath = nodePath.resolve(cwd)
  try {
    activeWatcher = fsWatch(activeWatchPath, { recursive: true }, (_eventType, filename) => {
      if (filename) {
        const top = filename.toString().split(/[/\\]/)[0]
        if (EXCLUDED_DIRS.has(top)) return
      }
      if (watchDebounce) clearTimeout(watchDebounce)
      watchDebounce = setTimeout(() => {
        watchDebounce = null
        if (activeWatchPath) workspaceTreeCache.delete(activeWatchPath)
        if (!win.isDestroyed()) {
          win.webContents.send(IpcChannel.WORKSPACE_CHANGED)
        }
      }, 160)
    })
  } catch (err) {
    console.error('工作区文件监听启动失败:', err)
  }
}

export function stopWatching() {
  if (watchDebounce) { clearTimeout(watchDebounce); watchDebounce = null }
  if (activeWatcher) { activeWatcher.close(); activeWatcher = null }
  activeWatchPath = null
}

/* ------------------------------------------------------------------ */
/*  IPC Handlers                                                       */
/* ------------------------------------------------------------------ */

export async function handleWorkspaceTree(_event: IpcMainInvokeEvent, cwd: string, force?: boolean): Promise<FileTreeEntry[]> {
  if (force) {
    workspaceTreeCache.delete(nodePath.resolve(cwd))
  }
  return getWorkspaceTree(cwd)
}

export function handleWorkspaceWatch(event: IpcMainEvent, cwd: string) {
  const senderWin = BrowserWindow.fromWebContents(event.sender)
  if (senderWin) startWatching(cwd, senderWin)
}

export function handleWorkspaceUnwatch() {
  stopWatching()
}
