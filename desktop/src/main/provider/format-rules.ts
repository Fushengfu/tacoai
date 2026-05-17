/**
 * Provider 格式规则
 * 
 * 定义各 LLM Provider 的消息格式要求
 */

import type { ProviderFormatRules } from './types'
import type { ProviderKey } from '../ai/llm'

/**
 * 各 Provider 的格式要求
 * 
 * qwen 和 mimo：直接使用 OpenAI 标准数组格式
 * 其他 provider：转换为字符串 + images 字段
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
      const images = msg.content.filter(p => p.type === 'image_url').map(p => p.image_url.url)
      return {
        role: msg.role,
        content: text,
        ...(images.length > 0 ? { images } : {}),
      }
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
}
