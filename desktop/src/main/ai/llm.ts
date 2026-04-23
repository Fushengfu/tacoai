import type { IncomingHttpHeaders } from 'node:http'
import { createHmac, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, extname, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { log } from '../system/logger'
import type { ToolDefinition, ToolCall } from '../tools'
import type { IpcUploadConfig } from '../../shared/ipc'

/** 标准聊天消息 */
export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** 用户消息可附带的图片（data URL / URL） */
  images?: string[]
  /** assistant 消息可能包含 tool_calls */
  tool_calls?: ToolCall[]
  /** tool 消息需要关联的 tool_call_id */
  tool_call_id?: string
}

/** 流式事件：文本片段 or 工具调用 */
export type StreamEvent =
  | { type: 'text'; content: string }
  | { type: 'reasoning'; content: string }
  | { type: 'tool_calls'; toolCalls: ToolCall[] }
  | { type: 'invalid_tool_calls'; names: string[] }
  | { type: 'usage'; usage: TokenUsage }

export type TokenUsage = {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  cachedTokens?: number
}

export type ProviderKey = 'deepseek' | 'kimi' | 'minimax' | 'glm' | 'qwen'

export type ProviderConfig = {
  baseUrl: string
  apiKey: string
  model: string
  temperature?: number
  headers?: IncomingHttpHeaders
  upload?: IpcUploadConfig
}

export type ProviderOverrides = Partial<Record<ProviderKey, Partial<ProviderConfig>>>

const providerConfigs: Record<ProviderKey, ProviderConfig> = {
  deepseek: {
    baseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
    apiKey: process.env.DEEPSEEK_API_KEY ?? '',
    model: process.env.DEEPSEEK_MODEL ?? ''
  },
  kimi: {
    baseUrl: process.env.KIMI_BASE_URL ?? 'https://api.moonshot.cn/v1',
    apiKey: process.env.KIMI_API_KEY ?? '',
    model: process.env.KIMI_MODEL ?? ''
  },
  minimax: {
    baseUrl: process.env.MINIMAX_BASE_URL ?? 'https://api.minimaxi.com/v1',
    apiKey: process.env.MINIMAX_API_KEY ?? '',
    model: process.env.MINIMAX_MODEL ?? ''
  },
  glm: {
    baseUrl: process.env.GLM_BASE_URL ?? 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: process.env.GLM_API_KEY ?? '',
    model: process.env.GLM_MODEL ?? ''
  },
  qwen: {
    baseUrl: process.env.QWEN_BASE_URL ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: process.env.QWEN_API_KEY ?? '',
    model: process.env.QWEN_MODEL ?? ''
  }
}

/** 默认模型温度（未显式配置时使用）。 */
const FIXED_MODEL_TEMPERATURE = 0.05
const MIN_MODEL_TEMPERATURE = 0
const MAX_MODEL_TEMPERATURE = 2
const RATE_LIMIT_MAX_ATTEMPTS = 5
const RATE_LIMIT_BASE_DELAY_MS = 2000
const RATE_LIMIT_MAX_DELAY_MS = 15000

function resolveRequestTemperature(config: ProviderConfig): number {
  const value = Number(config.temperature)
  if (!Number.isFinite(value)) return FIXED_MODEL_TEMPERATURE
  if (value < MIN_MODEL_TEMPERATURE || value > MAX_MODEL_TEMPERATURE) {
    return FIXED_MODEL_TEMPERATURE
  }
  return value
}

function createAbortError(): Error {
  try {
    return new DOMException('The operation was aborted.', 'AbortError')
  } catch {
    return new Error('The operation was aborted.')
  }
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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

async function readResponseTextSafe(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

async function fetchWith429Retry(
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
    log('REQUEST_RETRY', {
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

function getProviderConfig(
  provider: ProviderKey,
  overrides?: ProviderOverrides
): ProviderConfig {
  const base = providerConfigs[provider]
  const patch = overrides?.[provider]
  return {
    ...base,
    ...(patch ?? {}),
    headers: {
      ...(base.headers ?? {}),
      ...(patch?.headers ?? {})
    }
  }
}

export type RequestOptions = {
  tools?: ToolDefinition[]
  toolChoice?: 'auto' | 'required'
}

function normalizeToolName(name: string): string {
  return String(name || '').trim().toLowerCase()
}

function buildAllowedToolNameSet(options?: RequestOptions): Set<string> {
  const out = new Set<string>()
  for (const tool of options?.tools ?? []) {
    const name = normalizeToolName(tool?.function?.name || '')
    if (name) out.add(name)
  }
  return out
}

function extractDeltaString(value: unknown): string {
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

function extractReasoningDelta(delta: unknown): string {
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

function extractTextDelta(delta: unknown): string {
  if (!delta || typeof delta !== 'object') return ''
  const record = delta as Record<string, unknown>
  return extractDeltaString(record.content)
}

function resolveToolCallsFromMap(
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

function normalizeMessages(messages: ChatMessage[]): ChatMessage[] {
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
    if (msg.content?.trim()) extraSystem.push(msg.content.trim())
  }

  if (extraSystem.length === 0) return out

  if (firstSystemIdx === -1) {
    out.unshift({ role: 'system', content: extraSystem.join('\n\n') })
    return out
  }

  const first = out[firstSystemIdx]
  out[firstSystemIdx] = {
    ...first,
    content: [first.content?.trim() ?? '', ...extraSystem].filter(Boolean).join('\n\n'),
  }
  return out
}

type UserAssetEntry = { type: string; path: string }

type QwenContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'video'; video: string[] }

type DashScopeUploadPolicyData = {
  upload_dir: string
  oss_access_key_id: string
  signature: string
  policy: string
  x_oss_object_acl: string
  x_oss_forbid_overwrite: string
  upload_host: string
}

type QwenMessageBuildState = {
  requiresOssResolveHeader: boolean
  uploadedUrlByPath: Map<string, string>
  uploadPolicyPromise?: Promise<DashScopeUploadPolicyData>
}

const USER_ASSETS_BLOCK_REGEX = /\s*\[USER_ASSETS\][\s\S]*?\[\/USER_ASSETS\]\s*/gi
const USER_ASSETS_BLOCK_CAPTURE_REGEX = /\[USER_ASSETS\]([\s\S]*?)\[\/USER_ASSETS\]/i
const USER_QUERY_BLOCK_CAPTURE_REGEX = /\[USER_QUERY\]([\s\S]*?)\[\/USER_QUERY\]/i
const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.tif', '.tiff', '.heic', '.heif', '.avif',
])
const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.wmv', '.flv', '.mpeg', '.mpg', '.3gp', '.ts', '.m2ts',
])

function stripUserAssetsBlock(content: string): string {
  return String(content ?? '')
    .replace(USER_ASSETS_BLOCK_REGEX, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function extractUserAssetsBlock(content: string): string {
  const raw = String(content ?? '')
  const wrapped = raw.match(USER_ASSETS_BLOCK_CAPTURE_REGEX)
  if (!wrapped || !wrapped[1]) return ''
  return wrapped[1].trim()
}

function extractUserQueryText(content: string): string {
  const raw = stripUserAssetsBlock(String(content ?? ''))
  const wrapped = raw.match(USER_QUERY_BLOCK_CAPTURE_REGEX)
  if (wrapped && wrapped[1]) return wrapped[1].trim()
  return raw.trim()
}

function parseUserAssetEntries(content: string): UserAssetEntry[] {
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

function toAssetExtension(value: string): string {
  const clean = String(value ?? '').trim().split(/[?#]/, 1)[0] ?? ''
  return extname(clean).toLowerCase()
}

function inferAssetKind(entry: UserAssetEntry): 'image' | 'video' | 'other' {
  const type = String(entry.type ?? '').trim().toLowerCase()
  if (type.includes('video')) return 'video'
  if (type.includes('image')) return 'image'
  const ext = toAssetExtension(entry.path)
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (VIDEO_EXTENSIONS.has(ext)) return 'video'
  return 'other'
}

function normalizeMediaUrl(raw: string): string {
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

function dedupStrings(values: string[]): string[] {
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

function buildUserAssetsBlock(entries: UserAssetEntry[]): string {
  if (entries.length <= 0) return ''
  const lines: string[] = ['[USER_ASSETS]']
  for (const entry of entries) {
    const type = String(entry?.type ?? '').trim() || 'file'
    const path = String(entry?.path ?? '').trim()
    if (!path) continue
    lines.push(`- type: ${type}`)
    lines.push(`  path: ${path}`)
  }
  if (lines.length <= 1) return ''
  lines.push('[/USER_ASSETS]')
  return lines.join('\n')
}

function resolveDashScopeUploadPolicyUrls(baseUrl: string): string[] {
  const urls: string[] = ['https://dashscope.aliyuncs.com/api/v1/uploads']
  const pushUrl = (value: string) => {
    const text = String(value ?? '').trim()
    if (text) urls.push(text)
  }

  try {
    const parsed = new URL(baseUrl)
    const pathname = parsed.pathname.replace(/\/+$/, '')
    if (/\/compatible-mode\/v\d+$/i.test(pathname)) {
      const rewritten = new URL(parsed.toString())
      rewritten.pathname = pathname.replace(/\/compatible-mode\/v\d+$/i, '/api/v1/uploads')
      rewritten.search = ''
      rewritten.hash = ''
      pushUrl(rewritten.toString())
    }
    pushUrl(new URL('/api/v1/uploads', parsed.origin).toString())
  } catch {
    // ignore invalid baseUrl and fallback to official endpoint.
  }

  return dedupStrings(urls)
}

function maskAuthHeader(value: string): string {
  const text = String(value ?? '').trim()
  if (!text) return text
  const m = text.match(/^(Bearer\s+)(.+)$/i)
  if (!m) return text
  const prefix = m[1]
  const token = m[2]
  if (token.length <= 12) return `${prefix}***`
  return `${prefix}${token.slice(0, 6)}...${token.slice(-4)}`
}

function isLikelyLocalPath(value: string): boolean {
  if (isAbsolute(value)) return true
  return /^[a-zA-Z]:[\\/]/.test(value)
}

function isTokenPlanBaseUrl(baseUrl: string): boolean {
  const raw = String(baseUrl ?? '').trim()
  if (!raw) return false
  try {
    const u = new URL(raw)
    return /(^|\.)maas\.aliyuncs\.com$/i.test(u.hostname) && /^\/compatible-mode\/v\d+$/i.test(u.pathname.replace(/\/+$/, ''))
  } catch {
    return /token-plan\.cn-beijing\.maas\.aliyuncs\.com\/compatible-mode\/v\d+/i.test(raw)
  }
}

type ResolvedAliyunOssUploadConfig = {
  provider: 'aliyun_oss'
  accessKeyId: string
  accessKeySecret: string
  bucket: string
  endpoint: string
  objectPrefix: string
  publicBaseUrl: string
}

type ResolvedQiniuUploadConfig = {
  provider: 'qiniu'
  accessKey: string
  secretKey: string
  bucket: string
  uploadUrl: string
  objectPrefix: string
  publicBaseUrl: string
  expiresSeconds: number
}

type ResolvedUploadConfig = ResolvedAliyunOssUploadConfig | ResolvedQiniuUploadConfig

function asTrimmedText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeObjectPrefix(prefix: string): string {
  return asTrimmedText(prefix)
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
}

function ensureUrlWithScheme(value: string): string {
  const raw = asTrimmedText(value)
  if (!raw) return ''
  if (/^https?:\/\//i.test(raw)) return raw
  return `https://${raw}`
}

function normalizePublicBaseUrl(value: string): string {
  return ensureUrlWithScheme(value).replace(/\/+$/, '')
}

function buildStorageObjectKey(filePath: string, objectPrefix: string): string {
  const safePrefix = normalizeObjectPrefix(objectPrefix)
  const ext = extname(filePath).toLowerCase()
  const datePart = new Date().toISOString().slice(0, 10)
  const randomPart = randomUUID()
  const filePart = ext ? `${randomPart}${ext}` : randomPart
  return [safePrefix, datePart, filePart].filter(Boolean).join('/')
}

function encodeObjectKeyPath(key: string): string {
  return key
    .split('/')
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/')
}

function buildPublicUrl(publicBaseUrl: string, key: string): string {
  const base = normalizePublicBaseUrl(publicBaseUrl)
  const path = encodeObjectKeyPath(key)
  return `${base}/${path}`
}

function toUrlSafeBase64(value: string | Buffer): string {
  const encoded = Buffer.isBuffer(value)
    ? value.toString('base64')
    : Buffer.from(value).toString('base64')
  return encoded.replace(/\+/g, '-').replace(/\//g, '_')
}

function resolveQiniuRegionUploadUrl(rawText: string, currentUploadUrl: string): string | null {
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

function resolveUploadConfig(config: ProviderConfig): ResolvedUploadConfig | null {
  const upload = config.upload
  if (!upload || typeof upload !== 'object') return null
  if (upload.provider === 'aliyun_oss') {
    const accessKeyId = asTrimmedText(upload.accessKeyId)
    const accessKeySecret = asTrimmedText(upload.accessKeySecret)
    const bucket = asTrimmedText(upload.bucket)
    const endpoint = asTrimmedText(upload.endpoint)
    const objectPrefix = normalizeObjectPrefix(upload.objectPrefix || '')
    if (!accessKeyId || !accessKeySecret || !bucket || !endpoint) {
      throw new Error('Aliyun OSS upload config is incomplete: accessKeyId/accessKeySecret/bucket/endpoint are required')
    }
    const endpointUrl = new URL(ensureUrlWithScheme(endpoint))
    const bucketHost = endpointUrl.host.startsWith(`${bucket}.`)
      ? endpointUrl.host
      : `${bucket}.${endpointUrl.host}`
    const uploadOrigin = `${endpointUrl.protocol}//${bucketHost}`
    const publicBaseUrl = asTrimmedText(upload.publicBaseUrl)
      ? normalizePublicBaseUrl(upload.publicBaseUrl)
      : uploadOrigin
    return {
      provider: 'aliyun_oss',
      accessKeyId,
      accessKeySecret,
      bucket,
      endpoint: uploadOrigin,
      objectPrefix,
      publicBaseUrl,
    }
  }
  if (upload.provider === 'qiniu') {
    const accessKey = asTrimmedText(upload.accessKey)
    const secretKey = asTrimmedText(upload.secretKey)
    const bucket = asTrimmedText(upload.bucket)
    const uploadUrl = asTrimmedText(upload.uploadUrl) ? ensureUrlWithScheme(upload.uploadUrl) : 'https://up.qiniup.com'
    const publicBaseUrl = normalizePublicBaseUrl(asTrimmedText(upload.publicBaseUrl))
    const objectPrefix = normalizeObjectPrefix(upload.objectPrefix || '')
    const expiresSecondsRaw = Number(upload.expiresSeconds)
    const expiresSeconds = Number.isFinite(expiresSecondsRaw) && expiresSecondsRaw > 0
      ? Math.floor(expiresSecondsRaw)
      : 3600
    if (!accessKey || !secretKey || !bucket || !publicBaseUrl) {
      throw new Error('Qiniu upload config is incomplete: accessKey/secretKey/bucket/publicBaseUrl are required')
    }
    return {
      provider: 'qiniu',
      accessKey,
      secretKey,
      bucket,
      uploadUrl,
      objectPrefix,
      publicBaseUrl,
      expiresSeconds,
    }
  }
  return null
}

async function uploadLocalFileToAliyunOss(
  config: ResolvedAliyunOssUploadConfig,
  filePath: string,
  signal?: AbortSignal,
): Promise<string> {
  const bytes = await readFile(filePath)
  const fileName = basename(filePath)
  const key = buildStorageObjectKey(filePath, config.objectPrefix)
  const expiration = new Date(Date.now() + 10 * 60 * 1000).toISOString()
  const policyText = JSON.stringify({
    expiration,
    conditions: [
      ['starts-with', '$key', normalizeObjectPrefix(config.objectPrefix)],
      ['content-length-range', 0, 1024 * 1024 * 200],
    ],
  })
  const policy = Buffer.from(policyText).toString('base64')
  const signature = createHmac('sha1', config.accessKeySecret).update(policy).digest('base64')
  const formData = new FormData()
  formData.append('key', key)
  formData.append('policy', policy)
  formData.append('OSSAccessKeyId', config.accessKeyId)
  formData.append('Signature', signature)
  formData.append('success_action_status', '200')
  formData.append('file', new Blob([bytes]), fileName)
  const response = await fetch(config.endpoint, {
    method: 'POST',
    body: formData,
    signal,
  })
  if (!response.ok) {
    const rawText = await readResponseTextSafe(response)
    throw new Error(`Aliyun OSS upload failed: ${response.status} ${response.statusText} ${rawText}`)
  }
  return buildPublicUrl(config.publicBaseUrl, key)
}

async function uploadLocalFileToQiniu(
  config: ResolvedQiniuUploadConfig,
  filePath: string,
  signal?: AbortSignal,
): Promise<string> {
  const bytes = await readFile(filePath)
  const fileName = basename(filePath)
  const key = buildStorageObjectKey(filePath, config.objectPrefix)
  const deadline = Math.floor(Date.now() / 1000) + config.expiresSeconds
  const putPolicy = JSON.stringify({
    scope: `${config.bucket}:${key}`,
    deadline,
  })
  const encodedPutPolicy = toUrlSafeBase64(putPolicy)
  const signed = createHmac('sha1', config.secretKey).update(encodedPutPolicy).digest()
  const encodedSign = toUrlSafeBase64(signed)
  const uploadToken = `${config.accessKey}:${encodedSign}:${encodedPutPolicy}`
  const buildFormData = () => {
    const formData = new FormData()
    formData.append('token', uploadToken)
    formData.append('key', key)
    formData.append('file', new Blob([bytes]), fileName)
    return formData
  }
  let uploadUrl = config.uploadUrl
  let response = await fetch(uploadUrl, {
    method: 'POST',
    body: buildFormData(),
    signal,
  })
  if (!response.ok) {
    const rawText = await readResponseTextSafe(response)
    if (response.status === 400) {
      const regionUploadUrl = resolveQiniuRegionUploadUrl(rawText, uploadUrl)
      if (regionUploadUrl) {
        uploadUrl = regionUploadUrl
        response = await fetch(uploadUrl, {
          method: 'POST',
          body: buildFormData(),
          signal,
        })
      }
    }
    if (!response.ok) {
      const retryRaw = await readResponseTextSafe(response)
      throw new Error(`Qiniu upload failed: ${response.status} ${response.statusText} ${retryRaw}`)
    }
  }
  return buildPublicUrl(config.publicBaseUrl, key)
}

async function uploadLocalFileToPublicStorage(
  config: ResolvedUploadConfig,
  filePath: string,
  signal?: AbortSignal,
): Promise<string> {
  if (config.provider === 'aliyun_oss') {
    return uploadLocalFileToAliyunOss(config, filePath, signal)
  }
  return uploadLocalFileToQiniu(config, filePath, signal)
}

function toLocalPathIfFileUrl(value: string): string | null {
  const raw = String(value ?? '').trim()
  if (!/^file:\/\//i.test(raw)) return null
  try {
    return fileURLToPath(raw)
  } catch {
    return null
  }
}

async function getDashScopeUploadPolicy(
  config: ProviderConfig,
  signal?: AbortSignal,
  logScope?: string,
): Promise<DashScopeUploadPolicyData> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json',
  }
  const endpoints = resolveDashScopeUploadPolicyUrls(config.baseUrl)
  const endpointErrors: string[] = []

  for (const endpoint of endpoints) {
    const uploadUrl = new URL(endpoint)
    uploadUrl.searchParams.set('action', 'getPolicy')
    uploadUrl.searchParams.set('model', config.model)

    console.log('QWEN_UPLOAD_POLICY_REQUEST', {
      url: uploadUrl.toString(),
      headers: {
        ...headers,
        Authorization: maskAuthHeader(headers.Authorization),
      },
    }, logScope)
    const response = await fetchWith429Retry(uploadUrl.toString(), {
      method: 'GET',
      headers,
    }, signal, logScope)

    const rawText = await response.text()
    if (!response.ok) {
      endpointErrors.push(`${uploadUrl.toString()} => ${response.status} ${response.statusText} ${rawText}`)
      if (response.status === 404) continue
      throw new Error(`Failed to get upload policy: ${response.status} ${response.statusText} ${rawText}`)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(rawText)
      log('QWEN_UPLOAD_POLICY', parsed, logScope)
    } catch {
      throw new Error(`Failed to parse upload policy response: ${rawText}`)
    }
    const data = (parsed && typeof parsed === 'object')
      ? (parsed as { data?: unknown }).data
      : null
    if (!data || typeof data !== 'object') {
      throw new Error(`Upload policy missing data field: ${rawText}`)
    }
    const policy = data as Partial<DashScopeUploadPolicyData>
    if (
      !policy.upload_dir ||
      !policy.oss_access_key_id ||
      !policy.signature ||
      !policy.policy ||
      !policy.x_oss_object_acl ||
      !policy.x_oss_forbid_overwrite ||
      !policy.upload_host
    ) {
      throw new Error(`Upload policy fields are incomplete: ${rawText}`)
    }
    return {
      upload_dir: policy.upload_dir,
      oss_access_key_id: policy.oss_access_key_id,
      signature: policy.signature,
      policy: policy.policy,
      x_oss_object_acl: policy.x_oss_object_acl,
      x_oss_forbid_overwrite: policy.x_oss_forbid_overwrite,
      upload_host: policy.upload_host,
    }
  }

  throw new Error(
    `Failed to get upload policy: no reachable upload endpoint. ` +
      `The current Qwen base URL may not support media upload policy API. ` +
      `Tried: ${endpointErrors.join(' | ')}`,
  )
}

async function uploadLocalFileToDashScopeOss(
  policy: DashScopeUploadPolicyData,
  filePath: string,
  signal?: AbortSignal,
): Promise<string> {
  const fileName = basename(filePath)
  const uploadDir = String(policy.upload_dir || '').replace(/\/+$/, '')
  const key = `${uploadDir}/${fileName}`
  const bytes = await readFile(filePath)
  const formData = new FormData()
  formData.append('OSSAccessKeyId', policy.oss_access_key_id)
  formData.append('Signature', policy.signature)
  formData.append('policy', policy.policy)
  formData.append('x-oss-object-acl', policy.x_oss_object_acl)
  formData.append('x-oss-forbid-overwrite', policy.x_oss_forbid_overwrite)
  formData.append('key', key)
  formData.append('success_action_status', '200')
  formData.append('file', new Blob([bytes]), fileName)

  const response = await fetch(policy.upload_host, {
    method: 'POST',
    body: formData,
    signal,
  })
  if (!response.ok) {
    const rawText = await readResponseTextSafe(response)
    throw new Error(`Failed to upload file: ${response.status} ${response.statusText} ${rawText}`)
  }
  return `oss://${key}`
}

async function resolveQwenMediaUrl(
  raw: string,
  config: ProviderConfig,
  state: QwenMessageBuildState,
  signal?: AbortSignal,
  logScope?: string,
): Promise<string> {
  const value = String(raw ?? '').trim()
  if (!value) return ''
  if (/^oss:\/\//i.test(value)) {
    state.requiresOssResolveHeader = true
    return value
  }
  if (/^(?:https?:\/\/|data:)/i.test(value)) return value

  const localPathFromFileUrl = toLocalPathIfFileUrl(value)
  const localPath = localPathFromFileUrl || (isLikelyLocalPath(value) ? value : '')
  if (!localPath) return normalizeMediaUrl(value)
  const uploadConfig = resolveUploadConfig(config)
  if (uploadConfig) {
    const cacheKey = `${uploadConfig.provider}:${localPath}`
    const cached = state.uploadedUrlByPath.get(cacheKey)
    if (cached) return cached
    const publicUrl = await uploadLocalFileToPublicStorage(uploadConfig, localPath, signal)
    state.uploadedUrlByPath.set(cacheKey, publicUrl)
    log('QWEN_MEDIA_UPLOADED_PUBLIC', {
      provider: uploadConfig.provider,
      filePath: localPath,
      publicUrl,
    }, logScope)
    return publicUrl
  }
  if (isTokenPlanBaseUrl(config.baseUrl)) {
    throw new Error(
      `Current Qwen endpoint does not support local-file upload policy with this API key. ` +
      `Please use a public https:// media URL instead of local path: ${localPath}`,
    )
  }

  const cacheKey = localPath
  const cached = state.uploadedUrlByPath.get(cacheKey)
  if (cached) {
    state.requiresOssResolveHeader = true
    return cached
  }
  if (!state.uploadPolicyPromise) {
    state.uploadPolicyPromise = getDashScopeUploadPolicy(config, signal, logScope)
  }
  const policy = await state.uploadPolicyPromise
  const ossUrl = await uploadLocalFileToDashScopeOss(policy, localPath, signal)
  state.uploadedUrlByPath.set(cacheKey, ossUrl)
  state.requiresOssResolveHeader = true
  log('QWEN_MEDIA_UPLOADED', {
    filePath: localPath,
    ossUrl,
  }, logScope)
  return ossUrl
}

async function buildQwenUserContent(
  message: ChatMessage,
  config: ProviderConfig,
  state: QwenMessageBuildState,
  signal?: AbortSignal,
  logScope?: string,
): Promise<string | QwenContentPart[]> {
  const rawContent = String(message.content ?? '')
  const entries = parseUserAssetEntries(rawContent)
  const imageUrls: string[] = []
  for (const item of message.images ?? []) {
    const resolved = await resolveQwenMediaUrl(item, config, state, signal, logScope)
    if (resolved) imageUrls.push(resolved)
  }
  const entryImageUrls: string[] = []
  const entryVideoUrls: string[] = []
  const nonMediaEntries: UserAssetEntry[] = []

  for (const entry of entries) {
    const normalizedPath = await resolveQwenMediaUrl(entry.path, config, state, signal, logScope)
    if (!normalizedPath) continue
    const kind = inferAssetKind(entry)
    if (kind === 'image') {
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

  const parts: QwenContentPart[] = []
  for (const url of dedupStrings([...imageUrls, ...entryImageUrls])) {
    parts.push({ type: 'image_url', image_url: { url } })
  }

  const videoUrls = dedupStrings(entryVideoUrls)
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

  if (parts.length <= 0) return rawContent
  return parts
}

async function buildProviderMessages(
  provider: ProviderKey,
  config: ProviderConfig,
  messages: ChatMessage[],
  signal?: AbortSignal,
  logScope?: string,
): Promise<{ messages: unknown[]; requiresOssResolveHeader: boolean }> {
  if (provider !== 'qwen') {
    return { messages, requiresOssResolveHeader: false }
  }
  const state: QwenMessageBuildState = {
    requiresOssResolveHeader: false,
    uploadedUrlByPath: new Map<string, string>(),
  }
  const out: unknown[] = []
  for (const message of messages) {
    const { images: _unusedImages, ...rest } = message
    if (message.role !== 'user') {
      out.push(rest)
      continue
    }
    out.push({
      ...rest,
      content: await buildQwenUserContent(message, config, state, signal, logScope),
    })
  }
  return {
    messages: out,
    requiresOssResolveHeader: state.requiresOssResolveHeader,
  }
}

function fullHeadersForLog(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headers) return out
  const h = new Headers(headers)
  for (const [k, v] of h.entries()) {
    out[k] = v
  }
  return out
}

function parseJsonBodyForLog(body: BodyInit | null | undefined): unknown {
  if (typeof body !== 'string') return body ?? null
  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}

async function buildRequest(
  provider: ProviderKey,
  config: ProviderConfig,
  messages: ChatMessage[],
  stream: boolean,
  options?: RequestOptions,
  signal?: AbortSignal,
  logScope?: string,
) {
  const normalizedMessages = normalizeMessages(messages)
  const providerPrepared = await buildProviderMessages(provider, config, normalizedMessages, signal, logScope)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`,
  }
  if (config.headers) {
    for (const [k, v] of Object.entries(config.headers)) {
      if (typeof v === 'string') headers[k] = v
    }
  }
  if (provider === 'qwen' || providerPrepared.requiresOssResolveHeader) {
    headers['X-DashScope-OssResourceResolve'] = 'enable'
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body: Record<string, any> = {
    model: config.model,
    messages: providerPrepared.messages,
    temperature: resolveRequestTemperature(config),
    stream,
  }
  if (options?.tools && options.tools.length > 0) {
    body.tools = options.tools
    body.tool_choice = 'auto'
  }
  if (stream) {
    // 请求 provider 在流式响应中返回 usage（尤其 total_tokens）
    body.stream_options = { include_usage: true }
  }

  console.log('REQUEST_BUILD', {
    url: `${config.baseUrl}/chat/completions`,
    method: 'POST',
    headers: fullHeadersForLog(headers),
  }, logScope)

  return {
    url: `${config.baseUrl}/chat/completions`,
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    } satisfies RequestInit
  }
}

function shouldRetryWithoutStreamOptions(status: number, text: string): boolean {
  if (status !== 400) return false
  const lower = String(text).toLowerCase()
  return (
    lower.includes('stream_options') ||
    lower.includes('include_usage') ||
    lower.includes('unknown field') ||
    lower.includes('unknown parameter') ||
    lower.includes('invalid param')
  )
}

async function retryStreamRequestWithoutUsageOption(
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  logScope: string | undefined,
): Promise<Response | null> {
  if (typeof init.body !== 'string') return null
  try {
    const parsed = JSON.parse(init.body) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || !('stream_options' in parsed)) return null
    delete parsed.stream_options
    const retryInit: RequestInit = {
      ...init,
      body: JSON.stringify(parsed),
    }
    log('REQUEST_RETRY', {
      url,
      method: retryInit.method,
      reason: 'stream_options.include_usage not accepted, retry without stream_options',
      headers: fullHeadersForLog(retryInit.headers),
      body: parseJsonBodyForLog(retryInit.body),
    }, logScope)
    return await fetchWith429Retry(url, retryInit, signal, logScope)
  } catch {
    return null
  }
}

/** Non-streaming chat completion (returns full response) */
export async function requestChatCompletion(
  provider: ProviderKey,
  messages: ChatMessage[],
  overrides?: ProviderOverrides,
  signal?: AbortSignal,
  logScope?: string,
) {
  const config = getProviderConfig(provider, overrides)
  if (!config.apiKey || !config.model) {
    throw new Error(`Missing API key or model for ${provider}`)
  }

  const { url, init } = await buildRequest(provider, config, messages, false, undefined, signal, logScope)
  const startTime = Date.now()

  // ── 记录完整请求 ──
  log('REQUEST', {
    url,
    method: init.method,
    headers: fullHeadersForLog(init.headers),
    body: parseJsonBodyForLog(init.body),
  }, logScope)

  let response: Response
  try {
    response = await fetchWith429Retry(url, init, signal, logScope)
  } catch (err) {
    log('ERROR', { url, error: String(err), durationMs: Date.now() - startTime }, logScope)
    throw err
  }

  const finalRawText = await response.text()

  // ── 记录完整响应 ──
  log('RESPONSE', {
    url,
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
    durationMs: Date.now() - startTime,
    body: finalRawText,
  }, logScope)

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText} ${finalRawText}`)
  }

  const data = JSON.parse(finalRawText)
  const content = data?.choices?.[0]?.message?.content
  if (!content) {
    throw new Error('Empty response from provider')
  }
  return content as string
}

/** Streaming chat completion (yields content chunks via async generator) */
export async function* requestChatCompletionStream(
  provider: ProviderKey,
  messages: ChatMessage[],
  overrides?: ProviderOverrides,
  signal?: AbortSignal,
  logScope?: string,
  onUsage?: (usage: TokenUsage) => void,
): AsyncGenerator<string> {
  const config = getProviderConfig(provider, overrides)
  if (!config.apiKey || !config.model) {
    throw new Error(`Missing API key or model for ${provider}`)
  }

  const { url, init } = await buildRequest(provider, config, messages, true, undefined, signal, logScope)
  const startTime = Date.now()

  // ── 记录完整请求 ──
  log('REQUEST', {
    url,
    method: init.method,
    headers: fullHeadersForLog(init.headers),
    body: parseJsonBodyForLog(init.body),
  }, logScope)

  let response: Response
  try {
    response = await fetchWith429Retry(url, init, signal, logScope)
  } catch (err) {
    log('ERROR', { url, error: String(err), durationMs: Date.now() - startTime }, logScope)
    throw err
  }

  if (!response.ok) {
    let text = await response.text()
    if (shouldRetryWithoutStreamOptions(response.status, text)) {
      const retryResponse = await retryStreamRequestWithoutUsageOption(url, init, signal, logScope)
      if (retryResponse) {
        response = retryResponse
        if (!response.ok) text = await response.text()
      }
    }
    if (!response.ok) {
      log('RESPONSE', {
        url,
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        durationMs: Date.now() - startTime,
        body: text,
      }, logScope)
      throw new Error(`Request failed: ${response.status} ${response.statusText} ${text}`)
    }
  }

  if (!response.body) {
    throw new Error('Response body is empty (streaming not supported?)')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let accumulated = ''
  // 保留首个 chunk 的结构信息和最后一个 chunk 的 usage 等字段
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let firstChunk: any = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let lastChunk: any = null
  let mergedUsageRaw: unknown = null

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop()!

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (data === '[DONE]') {
          // ── 流结束，用原始响应结构 + 合并内容记录日志 ──
          logMergedStreamResponse({
            url,
            response,
            durationMs: Date.now() - startTime,
            firstChunk,
            lastChunk,
            content: accumulated,
            usage: mergedUsageRaw,
            logScope,
          })
          return
        }
        try {
          const parsed = JSON.parse(data)
          if (!firstChunk) firstChunk = parsed
          lastChunk = parsed
          if (Object.prototype.hasOwnProperty.call(parsed, 'usage')) {
            mergedUsageRaw = parsed.usage
          }
          const usage = parseTokenUsage(parsed)
          if (usage) onUsage?.(usage)
          const content = parsed.choices?.[0]?.delta?.content
          if (content) {
            accumulated += content
            yield content
          }
        } catch {
          // skip non-JSON lines
        }
      }
    }

    // 正常读完（没收到 [DONE]）
    logMergedStreamResponse({
      url,
      response,
      durationMs: Date.now() - startTime,
      firstChunk,
      lastChunk,
      content: accumulated,
      usage: mergedUsageRaw,
      logScope,
    })
  } catch (err) {
    log('RESPONSE_ERROR', {
      url,
      status: response.status,
      durationMs: Date.now() - startTime,
      body: buildMergedResponse(firstChunk, lastChunk, accumulated, mergedUsageRaw),
      error: String(err),
    }, logScope)
    throw err
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseTokenUsage(chunk: any): TokenUsage | null {
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

/**
 * 将流式 chunk 合并为类似非流式的完整响应结构再记录日志。
 * 保留 id、object、model、created、usage 等原始字段，
 * choices[0] 由 delta 合并为完整的 message。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildMergedResponse(
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

function logMergedStreamResponse(params: {
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
  log('RESPONSE', {
    url,
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
    durationMs,
    body: buildMergedResponse(firstChunk, lastChunk, content, usage, toolCalls, reasoningContent),
  }, logScope)
}

/* ------------------------------------------------------------------ */
/*  Agent-aware streaming: yields StreamEvent (text + tool_calls)      */
/* ------------------------------------------------------------------ */

/**
 * 流式请求，支持 tool calling。
 * yield StreamEvent：
 *   - { type: 'text', content } — 文本片段
 *   - { type: 'tool_calls', toolCalls } — 一轮完整的工具调用列表
 */
export async function* requestStreamWithTools(
  provider: ProviderKey,
  messages: ChatMessage[],
  overrides?: ProviderOverrides,
  options?: RequestOptions,
  signal?: AbortSignal,
  logScope?: string,
): AsyncGenerator<StreamEvent> {
  const config = getProviderConfig(provider, overrides)
  if (!config.apiKey || !config.model) {
    throw new Error(`Missing API key or model for ${provider}`)
  }

  const { url, init } = await buildRequest(provider, config, messages, true, options, signal, logScope)
  const startTime = Date.now()

  log('REQUEST', {
    url,
    method: init.method,
    headers: fullHeadersForLog(init.headers),
    body: parseJsonBodyForLog(init.body),
  }, logScope)

  let response: Response
  try {
    response = await fetchWith429Retry(url, init, signal, logScope)
  } catch (err) {
    log('ERROR', { url, error: String(err), durationMs: Date.now() - startTime }, logScope)
    throw err
  }

  if (!response.ok) {
    let text = await response.text()
    if (shouldRetryWithoutStreamOptions(response.status, text)) {
      const retryResponse = await retryStreamRequestWithoutUsageOption(url, init, signal, logScope)
      if (retryResponse) {
        response = retryResponse
        if (!response.ok) text = await response.text()
      }
    }
    if (!response.ok) {
      log('RESPONSE', { url, status: response.status, durationMs: Date.now() - startTime, body: text }, logScope)
      throw new Error(`Request failed: ${response.status} ${response.statusText} ${text}`)
    }
  }

  if (!response.body) {
    throw new Error('Response body is empty')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let accumulated = ''
  let accumulatedReasoning = ''
  let lastTextChunk = ''
  let repeatedTextChunkCount = 0
  const allowedToolNames = buildAllowedToolNameSet(options)
  // 累积 tool_calls（流式 delta 中分片到达）
  const toolCallsMap = new Map<number, { id: string; type: 'function'; function: { name: string; arguments: string } }>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let firstChunk: any = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let lastChunk: any = null
  let mergedUsageRaw: unknown = null

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop()!

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (data === '[DONE]') {
          // 如果有累积的 tool_calls，yield 出去
          let mergedToolCalls: ToolCall[] | undefined
          if (toolCallsMap.size > 0) {
            const resolved = resolveToolCallsFromMap(toolCallsMap, allowedToolNames)
            if (resolved.invalidNames.length > 0) {
              log('STREAM_INVALID_TOOL_CALLS', { names: resolved.invalidNames }, logScope)
              yield { type: 'invalid_tool_calls', names: resolved.invalidNames }
            }
            if (resolved.toolCalls.length > 0) {
              mergedToolCalls = resolved.toolCalls
              yield { type: 'tool_calls', toolCalls: resolved.toolCalls }
            }
          }
          logMergedStreamResponse({
            url,
            response,
            durationMs: Date.now() - startTime,
            firstChunk,
            lastChunk,
            content: accumulated,
            usage: mergedUsageRaw,
            toolCalls: mergedToolCalls,
            reasoningContent: accumulatedReasoning,
            logScope,
          })
          return
        }
        try {
          const parsed = JSON.parse(data)
          if (!firstChunk) firstChunk = parsed
          lastChunk = parsed
          if (Object.prototype.hasOwnProperty.call(parsed, 'usage')) {
            mergedUsageRaw = parsed.usage
          }
          const usage = parseTokenUsage(parsed)
          if (usage) yield { type: 'usage', usage }

          const delta = parsed.choices?.[0]?.delta

          const reasoning = extractReasoningDelta(delta)
          if (reasoning) {
            accumulatedReasoning += reasoning
            yield { type: 'reasoning', content: reasoning }
          }

          // 文本内容
          const textDelta = extractTextDelta(delta)
          if (textDelta) {
            const content = textDelta
            if (content === lastTextChunk && content.trim().length > 0) {
              repeatedTextChunkCount++
              // 某些 provider 在异常情况下会持续重复发送同一文本块，触发保护提前结束本轮流式
              if (repeatedTextChunkCount >= 40) {
                log('STREAM_REPEAT_GUARD_TRIGGERED', {
                  provider,
                  repeatedTextChunkCount,
                  sample: content.slice(0, 120),
                }, logScope)
                if (toolCallsMap.size > 0) {
                  const resolved = resolveToolCallsFromMap(toolCallsMap, allowedToolNames)
                  if (resolved.invalidNames.length > 0) {
                    log('STREAM_INVALID_TOOL_CALLS', { names: resolved.invalidNames }, logScope)
                    yield { type: 'invalid_tool_calls', names: resolved.invalidNames }
                  }
                  if (resolved.toolCalls.length > 0) {
                    yield { type: 'tool_calls', toolCalls: resolved.toolCalls }
                  }
                }
                logMergedStreamResponse({
                  url,
                  response,
                  durationMs: Date.now() - startTime,
                  firstChunk,
                  lastChunk,
                  content: accumulated,
                  usage: mergedUsageRaw,
                  toolCalls: resolveToolCallsFromMap(toolCallsMap, allowedToolNames).toolCalls,
                  reasoningContent: accumulatedReasoning,
                  logScope,
                })
                return
              }
            } else {
              lastTextChunk = content
              repeatedTextChunkCount = 0
            }
            accumulated += content
            yield { type: 'text', content }
          }

          // tool_calls delta（流式分片累积）
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0
              const existing = toolCallsMap.get(idx)
              if (!existing) {
                toolCallsMap.set(idx, {
                  id: tc.id ?? '',
                  type: 'function',
                  function: {
                    name: tc.function?.name ?? '',
                    arguments: tc.function?.arguments ?? '',
                  },
                })
              } else {
                if (tc.id) existing.id = tc.id
                if (tc.function?.name) existing.function.name += tc.function.name
                if (tc.function?.arguments) existing.function.arguments += tc.function.arguments
              }
            }
          }
        } catch {
          // skip non-JSON
        }
      }
    }

    // 如果有累积的 tool_calls
    let mergedToolCalls: ToolCall[] | undefined
    if (toolCallsMap.size > 0) {
      const resolved = resolveToolCallsFromMap(toolCallsMap, allowedToolNames)
      if (resolved.invalidNames.length > 0) {
        log('STREAM_INVALID_TOOL_CALLS', { names: resolved.invalidNames }, logScope)
        yield { type: 'invalid_tool_calls', names: resolved.invalidNames }
      }
      if (resolved.toolCalls.length > 0) {
        mergedToolCalls = resolved.toolCalls
        yield { type: 'tool_calls', toolCalls: resolved.toolCalls }
      }
    }
    logMergedStreamResponse({
      url,
      response,
      durationMs: Date.now() - startTime,
      firstChunk,
      lastChunk,
      content: accumulated,
      usage: mergedUsageRaw,
      toolCalls: mergedToolCalls,
      reasoningContent: accumulatedReasoning,
      logScope,
    })
  } catch (err) {
    log('RESPONSE_ERROR', {
      url,
      status: response.status,
      durationMs: Date.now() - startTime,
      body: buildMergedResponse(
        firstChunk,
        lastChunk,
        accumulated,
        mergedUsageRaw,
        resolveToolCallsFromMap(toolCallsMap, allowedToolNames).toolCalls,
        accumulatedReasoning,
      ),
      error: String(err),
    }, logScope)
    throw err
  }
}
