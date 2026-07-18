/**
 * LLM 客户端 - 类型定义
 * 
 * 统一管理所有 LLM 相关的公共类型，避免循环依赖。
 */

import type { IncomingHttpHeaders } from 'node:http'
import type { ToolDefinition, ToolCall } from '../tools'

/* ------------------------------------------------------------------ */
/*  核心类型                                                            */
/* ------------------------------------------------------------------ */

/** 标准聊天消息 */
export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
    | { type: 'video_url'; video_url: { url: string } }
    | { type: 'audio_url'; audio_url: { url: string } }
  >
  /** 用户消息可附带的图片（data URL / URL） */
  images?: string[]
  /** assistant 消息可能包含 tool_calls */
  tool_calls?: ToolCall[]
  /** DeepSeek 推理模型可携带的推理上下文字段 */
  reasoning_content?: string
  /** DeepSeek 前缀续写（beta） */
  prefix?: boolean
  /** 可选参与者名称（provider 透传） */
  name?: string
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

export type BuiltinProviderKey = 'deepseek' | 'kimi' | 'minimax' | 'glm' | 'qwen' | 'mimo'
/** 支持内置 6 个 provider + 网关/自定义 provider（任意字符串） */
export type ProviderKey = BuiltinProviderKey | (string & {})

export type ProviderConfig = {
  baseUrl: string
  apiKey: string
  model: string
  temperature?: number
  maxTokens?: number
  headers?: IncomingHttpHeaders
  supportsVision?: boolean
  supportsReasoning?: boolean
}

export type ProviderOverrides = Record<string, Partial<ProviderConfig>>

export type RequestOptions = {
  tools?: ToolDefinition[]
  toolChoice?: 'auto' | 'required'
}

/* ------------------------------------------------------------------ */
/*  消息适配器类型（Provider 格式转换）                                   */
/* ------------------------------------------------------------------ */

/**
 * 统一的标准消息内容元素
 * 
 * 前端始终使用此格式，后端根据 provider 转换
 * 
 * 支持的类型：
 * - text: 文本内容
 * - image_url: 图片 URL
 * - video_url: 视频 URL
 * - audio_url: 音频 URL
 * 
 * 非媒体文件（代码、文档等）使用 [FILE]path[/FILE] 标签包裹在文本中
 */
export type ContentPart =
  /** 文本内容 */
  | { type: 'text'; text: string }
  /** 图片 URL（支持 http/https/data URL） */
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } }
  /** 视频 URL */
  | { type: 'video_url'; video_url: { url: string } }
  /** 音频 URL */
  | { type: 'audio_url'; audio_url: { url: string } }

/** 消息内容：统一使用数组格式 */
export type MessageContent = ContentPart[]

/** 标准化聊天消息 */
export type StandardChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: MessageContent
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
  name?: string
  /** 思考内容（thinking mode） */
  reasoning_content?: string
}

/** Provider 格式规则 */
export type ProviderFormatRule = {
  /** 转换函数：将标准格式转换为目标 provider 格式 */
  transform: (msg: StandardChatMessage) => { role: string; content: unknown }
}

/** Provider 格式规则映射表 */
export type ProviderFormatRules = Record<ProviderKey, ProviderFormatRule>
