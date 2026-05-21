/**
 * File IPC Handlers
 *
 * 包含文件读写、删除、选择对话框、打开编辑器等 IPC handler。
 */

import { BrowserWindow, dialog, shell } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { exec } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'
import { IpcChannel, editorCommands } from '../../../shared/ipc'
import type { EditorId } from '../../../shared/ipc'

/* ------------------------------------------------------------------ */
/*  Directory / file dialogs                                           */
/* ------------------------------------------------------------------ */

/** 目录选择对话框 */
export async function handleSelectDirectory(event: IpcMainInvokeEvent): Promise<string | null> {
  const win = BrowserWindow.fromWebContents(event.sender)
  const result = await dialog.showOpenDialog(win!, {
    title: '选择工作空间目录',
    properties: ['openDirectory'],
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
}

/** 附件选择对话框 */
export async function handleSelectAttachments(event: IpcMainInvokeEvent): Promise<string[]> {
  const win = BrowserWindow.fromWebContents(event.sender)
  const result = await dialog.showOpenDialog(win!, {
    title: '选择附件',
    properties: ['openFile', 'multiSelections'],
  })
  if (result.canceled || result.filePaths.length === 0) return []
  return result.filePaths
}

/** 用编辑器打开文件 */
export async function handleOpenInEditor(_event: IpcMainInvokeEvent, filePath: string, editor: EditorId): Promise<void> {
  const entry = editorCommands[editor]
  if (!entry) throw new Error(`Unknown editor: ${editor}`)

  let cmd: string
  if (process.platform === 'darwin') {
    cmd = editor === 'system'
      ? `open "${filePath}"`
      : `open -a "${entry.macApp}" "${filePath}"`
  } else if (process.platform === 'win32') {
    cmd = editor === 'system'
      ? `start "" "${filePath}"`
      : `"${entry.cli}" "${filePath}"`
  } else {
    cmd = editor === 'system'
      ? `xdg-open "${filePath}"`
      : `${entry.cli} "${filePath}"`
  }

  return new Promise((resolve, reject) => {
    exec(cmd, (err) => {
      if (err) reject(new Error(`打开文件失败: ${err.message}`))
      else resolve()
    })
  })
}

/* ------------------------------------------------------------------ */
/*  File revert / delete                                               */
/* ------------------------------------------------------------------ */

/** 将文件内容恢复为旧内容 */
export async function handleFileRevert(_event: IpcMainInvokeEvent, filePath: string, oldContent: string): Promise<void> {
  try {
    const dir = nodePath.dirname(filePath)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(filePath, oldContent, 'utf-8')
  } catch (err: unknown) {
    throw err
  }
}

/** 删除文件（移到回收站） */
export async function handleFileDelete(_event: IpcMainInvokeEvent, filePath: string): Promise<void> {
  try {
    await shell.trashItem(filePath)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
}

/** 删除目录（移到回收站） */
export async function handleDirectoryDelete(_event: IpcMainInvokeEvent, dirPath: string): Promise<void> {
  try {
    await shell.trashItem(dirPath)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
}

/* ------------------------------------------------------------------ */
/*  File read / write                                                  */
/* ------------------------------------------------------------------ */

function isBinaryBuffer(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8192)
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

const FILE_READ_HARD_LIMIT = 5 * 1024 * 1024
const LARGE_TEXT_PREVIEW_BYTES = 1024 * 1024
const LARGE_TEXT_PREVIEW_EXTS = new Set([
  '.log', '.txt', '.md', '.mdx', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.xml', '.csv', '.tsv', '.sql', '.sh', '.bash', '.zsh', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.hpp', '.php', '.rb', '.swift', '.kt', '.kts',
  '.env',
])

function isLargeTextPreviewPath(filePath: string): boolean {
  const ext = nodePath.extname(filePath).toLowerCase()
  if (LARGE_TEXT_PREVIEW_EXTS.has(ext)) return true
  const base = nodePath.basename(filePath).toLowerCase()
  return base === '.env' || base.endsWith('.log')
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

async function readUtf8Tail(filePath: string, size: number, maxBytes: number): Promise<string> {
  const start = Math.max(0, size - maxBytes)
  const length = Math.max(0, size - start)
  if (length === 0) return ''
  const fh = await fs.open(filePath, 'r')
  try {
    const buf = Buffer.alloc(length)
    await fh.read(buf, 0, length, start)
    return buf.toString('utf-8')
  } finally {
    await fh.close()
  }
}

function imageMimeFromPath(filePath: string): string | null {
  const ext = nodePath.extname(filePath).toLowerCase()
  const m: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
  }
  return m[ext] ?? null
}

export async function handleFileRead(
  _event: IpcMainInvokeEvent, filePath: string,
): Promise<{ content: string | null; size: number; isBinary: boolean; dataUrl?: string; truncated?: boolean }> {
  const stat = await fs.stat(filePath)
  const size = stat.size
  const imageMime = imageMimeFromPath(filePath)

  if (size > FILE_READ_HARD_LIMIT) {
    if (!imageMime && isLargeTextPreviewPath(filePath)) {
      const preview = await readUtf8Tail(filePath, size, LARGE_TEXT_PREVIEW_BYTES)
      const notice = `[文件较大，已加载尾部预览：${formatBytes(LARGE_TEXT_PREVIEW_BYTES)} / ${formatBytes(size)}]\n\n`
      return { content: `${notice}${preview}`, size, isBinary: false, truncated: true }
    }
    return { content: null, size, isBinary: true }
  }

  const buf = Buffer.from(await fs.readFile(filePath))
  if (isBinaryBuffer(buf)) {
    if (imageMime) {
      return {
        content: null,
        size,
        isBinary: true,
        dataUrl: `data:${imageMime};base64,${buf.toString('base64')}`,
      }
    }
    const previewLen = Math.min(buf.length, 8192)
    const hexPreview = buf.subarray(0, previewLen).toString('hex')
    const lines: string[] = []
    for (let i = 0; i < hexPreview.length; i += 64) {
      lines.push(hexPreview.slice(i, i + 64))
    }
    const hexText = lines.join('\n')
    const hexDataUrl = `data:text/plain;charset=utf-8,${encodeURIComponent(hexText)}`
    return { content: null, size, isBinary: true, dataUrl: hexDataUrl }
  }

  const text = buf.toString('utf-8')
  if (imageMime === 'image/svg+xml') {
    return {
      content: text,
      size,
      isBinary: false,
      dataUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`,
    }
  }
  return { content: text, size, isBinary: false }
}

export async function handleFileWrite(
  _event: IpcMainInvokeEvent, filePath: string, content: string,
): Promise<void> {
  const dir = nodePath.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(filePath, content, 'utf-8')
}
