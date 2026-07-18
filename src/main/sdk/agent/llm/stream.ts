/**
 * LLM 客户端 - 流式请求处理
 * 
 * 包含 requestChatCompletionStream（纯文本流）和
 * requestStreamWithTools（带 tool calling 的代理流）。
 */

import type { ToolCall } from '../tools'
import type { ChatMessage, ProviderConfig, ProviderKey, ProviderOverrides, RequestOptions, StreamEvent, TokenUsage } from './types'
import { isBuiltinProvider, getProviderConfig, llmLog } from './providers'
import {
  fetchWith429Retry,
  fullHeadersForLog,
  parseJsonBodyForLog,
  buildAllowedToolNameSet,
  extractReasoningDelta,
  extractTextDelta,
  resolveToolCallsFromMap,
  parseTokenUsage,
  buildMergedResponse,
  logMergedStreamResponse,
} from './utils'

/* ------------------------------------------------------------------ */
/*  流选项兼容性重试                                                      */
/* ------------------------------------------------------------------ */

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
    llmLog('REQUEST_RETRY', {
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

/* ------------------------------------------------------------------ */
/*  Streaming chat completion（纯文本流）                                 */
/* ------------------------------------------------------------------ */

/** Streaming chat completion (yields content chunks via async generator) */
export async function* requestChatCompletionStream(
  provider: ProviderKey,
  messages: ChatMessage[],
  overrides?: ProviderOverrides,
  signal?: AbortSignal,
  logScope?: string,
  onUsage?: (usage: TokenUsage) => void,
  userId?: string,
): AsyncGenerator<string> {
  const config = getProviderConfig(provider, overrides)
  if (!config.apiKey || !config.model) {
    throw new Error(`Missing API key or model for ${provider}`)
  }

  const isAnthropic = provider === 'anthropic' || (!isBuiltinProvider(provider) && config.baseUrl.includes('anthropic'))

  const { buildRequest } = await import('./client')
  const { url, init } = await buildRequest(provider, config, messages, true, undefined, signal, logScope, userId)
  const startTime = Date.now()

  llmLog('REQUEST', {
    url,
    method: init.method,
    headers: fullHeadersForLog(init.headers),
    body: parseJsonBodyForLog(init.body),
  }, logScope)

  let response: Response
  try {
    response = await fetchWith429Retry(url, init, signal, logScope)
  } catch (err) {
    llmLog('ERROR', { url, error: String(err), durationMs: Date.now() - startTime }, logScope)
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
      llmLog('RESPONSE', {
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

          // ── Anthropic SSE 格式 ──
          if (isAnthropic) {
            if (parsed.type === 'message_start' && parsed.message?.usage) {
              mergedUsageRaw = parsed.message.usage
              const antUsage: TokenUsage = { promptTokens: parsed.message.usage.input_tokens }
              if (antUsage.promptTokens) onUsage?.(antUsage)
            }
            if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta' && parsed.delta?.text) {
              accumulated += parsed.delta.text
              yield parsed.delta.text
            }
            if (parsed.type === 'message_delta' && parsed.usage) {
              mergedUsageRaw = parsed.usage
              const antUsage: TokenUsage = { completionTokens: parsed.usage.output_tokens }
              if (antUsage.completionTokens) onUsage?.(antUsage)
            }
            if (parsed.type === 'message_stop') {
              logMergedStreamResponse({ url, response, durationMs: Date.now() - startTime, firstChunk, lastChunk, content: accumulated, usage: mergedUsageRaw, logScope })
              return
            }
            continue
          }

          // ── OpenAI SSE 格式 ──
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
    llmLog('RESPONSE_ERROR', {
      url,
      status: response.status,
      durationMs: Date.now() - startTime,
      body: buildMergedResponse(firstChunk, lastChunk, accumulated, mergedUsageRaw),
      error: String(err),
    }, logScope)
    throw err
  }
}

/* ------------------------------------------------------------------ */
/*  Agent-aware streaming（含 tool calling）                             */
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
  userId?: string,
): AsyncGenerator<StreamEvent> {
  const config = getProviderConfig(provider, overrides)
  if (!config.apiKey || !config.model) {
    throw new Error(`Missing API key or model for ${provider}`)
  }

  const { buildRequest } = await import('./client')
  const { url, init } = await buildRequest(provider, config, messages, true, options, signal, logScope, userId)
  const startTime = Date.now()

  llmLog('REQUEST', {
    url,
    method: init.method,
    headers: fullHeadersForLog(init.headers),
    body: parseJsonBodyForLog(init.body),
  }, logScope)

  let response: Response
  try {
    response = await fetchWith429Retry(url, init, signal, logScope)
  } catch (err) {
    llmLog('ERROR', { url, error: String(err), durationMs: Date.now() - startTime }, logScope)
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
      llmLog('RESPONSE', { url, status: response.status, durationMs: Date.now() - startTime, body: text }, logScope)
      throw new Error(`Request failed: ${response.status} ${response.statusText} ${text}`)
    }
  }

  if (!response.body) {
    throw new Error('Response body is empty')
  }

  const reader = response.body.getReader()

  // Anthropic 协议使用独立流式解析器
  if (provider === 'anthropic' || (!isBuiltinProvider(provider) && config.baseUrl.includes('anthropic'))) {
    const { parseAnthropicStream } = await import('./anthropic-adapter')
    const allowedToolNames = buildAllowedToolNameSet(options)
    try {
      for await (const event of parseAnthropicStream(reader, allowedToolNames)) {
        yield event
      }
    } catch (err) {
      llmLog('RESPONSE_ERROR', {
        url,
        status: response.status,
        durationMs: Date.now() - startTime,
        error: String(err),
      }, logScope)
      throw err
    }
    return
  }

  const decoder = new TextDecoder()
  let buffer = ''
  let accumulated = ''
  let accumulatedReasoning = ''
  let lastTextChunk = ''
  let repeatedTextChunkCount = 0
  const allowedToolNames = buildAllowedToolNameSet(options)
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
          let mergedToolCalls: ToolCall[] | undefined
          if (toolCallsMap.size > 0) {
            const resolved = resolveToolCallsFromMap(toolCallsMap, allowedToolNames)
            if (resolved.invalidNames.length > 0) {
              llmLog('STREAM_INVALID_TOOL_CALLS', { names: resolved.invalidNames }, logScope)
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

          const textDelta = extractTextDelta(delta)
          if (textDelta) {
            const content = textDelta
            if (content === lastTextChunk && content.trim().length > 0) {
              repeatedTextChunkCount++
              if (repeatedTextChunkCount >= 40) {
                llmLog('STREAM_REPEAT_GUARD_TRIGGERED', {
                  provider,
                  repeatedTextChunkCount,
                  sample: content.slice(0, 120),
                }, logScope)
                if (toolCallsMap.size > 0) {
                  const resolved = resolveToolCallsFromMap(toolCallsMap, allowedToolNames)
                  if (resolved.invalidNames.length > 0) {
                    llmLog('STREAM_INVALID_TOOL_CALLS', { names: resolved.invalidNames }, logScope)
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

    let mergedToolCalls: ToolCall[] | undefined
    if (toolCallsMap.size > 0) {
      const resolved = resolveToolCallsFromMap(toolCallsMap, allowedToolNames)
      if (resolved.invalidNames.length > 0) {
        llmLog('STREAM_INVALID_TOOL_CALLS', { names: resolved.invalidNames }, logScope)
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
    llmLog('RESPONSE_ERROR', {
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
