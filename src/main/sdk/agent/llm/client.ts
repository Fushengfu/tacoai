/**
 * LLM 客户端 - 主编排器
 * 
 * 统一入口，包含 buildRequest（请求构建）和 requestChatCompletion（非流式调用），
 * 并重导出所有子模块的公开 API，确保外部 20+ 个导入方零破坏。
 */

import type { ToolDefinition } from '../tools'
import type { ChatMessage, ProviderConfig, ProviderKey, RequestOptions } from './types'
import { isBuiltinProvider, getProviderConfig, llmLog } from './providers'
import {
  resolveRequestTemperature,
  normalizeMessages,
  fullHeadersForLog,
  parseJsonBodyForLog,
  fetchWith429Retry,
} from './utils'

/* ------------------------------------------------------------------ */
/*  重导出所有公开 API（零破坏）                                          */
/* ------------------------------------------------------------------ */

// 类型
export type {
  ChatMessage,
  StreamEvent,
  TokenUsage,
  BuiltinProviderKey,
  ProviderKey,
  ProviderConfig,
  ProviderOverrides,
  RequestOptions,
} from './types'

// Provider 管理
export { setLLMLogger, isBuiltinProvider, getProviderConfig } from './providers'

// 流式请求
export { requestChatCompletionStream, requestStreamWithTools } from './stream'

// 存储上传
export { resolveUploadConfig, uploadDataUrlViaGateway, uploadDataUrlToStorage } from './storage'
export type { ResolvedUploadConfig, ResolvedAliyunOssUploadConfig, ResolvedQiniuUploadConfig } from './storage'

// Qwen 消息构建
export { buildQwenUserContent, buildProviderMessages } from './qwen-messages'

/* ------------------------------------------------------------------ */
/*  buildRequest：构建 LLM 请求                                           */
/* ------------------------------------------------------------------ */

export async function buildRequest(
  provider: ProviderKey,
  config: ProviderConfig,
  messages: ChatMessage[],
  stream: boolean,
  options?: RequestOptions,
  signal?: AbortSignal,
  logScope?: string,
  userId?: string,
) {
  // Anthropic 协议使用独立请求构建
  if (provider === 'anthropic' || (!isBuiltinProvider(provider) && config.baseUrl.includes('anthropic'))) {
    const { buildAnthropicRequest } = await import('./anthropic-adapter')
    return buildAnthropicRequest(provider, config, messages, stream, options, userId)
  }

  // 步骤 1: 合并 system 消息
  const normalizedMessages = normalizeMessages(messages)

  // 步骤 2: 使用 provider 适配器转换消息格式
  const { parseMessagesToStandard, adaptMessagesForProvider } = await import('./index')
  const standardMessages = parseMessagesToStandard(normalizedMessages as any)
  const providerReadyMessages = adaptMessagesForProvider(standardMessages, provider)
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
    messages: providerReadyMessages,
    temperature: resolveRequestTemperature(config),
    stream,
    ...(userId ? { user_id: userId } : {}),
    ...(Number.isFinite(config.maxTokens) && (config.maxTokens as number) > 0 ? { max_tokens: config.maxTokens } : {}),
  }
  if (options?.tools && options.tools.length > 0) {
    body.tools = options.tools
    if (isBuiltinProvider(provider)) {
      // qwen 在 thinking mode 下不支持 tool_choice: 'required'，需要改为 'auto'
      let toolChoice = options.toolChoice ?? 'auto'
      if ((provider === 'qwen' || provider === 'deepseek') && toolChoice === 'required') {
        toolChoice = 'auto'
      }
      body.tool_choice = toolChoice
    }
  }
  if (stream) {
    body.stream_options = { include_usage: true }
  }

  if (isBuiltinProvider(provider)) {
    if (provider === 'deepseek') {
      body.reasoning_effort = 'max'
    } else if (provider === 'mimo') {
      body.reasoning_effort = 'high'
    }
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

/* ------------------------------------------------------------------ */
/*  requestChatCompletion：非流式调用                                     */
/* ------------------------------------------------------------------ */

/** Non-streaming chat completion (returns full response) */
export async function requestChatCompletion(
  provider: ProviderKey,
  messages: ChatMessage[],
  overrides?: import('./types').ProviderOverrides,
  signal?: AbortSignal,
  logScope?: string,
  userId?: string,
) {
  const config = getProviderConfig(provider, overrides)
  if (!config.apiKey || !config.model) {
    throw new Error(`Missing API key or model for ${provider}`)
  }

  const { url, init } = await buildRequest(provider, config, messages, false, undefined, signal, logScope, userId)
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

  const finalRawText = await response.text()

  llmLog('RESPONSE', {
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
  const isAnthropic = provider === 'anthropic' || (!isBuiltinProvider(provider) && config.baseUrl.includes('anthropic'))
  const content = isAnthropic
    ? (Array.isArray(data?.content) ? data.content.find((c: any) => c.type === 'text')?.text : undefined)
    : data?.choices?.[0]?.message?.content
  if (!content) {
    throw new Error('Empty response from provider')
  }
  return content as string
}
