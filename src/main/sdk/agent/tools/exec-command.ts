/**
 * 工具执行器 - 命令执行 + 文件上传
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import type { AgentServices } from '../services'
import { uploadDataUrlToStorage } from '../llm/client'
import {
  resolveSafe,
  execAsync,
  getRunCommandEnv,
  isAbortError,
  type ExecResult,
  type ToolRuntimeContext,
} from './exec-utils'

/* ------------------------------------------------------------------ */
/*  run_command                                                        */
/* ------------------------------------------------------------------ */

export async function execRunCommand(
  args: Record<string, unknown>,
  workspace: string,
  signal?: AbortSignal,
): Promise<ExecResult> {
  const command = String(args.command ?? '').trim()
  if (!command) return { content: 'Error: command is required', success: false }

  const check = resolveSafe(workspace, String(args.cwd ?? '.'))
  const cwd = 'error' in check ? workspace : check.resolved

  const MAX_OUTPUT_CHARS = 12000
  const TIMEOUT_MS = 120_000

  try {
    const env = await getRunCommandEnv()
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      signal,
      env,
    })

    const combined = (stdout ? `stdout:\n${stdout}` : '') +
      (stderr ? `\nstderr:\n${stderr}` : '')

    if (combined.length > MAX_OUTPUT_CHARS) {
      return {
        content: combined.slice(0, MAX_OUTPUT_CHARS) +
          `\n\n[输出已截断，共 ${combined.length} 字符，仅显示前 ${MAX_OUTPUT_CHARS} 字符]`,
        success: true,
      }
    }

    return { content: combined || '(命令执行成功，无输出)', success: true }
  } catch (err) {
    if (isAbortError(err)) throw err
    const execErr = err as Error & { stdout?: string; stderr?: string; code?: string | number; signal?: string }
    const stdout = execErr.stdout ?? ''
    const stderr = execErr.stderr ?? ''
    const combined = (stdout ? `stdout:\n${stdout}` : '') + (stderr ? `\nstderr:\n${stderr}` : '')

    let reason = execErr.message
    if (execErr.code === 'ENOENT') reason = '命令未找到'
    else if (execErr.signal === 'SIGTERM') reason = '命令被终止'
    else if (execErr.code === 'ETIMEDOUT' || reason.includes('timeout')) reason = '命令执行超时'

    const output = combined.length > MAX_OUTPUT_CHARS
      ? combined.slice(0, MAX_OUTPUT_CHARS) + `\n\n[输出已截断]`
      : combined

    return {
      content: `Error: ${reason}${output ? '\n\n' + output : ''}`,
      success: false,
    }
  }
}

/* ------------------------------------------------------------------ */
/*  文件上传到云存储                                                     */
/* ------------------------------------------------------------------ */

const FILE_EXT_MIME_MAP: Record<string, string> = {
  '.apk': 'application/vnd.android.package-archive',
  '.ipa': 'application/octet-stream',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar.gz': 'application/x-gzip',
  '.tar': 'application/x-tar',
  '.dmg': 'application/x-apple-diskimage',
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.msi': 'application/x-msi',
  '.deb': 'application/vnd.debian.binary-package',
  '.rpm': 'application/x-rpm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/ico',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.ts': 'application/typescript',
}

function detectFileMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  if (filePath.toLowerCase().endsWith('.tar.gz')) return 'application/x-gzip'
  return FILE_EXT_MIME_MAP[ext] || 'application/octet-stream'
}

export async function execUploadFile(args: Record<string, unknown>, workspace: string, services?: AgentServices): Promise<ExecResult> {
  const rawPath = String(args.filePath ?? '').trim()
  if (!rawPath) return { content: 'Error: filePath is required', success: false }

  const resolved = path.resolve(workspace, rawPath)

  try {
    await fs.access(resolved)
  } catch {
    return { content: `Error: File not found: ${rawPath}`, success: false }
  }

  let fileSize: number
  let fileName: string
  try {
    const stat = await fs.stat(resolved)
    if (!stat.isFile()) return { content: `Error: Not a file: ${rawPath}`, success: false }
    fileSize = stat.size
    fileName = path.basename(resolved)
  } catch (err) {
    return { content: `Error: Cannot read file: ${err instanceof Error ? err.message : String(err)}`, success: false }
  }

  if (!services) {
    return { content: 'Error: services not available', success: false }
  }

  try {
    const bytes = await fs.readFile(resolved)
    const base64 = bytes.toString('base64')
    const mimeType = detectFileMime(resolved)
    const dataUrl = `data:${mimeType};base64,${base64}`

    const cloudUrl = await uploadDataUrlToStorage(null as any, dataUrl, undefined, services.getToken?.())
    services.logger('UPLOAD_FILE_SUCCESS', { filePath: resolved, fileSize, fileName, cloudUrl })

    const formattedSize = fileSize < 1024
      ? `${fileSize} B`
      : fileSize < 1024 * 1024
        ? `${(fileSize / 1024).toFixed(1)} KB`
        : `${(fileSize / (1024 * 1024)).toFixed(1)} MB`

    return {
      content: JSON.stringify({
        cloudUrl,
        fileName,
        filePath: resolved,
        fileSize,
        formattedSize,
        mimeType: detectFileMime(resolved),
      }),
      success: true,
    }
  } catch (err) {
    services.logger('UPLOAD_FILE_FAIL', { filePath: resolved, error: err instanceof Error ? err.message : String(err) })
    return {
      content: `Error: 上传失败 - ${err instanceof Error ? err.message : String(err)}`,
      success: false,
    }
  }
}
