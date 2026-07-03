/**
 * Anthropic 协议适配器
 *
 * 负责将 Taco 标准消息格式与 Anthropic Messages API 之间互相转换。
 * Anthropic API: https://docs.anthropic.com/en/api/messages
 */

import type { ChatMessage, ProviderConfig, ProviderKey, StreamEvent, TokenUsage } from './client'
import type { ToolCall, ToolDefinition } from '../tools'

/* ------------------------------------------------------------------ */
/*  消息格式转换：Taco → Anthropic                                        */
/* ------------------------------------------------------------------ */

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }

type AnthropicMessage = {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

type AnthropicTool = {
  name: string
  description?: string
  input_schema: Record<string, unknown>
}

/**
 * 从 data URL 中提取 media_type 和 base64 data
 */
function parseDataUrl(dataUrl: string): { mediaType: string; data: string } | null {
  const match = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/)
  if (!match) return null
  return { mediaType: match[1], data: match[2] }
}

/**
 * 将 Taco 工具定义转换为 Anthropic tool 格式
 */
export function convertToolsToAnthropic(tools?: ToolDefinition[]): AnthropicTool[] {
  if (!tools || tools.length === 0) return []
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters ?? { type: 'object', properties: {} },
  }))
}

/**
 * 将 Taco 消息列表转换为 Anthropic 格式
 * - System 消息提取到顶层 system 字段
 * - User 消息中的图片转为 Anthropic image content block
 * - Assistant 消息中的 tool_calls 转为 tool_use content block
 * - Tool 消息转为 tool_result content block
 */
export function convertMessagesToAnthropic(
  messages: ChatMessage[],
): { system?: string; messages: AnthropicMessage[] } {
  const systemParts: string[] = []
  const anthropicMessages: AnthropicMessage[] = []

  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = typeof msg.content === 'string'
        ? msg.content
        : (Array.isArray(msg.content) ? msg.content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n') : '')
      if (text.trim()) systemParts.push(text.trim())
      continue
    }

    if (msg.role === 'user') {
      const blocks: AnthropicContentBlock[] = []
      const textParts: string[] = []

      if (typeof msg.content === 'string') {
        if (msg.content.trim()) textParts.push(msg.content.trim())
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content as any[]) {
          if (part.type === 'text' && part.text) {
            textParts.push(part.text)
          } else if (part.type === 'image_url' && part.image_url?.url) {
            const url = part.image_url.url
            const parsed = parseDataUrl(url)
            if (parsed) {
              blocks.push({
                type: 'image',
                source: { type: 'base64', media_type: parsed.mediaType, data: parsed.data },
              })
            }
            // 非 base64 的图片 URL 暂不处理（Anthropic 要求 base64）
          }
        }
      }

      // 图片（legacy images 数组）
      if (msg.images) {
        for (const imgUrl of msg.images) {
          const parsed = parseDataUrl(imgUrl)
          if (parsed) {
            blocks.push({
              type: 'image',
              source: { type: 'base64', media_type: parsed.mediaType, data: parsed.data },
            })
          }
        }
      }

      if (textParts.length > 0) {
        blocks.unshift({ type: 'text', text: textParts.join('\n') })
      }

      if (blocks.length > 0) {
        anthropicMessages.push({ role: 'user', content: blocks })
      } else if (textParts.length > 0) {
        anthropicMessages.push({ role: 'user', content: textParts.join('\n') })
      }
      continue
    }

    if (msg.role === 'assistant') {
      const blocks: AnthropicContentBlock[] = []

      const text = typeof msg.content === 'string'
        ? msg.content
        : (Array.isArray(msg.content) ? msg.content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n') : '')

      if (text.trim()) {
        blocks.push({ type: 'text', text: text.trim() })
      }

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          let input: Record<string, unknown> = {}
          try {
            input = JSON.parse(tc.function.arguments || '{}')
          } catch { /* keep empty */ }
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input,
          })
        }
      }

      if (blocks.length > 0) {
        anthropicMessages.push({ role: 'assistant', content: blocks })
      }
      continue
    }

    if (msg.role === 'tool') {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
      anthropicMessages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: msg.tool_call_id || 'unknown',
          content,
        }],
      })
      continue
    }
  }

  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    messages: anthropicMessages,
  }
}

/* ------------------------------------------------------------------ */
/*  Anthropic SSE 流式解析 → Taco StreamEvent                            */
/* ------------------------------------------------------------------ */

/**
 * 解析 Anthropic SSE 流式响应，yield Taco StreamEvent
 */
export async function* parseAnthropicStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  allowedToolNames: Set<string>,
): AsyncGenerator<StreamEvent> {
  const decoder = new TextDecoder()
  let buffer = ''
  let currentEventType = ''
  let accumulated = ''
  let totalInputTokens = 0
  let totalOutputTokens = 0
  // 按 index 累积 tool_use
  const toolUseMap = new Map<number, { id: string; name: string; inputJson: string }>()

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop()!

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) {
        // 空行 = 事件分隔，重置 event type
        currentEventType = ''
        continue
      }

      if (trimmed.startsWith('event:')) {
        currentEventType = trimmed.slice(6).trim()
        continue
      }

      if (!trimmed.startsWith('data:')) continue
      const dataStr = trimmed.slice(5).trim()
      if (!dataStr) continue

      let parsed: any
      try {
        parsed = JSON.parse(dataStr)
      } catch {
        continue
      }

      const eventType = parsed.type || currentEventType

      switch (eventType) {
        case 'message_start': {
          const usage = parsed.message?.usage
          if (usage) {
            totalInputTokens = usage.input_tokens || 0
            yield {
              type: 'usage',
              usage: {
                promptTokens: usage.input_tokens,
                completionTokens: usage.output_tokens || 0,
                totalTokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
              },
            }
          }
          break
        }

        case 'content_block_start': {
          const block = parsed.content_block
          if (block?.type === 'tool_use') {
            const normalizedName = String(block.name || '').trim().toLowerCase()
            if (allowedToolNames.size > 0 && !allowedToolNames.has(normalizedName)) {
              yield { type: 'invalid_tool_calls', names: [block.name] }
              break
            }
            toolUseMap.set(parsed.index, {
              id: block.id || '',
              name: block.name || '',
              inputJson: '',
            })
          }
          break
        }

        case 'content_block_delta': {
          const delta = parsed.delta
          if (delta?.type === 'text_delta' && delta.text) {
            accumulated += delta.text
            yield { type: 'text', content: delta.text }
          } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
            const existing = toolUseMap.get(parsed.index)
            if (existing) {
              existing.inputJson += delta.partial_json
            }
          }
          break
        }

        case 'content_block_stop': {
          // content block 结束，不需要额外处理
          break
        }

        case 'message_delta': {
          const usage = parsed.usage
          if (usage) {
            totalOutputTokens = usage.output_tokens || 0
            yield {
              type: 'usage',
              usage: {
                promptTokens: totalInputTokens,
                completionTokens: totalOutputTokens,
                totalTokens: totalInputTokens + totalOutputTokens,
              },
            }
          }
          break
        }

        case 'message_stop': {
          // 流结束，如果有累积的 tool_use 则 yield
          if (toolUseMap.size > 0) {
            const toolCalls: ToolCall[] = []
            for (const [, tc] of toolUseMap) {
              if (!tc.name) continue
              toolCalls.push({
                id: tc.id,
                type: 'function',
                function: {
                  name: tc.name,
                  arguments: tc.inputJson || '{}',
                },
              })
            }
            if (toolCalls.length > 0) {
              yield { type: 'tool_calls', toolCalls }
            }
          }
          break
        }
      }
    }
  }

  // 流意外结束但有累积的 tool_use
  if (toolUseMap.size > 0) {
    const toolCalls: ToolCall[] = []
    for (const [, tc] of toolUseMap) {
      if (!tc.name) continue
      toolCalls.push({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.inputJson || '{}' },
      })
    }
    if (toolCalls.length > 0) {
      yield { type: 'tool_calls', toolCalls }
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Anthropic 请求构建                                                   */
/* ------------------------------------------------------------------ */

/**
 * 构建 Anthropic API 请求
 */
export function buildAnthropicRequest(
  provider: ProviderKey,
  config: ProviderConfig,
  messages: ChatMessage[],
  stream: boolean,
  options?: { tools?: ToolDefinition[] },
  userId?: string,
): { url: string; init: RequestInit } {
  const { system, messages: anthropicMessages } = convertMessagesToAnthropic(messages)

  const anthropicTools = convertToolsToAnthropic(options?.tools)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body: Record<string, any> = {
    model: config.model,
    max_tokens: 4096,
    messages: anthropicMessages,
    stream,
    ...(userId ? { metadata: { user_id: userId } } : {}),
  }

  if (system) {
    body.system = system
  }

  if (anthropicTools.length > 0) {
    body.tools = anthropicTools
  }

  const temperature = config.temperature !== undefined ? Number(config.temperature) : undefined
  if (temperature !== undefined && Number.isFinite(temperature)) {
    body.temperature = temperature
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': config.apiKey,
    'Authorization': `Bearer ${config.apiKey}`,
    'anthropic-version': '2023-06-01',
  }

  return {
    url: `${config.baseUrl}/v1/messages`,
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    } satisfies RequestInit,
  }
}
