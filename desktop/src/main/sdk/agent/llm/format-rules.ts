/**
 * Provider 格式规则
 * 
 * 定义各 LLM Provider 的消息格式要求。
 * 
 * 非视觉模型（deepseek/kimi/glm/minimax）：
 * 图片以 [用户上传图片: url] 文本标记嵌入 content，AI 应调用 analyze_image 分析。
 * 
 * 视觉模型（qwen/mimo/anthropic/openai）：
 * 使用 OpenAI 标准 content 数组格式，直接传递 image_url。
 */

import type { ProviderFormatRules } from './types'
import type { ProviderKey } from './client'

/**
 * 各 Provider 的格式要求
 * 
 * qwen 和 mimo：直接使用 OpenAI 标准数组格式
 * 其他 provider：转换为纯文本 + [用户上传图片/视频/音频: url] 标记
 */
export const providerFormatRules: ProviderFormatRules = {
  qwen: {
    transform: (msg) => ({ role: msg.role, content: msg.content }),
  },
  mimo: {
    transform: (msg) => ({ role: msg.role, content: msg.content }),
  },
  deepseek: {
    transform: (msg) => {
      const text = msg.content.filter(p => p.type === 'text').map(p => p.text).join('\n')
      const imageUrls = msg.content.filter(p => p.type === 'image_url').map(p => p.image_url.url)
      const videoUrls = msg.content.filter(p => p.type === 'video_url').map(p => p.video_url.url)
      const audioUrls = msg.content.filter(p => p.type === 'audio_url').map(p => p.audio_url.url)
      
      const mediaLines: string[] = []
      for (const url of imageUrls) mediaLines.push(`[用户上传图片: ${url}]`)
      for (const url of videoUrls) mediaLines.push(`[用户上传视频: ${url}]`)
      for (const url of audioUrls) mediaLines.push(`[用户上传音频: ${url}]`)
      
      const fullText = mediaLines.length > 0
        ? (text ? `${text}\n\n${mediaLines.join('\n')}` : mediaLines.join('\n'))
        : text
      
      return { role: msg.role, content: fullText }
    },
  },
  kimi: {
    transform: (msg) => providerFormatRules.deepseek.transform(msg),
  },
  minimax: {
    transform: (msg) => providerFormatRules.deepseek.transform(msg),
  },
  glm: {
    transform: (msg) => providerFormatRules.deepseek.transform(msg),
  },
  // Anthropic / OpenAI 协议使用 OpenAI 兼容数组格式（协议差异由各自 adapter 处理）
  anthropic: {
    transform: (msg) => ({ role: msg.role, content: msg.content }),
  },
  openai: {
    transform: (msg) => ({ role: msg.role, content: msg.content }),
  },
}
