/**
 * Bridge 工具函数 & 缓存 & 树结构 & 图片脱敏 & 文件 I/O
 *
 * 从 bridge-handlers.ts 提取的纯工具函数，无 IPC 依赖。
 */

import { nativeImage } from 'electron'
import nodePath from 'node:path'
import * as fs from 'node:fs/promises'

/* ------------------------------------------------------------------ */
/*  Token 缓存                                                         */
/* ------------------------------------------------------------------ */

/** token 消耗缓存：projectId → tokenUsage，供 bridge:request-state 读取 */
export const tokenUsageCache = new Map<string, {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  cachedTokens?: number
}>()

/** 项目累计 token 统计缓存：projectId → projectTokenStats */
export const projectTokenStatsCache = new Map<string, {
  inputTokens?: number
  outputTokens?: number
  cachedTokens?: number
  turns?: number
}>()

/* ------------------------------------------------------------------ */
/*  Workspace tree flattening to nested structure                      */
/* ------------------------------------------------------------------ */

/**
 * 将扁平的 WorkspaceEntry[] 转换为嵌套的树形结构。
 * 桌面端 getWorkspaceTree 返回扁平 entries，移动端期望嵌套 children 结构。
 */
export function buildNestedTree(
  entries: Array<{ path: string; name: string; kind: string; depth: number }>,
): Array<{ name: string; path: string; isDirectory: boolean; children?: any[] }> {
  const nodeMap = new Map<string, { name: string; path: string; isDirectory: boolean; children?: any[] }>()
  const roots: Array<{ name: string; path: string; isDirectory: boolean; children?: any[] }> = []

  for (const entry of entries) {
    const isDir = entry.kind === 'directory'
    const node = {
      name: entry.name,
      path: entry.path,
      isDirectory: isDir,
      children: isDir ? [] : undefined,
    }
    nodeMap.set(entry.path, node)
  }

  for (const entry of entries) {
    const node = nodeMap.get(entry.path)!
    const parentPath = entry.path.includes('/') ? entry.path.split('/').slice(0, -1).join('/') : ''
    if (parentPath && nodeMap.has(parentPath)) {
      const parent = nodeMap.get(parentPath)!
      if (!parent.children) parent.children = []
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }

  for (const node of nodeMap.values()) {
    if (node.children) {
      node.children.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        return a.name.localeCompare(b.name)
      })
    }
  }

  roots.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return roots
}

/* ------------------------------------------------------------------ */
/*  Image data stripping for bridge (reduce WebSocket payload)         */
/* ------------------------------------------------------------------ */

/**
 * 压缩 base64 图片 dataUrl，使其适合 WebSocket 传输。
 * 使用 Electron nativeImage 缩放 + JPEG 压缩，目标 80KB 以下。
 */
function compressDataUrlForBridge(dataUrl: string, maxChars: number = 110_000): string {
  try {
    const img = nativeImage.createFromDataURL(dataUrl)
    if (img.isEmpty()) return dataUrl

    const size = img.getSize()
    const maxDim = 800
    let scale = 1
    if (size.width > maxDim || size.height > maxDim) {
      scale = Math.min(maxDim / size.width, maxDim / size.height)
    }

    const newWidth = Math.max(1, Math.round(size.width * scale))
    const newHeight = Math.max(1, Math.round(size.height * scale))
    const resized = img.resize({ width: newWidth, height: newHeight, quality: 'best' })

    for (const q of [70, 55, 40, 25]) {
      const buf = resized.toJPEG(q)
      const jpeg = `data:image/jpeg;base64,${buf.toString('base64')}`
      if (jpeg.length <= maxChars) return jpeg
    }
    const fallbackBuf = resized.toJPEG(25)
    return `data:image/jpeg;base64,${fallbackBuf.toString('base64')}`
  } catch {
    return dataUrl
  }
}

/**
 * 从消息列表中剥离图片 dataUrl（base64），只保留 cloudUrl + 元数据。
 * 大幅减少通过 WebSocket 推送到移动端的数据量。
 */
export function stripDataUrlFromMessages(messages: unknown[]): unknown[] {
  return messages.map((msg: any) => {
    if (!msg || typeof msg !== 'object') return msg

    const result = { ...msg }

    if (Array.isArray(result.images)) {
      result.images = result.images.map((img: any) => {
        if (!img || typeof img !== 'object') return img
        if (typeof img.dataUrl !== 'string' || img.dataUrl.length === 0) return img

        const hasCloudUrl = typeof img.cloudUrl === 'string' && img.cloudUrl.length > 0
        if (hasCloudUrl) {
          const { dataUrl, ...rest } = img
          return rest
        }

        if (img.dataUrl.length > 100 * 1024) {
          const compressed = compressDataUrlForBridge(img.dataUrl)
          return { ...img, dataUrl: compressed }
        }
        return img
      })
    }

    if (Array.isArray(result.content)) {
      result.content = result.content.map((part: any) => {
        if (!part || typeof part !== 'object') return part
        if (part.type === 'image_url' && part.image_url?.url) {
          const url = part.image_url.url as string
          if (url.startsWith('data:')) {
            const compressed = compressDataUrlForBridge(url)
            return { ...part, image_url: { ...part.image_url, url: compressed } }
          }
        }
        return part
      })
    }

    return result
  })
}

/**
 * 对消息的 agentSteps 进行按需加载预处理（步骤级）：
 * - 如果有活跃步骤（running / calling / confirm），保留完整 agentSteps
 * - 否则清空 heavy 字段（thinking / toolCalls.arguments / toolResults.content / fileChange）
 */
export function stripAgentStepsForBridge(messages: unknown[]): unknown[] {
  return messages.map((msg: any) => {
    if (!msg || typeof msg !== 'object') return msg
    if (msg.role !== 'assistant') return msg
    const agentSteps: any[] | undefined = msg.agentSteps
    if (!Array.isArray(agentSteps) || agentSteps.length === 0) return msg

    const hasActive = agentSteps.some(
      (s: any) => s.status === 'running' || s.status === 'calling' || s.status === 'confirm'
    )

    if (hasActive) return msg

    const stripped = agentSteps.map((s: any) => ({
      round: s.round,
      status: s.status,
      ...(s.systemTitle ? { systemTitle: s.systemTitle } : {}),
      ...(s.systemDetail ? { systemDetail: s.systemDetail } : {}),
      ...(s.confirmId ? { confirmId: s.confirmId } : {}),
      thinking: '',
      toolCalls: Array.isArray(s.toolCalls)
        ? s.toolCalls.map((tc: any) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.function?.name || tc.name || '', arguments: '' },
          }))
        : [],
      toolResults: Array.isArray(s.toolResults)
        ? s.toolResults.map((tr: any) => ({
            tool_call_id: tr.tool_call_id || '',
            name: tr.name || '',
            content: '',
            success: tr.success ?? false,
          }))
        : [],
      ...(Array.isArray(s.risks) && s.risks.length > 0 ? { risks: s.risks } : {}),
    }))

    return { ...msg, agentSteps: stripped, agentStepsTruncated: true }
  })
}

/* ------------------------------------------------------------------ */
/*  File read/write helpers (for bridge)                               */
/* ------------------------------------------------------------------ */

const FILE_READ_HARD_LIMIT = 5 * 1024 * 1024

function isBinaryBuffer(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8192)
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true
  }
  return false
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

export async function handleFileRead(filePath: string): Promise<{
  content: string | null
  size: number
  isBinary: boolean
  dataUrl?: string
  truncated?: boolean
}> {
  const stat = await fs.stat(filePath)
  const size = stat.size
  const imageMime = imageMimeFromPath(filePath)

  if (size > FILE_READ_HARD_LIMIT) {
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

export async function handleFileWrite(filePath: string, content: string): Promise<void> {
  const dir = nodePath.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(filePath, content, 'utf-8')
}
