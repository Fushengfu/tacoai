/**
 * Provider 消息适配器 - 类型定义
 * 
 * 定义统一的标准消息格式，前端始终使用此格式
 */

import type { ProviderKey } from './llm-client'

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
