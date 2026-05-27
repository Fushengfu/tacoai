/**
 * USER_ASSETS / USER_QUERY 协议解析工具
 *
 * 统一处理用户消息中的 [USER_ASSETS] 和 [USER_QUERY] 标记块，
 * 消除 agent/index.ts、ai/llm.ts、data/notes.ts、ipc/index.ts、
 * renderer/hooks/useChat.ts 中的重复定义。
 */

/* ------------------------------------------------------------------ */
/*  常量                                                                */
/* ------------------------------------------------------------------ */

/** 纯 JS 版 extname，避免在 shared 模块中引入 node:path（渲染进程无法使用） */
function extname(filePath: string): string {
  const base = filePath.split(/[?#]/, 1)[0] ?? filePath
  const idx = base.lastIndexOf('.')
  if (idx <= 0 || idx === base.length - 1) return ''
  return base.slice(idx).toLowerCase()
}

export const USER_ASSETS_BLOCK_REGEX = /\s*\[USER_ASSETS\][\s\S]*?\[\/USER_ASSETS\]\s*/gi
export const USER_ASSETS_BLOCK_CAPTURE_REGEX = /\[USER_ASSETS\]([\s\S]*?)\[\/USER_ASSETS\]/i
export const USER_QUERY_BLOCK_CAPTURE_REGEX = /\[USER_QUERY\]([\s\S]*?)\[\/USER_QUERY\]/i

export const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.tif', '.tiff', '.heic', '.heif', '.avif',
])

export const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.wmv', '.flv', '.mpeg', '.mpg', '.3gp', '.ts', '.m2ts',
])

export const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a',
])

/** 判断文件路径是否为媒体类型（图片、视频、音频） */
export function isMediaFile(filePath: string): boolean {
  const ext = extname(filePath)
  if (!ext) return false
  return IMAGE_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext) || AUDIO_EXTENSIONS.has(ext)
}

/** 推断媒体文件的子类型 */
export function inferMediaSubtype(filePath: string): 'image_url' | 'video_url' | 'audio_url' | null {
  const ext = extname(filePath)
  if (!ext) return null
  if (IMAGE_EXTENSIONS.has(ext)) return 'image_url'
  if (VIDEO_EXTENSIONS.has(ext)) return 'video_url'
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio_url'
  return null
}

/* ------------------------------------------------------------------ */
/*  类型                                                                */
/* ------------------------------------------------------------------ */

export type UserAssetEntry = { type: string; path: string }

/* ------------------------------------------------------------------ */
/*  解析函数                                                            */
/* ------------------------------------------------------------------ */

/** 从内容中移除 [USER_ASSETS] 块 */
export function stripUserAssetsBlock(content: string): string {
  return String(content ?? '')
    .replace(USER_ASSETS_BLOCK_REGEX, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 提取 [USER_ASSETS] 块内部内容 */
export function extractUserAssetsBlock(content: string): string {
  const raw = String(content ?? '')
  const wrapped = raw.match(USER_ASSETS_BLOCK_CAPTURE_REGEX)
  if (!wrapped || !wrapped[1]) return ''
  return wrapped[1].trim()
}

/** 提取 [USER_QUERY] 中的原始查询文本 */
export function extractUserQueryText(content: string): string {
  const raw = stripUserAssetsBlock(String(content ?? ''))
  const wrapped = raw.match(USER_QUERY_BLOCK_CAPTURE_REGEX)
  if (wrapped && wrapped[1]) return wrapped[1].trim()
  return raw.trim()
}

/** 解析 [USER_ASSETS] 块中的条目列表 */
export function parseUserAssetEntries(content: string): UserAssetEntry[] {
  const body = extractUserAssetsBlock(content)
  if (!body) return []
  const entries: UserAssetEntry[] = []
  let currentType = ''
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const typeMatch = line.match(/^-+\s*type:\s*(.+)$/i)
    if (typeMatch && typeMatch[1]) {
      currentType = typeMatch[1].trim() || 'file'
      continue
    }
    const pathMatch = line.match(/^(?:-+\s*)?path:\s*(.+)$/i)
    if (pathMatch && pathMatch[1]) {
      entries.push({
        type: currentType || 'file',
        path: pathMatch[1].trim(),
      })
    }
  }
  return entries
}

/** 推断单个资源条目的类型 */
export function inferAssetKind(entry: UserAssetEntry): 'image' | 'video' | 'other' {
  const type = String(entry.type ?? '').trim().toLowerCase()
  if (type.includes('video')) return 'video'
  if (type.includes('image')) return 'image'
  const ext = extname(String(entry.path ?? '').trim().split(/[?#]/, 1)[0] ?? '').toLowerCase()
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (VIDEO_EXTENSIONS.has(ext)) return 'video'
  return 'other'
}

/* ------------------------------------------------------------------ */
/*  媒体引用收集                                                        */
/* ------------------------------------------------------------------ */

/** 从单条内容中提取媒体文件路径（image/video） */
export function collectUserMediaRefsFromContent(content: string): string[] {
  const refs: string[] = []
  for (const entry of parseUserAssetEntries(content)) {
    const kind = inferAssetKind(entry)
    if (kind !== 'image' && kind !== 'video') continue
    const ref = String(entry.path ?? '').trim()
    if (!ref) continue
    if (refs.includes(ref)) continue
    refs.push(ref)
  }
  return refs
}

/** 从消息数组中提取所有媒体文件路径 */
export function collectUserMediaRefsFromMessages(messages: Array<{ role: string; content: unknown }>): string[] {
  const refs: string[] = []
  for (const message of messages) {
    if (message.role !== 'user') continue
    for (const item of collectUserMediaRefsFromContent(String(message.content ?? ''))) {
      if (refs.includes(item)) continue
      refs.push(item)
    }
  }
  return refs
}

/** 将缺失的媒体引用附加到摘要文本末尾 */
export function appendMediaRefsToSummary(summary: string, mediaRefs: string[]): string {
  const cleanedSummary = String(summary ?? '').trim()
  if (mediaRefs.length <= 0) return cleanedSummary
  const missingRefs = mediaRefs.filter((ref) => !cleanedSummary.includes(ref))
  if (missingRefs.length <= 0) return cleanedSummary
  const mediaBlock = [
    '用户提交媒体文件（路径/链接）:',
    ...missingRefs.map((ref) => `- ${ref}`),
  ].join('\n')
  return cleanedSummary ? `${cleanedSummary}\n\n${mediaBlock}` : mediaBlock
}

/* ------------------------------------------------------------------ */
/*  构建函数                                                            */
/* ------------------------------------------------------------------ */

/** 将资源条目列表构建为 [USER_ASSETS] 块文本 */
export function buildUserAssetsBlock(entries: UserAssetEntry[]): string {
  if (entries.length <= 0) return ''
  const dedup = new Set<string>()
  const lines: string[] = ['[USER_ASSETS]']
  for (const entry of entries) {
    const type = String(entry?.type ?? '').trim() || 'file'
    const p = String(entry?.path ?? '').trim()
    if (!p) continue
    const key = `${type}:${p}`
    if (dedup.has(key)) continue
    dedup.add(key)
    lines.push(`- type: ${type}`)
    lines.push(`  path: ${p}`)
  }
  if (lines.length <= 1) return ''
  lines.push('[/USER_ASSETS]')
  return lines.join('\n')
}

/** 将 AttachedAsset 数组构建为 [USER_ASSETS] 块（渲染进程用） */
export function buildUserAssetsBlockFromAttachments(
  attachments: Array<{ path?: string }>,
  inferType: (p: string) => string,
): string {
  if (!attachments || attachments.length <= 0) return ''
  const dedup = new Set<string>()
  const lines: string[] = ['[USER_ASSETS]']
  for (const asset of attachments) {
    const p = String(asset?.path ?? '').trim()
    if (!p) continue
    const key = p.toLowerCase()
    if (dedup.has(key)) continue
    dedup.add(key)
    lines.push(`- type: ${inferType(p)}`)
    lines.push(`  path: ${p}`)
  }
  if (lines.length === 1) return ''
  lines.push('[/USER_ASSETS]')
  return lines.join('\n')
}

/** 推断附件类型（渲染进程用，基于扩展名） */
export function inferAttachmentType(rawPath: string): 'image' | 'video' | 'file' {
  const raw = String(rawPath ?? '').trim()
  if (!raw) return 'file'
  const normalized = raw.replace(/\\/g, '/').split(/[?#]/, 1)[0] ?? raw
  if (/\.(png|jpe?g|gif|webp|bmp|svg|ico|tiff?|heic|heif|avif)$/i.test(normalized)) return 'image'
  if (/\.(mp4|mov|m4v|webm|mkv|avi|wmv|flv|mpeg|mpg|3gp|ts|m2ts)$/i.test(normalized)) return 'video'
  return 'file'
}
