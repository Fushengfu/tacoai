/**
 * Agent SDK — 工厂函数
 *
 * 提供面向对象的 Agent 实例接口，封装了 runAgent 的复杂参数。
 */

import { runAgent } from './loop'
import type { AgentEvent } from './types'
import type { ChatMessage, ProviderOverrides, ProviderKey } from './llm/client'
import type { AgentServices } from './services'

export type AgentStatus = 'idle' | 'running' | 'waiting_confirm' | 'paused' | 'error'

export interface AgentConfig {
  /** AI 提供商 */
  provider: ProviderKey
  /** 工作区路径 */
  workspace: string
  /** 项目 ID（可选） */
  projectId?: string
  /** 会话 ID（可选） */
  sessionId?: string
  /** 上下文长度限制 */
  contextLength?: number
  /** 事件回调 */
  onEvent?: (event: AgentEvent) => void
  /** 日志作用域 */
  logScope?: string
  /** 是否启用召回调试 */
  recallDebug?: boolean
  /** 服务容器（依赖注入） */
  services: AgentServices
}

export interface AgentInstance {
  /** 发送消息 */
  sendMessage: (
    content: string,
    options?: {
      overrides?: ProviderOverrides
      attachments?: Array<{ type: string; url: string }>
    }
  ) => Promise<void>
  /** 停止当前 Agent 运行 */
  stop: () => void
  /** 获取当前状态 */
  getStatus: () => AgentStatus
  /** 获取当前消息列表 */
  getMessages: () => ChatMessage[]
  /** 更新配置 */
  updateConfig: (config: Partial<AgentConfig>) => void
}

export function createAgent(config: AgentConfig): AgentInstance {
  let status: AgentStatus = 'idle'
  let messages: ChatMessage[] = []
  let currentAbortController: AbortController | null = null

  return {
    async sendMessage(content, options) {
      if (status === 'running') {
        throw new Error('Agent 正在运行中，请先停止当前任务')
      }

      status = 'running'
      currentAbortController = new AbortController()

      // 构建用户消息
      const userMessage: ChatMessage = {
        role: 'user',
        content,
      }

      if (options?.attachments?.length) {
        userMessage.images = options.attachments
          .filter((a) => a.type === 'image')
          .map((a) => a.url)
      }

      messages.push(userMessage)

      try {
        await runAgent(
          config.provider,
          messages,
          options?.overrides,
          config.workspace,
          (event) => {
            // 更新状态
            if (event.type === 'confirm') {
              status = 'waiting_confirm'
            } else if (event.type === 'done') {
              status = 'idle'
            } else if (event.type === 'error') {
              status = 'error'
            }
            // 转发事件
            config.onEvent?.(event)
          },
          config.contextLength,
          currentAbortController.signal,
          config.projectId,
          config.sessionId,
          undefined,
          undefined,
          config.logScope,
          config.recallDebug,
          config.services,
        )
      } catch (err) {
        status = 'error'
        throw err
      }
    },

    stop() {
      currentAbortController?.abort()
      status = 'idle'
    },

    getStatus() {
      return status
    },

    getMessages() {
      return [...messages]
    },

    updateConfig(newConfig) {
      Object.assign(config, newConfig)
    },
  }
}
