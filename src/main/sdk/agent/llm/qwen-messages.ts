/**
 * Qwen / Mimo 专用消息构建
 * 
 * Qwen 模型的特殊消息格式处理，包括：
 * - explicit cache 检测与头注入
 * - 多媒体 URL 解析
 * - 用户消息 content 数组构建
 */

import type { UserAssetEntry } from '../shared/user-assets'
import {
  extractUserQueryText,
  inferAssetKind,
  parseUserAssetEntries,
  buildUserAssetsBlock,
} from '../shared/user-assets'
import type { ChatMessage, ProviderConfig, ProviderKey } from './types'
import { normalizeModelName, normalizeMediaUrl, dedupStrings, isLikelyLocalPath } from './utils'
import { llmLog } from './providers'

/* ------------------------------------------------------------------ */
/*  类型                                                               */
/* ------------------------------------------------------------------ */

export type QwenContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'video'; video: string[] }

export type QwenMessageBuildState = {
  uploadedUrlByPath: Map<string, string>
}

/* ------------------------------------------------------------------ */
/*  Explicit Cache 检测                                                 */
/* ------------------------------------------------------------------ */

const QWEN_EXPLICIT_CACHE_HEADER_KEYS = new Set([
  'x-dashscope-explicit-cache',
  'x-explicit-cache',
  'x-enable-explicit-cache',
  'x-enable-cache',
  'x-dashscope-cache-control',
])
const EXPLICIT_CACHE_CONTENT_HINT_PATTERN =
  /["']cache_control["']\s*:|["']cache-control["']\s*:|\[EXPLICIT_CACHE\]|explicit[_\s-]?cache\s*[:=]\s*(?:true|1|enable|enabled)|enable[_\s-]?cache\s*[:=]\s*(?:true|1|enable|enabled)/i

export function isQwen36PlusModel(model: string): boolean {
  const normalized = normalizeModelName(model)
  return normalized.includes('qwen3.6-plus') || normalized.includes('qwen3-6-plus')
}

function isTruthyText(value: unknown): boolean {
  const text = String(value ?? '').trim().toLowerCase()
  return text === '1' || text === 'true' || text === 'yes' || text === 'enable' || text === 'enabled' || text === 'on'
}

export function hasQwenExplicitCacheHint(
  message: ChatMessage,
  config: ProviderConfig,
  rawContent: string,
): boolean {
  const msgRecord = message as unknown as Record<string, unknown>
  const booleanKeys = [
    'explicitCache',
    'enableExplicitCache',
    'useExplicitCache',
    'explicit_cache',
    'enable_explicit_cache',
    'cacheControl',
    'cache_control',
  ]
  for (const key of booleanKeys) {
    const value = msgRecord[key]
    if (value && typeof value === 'object') return true
    if (typeof value === 'boolean' && value) return true
    if (typeof value === 'string' && isTruthyText(value)) return true
  }

  const headers = config.headers ?? {}
  for (const [key, value] of Object.entries(headers)) {
    const normalizedKey = String(key ?? '').trim().toLowerCase()
    if (!QWEN_EXPLICIT_CACHE_HEADER_KEYS.has(normalizedKey)) continue
    if (typeof value === 'string' && isTruthyText(value)) return true
  }

  return EXPLICIT_CACHE_CONTENT_HINT_PATTERN.test(String(rawContent ?? ''))
}

/* ------------------------------------------------------------------ */
/*  Media URL 解析                                                      */
/* ------------------------------------------------------------------ */

export async function resolveQwenMediaUrl(
  raw: string,
  config: ProviderConfig,
  _state: QwenMessageBuildState,
  _provider: ProviderKey,
  signal?: AbortSignal,
  logScope?: string,
  supportsVision?: boolean,
): Promise<string> {
  const value = String(raw ?? '').trim()
  if (!value) return ''
  
  // http:// https:// 直接返回 (前端已上传到云存储)
  if (/^(?:https?:\/\/)/i.test(value)) return value

  // 不再处理data URL和本地路径 (已在前端上传)
  if (/^data:/i.test(value) || isLikelyLocalPath(value)) {
    llmLog('UNEXPECTED_MEDIA_TYPE', { media: value.slice(0, 50), reason: 'should_be_uploaded_by_renderer' }, logScope)
    return ''
  }

  return normalizeMediaUrl(value)
}

/* ------------------------------------------------------------------ */
/*  用户消息 content 构建                                                */
/* ------------------------------------------------------------------ */

export async function buildQwenUserContent(
  message: ChatMessage,
  config: ProviderConfig,
  state: QwenMessageBuildState,
  provider: ProviderKey,
  signal?: AbortSignal,
  logScope?: string,
): Promise<string | QwenContentPart[]> {
  const rawContent = String(message.content ?? '')
  const entries = parseUserAssetEntries(rawContent)
  const qwen36Plus = isQwen36PlusModel(config.model)
  const explicitCacheEnabled = hasQwenExplicitCacheHint(message, config, rawContent)
  
  // 检查模型是否支持视觉理解
  const hasVision = config.supportsVision === true
  
  const imageUrls: string[] = []
  for (const item of message.images ?? []) {
    const resolved = await resolveQwenMediaUrl(item, config, state, provider, signal, logScope, hasVision)
    if (resolved) imageUrls.push(resolved)
  }
  const entryImageUrls: string[] = []
  const entryVideoUrls: string[] = []
  const nonMediaEntries: UserAssetEntry[] = []

  for (const entry of entries) {
    const normalizedPath = await resolveQwenMediaUrl(entry.path, config, state, provider, signal, logScope, hasVision)
    if (!normalizedPath) continue
    const kind = inferAssetKind(entry)
    if (kind === 'image') {
      if (!hasVision) {
        nonMediaEntries.push({
          type: 'image',
          path: entry.path,
        })
        continue
      }
      entryImageUrls.push(normalizedPath)
      continue
    }
    if (kind === 'video') {
      entryVideoUrls.push(normalizedPath)
      continue
    }
    nonMediaEntries.push({
      type: String(entry.type || 'file').trim() || 'file',
      path: entry.path,
    })
  }

  const dedupedImageUrls = dedupStrings([...imageUrls, ...entryImageUrls])
  const videoUrls = dedupStrings(entryVideoUrls)
  const hasMediaInput = dedupedImageUrls.length > 0 || videoUrls.length > 0

  const parts: QwenContentPart[] = []
  for (const url of dedupedImageUrls) {
    parts.push({ type: 'image_url', image_url: { url } })
  }

  if (videoUrls.length > 0) {
    parts.push({ type: 'video', video: videoUrls })
  }

  const textSegments: string[] = []
  const userQueryText = extractUserQueryText(rawContent)
  if (userQueryText) textSegments.push(userQueryText)
  const nonMediaAssetsBlock = buildUserAssetsBlock(nonMediaEntries)
  if (nonMediaAssetsBlock) textSegments.push(nonMediaAssetsBlock)
  const text = textSegments.join('\n\n').trim()
  if (text) parts.push({ type: 'text', text })

  // mimo 模型：无媒体输入时使用字符串，有媒体输入时使用数组
  if (provider === 'mimo') {
    if (!hasMediaInput) {
      return text || rawContent
    }
    if (parts.length <= 0) {
      const fallbackText = (text || rawContent).trim()
      if (!fallbackText) return rawContent
      return [{ type: 'text', text: fallbackText }]
    }
    return parts
  }

  if (!qwen36Plus) {
    if (parts.length <= 0) return rawContent
    return parts
  }

  const shouldUseArrayContent = hasMediaInput || explicitCacheEnabled
  if (!shouldUseArrayContent) {
    return text || rawContent
  }

  if (parts.length <= 0) {
    const fallbackText = (text || rawContent).trim()
    if (!fallbackText) return rawContent
    return [{ type: 'text', text: fallbackText }]
  }

  if (parts.length <= 0) return rawContent
  return parts
}

/* ------------------------------------------------------------------ */
/*  批量消息构建                                                        */
/* ------------------------------------------------------------------ */

export async function buildProviderMessages(
  provider: ProviderKey,
  config: ProviderConfig,
  messages: ChatMessage[],
  signal?: AbortSignal,
  logScope?: string,
): Promise<{ messages: unknown[] }> {
  const state: QwenMessageBuildState = {
    uploadedUrlByPath: new Map<string, string>(),
  }
  const out: unknown[] = []
  for (const message of messages) {
    if (message.role !== 'user') {
      out.push(message)
      continue
    }
    out.push({
      ...message,
      content: await buildQwenUserContent(message, config, state, provider, signal, logScope),
      images: undefined, // 请求AI模型时不能包含images字段
    })
  }
  return { messages: out }
}
