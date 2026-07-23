/**
 * Bridge 数据查询处理器
 *
 * 处理移动端发送的项目列表、目录树、文件读写、状态请求、模型列表等请求。
 * 从 bridge-handlers.ts 提取 SetupBridgeDataHandler。
 */

import { BrowserWindow } from 'electron'
import { getBridgeManager } from '../../bridge/bridge-manager'
import { getAppState } from '../../infrastructure/app-state'
import {
  loadChatStoreSessionPage,
  loadChatStoreMessageById,
} from '../../repositories/memory-db/index'
import { log, logError } from '../../infrastructure/logger'
import { handleGatewayGetModels } from './gateway-handlers'
import { setGlobalAuthLevel, saveAuthLevel, loadAuthLevel, isAutoCommitEnabled, saveAutoCommitEnabled } from '../../sdk/agent/tools'
import { agentAbortControllers } from './chat-handlers'
import nodePath from 'node:path'
import {
  tokenUsageCache,
  projectTokenStatsCache,
  buildNestedTree,
  stripDataUrlFromMessages,
  stripAgentStepsForBridge,
  handleFileRead,
  handleFileWrite,
} from './bridge-utils'

/* ------------------------------------------------------------------ */
/*  主数据处理器                                                        */
/* ------------------------------------------------------------------ */

/** 注册移动端数据查询处理器 */
export function setupBridgeDataHandler(): void {
  const mgr = getBridgeManager()

  mgr.setDataHandler(async (msg, respond) => {
    const type = String(msg.type || '')
    const requestId = String(msg.requestId || '')

    try {
      switch (type) {
        /* ---- 项目列表 ---- */
        case 'bridge:get-projects': {
          const state = await getAppState()
          const projects = state.threadsState.threads.map((t) => ({
            id: t.id,
            title: t.title,
            workspace: t.workspace,
            sessions: t.sessions.map((s) => ({
              id: s.id,
              title: s.title,
              createdAt: s.createdAt,
            })),
            activeSessionId: t.activeSessionId,
            modelConfigId: t.modelConfigId,
          }))
          respond({
            type: 'bridge:projects',
            requestId,
            projects,
            activeThreadId: getBridgeManager().getActiveThreadId() || state.threadsState.activeThreadId,
          })
          mgr.pushProjectsOnDemand()
          break
        }

        /* ---- 目录树 ---- */
        case 'bridge:get-workspace-tree': {
          const cwd = String(msg.path || '')
          if (!cwd) {
            respond({ type: 'bridge:workspace-tree', requestId, tree: [], error: 'path required' })
            break
          }
          const { getWorkspaceTree } = await import('../../sdk/agent/tools')
          const result = await getWorkspaceTree(cwd)
          const tree = buildNestedTree(result.entries)
          respond({ type: 'bridge:workspace-tree', requestId, tree })
          break
        }

        /* ---- 文件读取 ---- */
        case 'bridge:file-read': {
          const filePath = String(msg.path || '')
          if (!filePath) {
            respond({ type: 'bridge:file-content', requestId, content: null, size: 0, isBinary: true, error: 'path required' })
            break
          }
          try {
            let resolvedPath = filePath
            if (!nodePath.isAbsolute(filePath)) {
              const state = await getAppState()
              const bridgeThreadId = getBridgeManager().getActiveThreadId() || state.threadsState.activeThreadId
              const activeThread = state.threadsState.threads.find((t) => t.id === bridgeThreadId)
              if (activeThread?.workspace) {
                resolvedPath = nodePath.join(activeThread.workspace, filePath)
              }
            }
            const result = await handleFileRead(resolvedPath)
            respond({
              type: 'bridge:file-content',
              requestId,
              content: result.content,
              size: result.size,
              isBinary: result.isBinary,
              dataUrl: result.dataUrl,
              truncated: result.truncated,
            })
          } catch (err) {
            respond({
              type: 'bridge:file-content',
              requestId,
              content: null,
              size: 0,
              isBinary: true,
              error: err instanceof Error ? err.message : String(err),
            })
          }
          break
        }

        /* ---- 文件写入 ---- */
        case 'bridge:file-write': {
          const filePath = String(msg.path || '')
          const content = String(msg.content || '')
          if (!filePath) {
            respond({ type: 'bridge:file-written', requestId, success: false, error: 'path required' })
            break
          }
          try {
            let resolvedPath = filePath
            if (!nodePath.isAbsolute(filePath)) {
              const state = await getAppState()
              const bridgeThreadId = getBridgeManager().getActiveThreadId() || state.threadsState.activeThreadId
              const activeThread = state.threadsState.threads.find((t) => t.id === bridgeThreadId)
              if (activeThread?.workspace) {
                resolvedPath = nodePath.join(activeThread.workspace, filePath)
              }
            }
            await handleFileWrite(resolvedPath, content)
            respond({ type: 'bridge:file-written', requestId, success: true })
          } catch (err) {
            respond({
              type: 'bridge:file-written',
              requestId,
              success: false,
              error: err instanceof Error ? err.message : String(err),
            })
          }
          break
        }

        /* ---- 切换项目 ---- */
        case 'bridge:switch-project': {
          const projectId = String(msg.projectId || '')
          const sessionId = String(msg.sessionId || '').trim() || undefined
          if (!projectId) {
            respond({ type: 'bridge:project-switched', requestId, success: false, error: 'projectId required' })
            break
          }
          respond({ type: 'bridge:project-switched', requestId, success: true })

          try {
            const mgr = getBridgeManager()
            const state = await getAppState()
            const orderedProjectIds = state.threadsState.threads.map(t => t.id)
            mgr.setActiveThread(projectId, orderedProjectIds)
            mgr.syncProjectModelConfigs(state.threadsState.threads)
          } catch { /* bridge 未初始化时忽略 */ }

          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) {
              win.webContents.send('bridge:switch-project-from-mobile', { projectId, sessionId })
            }
          }
          break
        }

        /* ---- 移动端设置授权级别 ---- */
        case 'bridge:set-auth-level': {
          const level = String(msg.level || '').trim()
          const validLevels = ['standard', 'auto']
          if (!validLevels.includes(level)) {
            respond({ type: 'bridge:auth-level-set', requestId, success: false, error: `invalid level: ${level}` })
            break
          }
          try {
            const state = await getAppState()
            const projectId = String(msg.projectId || '').trim() || getBridgeManager().getActiveThreadId() || state.threadsState.activeThreadId
            if (projectId) {
              setGlobalAuthLevel(level as any)
              saveAuthLevel(projectId, level as any)
            }
            respond({ type: 'bridge:auth-level-set', requestId, success: true, authLevel: level })
            log('BRIDGE_AUTH_LEVEL_SET', { level, projectId }, 'bridge')
            for (const win of BrowserWindow.getAllWindows()) {
              if (!win.isDestroyed()) {
                win.webContents.send('bridge:auth-level-changed', { level, projectId })
              }
            }
            if (projectId) {
              const mgr = getBridgeManager()
              mgr.sendHostMessage({
                type: 'bridge:state',
                messages: [],
                threadId: projectId,
                authLevel: level,
                timestamp: Date.now(),
              } as any)
            }
          } catch (err) {
            respond({ type: 'bridge:auth-level-set', requestId, success: false, error: err instanceof Error ? err.message : String(err) })
          }
          break
        }

        /* ---- 移动端设置自动提交开关 ---- */
        case 'bridge:set-auto-commit': {
          const enabled = Boolean(msg.enabled)
          try {
            const state = await getAppState()
            const projectId = getBridgeManager().getActiveThreadId() || state.threadsState.activeThreadId
            if (projectId) {
              saveAutoCommitEnabled(projectId, enabled)
            }
            respond({ type: 'bridge:auto-commit-set', requestId, success: true, enabled })
            log('BRIDGE_AUTO_COMMIT_SET', { enabled, projectId }, 'bridge')
            for (const win of BrowserWindow.getAllWindows()) {
              if (!win.isDestroyed()) {
                win.webContents.send('bridge:auto-commit-changed', { enabled, projectId })
              }
            }
            if (projectId) {
              const mgr = getBridgeManager()
              mgr.sendHostMessage({
                type: 'bridge:state',
                messages: [],
                threadId: projectId,
                autoCommit: enabled,
                timestamp: Date.now(),
              } as any)
            }
          } catch (err) {
            respond({ type: 'bridge:auto-commit-set', requestId, success: false, error: err instanceof Error ? err.message : String(err) })
          }
          break
        }

        /* ---- 移动端主动请求状态快照 ---- */
        case 'bridge:request-state': {
          try {
            const state = await getAppState()
            const requestedThreadId = String(msg.threadId || '').trim()
            const resolvedThreadId = requestedThreadId || getBridgeManager().getActiveThreadId() || state.threadsState.activeThreadId
            const activeThread = state.threadsState.threads.find((t) => t.id === resolvedThreadId)
            if (!activeThread) {
              respond({ type: 'bridge:state', requestId, messages: [], threadId: requestedThreadId || '' })
              break
            }

            const resolvedSessionId = activeThread.activeSessionId || activeThread.sessions[0]?.id || ''
            if (!resolvedSessionId) {
              respond({ type: 'bridge:state', requestId, messages: [], threadId: activeThread.id })
              break
            }

            const page = loadChatStoreSessionPage(resolvedSessionId, { limit: 50 })
            if (page && Array.isArray(page.messages)) {
              const modelConfig = state.providersState.modelConfigs.find(
                (m) => m.id === activeThread.modelConfigId,
              )
              const hasActiveTask = agentAbortControllers.size > 0 &&
                Array.from(agentAbortControllers.keys()).some(key => {
                  return key.includes(resolvedSessionId) || key.includes(activeThread.id)
                })
              const activeAgentRequestId = hasActiveTask ? `agent-${resolvedSessionId}` : undefined

              const curUsage = tokenUsageCache.get(activeThread.id) || {}
              const projStats = projectTokenStatsCache.get(activeThread.id) || {}
              const mergedTokenUsage = {
                ...curUsage,
                ...(projStats.inputTokens !== undefined ? { projectInputTokens: projStats.inputTokens } : {}),
                ...(projStats.outputTokens !== undefined ? { projectOutputTokens: projStats.outputTokens } : {}),
                ...(projStats.cachedTokens !== undefined ? { projectCachedTokens: projStats.cachedTokens } : {}),
                ...(projStats.turns !== undefined ? { projectTurns: projStats.turns } : {}),
              }

              respond({
                type: 'bridge:state',
                requestId,
                messages: stripAgentStepsForBridge(stripDataUrlFromMessages(page.messages)),
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
              })
              log('BRIDGE_STATE_REQUEST_HANDLED', {
                threadId: activeThread.id,
                sessionId: resolvedSessionId,
                messageCount: page.messages.length,
              }, 'bridge')
            } else {
              respond({ type: 'bridge:state', requestId, messages: [], threadId: activeThread.id })
            }
          } catch (err) {
            logError('bridge', '处理 bridge:request-state 失败', {
              error: err instanceof Error ? err.message : String(err),
            })
            respond({ type: 'bridge:state', requestId, messages: [], threadId: '' })
          }
          break
        }

        /* ---- 加载更早消息（分页） ---- */
        case 'bridge:load-older-messages': {
          const sessionId = String(msg.sessionId || '').trim()
          const beforeSeq = Number(msg.beforeSeq)
          const limit = Math.min(200, Math.max(1, Number(msg.limit) || 50))
          if (!sessionId || !Number.isFinite(beforeSeq)) {
            respond({ type: 'bridge:older-messages', requestId, messages: [], totalCount: 0, error: 'sessionId and beforeSeq required' })
            break
          }
          const page = loadChatStoreSessionPage(sessionId, { beforeSeq, limit })
          if (!page) {
            respond({ type: 'bridge:older-messages', requestId, messages: [], totalCount: 0 })
            break
          }
          respond({
            type: 'bridge:older-messages',
            requestId,
            messages: stripAgentStepsForBridge(stripDataUrlFromMessages(page.messages)),
            totalCount: page.totalCount,
            startSeq: page.startSeq,
            endSeq: page.endSeq,
          })
          break
        }

        /* ---- 模型列表 ---- */
        case 'bridge:get-models': {
          const state = await getAppState()
          const providersState = state.providersState

          const localModels = providersState.modelConfigs.map((m) => ({
            id: m.id,
            provider: m.provider,
            name: m.name,
            displayName: m.name,
            model: m.model,
            supportsVision: Boolean(m.supportsVision),
            supportsReasoning: Boolean(m.supportsReasoning),
            source: 'custom' as const,
          }))

          let gatewayModels: Array<{
            id: string; provider: string; name: string; displayName: string;
            model: string; apiKey: string; supportsVision: boolean; supportsReasoning?: boolean; source: string;
          }> = []
          try {
            const gwResult = await handleGatewayGetModels(null as any)
            const gwList = Array.isArray(gwResult) ? gwResult
              : (gwResult && typeof gwResult === 'object' && Array.isArray((gwResult as any).data))
                ? (gwResult as any).data
                : []
            gatewayModels = (gwList as Array<Record<string, unknown>>).map((m) => ({
              id: String(m.id ?? ''),
              provider: String(m.provider ?? ''),
              name: String(m.name ?? ''),
              displayName: String(m.displayName ?? m.name ?? ''),
              model: String(m.model ?? ''),
              apiKey: String(m.apiKey ?? ''),
              supportsVision: Boolean(m.supportsVision),
              supportsReasoning: Boolean(m.supportsReasoning),
              source: 'system' as const,
            }))
          } catch (gwErr) {
            logError('bridge', '获取网关模型失败（降级为仅本地模型）', {
              error: gwErr instanceof Error ? gwErr.message : String(gwErr),
            })
          }

          type ModelItem = { id: string; provider: string; name: string; displayName: string; model: string; apiKey?: string; supportsVision: boolean; supportsReasoning?: boolean; source: string }
          const mergedMap = new Map<string, ModelItem>()
          for (const m of localModels) mergedMap.set(m.id, m)
          for (const m of gatewayModels) {
            if (!mergedMap.has(m.id)) mergedMap.set(m.id, m)
          }
          const mergedModels = [...mergedMap.values()]

          respond({
            type: 'bridge:models',
            requestId,
            models: mergedModels.map(({ source, ...m }) => m),
            activeModelConfigId: providersState.activeModelConfigId,
          })
          break
        }

        /* ---- 轮询任务状态 ---- */
        case 'bridge:poll-task-status': {
          const projectId = String(msg.projectId || '')
          if (!projectId) {
            respond({ type: 'bridge:task-status', requestId, isProcessing: false, error: 'projectId required' })
            break
          }
          try {
            const mgr = getBridgeManager()
            const isProcessing = mgr.isProjectProcessing(projectId)
            const activeTaskId = mgr.getActiveTaskForProject(projectId)
            respond({
              type: 'bridge:task-status',
              requestId,
              isProcessing,
              activeTaskId: activeTaskId || null,
            })
          } catch (err) {
            respond({
              type: 'bridge:task-status',
              requestId,
              isProcessing: false,
              error: err instanceof Error ? err.message : String(err),
            })
          }
          break
        }

        /* ---- 切换模型 ---- */
        case 'bridge:switch-model': {
          const modelConfigId = String(msg.modelConfigId || '').trim()
          if (!modelConfigId) {
            respond({ type: 'bridge:model-switched', requestId, success: false, error: 'modelConfigId required' })
            break
          }
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) {
              win.webContents.send('bridge:switch-model-from-mobile', { modelConfigId })
            }
          }
          respond({ type: 'bridge:model-switched', requestId, success: true })
          break
        }

        /* ---- 按需加载消息详情 ---- */
        case 'bridge:get-message-detail': {
          const rawSessionId = String(msg.sessionId || '').trim()
          const messageId = String(msg.messageId || '').trim()
          if (!rawSessionId || !messageId) {
            respond({ type: 'bridge:message-detail', requestId, messageId, error: 'sessionId and messageId required' })
            break
          }
          const state = await getAppState()
          const activeThread = state.threadsState.threads.find((t: any) => t.id === rawSessionId)
          const sessionId = activeThread?.activeSessionId || activeThread?.sessions?.[0]?.id || rawSessionId
          const fullMsg = loadChatStoreMessageById(sessionId, messageId)
          if (!fullMsg) {
            respond({ type: 'bridge:message-detail', requestId, messageId, error: 'message not found' })
            break
          }
          respond({
            type: 'bridge:message-detail',
            requestId,
            messageId,
            message: stripDataUrlFromMessages([fullMsg])[0],
          })
          break
        }

        /* ---- 按需加载步骤详情 ---- */
        case 'bridge:get-step-detail': {
          const rawSessionId = String(msg.sessionId || '').trim()
          const messageId = String(msg.messageId || '').trim()
          const stepRound = Number(msg.stepRound)
          if (!rawSessionId || !messageId || isNaN(stepRound)) {
            respond({ type: 'bridge:step-detail', requestId, messageId, stepRound, error: 'sessionId, messageId, and stepRound required' })
            break
          }
          const state = await getAppState()
          const activeThread = state.threadsState.threads.find((t: any) => t.id === rawSessionId)
          const sessionId = activeThread?.activeSessionId || activeThread?.sessions?.[0]?.id || rawSessionId
          const fullMsg = loadChatStoreMessageById(sessionId, messageId)
          if (!fullMsg) {
            respond({ type: 'bridge:step-detail', requestId, messageId, stepRound, error: 'message not found' })
            break
          }
          const agentSteps: any[] = Array.isArray((fullMsg as any).agentSteps) ? (fullMsg as any).agentSteps : []
          const step = agentSteps.find((s: any) => s.round === stepRound)
          if (!step) {
            respond({ type: 'bridge:step-detail', requestId, messageId, stepRound, error: 'step not found' })
            break
          }
          respond({
            type: 'bridge:step-detail',
            requestId,
            messageId,
            stepRound,
            stepDetail: {
              thinking: step.thinking || '',
              toolCallsArgs: Array.isArray(step.toolCalls)
                ? step.toolCalls.map((tc: any) => ({
                    id: tc.id,
                    arguments: tc.function?.arguments || tc.arguments || '',
                  }))
                : [],
              toolResultsDetail: Array.isArray(step.toolResults)
                ? step.toolResults.map((tr: any) => ({
                    tool_call_id: tr.tool_call_id || '',
                    content: tr.content || '',
                    fileChange: tr.fileChange || null,
                  }))
                : [],
            },
          })
          break
        }

        /* ---- 获取上传凭据 ---- */
        case 'bridge:upload-token-request': {
          try {
            const fileName = String(msg.fileName || 'upload.png').trim()
            const mimeType = String(msg.mimeType || 'image/png').trim()
            const hash = msg.hash ? String(msg.hash).trim() : ''

            const mgr = getBridgeManager()
            const token = mgr.getToken()
            if (!token) {
              respond({
                type: 'bridge:upload-token-response',
                requestId,
                success: false,
                error: '未登录，无法获取上传凭证',
              })
              break
            }

            const body: Record<string, string> = {
              file_name: fileName,
              mime_type: mimeType,
            }
            if (hash) body.hash = hash

            const resp = await fetch('https://agent.bjctykj.com/api/member/storage/upload-token', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
              },
              body: JSON.stringify(body),
            })

            if (!resp.ok) {
              const errText = await resp.text().catch(() => '')
              respond({
                type: 'bridge:upload-token-response',
                requestId,
                success: false,
                error: `网关返回错误 (${resp.status}): ${errText}`,
              })
              break
            }

            const json = await resp.json() as any
            if (json.code !== 0 || !json.data) {
              respond({
                type: 'bridge:upload-token-response',
                requestId,
                success: false,
                error: `网关返回异常: ${json.message || '未知错误'}`,
              })
              break
            }

            const data = json.data
            if (data.reused === true && data.public_url) {
              respond({
                type: 'bridge:upload-token-response',
                requestId,
                success: true,
                reused: true,
                publicUrl: data.public_url,
              })
              break
            }

            respond({
              type: 'bridge:upload-token-response',
              requestId,
              success: true,
              provider: data.provider || 'qiniu',
              uploadUrl: data.upload_url || '',
              token: data.token || '',
              key: data.key || '',
              publicBaseUrl: (data.public_base_url || '').replace(/\/+$/, ''),
            })
          } catch (err) {
            logError('bridge', '网关获取上传凭据失败', {
              error: err instanceof Error ? err.message : String(err),
            })
            respond({
              type: 'bridge:upload-token-response',
              requestId,
              success: false,
              error: err instanceof Error ? err.message : '获取上传凭据失败',
            })
          }
          break
        }

        default:
          respond({ type: 'error', requestId, message: `Unknown request type: ${type}` })
          break
      }
    } catch (err) {
      logError('bridge-data-handler', `处理移动端请求 ${type} 失败`, {
        error: err instanceof Error ? err.message : String(err),
        requestId,
      }, undefined)
      const ERROR_RESPONSE_TYPE_MAP: Record<string, string> = {
        'bridge:file-read': 'bridge:file-content',
        'bridge:file-write': 'bridge:file-written',
        'bridge:get-projects': 'bridge:projects',
        'bridge:get-workspace-tree': 'bridge:workspace-tree',
        'bridge:poll-task-status': 'bridge:task-status',
        'bridge:get-models': 'bridge:models',
        'bridge:switch-model': 'bridge:model-switched',
        'bridge:switch-project': 'bridge:project-switched',
        'bridge:get-message-detail': 'bridge:message-detail',
        'bridge:get-step-detail': 'bridge:step-detail',
        'bridge:load-older-messages': 'bridge:older-messages',
        'bridge:request-state': 'bridge:state',
        'bridge:set-auth-level': 'bridge:auth-level-set',
        'bridge:upload-token-request': 'bridge:upload-token-response',
      }
      respond({
        type: ERROR_RESPONSE_TYPE_MAP[type] || type,
        requestId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })
}

