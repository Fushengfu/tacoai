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
    model: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat'
  },
  kimi: {
    baseUrl: process.env.KIMI_BASE_URL ?? 'https://api.moonshot.cn/v1',
    apiKey: process.env.KIMI_API_KEY ?? '',
    model: process.env.KIMI_MODEL ?? 'kimi-k2.5'
  },
  minimax: {
    baseUrl: process.env.MINIMAX_BASE_URL ?? 'https://api.minimaxi.com/v1',
    apiKey: process.env.MINIMAX_API_KEY ?? '',
    model: process.env.MINIMAX_MODEL ?? 'MiniMax-M2.1'
  },
  glm: {
    baseUrl: process.env.GLM_BASE_URL ?? 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: process.env.GLM_API_KEY ?? '',
    model: process.env.GLM_MODEL ?? 'glm-4.7'
  }
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
}

function buildRequest(config: ProviderConfig, messages: ChatMessage[], stream: boolean, options?: RequestOptions) {
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
    messages,
    temperature: 0.1,
    stream,
  }
  if (options?.tools && options.tools.length > 0) {
    body.tools = options.tools
    body.tool_choice = 'auto'
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
  log('REQUEST', { url, method: init.method, headers: init.headers, body: init.body }, logScope)

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
): AsyncGenerator<string> {
  const config = getProviderConfig(provider, overrides)
  if (!config.apiKey || !config.model) {
    throw new Error(`Missing API key or model for ${provider}`)
  }

  const { url, init } = buildRequest(config, messages, true)
  const startTime = Date.now()

  // ── 记录完整请求 ──
  log('REQUEST', { url, method: init.method, headers: init.headers, body: init.body }, logScope)

  let response: Response
  try {
    response = await fetch(url, { ...init, signal })
  } catch (err) {
    log('ERROR', { url, error: String(err), durationMs: Date.now() - startTime }, logScope)
    throw err
  }

  if (!response.ok) {
    const text = await response.text()
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
          logMergedStreamResponse(url, response.status, Date.now() - startTime, firstChunk, lastChunk, accumulated, logScope)
          return
        }
        try {
          const parsed = JSON.parse(data)
          if (!firstChunk) firstChunk = parsed
          lastChunk = parsed
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
    logMergedStreamResponse(url, response.status, Date.now() - startTime, firstChunk, lastChunk, accumulated, logScope)
  } catch (err) {
    log('RESPONSE_ERROR', {
      url,
      status: response.status,
      durationMs: Date.now() - startTime,
      body: buildMergedResponse(firstChunk, lastChunk, accumulated),
      error: String(err),
    }, logScope)
    throw err
  }
}

/**
 * 将流式 chunk 合并为类似非流式的完整响应结构再记录日志。
 * 保留 id、object、model、created、usage 等原始字段，
 * choices[0] 由 delta 合并为完整的 message。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildMergedResponse(firstChunk: any, lastChunk: any, content: string) {
  if (!firstChunk) return { content }
  return {
    id: firstChunk.id,
    object: 'chat.completion',
    model: firstChunk.model,
    created: firstChunk.created,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: lastChunk?.choices?.[0]?.finish_reason ?? 'stop',
      }
    ],
    usage: lastChunk?.usage ?? null,
  }
}

function logMergedStreamResponse(
  url: string,
  status: number,
  durationMs: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  firstChunk: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lastChunk: any,
  content: string,
  logScope?: string,
) {
  log('RESPONSE', {
    url,
    status,
    durationMs,
    body: buildMergedResponse(firstChunk, lastChunk, content),
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

  log('REQUEST', { url, method: init.method, headers: init.headers, body: init.body }, logScope)

  let response: Response
  try {
    response = await fetch(url, { ...init, signal })
  } catch (err) {
    log('ERROR', { url, error: String(err), durationMs: Date.now() - startTime }, logScope)
    throw err
  }

  if (!response.ok) {
    const text = await response.text()
    log('RESPONSE', { url, status: response.status, durationMs: Date.now() - startTime, body: text }, logScope)
    throw new Error(`Request failed: ${response.status} ${response.statusText} ${text}`)
  }

  if (!response.body) {
    throw new Error('Response body is empty')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let accumulated = ''
  // 累积 tool_calls（流式 delta 中分片到达）
  const toolCallsMap = new Map<number, { id: string; type: 'function'; function: { name: string; arguments: string } }>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let firstChunk: any = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let lastChunk: any = null

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
          if (toolCallsMap.size > 0) {
            const toolCalls = Array.from(toolCallsMap.values())
            yield { type: 'tool_calls', toolCalls }
          }
          logMergedStreamResponse(url, response.status, Date.now() - startTime, firstChunk, lastChunk, accumulated, logScope)
          return
        }
        try {
          const parsed = JSON.parse(data)
          if (!firstChunk) firstChunk = parsed
          lastChunk = parsed

          const delta = parsed.choices?.[0]?.delta

          // 文本内容
          if (delta?.content) {
            accumulated += delta.content
            yield { type: 'text', content: delta.content }
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
    if (toolCallsMap.size > 0) {
      const toolCalls = Array.from(toolCallsMap.values())
      yield { type: 'tool_calls', toolCalls }
    }
    logMergedStreamResponse(url, response.status, Date.now() - startTime, firstChunk, lastChunk, accumulated, logScope)
  } catch (err) {
    log('RESPONSE_ERROR', { url, status: response.status, durationMs: Date.now() - startTime, error: String(err) }, logScope)
    throw err
  }
}
