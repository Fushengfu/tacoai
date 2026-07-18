/**
 * Bridge 事件监听 Hook
 * 职责：监听移动端发来的切换项目 / 切换模型 / 发送消息 / 确认 / 中止事件
 */
import { useEffect, type MutableRefObject } from 'react'
import type { Thread } from '../types'

interface ThreadStoreLike {
  threads: Thread[]
  switchThread: (id: string) => void
  switchSession: (threadId: string, sessionId: string) => void
}

interface ChatLike {
  ensureSessionLoaded: (sessionId: string) => Promise<void>
  getRunTokenStats: (id: string) => { inputTokens: number; hitTokens: number; outputTokens: number }
  getProjectTokenStats: (id: string) => { totalTokens: number; turns: number; inputTokens: number; outputTokens: number }
}

interface FileViewerLike {
  reset: () => void
}

interface BridgeListenersParams {
  threadStore: ThreadStoreLike
  chat: ChatLike
  fileViewer: FileViewerLike
  doSendRef: MutableRefObject<((contentParts: any[], target?: any) => void)>
  handleProviderChangeRef: MutableRefObject<((id: string) => void)>
}

export function useBridgeListeners({
  threadStore,
  chat,
  fileViewer,
  doSendRef,
  handleProviderChangeRef,
}: BridgeListenersParams) {
  // 监听移动端请求切换项目
  useEffect(() => {
    const unsubscribe = window.taco.bridge.onSwitchProject((data: any) => {
      const projectId = String(data.projectId || '').trim()
      const sessionId = String(data.sessionId || '').trim() || undefined

      if (!projectId) return

      // 检查项目是否存在
      const thread = threadStore.threads.find((t) => t.id === projectId)
      if (!thread) return

      // 切换项目
      threadStore.switchThread(projectId)

      // 如果指定了会话，切换到对应会话
      if (sessionId) {
        const hasSession = thread.sessions.some((s) => s.id === sessionId)
        if (hasSession) {
          threadStore.switchSession(projectId, sessionId)
        }
      }

      fileViewer.reset()

      // 通知主进程：项目切换完成
      const activeSessionId = sessionId || thread.activeSessionId || thread.sessions[0]?.id
      if (activeSessionId) {
        void chat.ensureSessionLoaded(activeSessionId).then(() => {
          const runStats = chat.getRunTokenStats(projectId)
          const hasRunUsage = runStats.inputTokens > 0 || runStats.hitTokens > 0 || runStats.outputTokens > 0
          const tokenUsage = hasRunUsage ? {
            promptTokens: runStats.inputTokens,
            completionTokens: runStats.outputTokens,
            totalTokens: runStats.inputTokens + runStats.outputTokens,
            cachedTokens: runStats.hitTokens,
          } : undefined

          const projStats = chat.getProjectTokenStats(projectId)
          const hasProjData = projStats.totalTokens > 0 || projStats.turns > 0
          const projectTokenStats = hasProjData ? {
            inputTokens: projStats.inputTokens,
            outputTokens: projStats.outputTokens,
            turns: projStats.turns,
          } : undefined
          window.taco.bridge.notifySwitchProjectLoaded({ projectId, sessionId: activeSessionId, tokenUsage, projectTokenStats })
        })
      }
    })
    return unsubscribe
  }, [threadStore, chat, fileViewer])

  // 监听移动端请求切换模型
  useEffect(() => {
    const unsubscribe = window.taco.bridge.onSwitchModel((data: any) => {
      const modelConfigId = String(data.modelConfigId || '').trim()
      if (!modelConfigId) return
      handleProviderChangeRef.current(modelConfigId)
    })
    return unsubscribe
  }, [])

  // 监听移动端发来的消息（chat-send / agent-confirm / agent-abort / retry-response）
  useEffect(() => {
    const unsubscribe = window.taco.bridge.onClientMessage((msg: any) => {
      const type = String(msg.type || '')
      const doSend = doSendRef.current
      if (!doSend) return

      switch (type) {
        case 'bridge:chat-send': {
          const content = String(msg.content || '')
          const threadId = String(msg.threadId || '')
          const images: string[] | undefined = (msg as any).images
          const hasImages = images && images.length > 0
          if (content.trim() || hasImages) {
            const contentParts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [
              { type: 'text' as const, text: content },
            ]
            if (hasImages) {
              for (const url of images!) {
                contentParts.push({ type: 'image_url', image_url: { url } })
              }
            }
            const target = threadId ? { threadId } : undefined
            doSend(contentParts, target)
          }
          break
        }
        case 'bridge:agent-confirm': {
          const confirmId = String(msg.confirmId || '')
          const approved = Boolean(msg.approved)
          if (confirmId) {
            window.taco.agent.confirmResponse(confirmId, approved)
            window.dispatchEvent(new CustomEvent('taco:confirm-response', { detail: { confirmId, approved } }))
          }
          break
        }
        case 'bridge:agent-abort': {
          const requestId = String(msg.originalRequestId || msg.requestId || '')
          if (requestId) {
            window.taco.agent.abort(requestId)
          }
          break
        }
        case 'bridge:retry-response': {
          const retryId = String(msg.retryId || '')
          const shouldRetry = Boolean(msg.shouldRetry)
          if (retryId) {
            window.taco.agent.retryResponse(retryId, shouldRetry)
          }
          break
        }
      }
    })
    return unsubscribe
  }, [])
}
