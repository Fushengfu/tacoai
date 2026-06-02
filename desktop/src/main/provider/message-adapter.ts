/**
 * Provider 消息适配器 - 核心逻辑
 * 
 * 负责将前端统一的标准格式转换为各 provider 需要的格式
 */

import type { ChatMessage, BuiltinProviderKey, ProviderKey } from '../ai/llm'
import type { StandardChatMessage, ContentPart } from './types'
import type { ToolCall } from '../tools/definitions'

/* ------------------------------------------------------------------ */
/*  工具函数                                                           */
/* ------------------------------------------------------------------ */

/**
 * 从 content 中提取文本（支持字符串和数组）
 * 
 * @param content - 字符串或 content 数组
 * @returns 纯文本字符串
 */
export function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return extractTextFromParts(content as ContentPart[])
  }
  return String(content ?? '')
}

/**
 * 从标准 content 数组中提取文本
 */
export function extractTextFromParts(parts: ContentPart[]): string {
  return parts
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
}

/**
 * 从标准 content 数组中提取图片 URL
 */
export function extractImageUrls(parts: ContentPart[]): string[] {
  return parts
    .filter((p): p is Extract<ContentPart, { type: 'image_url' }> => p.type === 'image_url')
    .map((p) => p.image_url.url)
}

/**
 * 从标准 content 数组中提取视频 URL
 */
export function extractVideoUrls(parts: ContentPart[]): string[] {
  return parts
    .filter((p): p is Extract<ContentPart, { type: 'video_url' }> => p.type === 'video_url')
    .map((p) => p.video_url.url)
}

/**
 * 从标准 content 数组中提取音频 URL
 */
export function extractAudioUrls(parts: ContentPart[]): string[] {
  return parts
    .filter((p): p is Extract<ContentPart, { type: 'audio_url' }> => p.type === 'audio_url')
    .map((p) => p.audio_url.url)
}

/* ------------------------------------------------------------------ */
/*  Provider 转换函数                                                  */
/* ------------------------------------------------------------------ */

/**
 * 转换为 Qwen 格式（OpenAI 兼容数组）
 */
function transformForQwen(msg: StandardChatMessage): { role: string; content: unknown } {
  return {
    role: msg.role,
    // 空 content 数组 → 空字符串，否则直接使用数组
    content: msg.content.length === 0 ? '' : msg.content,
  }
}

/**
 * 转换为 Mimo 格式（OpenAI 兼容数组）
 */
function transformForMimo(msg: StandardChatMessage): { role: string; content: unknown; tool_call_id?: string; name?: string; tool_calls?: unknown[]; reasoning_content?: string } {
  const result: { role: string; content: unknown; tool_call_id?: string; name?: string; tool_calls?: unknown[]; reasoning_content?: string } = {
    role: msg.role,
    // 空 content 数组 → 空字符串，否则直接使用数组
    content: msg.content.length === 0 ? '' : msg.content,
  }
  
  // tool 消息需要保留 tool_call_id 和 name
  if (msg.role === 'tool') {
    if (msg.tool_call_id) result.tool_call_id = msg.tool_call_id
    if (msg.name) result.name = msg.name
  }
  
  // assistant 消息如果有 tool_calls 也需要保留
  if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
    result.tool_calls = msg.tool_calls
  }
  
  // assistant 消息需要保留 reasoning_content（thinking mode 必须）
  if (msg.role === 'assistant' && msg.reasoning_content) {
    result.reasoning_content = msg.reasoning_content
  }
  
  return result
}

/**
 * 转换为 Deepseek 格式（字符串 + images 字段）
 */
function transformForDeepseek(msg: StandardChatMessage): { role: string; content: unknown } {
  if (msg.role !== 'user') {
    return {
      role: msg.role,
      content: extractTextFromParts(msg.content),
    }
  }

  const text = extractTextFromParts(msg.content)
  const images = extractImageUrls(msg.content)

  return {
    role: msg.role,
    content: text,
    ...(images.length > 0 ? { images } : {}),
  }
}

/**
 * 转换为 Kimi 格式（类似 Deepseek）
 */
function transformForKimi(msg: StandardChatMessage): { role: string; content: unknown } {
  return transformForDeepseek(msg)
}

/**
 * 去掉 content 中的 [HISTORICAL_TASK_RESULT] 和 [/HISTORICAL_TASK_RESULT] 标签，
 * 保留标签之间的内容。支持字符串和 ContentPart 数组两种格式。
 */
function stripHistoricalTaskResult(content: unknown): unknown {
  if (typeof content === 'string') {
    return content
      .replace(/\[HISTORICAL_TASK_RESULT\]/g, '')
      .replace(/\[\/HISTORICAL_TASK_RESULT\]/g, '')
  }
  if (Array.isArray(content)) {
    return (content as ContentPart[]).map((part) => {
      if (part.type === 'text') {
        return {
          ...part,
          text: part.text
            .replace(/\[HISTORICAL_TASK_RESULT\]/g, '')
            .replace(/\[\/HISTORICAL_TASK_RESULT\]/g, ''),
        }
      }
      return part
    })
  }
  return content
}

/**
 * 转换为 Minimax 格式
 */
function transformForMinimax(msg: StandardChatMessage): { role: string; content: unknown; tool_call_id?: string; name?: string; tool_calls?: unknown[]; reasoning_content?: string } {
  const rawContent: unknown = msg.content.length === 0 ? '' : msg.content
  const result: { role: string; content: unknown; tool_call_id?: string; name?: string; tool_calls?: unknown[]; reasoning_content?: string } = {
    role: msg.role,
    content: stripHistoricalTaskResult(rawContent),
  }
  
  // tool 消息需要保留 tool_call_id 和 name
  if (msg.role === 'tool') {
    if (msg.tool_call_id) result.tool_call_id = msg.tool_call_id
    if (msg.name) result.name = msg.name
  }
  
  // assistant 消息如果有 tool_calls 也需要保留
  if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
    result.tool_calls = msg.tool_calls
  }
  
  // assistant 消息需要保留 reasoning_content（thinking mode 必须）
  if (msg.role === 'assistant' && msg.reasoning_content) {
    result.reasoning_content = msg.reasoning_content
  }
  
  return result
}

/**
 * 转换为 GLM 格式
 */
function transformForGLM(msg: StandardChatMessage): { role: string; content: unknown } {
  return transformForDeepseek(msg)
}

/* ------------------------------------------------------------------ */
/*  主转换函数                                                         */
/* ------------------------------------------------------------------ */

/** Provider 转换函数映射表 */
const transformers: Record<string, (msg: StandardChatMessage) => { role: string; content: unknown }> = {
  qwen: transformForQwen,
  mimo: transformForMimo,
  deepseek: transformForDeepseek,
  kimi: transformForKimi,
  minimax: transformForMinimax,
  glm: transformForGLM,
}

/**
 * 将标准消息转换为目标 provider 格式
 * 
 * 对于未知 provider（如网关模型的 alibaba、openai 等），
 * 回退为 OpenAI 兼容格式（直接使用标准格式）。
 *
 * @param msg - 标准格式消息
 * @param provider - Provider 标识
 * @returns provider-ready 消息
 */
export function adaptForProvider(msg: StandardChatMessage, provider: string): ChatMessage {
  const transformer = transformers[provider]
  // 未知 provider 回退为 OpenAI 兼容格式（直接传递标准格式）
  // 空 content 数组 → 空字符串
  const result = transformer ? transformer(msg) : {
    role: msg.role,
    content: msg.content.length === 0 ? '' : msg.content,
  }
  
  // 构建基础消息对象
  const adaptedMsg: ChatMessage = {
    ...msg,  // 保留所有原始字段（tool_calls, tool_call_id, name 等）
    role: result.role as ChatMessage['role'],
    content: result.content as string,
  }
  
  // 如果 transformer 返回了额外的字段（如 tool_calls, tool_call_id, name），需要合并
  if ('tool_calls' in result && result.tool_calls) {
    adaptedMsg.tool_calls = result.tool_calls as ChatMessage['tool_calls']
  }
  if ('tool_call_id' in result && result.tool_call_id) {
    (adaptedMsg as Record<string, unknown>).tool_call_id = (result as Record<string, unknown>).tool_call_id
  }
  if ('name' in result && result.name) {
    (adaptedMsg as Record<string, unknown>).name = (result as Record<string, unknown>).name
  }
  if ('reasoning_content' in result && result.reasoning_content) {
    (adaptedMsg as Record<string, unknown>).reasoning_content = (result as Record<string, unknown>).reasoning_content
  }
  
  return adaptedMsg
}

/**
 * 批量转换消息
 */
export function adaptMessagesForProvider(messages: StandardChatMessage[], provider: string): ChatMessage[] {
  return messages.map((msg) => adaptForProvider(msg, provider))
}

/**
 * 将旧格式消息转换为标准格式（向后兼容）
 * 
 * @param msg - 旧格式消息 { content: string, images?: string[] }
 * @returns 标准格式消息
 */
export function parseToStandard(msg: { role: string; content: string | unknown[]; images?: string[]; tool_calls?: unknown[]; tool_call_id?: string; name?: string; reasoning_content?: string }): StandardChatMessage {
  // 如果已经是数组格式，直接返回
  if (Array.isArray(msg.content)) {
    const standardMsg: StandardChatMessage = {
      role: msg.role as StandardChatMessage['role'],
      content: msg.content as ContentPart[],
    }
    
    // 保留 assistant 消息的 tool_calls
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      standardMsg.tool_calls = msg.tool_calls as ToolCall[]
    }
    
    // 保留 tool 消息的 tool_call_id 和 name
    if (msg.role === 'tool') {
      if (msg.tool_call_id) standardMsg.tool_call_id = msg.tool_call_id
      if (msg.name) standardMsg.name = msg.name
    }
    
    // 保留 assistant 消息的 reasoning_content
    if (msg.role === 'assistant' && msg.reasoning_content) {
      standardMsg.reasoning_content = msg.reasoning_content
    }
    
    return standardMsg
  }

  // 旧格式：字符串 + images
  const parts: ContentPart[] = []
  
  // 添加文本 — 只对非空字符串才创建 text part
  // 空字符串表示"无文本内容"（如 assistant 只返回 tool_calls，不返回文本），
  // 不应转换为 [{ type: 'text', text: '' }]，而应保持空数组
  if (typeof msg.content === 'string' && msg.content.length > 0) {
    parts.push({ type: 'text', text: msg.content })
  }

  // 添加图片
  if (msg.images && msg.images.length > 0) {
    for (const url of msg.images) {
      parts.push({ type: 'image_url', image_url: { url } })
    }
  }

  const standardMsg: StandardChatMessage = {
    role: msg.role as StandardChatMessage['role'],
    // 空字符串 + 无图片 → content 为空数组（不是 [{ type: 'text', text: '' }]）
    content: parts.length > 0 ? parts : [],
  }
  
  // 保留 assistant 消息的 tool_calls
  if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
    standardMsg.tool_calls = msg.tool_calls as ToolCall[]
  }
  
  // 保留 tool 消息的 tool_call_id 和 name
  if (msg.role === 'tool') {
    if (msg.tool_call_id) standardMsg.tool_call_id = msg.tool_call_id
    if (msg.name) standardMsg.name = msg.name
  }
  
  // 保留 assistant 消息的 reasoning_content
  if (msg.role === 'assistant' && msg.reasoning_content) {
    standardMsg.reasoning_content = msg.reasoning_content
  }
  
  return standardMsg
}

/**
 * 批量转换为标准格式
 */
export function parseMessagesToStandard(messages: Array<{ role: string; content: string | unknown[]; images?: string[] }>): StandardChatMessage[] {
  return messages.map(parseToStandard)
}
