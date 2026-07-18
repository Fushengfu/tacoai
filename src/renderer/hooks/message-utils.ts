import type { AttachedAsset, AttachedImage, ChatMsg, ModelConfig, ProviderId } from '../types'
import { stripUserAssetsBlock, inferMediaSubtype } from '../../shared/user-assets'

// 重试配置
export const MAX_RETRY_ATTEMPTS = 2
export const RETRY_DELAY_MS = 1000
export const RETRYABLE_ERRORS = [
  'network',
  'timeout',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'fetch failed',
  'request failed',
]

/**
 * API 消息类型 - 统一使用标准 content 数组格式
 * 
 * 前端始终使用统一格式，后端根据 provider 转换
 * 
 * content 数组支持的类型：
 * - text: 文本内容
 * - image_url: 图片 URL
 * - video_url: 视频 URL
 * - audio_url: 音频 URL
 * 
 * 非媒体文件（代码、文档等）使用标签包裹插入文本：[FILE]path[/FILE]
 */
export type ApiChatMessage = {
  role: ChatMsg['role']
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
    | { type: 'video_url'; video_url: { url: string } }
    | { type: 'audio_url'; audio_url: { url: string } }
  >
}

/** API 消息 content 数组元素类型 */
export type MessageContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } } | { type: 'video_url'; video_url: { url: string } } | { type: 'audio_url'; audio_url: { url: string } }

export type SendMessageParams = {
  threadId: string
  /** 项目标识（用于项目级日志与笔记隔离） */
  projectId?: string
  /** 当前项目的自定义规则（自动注入 system prompt） */
  projectRules?: string
  /** 统一的 content 数组格式 */
  content: string | MessageContentPart[]
  /** 用户附带的图片（兼容旧格式，优先使用 content 数组） */
  images?: AttachedImage[]
  /** 用户附带的文件附件（绝对路径，兼容旧格式，优先使用 content 数组） */
  attachments?: AttachedAsset[]
  provider: ProviderId
  modelConfig: ModelConfig
  /** Agent 模式的工作空间目录 */
  workspace?: string
  /** 上下文窗口大小（token 数），用于自动压缩 */
  contextLength?: number
  /** 首条消息时回调，用于自动命名线程 */
  onFirstMessage?: (autoTitle: string) => void
  /** 完成后回调，用于更新线程时间戳 */
  onComplete?: () => void
}

/**
 * 将 ChatMsg 转换为统一的标准 API 消息格式
 */
export function mapMessageForApi(msg: ChatMsg, isLastUserMessage = false): ApiChatMessage {
  // system 和 assistant 消息也使用数组格式
  if (msg.role !== 'user') {
    return {
      role: msg.role,
      content: [{ type: 'text', text: `[HISTORICAL_TASK_RESULT]\n${msg.content}\n[/HISTORICAL_TASK_RESULT]` }]
    }
  }

  // 构建用户消息的 content 数组
  const parts: ApiChatMessage['content'] = []

  // 1. 构建文本内容
  const raw = stripUserAssetsBlock(String(msg.content ?? ''))
  const wrapped = raw.match(/\[USER_QUERY\]([\s\S]*?)\[\/USER_QUERY\]/i)
  let textContent: string
  if (wrapped && wrapped[1] !== undefined) {
    textContent = raw.trim()
  } else if (isLastUserMessage) {
    // 最后一条最新用户消息：不包裹 USER_QUERY 标签
    textContent = raw.trim()
  } else {
    // 历史用户消息：使用 USER_QUERY 标签包裹
    textContent = `[USER_QUERY]\n${raw.trim()}\n[/USER_QUERY]`
  }

  // 2. 处理附件：媒体文件加入数组，非媒体文件用标签包裹插入文本
  const mediaFiles: Array<{ type: string; url: string }> = []
  const nonMediaFiles: string[] = []

  if (msg.attachments && msg.attachments.length > 0) {
    for (const asset of msg.attachments) {
      const subtype = inferMediaSubtype(asset.path)
      if (subtype) {
        // 媒体文件：加入数组
        mediaFiles.push({ type: subtype, url: asset.path })
      } else {
        // 非媒体文件：用标签包裹
        nonMediaFiles.push(asset.path)
      }
    }
  }

  // 将非媒体文件路径添加到文本中
  if (nonMediaFiles.length > 0) {
    textContent += '\n\n' + nonMediaFiles.map(p => `[FILE]${p}[/FILE]`).join('\n')
  }

  // 添加文本部分
  parts.push({ type: 'text', text: textContent })

  // 3. 添加图片部分（使用 cloudUrl）
  const imageUrls = (msg.images ?? [])
    .map((img) => {
      const cloudUrl = String(img?.cloudUrl ?? '').trim()
      return cloudUrl
    })
    .filter(Boolean)

  for (const url of imageUrls) {
    parts.push({ type: 'image_url', image_url: { url } })
  }

  // 4. 添加其他媒体文件
  for (const media of mediaFiles) {
    if (media.type === 'image_url') {
      parts.push({ type: 'image_url', image_url: { url: media.url } })
    } else if (media.type === 'video_url') {
      parts.push({ type: 'video_url', video_url: { url: media.url } })
    } else if (media.type === 'audio_url') {
      parts.push({ type: 'audio_url', audio_url: { url: media.url } })
    }
  }

  return { role: msg.role, content: parts }
}

/**
 * 构建 API 消息数组
 */
export function buildMessagesForApi(messages: ChatMsg[]): ApiChatMessage[] {
  const MAX_RECENT_MESSAGES = 8
  const MAX_RECENT_USER_TURNS = 3
  const recent: ChatMsg[] = []
  let userTurns = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === 'system') continue
    recent.push(msg)
    if (msg.role === 'user') userTurns++
    if (recent.length >= MAX_RECENT_MESSAGES || userTurns >= MAX_RECENT_USER_TURNS) break
  }
  if (recent.length > 0) {
    const reversed = recent.reverse()
    // 找到最后一条用户消息的索引
    let lastUserIndex = -1
    for (let i = reversed.length - 1; i >= 0; i--) {
      if (reversed[i].role === 'user') {
        lastUserIndex = i
        break
      }
    }
    return reversed.map((msg, idx) => mapMessageForApi(msg, idx === lastUserIndex))
  }
  const last = messages[messages.length - 1]
  return last ? [mapMessageForApi(last, last.role === 'user')] : []
}

export function isRecallDebugEnabled(): boolean {
  return localStorage.getItem('taco.recallDebugEnabled') === 'true'
}

/**
 * 判断错误是否可重试
 */
export function isRetryableError(error: Error): boolean {
  const message = error.message.toLowerCase()
  return RETRYABLE_ERRORS.some((keyword) => message.includes(keyword))
}

/**
 * 延迟函数
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
