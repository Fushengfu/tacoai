/**
 * LLM 客户端 - 工具函数
 * 
 * 纯函数集合，无副作用，无模块级状态。
 */

import { extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ToolCall } from '../tools'
import type { ChatMessage, ProviderConfig, RequestOptions, TokenUsage } from './types'
import { llmLog } from './providers'

/* ------------------------------------------------------------------ */
/*  常量                                                               */
/* ------------------------------------------------------------------ */

/** 默认模型温度（未显式配置时使用）。 */
export const FIXED_MODEL_TEMPERATURE = 0.05
const MIN_MODEL_TEMPERATURE = 0
const MAX_MODEL_TEMPERATURE = 2
export const RATE_LIMIT_MAX_ATTEMPTS = 5
const RATE_LIMIT_BASE_DELAY_MS = 2000
const RATE_LIMIT_MAX_DELAY_MS = 15000

/* ------------------------------------------------------------------ */
/*  HTTP / fetch 相关                                                   */
/* ------------------------------------------------------------------ */

export function resolveRequestTemperature(config: ProviderConfig): number {
  const value = Number(config.temperature)
  if (!Number.isFinite(value)) return FIXED_MODEL_TEMPERATURE
  if (value < MIN_MODEL_TEMPERATURE || value > MAX_MODEL_TEMPERATURE) {
    return FIXED_MODEL_TEMPERATURE
  }
  return value
}

export function createAbortError(): Error {
  try {
    return new DOMException('The operation was aborted.', 'AbortError')
  } catch {
    return new Error('The operation was aborted.')
  }
}

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return
  if (signal?.aborted) throw createAbortError()
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(createAbortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function parseRetryAfterMs(retryAfterValue: string | null): number | null {
  if (!retryAfterValue) return null
  const seconds = Number(retryAfterValue)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.max(0, Math.floor(seconds * 1000))
  }
  const dateMs = Date.parse(retryAfterValue)
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now())
  }
  return null
}

function resolve429DelayMs(response: Response, attempt: number): number {
  const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'))
  if (retryAfterMs !== null) {
    return Math.min(RATE_LIMIT_MAX_DELAY_MS, Math.max(500, retryAfterMs))
  }
  const backoffMs = RATE_LIMIT_BASE_DELAY_MS * (2 ** (attempt - 1))
  return Math.min(RATE_LIMIT_MAX_DELAY_MS, backoffMs)
}

export async function readResponseTextSafe(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

export async function fetchWith429Retry(
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  logScope: string | undefined,
): Promise<Response> {
  for (let attempt = 1; attempt <= RATE_LIMIT_MAX_ATTEMPTS; attempt++) {
    const response = await fetch(url, { ...init, signal })
    if (response.status !== 429) return response

    const canRetry = attempt < RATE_LIMIT_MAX_ATTEMPTS
    const waitMs = canRetry ? resolve429DelayMs(response, attempt) : 0
    const body = await readResponseTextSafe(response.clone())
    llmLog('REQUEST_RETRY', {
      url,
      method: init.method,
      reason: 'HTTP 429 Too Many Requests',
      attempt,
      maxAttempts: RATE_LIMIT_MAX_ATTEMPTS,
      waitMs,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    }, logScope)

    if (!canRetry) return response
    await sleep(waitMs, signal)
  }

  throw new Error('Unexpected retry state')
}

/* ------------------------------------------------------------------ */
/*  Tool 名称处理                                                       */
/* ------------------------------------------------------------------ */

export function normalizeToolName(name: string): string {
  return String(name || '').trim().toLowerCase()
}

export function buildAllowedToolNameSet(options?: RequestOptions): Set<string> {
  const out = new Set<string>()
  for (const tool of options?.tools ?? []) {
    const name = normalizeToolName(tool?.function?.name || '')
    if (name) out.add(name)
  }
  return out
}

/* ------------------------------------------------------------------ */
/*  流式 delta 提取                                                      */
/* ------------------------------------------------------------------ */

export function extractDeltaString(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (!value) return ''
  if (Array.isArray(value)) {
    return value.map((item) => extractDeltaString(item)).filter(Boolean).join('')
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const prioritizedKeys = [
      'text',
      'content',
      'value',
      'output_text',
      'reasoning_content',
      'reasoning',
      'thinking',
      'analysis',
    ]
    for (const key of prioritizedKeys) {
      const nested = extractDeltaString(record[key])
      if (nested) return nested
    }
  }
  return ''
}

export function extractReasoningDelta(delta: unknown): string {
  if (!delta || typeof delta !== 'object') return ''
  const record = delta as Record<string, unknown>
  const reasoningCandidates = [
    record.reasoning_content,
    record.reasoning,
    record.thinking,
    record.analysis,
  ]
  for (const candidate of reasoningCandidates) {
    const text = extractDeltaString(candidate)
    if (text) return text
  }
  return ''
}

export function extractTextDelta(delta: unknown): string {
  if (!delta || typeof delta !== 'object') return ''
  const record = delta as Record<string, unknown>
  return extractDeltaString(record.content)
}

/* ------------------------------------------------------------------ */
/*  Tool calls 解析                                                      */
/* ------------------------------------------------------------------ */

export function resolveToolCallsFromMap(
  toolCallsMap: Map<number, { id: string; type: 'function'; function: { name: string; arguments: string } }>,
  allowedToolNames: Set<string>,
): { toolCalls: ToolCall[]; invalidNames: string[] } {
  const invalidNames: string[] = []
  const toolCalls: ToolCall[] = []
  for (const raw of Array.from(toolCallsMap.values())) {
    const normalizedName = normalizeToolName(raw.function?.name || '')
    if (!normalizedName) continue
    if (allowedToolNames.size > 0 && !allowedToolNames.has(normalizedName)) {
      invalidNames.push(normalizedName)
      continue
    }
    toolCalls.push({
      id: String(raw.id || ''),
      type: 'function',
      function: {
        name: normalizedName,
        arguments: String(raw.function?.arguments || ''),
      },
    })
  }
  return {
    toolCalls,
    invalidNames: [...new Set(invalidNames)],
  }
}

/* ------------------------------------------------------------------ */
/*  消息处理                                                            */
/* ------------------------------------------------------------------ */

/** 从 content 中提取文本（支持字符串和数组） */
export function extractContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((p: any) => p.type === 'text')
      .map((p: any) => p.text)
      .join('\n')
  }
  return String(content ?? '')
}

/** 合并多条 system 消息为一条 */
export function normalizeMessages(messages: ChatMessage[]): ChatMessage[] {
  let firstSystemIdx = -1
  const extraSystem: string[] = []
  const out: ChatMessage[] = []

  for (const msg of messages) {
    if (msg.role !== 'system') {
      out.push(msg)
      continue
    }
    if (firstSystemIdx === -1) {
      firstSystemIdx = out.length
      out.push(msg)
      continue
    }
    const text = extractContentText(msg.content)
    if (text.trim()) extraSystem.push(text.trim())
  }

  if (extraSystem.length === 0) return out

  const first = out[firstSystemIdx]
  const firstText = extractContentText(first.content)
  out[firstSystemIdx] = {
    ...first,
    content: [firstText?.trim() ?? '', ...extraSystem].filter(Boolean).join('\n\n'),
  }
  return out
}

/* ------------------------------------------------------------------ */
/*  Request / Response 日志辅助                                           */
/* ------------------------------------------------------------------ */

export function fullHeadersForLog(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headers) return out
  const h = new Headers(headers)
  for (const [k, v] of h.entries()) {
    out[k] = v
  }
  return out
}

export function parseJsonBodyForLog(body: BodyInit | null | undefined): unknown {
  if (typeof body !== 'string') return body ?? null
  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}

/* ------------------------------------------------------------------ */
/*  路径 / URL 辅助                                                      */
/* ------------------------------------------------------------------ */

export function normalizeMediaUrl(raw: string): string {
  const value = String(raw ?? '').trim()
  if (!value) return ''
  if (/^(?:https?:\/\/|data:|oss:\/\/|file:\/\/)/i.test(value)) return value
  if (isAbsolute(value)) {
    try {
      return pathToFileURL(value).toString()
    } catch {
      return value
    }
  }
  return value
}

export function dedupStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const text = String(value ?? '').trim()
    if (!text) continue
    if (seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

export function isLikelyLocalPath(value: string): boolean {
  if (isAbsolute(value)) return true
  return /^[a-zA-Z]:[\\/]/.test(value)
}

export function isTokenPlanBaseUrl(baseUrl: string): boolean {
  const raw = String(baseUrl ?? '').trim()
  if (!raw) return false
  try {
    const u = new URL(raw)
    return /(^|\.)maas\.aliyuncs\.com$/i.test(u.hostname) && /^\/compatible-mode\/v\d+$/i.test(u.pathname.replace(/\/+$/, ''))
  } catch {
    return /token-plan\.cn-beijing\.maas\.aliyuncs\.com\/compatible-mode\/v\d+/i.test(raw)
  }
}

export function asTrimmedText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function normalizeObjectPrefix(prefix: string): string {
  return asTrimmedText(prefix)
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
}

export function ensureUrlWithScheme(value: string): string {
  const raw = asTrimmedText(value)
  if (!raw) return ''
  if (/^https?:\/\//i.test(raw)) return raw
  return `https://${raw}`
}

export function normalizePublicBaseUrl(value: string): string {
  return ensureUrlWithScheme(value).replace(/\/+$/, '')
}

export function buildStorageObjectKey(filePath: string, objectPrefix: string): string {
  const safePrefix = normalizeObjectPrefix(objectPrefix)
  const ext = extname(filePath).toLowerCase()
  const datePart = new Date().toISOString().slice(0, 10)
  const randomPart = randomUUID()
  const filePart = ext ? `${randomPart}${ext}` : randomPart
  return [safePrefix, datePart, filePart].filter(Boolean).join('/')
}

export function encodeObjectKeyPath(key: string): string {
  return key
    .split('/')
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/')
}

export function buildPublicUrl(publicBaseUrl: string, key: string): string {
  const base = normalizePublicBaseUrl(publicBaseUrl)
  const path = encodeObjectKeyPath(key)
  return `${base}/${path}`
}

export function toUrlSafeBase64(value: string | Buffer): string {
  const encoded = Buffer.isBuffer(value)
    ? value.toString('base64')
    : Buffer.from(value).toString('base64')
  return encoded.replace(/\+/g, '-').replace(/\//g, '_')
}

export function resolveQiniuRegionUploadUrl(rawText: string, currentUploadUrl: string): string | null {
  const text = String(rawText ?? '')
  const match = text.match(/please use\s+([a-z0-9.-]+qiniup\.com)/i)
  const host = match?.[1] ? match[1].trim() : ''
  if (!host) return null
  const current = String(currentUploadUrl ?? '').trim()
  const protocolMatch = current.match(/^(https?):\/\//i)
  const protocol = protocolMatch?.[1] ? protocolMatch[1].toLowerCase() : 'https'
  const next = `${protocol}://${host}`
  if (current && current.toLowerCase() === next.toLowerCase()) return null
  return next
}

export function toLocalPathIfFileUrl(value: string): string | null {
  const raw = String(value ?? '').trim()
  if (!/^file:\/\//i.test(raw)) return null
  try {
    return require('node:url').fileURLToPath(raw)
  } catch {
    return null
  }
}

export function normalizeModelName(value: string): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
}

/* ------------------------------------------------------------------ */
/*  Token usage 解析                                                    */
/* ------------------------------------------------------------------ */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseTokenUsage(chunk: any): TokenUsage | null {
  const usage = chunk?.usage
  if (!usage || typeof usage !== 'object') return null

  const promptTokens = Number(usage.prompt_tokens)
  const completionTokens = Number(usage.completion_tokens)
  const totalTokens = Number(usage.total_tokens)
  const promptDetails = usage.prompt_tokens_details && typeof usage.prompt_tokens_details === 'object'
    ? usage.prompt_tokens_details
    : null
  const inputDetails = usage.input_tokens_details && typeof usage.input_tokens_details === 'object'
    ? usage.input_tokens_details
    : null
  const cachedTokensRaw =
    promptDetails?.cached_tokens
    ?? promptDetails?.cache_read_tokens
    ?? inputDetails?.cached_tokens
    ?? inputDetails?.cache_read_tokens
  const cachedTokens = Number(cachedTokensRaw)

  const out: TokenUsage = {}
  if (Number.isFinite(promptTokens)) out.promptTokens = promptTokens
  if (Number.isFinite(completionTokens)) out.completionTokens = completionTokens
  if (Number.isFinite(totalTokens)) out.totalTokens = totalTokens
  if (Number.isFinite(cachedTokens)) out.cachedTokens = cachedTokens

  return Object.keys(out).length > 0 ? out : null
}

/* ------------------------------------------------------------------ */
/*  流式响应合并 + 日志                                                    */
/* ------------------------------------------------------------------ */

/**
 * 将流式 chunk 合并为类似非流式的完整响应结构再记录日志。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildMergedResponse(
  firstChunk: any,
  lastChunk: any,
  content: string,
  usageOverride?: unknown,
  toolCalls?: ToolCall[],
  reasoningContent?: string,
) {
  const usage = usageOverride !== undefined ? usageOverride : (lastChunk?.usage ?? null)
  const message: { role: 'assistant'; content: string; tool_calls?: ToolCall[]; reasoning_content?: string } = {
    role: 'assistant',
    content,
  }
  if (toolCalls && toolCalls.length > 0) {
    message.tool_calls = toolCalls
  }
  if (reasoningContent && reasoningContent.trim()) {
    message.reasoning_content = reasoningContent
  }

  if (!firstChunk) {
    return {
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message,
          finish_reason: lastChunk?.choices?.[0]?.finish_reason ?? 'stop',
        }
      ],
      usage,
    }
  }
  return {
    id: firstChunk.id,
    object: 'chat.completion',
    model: firstChunk.model,
    created: firstChunk.created,
    choices: [
      {
        index: 0,
        message,
        finish_reason: lastChunk?.choices?.[0]?.finish_reason ?? 'stop',
      }
    ],
    usage,
  }
}

export function logMergedStreamResponse(params: {
  url: string
  response: Response
  durationMs: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  firstChunk: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lastChunk: any
  content: string
  usage?: unknown
  toolCalls?: ToolCall[]
  reasoningContent?: string
  logScope?: string
}) {
  const { url, response, durationMs, firstChunk, lastChunk, content, usage, toolCalls, reasoningContent, logScope } = params
  llmLog('RESPONSE', {
    url,
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
    durationMs,
    body: buildMergedResponse(firstChunk, lastChunk, content, usage, toolCalls, reasoningContent),
  }, logScope)
}
