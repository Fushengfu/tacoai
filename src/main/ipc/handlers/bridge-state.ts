/**
 * Bridge 状态处理器
 *
 * 包含：项目切换后推送、Token 更新、状态转发、客户端连接回调、快照响应。
 * 从 bridge-handlers.ts 提取。
 */

import { ipcMain, BrowserWindow } from 'electron'
import { getBridgeManager } from '../../bridge/bridge-manager'
import type { BridgeChatMessage } from '../../bridge/bridge-protocol'
import { getAppState } from '../../infrastructure/app-state'
import { loadChatStoreSessionPage } from '../../repositories/memory-db/index'
import { log, logError } from '../../infrastructure/logger'
import { agentAbortControllers } from './chat-handlers'
import { loadAuthLevel, isAutoCommitEnabled } from '../../sdk/agent/tools'
import { IpcChannel } from '../../../shared/ipc'
import { tokenUsageCache, projectTokenStatsCache, stripDataUrlFromMessages, stripAgentStepsForBridge } from './bridge-utils'

/* ------------------------------------------------------------------ */
/*  项目切换完成后推送 bridge:state                                    */
/* ------------------------------------------------------------------ */

/** 注册 renderer 项目切换完成回调 */
export function setupBridgeSwitchProjectLoadedHandler(): void {
  ipcMain.on('bridge:switch-project-loaded', async (_event, payload: {
    projectId: string
    sessionId: string
    tokenUsage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number; cachedTokens?: number }
    projectTokenStats?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number; turns?: number }
  }) => {
    try {
      const projectId = String(payload.projectId || '')
      const sessionId = String(payload.sessionId || '')
      if (!projectId || !sessionId) return

      if (payload.tokenUsage) tokenUsageCache.set(projectId, payload.tokenUsage)
      if (payload.projectTokenStats) projectTokenStatsCache.set(projectId, payload.projectTokenStats)

      const state = await getAppState()
      const activeThread = state.threadsState.threads.find((t) => t.id === projectId)
      if (!activeThread) return

      const page = loadChatStoreSessionPage(sessionId, { limit: 50 })
      if (!page || !Array.isArray(page.messages)) return

      const modelConfig = state.providersState.modelConfigs.find(
        (m) => m.id === activeThread.modelConfigId,
      )
      const hasActiveTask = agentAbortControllers.size > 0 &&
        Array.from(agentAbortControllers.keys()).some(key => key.includes(sessionId) || key.includes(activeThread.id))
      const activeAgentRequestId = hasActiveTask ? `agent-${sessionId}` : undefined

      const curUsage = tokenUsageCache.get(projectId) || {}
      const projStats = projectTokenStatsCache.get(projectId) || {}
      const mergedTokenUsage = {
        ...curUsage,
        ...(projStats.inputTokens !== undefined ? { projectInputTokens: projStats.inputTokens } : {}),
        ...(projStats.outputTokens !== undefined ? { projectOutputTokens: projStats.outputTokens } : {}),
        ...(projStats.cachedTokens !== undefined ? { projectCachedTokens: projStats.cachedTokens } : {}),
        ...(projStats.turns !== undefined ? { projectTurns: projStats.turns } : {}),
      }

      const mgr = getBridgeManager()
      mgr.sendHostMessage({
        type: 'bridge:state',
        messages: stripAgentStepsForBridge(stripDataUrlFromMessages(page.messages)) as BridgeChatMessage[],
        threadId: activeThread.id,
        workspace: activeThread.workspace,
        modelLabel: modelConfig?.model || modelConfig?.name || '',
        modelConfigId: activeThread.modelConfigId,
        threadTitle: activeThread.title,
        projectTitle: activeThread.title,
        authLevel: loadAuthLevel(activeThread.id),
        autoCommit: isAutoCommitEnabled(activeThread.id),
        timestamp: Date.now(),
        tokenUsage: mergedTokenUsage,
        ...(activeAgentRequestId ? { activeAgentRequestId } : {}),
      } as any)
      log('BRIDGE_STATE_PUSHED_AFTER_SWITCH', {
        threadId: activeThread.id,
        sessionId,
        messageCount: page.messages.length,
      }, 'bridge')
    } catch (err) {
      logError('bridge', '切换项目后推送 bridge:state 失败', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })
}

/* ------------------------------------------------------------------ */
/*  Token 使用情况实时推送                                             */
/* ------------------------------------------------------------------ */

/** 注册 renderer 实时推送 token 使用情况 */
export function setupBridgeTokenUsageUpdateHandler(): void {
  ipcMain.on('bridge:update-token-usage', (_event, payload: {
    projectId: string
    tokenUsage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number; cachedTokens?: number }
    projectTokenStats?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number; turns?: number }
  }) => {
    try {
      const projectId = String(payload.projectId || '')
      if (!projectId) return

      if (payload.tokenUsage) tokenUsageCache.set(projectId, payload.tokenUsage)
      if (payload.projectTokenStats) {
        const existing = projectTokenStatsCache.get(projectId) || {}
        projectTokenStatsCache.set(projectId, {
          inputTokens: (existing.inputTokens || 0) + (payload.projectTokenStats.inputTokens || 0),
          outputTokens: (existing.outputTokens || 0) + (payload.projectTokenStats.outputTokens || 0),
          cachedTokens: (existing.cachedTokens || 0) + (payload.projectTokenStats.cachedTokens || 0),
          turns: (existing.turns || 0) + (payload.projectTokenStats.turns || 0),
        })
      }

      const curUsage = tokenUsageCache.get(projectId) || {}
      const projStats = projectTokenStatsCache.get(projectId) || {}
      const mergedTokenUsage = {
        ...curUsage,
        ...(projStats.inputTokens !== undefined ? { projectInputTokens: projStats.inputTokens } : {}),
        ...(projStats.outputTokens !== undefined ? { projectOutputTokens: projStats.outputTokens } : {}),
        ...(projStats.turns !== undefined ? { projectTurns: projStats.turns } : {}),
      }

      const mgr = getBridgeManager()
      mgr.sendHostMessage({
        type: 'bridge:token-usage',
        threadId: projectId,
        tokenUsage: mergedTokenUsage,
        timestamp: Date.now(),
      } as any)
    } catch (err) {
      logError('bridge', '更新 token 使用情况失败', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })
}

/* ------------------------------------------------------------------ */
/*  桥接状态转发                                                       */
/* ------------------------------------------------------------------ */

/** 注册桥接状态转发：BridgeManager 状态变化时推送给所有 renderer */
export function setupBridgeStatusForwarding(): void {
  const mgr = getBridgeManager()

  mgr.onStatusChange((status) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IpcChannel.BRIDGE_STATUS_CHANGED, status)
      }
    }
  })

  mgr.onClientMessage((msg) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IpcChannel.BRIDGE_CLIENT_MESSAGE, msg)
      }
    }
  })
}

/* ------------------------------------------------------------------ */
/*  移动端连接成功回调                                                  */
/* ------------------------------------------------------------------ */

/** 注册移动端连接成功回调：仅更新活跃项目，不再主动推送全量快照 */
export function setupBridgeClientConnectedHandler(): void {
  const mgr = getBridgeManager()

  mgr.onClientConnected(async () => {
    log('BRIDGE_CLIENT_CONNECTED', {}, 'bridge')
    try {
      const state = await getAppState()
      const activeThread = state.threadsState.threads.find(
        (t) => t.id === state.threadsState.activeThreadId,
      )
      if (!activeThread) {
        log('BRIDGE_NO_ACTIVE_THREAD', {}, 'bridge')
        return
      }

      const orderedProjectIds = state.threadsState.threads.map(t => t.id)
      mgr.setActiveThread(state.threadsState.activeThreadId, orderedProjectIds)
      mgr.syncProjectModelConfigs(state.threadsState.threads)
      mgr.pushProjectsOnDemand(orderedProjectIds)

      log('BRIDGE_CLIENT_CONNECTED_NO_SNAPSHOT', {
        threadId: activeThread.id,
      }, 'bridge')
    } catch (err) {
      logError('bridge', 'setupBridgeClientConnectedHandler 失败', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })
}

/* ------------------------------------------------------------------ */
/*  状态快照响应                                                       */
/* ------------------------------------------------------------------ */

/** 注册移动端连接成功回调：主动推送 bridge:state 状态快照 */
export function setupBridgeStateSnapshotResponse(): void {
  ipcMain.on('bridge:state-snapshot-response', (_event, payload: {
    messages: Array<{
      id: string; role: string; content: string; hasImages?: boolean; streaming?: boolean
      agentSteps?: any[]; activePlan?: any; taskTiming?: any
    }>
    threadId: string; sessionId?: string; workspace?: string; modelLabel?: string
    modelConfigId?: string; threadTitle?: string; projectTitle?: string
    activeAgentRequestId?: string
    tokenUsage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number; cachedTokens?: number }
    projectTokenStats?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number; turns?: number }
  }) => {
    try {
      const mgr = getBridgeManager()

      if (payload.projectTokenStats) {
        projectTokenStatsCache.set(payload.threadId, payload.projectTokenStats)
      }

      const curUsage = payload.tokenUsage || {}
      const projStats = payload.projectTokenStats || {}
      const mergedTokenUsage = {
        ...curUsage,
        ...(projStats.inputTokens !== undefined ? { projectInputTokens: projStats.inputTokens } : {}),
        ...(projStats.outputTokens !== undefined ? { projectOutputTokens: projStats.outputTokens } : {}),
        ...(projStats.cachedTokens !== undefined ? { projectCachedTokens: projStats.cachedTokens } : {}),
        ...(projStats.turns !== undefined ? { projectTurns: projStats.turns } : {}),
      }

      mgr.sendHostMessage({
        type: 'bridge:state',
        messages: stripAgentStepsForBridge(stripDataUrlFromMessages(payload.messages)) as BridgeChatMessage[],
        threadId: payload.threadId,
        activeAgentRequestId: payload.activeAgentRequestId,
        workspace: payload.workspace,
        modelLabel: payload.modelLabel,
        modelConfigId: payload.modelConfigId,
        threadTitle: payload.threadTitle,
        projectTitle: payload.projectTitle,
        tokenUsage: mergedTokenUsage,
        authLevel: loadAuthLevel(payload.threadId),
        autoCommit: isAutoCommitEnabled(payload.threadId),
        timestamp: Date.now(),
      })
      log('BRIDGE_STATE_PUSHED', {
        threadId: payload.threadId,
        messageCount: payload.messages.length,
      }, 'bridge')
    } catch (err) {
      logError('bridge', '转发 bridge:state 失败', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })
}
