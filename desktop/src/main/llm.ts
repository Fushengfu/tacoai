import type { IncomingHttpHeaders } from 'node:http'
import { log } from './logger'
import type { ToolDefinition, ToolCall } from './tools'

/** 标准聊天消息 */
export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** assistant 消息可能包含 tool_calls */
  tool_calls?: ToolCall[]
  /** tool 消息需要关联的 tool_call_id */
  tool_call_id?: string
}

/** 流式事件：文本片段 or 工具调用 */
export type StreamEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_calls'; toolCalls: ToolCall[] }
  | { type: 'invalid_tool_calls'; names: string[] }
  | { type: 'usage'; usage: TokenUsage }

export type TokenUsage = {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  cachedTokens?: number
}

export type ProviderKey = 'deepseek' | 'kimi' | 'minimax' | 'glm'

export type ProviderConfig = {
  baseUrl: string
  apiKey: string
  model: string
  headers?: IncomingHttpHeaders
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
  }
}

/**
 * 固定模型温度（不走设置页配置）：
 * 值越低输出越稳定、越可复现。
 */
const FIXED_MODEL_TEMPERATURE = 0.05

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

function buildRequest(config: ProviderConfig, messages: ChatMessage[], stream: boolean, options?: RequestOptions) {
  const normalizedMessages = normalizeMessages(messages)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`,
  }
  if (config.headers) {
    for (const [k, v] of Object.entries(config.headers)) {
      if (typeof v === 'string') headers[k] = v
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body: Record<string, any> = {
    model: config.model,
    messages: normalizedMessages,
    temperature: FIXED_MODEL_TEMPERATURE,
    stream,
  }
  if (options?.tools && options.tools.length > 0) {
    body.tools = options.tools
    body.tool_choice = options.toolChoice ?? 'auto'
  }
  if (stream) {
    // 请求 provider 在流式响应中返回 usage（尤其 total_tokens）
    body.stream_options = { include_usage: true }
  }

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
    return await fetch(url, { ...retryInit, signal })
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

  const { url, init } = buildRequest(config, messages, false)
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
    response = await fetch(url, { ...init, signal })
  } catch (err) {
    log('ERROR', { url, error: String(err), durationMs: Date.now() - startTime }, logScope)
    throw err
  }

  const rawText = await response.text()

  // ── 记录完整响应 ──
  log('RESPONSE', {
    url,
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
    durationMs: Date.now() - startTime,
    body: rawText,
  }, logScope)

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText} ${rawText}`)
  }

  const data = JSON.parse(rawText)
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

  const { url, init } = buildRequest(config, messages, true)
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
    response = await fetch(url, { ...init, signal })
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
) {
  const usage = usageOverride !== undefined ? usageOverride : (lastChunk?.usage ?? null)
  const message: { role: 'assistant'; content: string; tool_calls?: ToolCall[] } = {
    role: 'assistant',
    content,
  }
  if (toolCalls && toolCalls.length > 0) {
    message.tool_calls = toolCalls
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
  logScope?: string
}) {
  const { url, response, durationMs, firstChunk, lastChunk, content, usage, toolCalls, logScope } = params
  log('RESPONSE', {
    url,
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
    durationMs,
    body: buildMergedResponse(firstChunk, lastChunk, content, usage, toolCalls),
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

  const { url, init } = buildRequest(config, messages, true, options)
  const startTime = Date.now()

  log('REQUEST', {
    url,
    method: init.method,
    headers: fullHeadersForLog(init.headers),
    body: parseJsonBodyForLog(init.body),
  }, logScope)

  let response: Response
  try {
    response = await fetch(url, { ...init, signal })
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

          // 文本内容
          if (delta?.content) {
            const content = String(delta.content)
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
      ),
      error: String(err),
    }, logScope)
    throw err
  }
}
