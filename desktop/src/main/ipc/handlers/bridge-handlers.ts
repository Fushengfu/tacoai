/**
 * Bridge IPC Handlers
 *
 * 包含 Bridge 跨端桥接相关的所有 handler：连接、状态转发、数据查询、项目切换等。
 */

import { ipcMain, BrowserWindow, nativeImage } from 'electron'
import type { IpcMainEvent } from 'electron'
import { IpcChannel } from '../../../shared/ipc'
import type { BridgeStatusPayload } from '../../../shared/ipc'
import { getBridgeManager } from '../../bridge/bridge-manager'
import type { BridgeChatMessage as BridgeChatMessageType } from '../../bridge/bridge-protocol'
import { getAppState } from '../../system/app-state'
import { loadChatStoreSessionPage } from '../../data/memory-db'
import { log, logError } from '../../system/logger'
import { agentAbortControllers } from './chat-handlers'
import { handleGatewayGetModels } from './gateway-handlers'

/* ------------------------------------------------------------------ */
/*  Workspace tree flattening to nested structure                      */
/* ------------------------------------------------------------------ */

/**
 * 将扁平的 WorkspaceEntry[] 转换为嵌套的树形结构。
 * 桌面端 getWorkspaceTree 返回扁平 entries，移动端期望嵌套 children 结构。
 */
function buildNestedTree(
  entries: Array<{ path: string; name: string; kind: string; depth: number }>,
): Array<{ name: string; path: string; isDirectory: boolean; children?: any[] }> {
  const nodeMap = new Map<string, { name: string; path: string; isDirectory: boolean; children?: any[] }>()
  const roots: Array<{ name: string; path: string; isDirectory: boolean; children?: any[] }> = []

  // 先创建所有节点
  for (const entry of entries) {
    const isDir = entry.kind === 'directory'
    const node = {
      name: entry.name,
      path: entry.path,
      isDirectory: isDir,
      children: isDir ? [] : undefined,
    }
    nodeMap.set(entry.path, node)
  }

  // 建立父子关系
  for (const entry of entries) {
    const node = nodeMap.get(entry.path)!
    const parentPath = entry.path.includes('/') ? entry.path.split('/').slice(0, -1).join('/') : ''
    
    if (parentPath && nodeMap.has(parentPath)) {
      const parent = nodeMap.get(parentPath)!
      if (!parent.children) parent.children = []
      parent.children.push(node)
    } else {
      // 根节点（没有父节点或父节点不在列表中）
      roots.push(node)
    }
  }

  // 对每个节点的 children 排序：目录在前，文件在后，按名称字母顺序
  for (const node of nodeMap.values()) {
    if (node.children) {
      node.children.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) {
          return a.isDirectory ? -1 : 1
        }
        return a.name.localeCompare(b.name)
      })
    }
  }

  // 根节点也排序
  roots.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1
    }
    return a.name.localeCompare(b.name)
  })

  return roots
}

/** 注册 renderer 项目切换完成回调：renderer 加载消息后推送 bridge:state 给移动端 */
export function setupBridgeSwitchProjectLoadedHandler(): void {
  ipcMain.on('bridge:switch-project-loaded', async (_event, payload: { projectId: string; sessionId: string }) => {
    try {
      const projectId = String(payload.projectId || '')
      const sessionId = String(payload.sessionId || '')
      if (!projectId || !sessionId) return

      const state = await getAppState()
      const activeThread = state.threadsState.threads.find((t) => t.id === projectId)
      if (!activeThread) return

      const page = loadChatStoreSessionPage(sessionId, { limit: 50 })
      if (!page || !Array.isArray(page.messages)) return

      const modelConfig = state.providersState.modelConfigs.find(
        (m) => m.id === activeThread.modelConfigId,
      )
      const hasActiveTask = agentAbortControllers.size > 0 &&
        Array.from(agentAbortControllers.keys()).some(key => {
          return key.includes(sessionId) || key.includes(activeThread.id)
        })
      const activeAgentRequestId = hasActiveTask ? `agent-${sessionId}` : undefined

      const mgr = getBridgeManager()
      mgr.sendHostMessage({
        type: 'bridge:state',
        messages: stripDataUrlFromMessages(page.messages) as BridgeChatMessageType[],
        threadId: activeThread.id,
        workspace: activeThread.workspace,
        modelLabel: modelConfig?.model || modelConfig?.name || '',
        modelConfigId: activeThread.modelConfigId,
        threadTitle: activeThread.title,
        projectTitle: activeThread.title,
        timestamp: Date.now(),
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
/*  Image data stripping for bridge (reduce WebSocket payload)         */
/* ------------------------------------------------------------------ */

/**
 * 压缩 base64 图片 dataUrl，使其适合 WebSocket 传输。
 * 使用 Electron nativeImage 缩放 + JPEG 压缩，目标 80KB 以下。
 */
function compressDataUrlForBridge(dataUrl: string, maxChars: number = 110_000): string {
  try {
    const img = nativeImage.createFromDataURL(dataUrl)
    if (img.isEmpty()) return dataUrl

    const size = img.getSize()
    const maxDim = 800

    let scale = 1
    if (size.width > maxDim || size.height > maxDim) {
      scale = Math.min(maxDim / size.width, maxDim / size.height)
    }

    const newWidth = Math.max(1, Math.round(size.width * scale))
    const newHeight = Math.max(1, Math.round(size.height * scale))
    const resized = img.resize({ width: newWidth, height: newHeight, quality: 'best' })

    // 从质量 70 开始递减，直到目标大小以下
    for (const q of [70, 55, 40, 25]) {
      const buf = resized.toJPEG(q)
      const jpeg = `data:image/jpeg;base64,${buf.toString('base64')}`
      if (jpeg.length <= maxChars) return jpeg
    }
    // 最低质量兜底
    const fallbackBuf = resized.toJPEG(25)
    return `data:image/jpeg;base64,${fallbackBuf.toString('base64')}`
  } catch {
    return dataUrl
  }
}

/**
 * 从消息列表中剥离图片 dataUrl（base64），只保留 cloudUrl + 元数据。
 * 大幅减少通过 WebSocket 推送到移动端的数据量。
 *
 * 规则（v2 — 压缩替代丢弃）：
 * - 如果有 cloudUrl：去掉 dataUrl（移动端用 Image.network 加载）
 * - 如果没有 cloudUrl 且 dataUrl < 100KB：保留 dataUrl（唯一显示方式）
 * - 如果没有 cloudUrl 且 dataUrl >= 100KB：压缩为 JPEG 后保留（不再丢弃）
 */
function stripDataUrlFromMessages(messages: unknown[]): unknown[] {
  return messages.map((msg: any) => {
    if (!msg || typeof msg !== 'object') return msg

    const result = { ...msg }

    // 处理 images 数组
    if (Array.isArray(result.images)) {
      result.images = result.images.map((img: any) => {
        if (!img || typeof img !== 'object') return img
        if (typeof img.dataUrl !== 'string' || img.dataUrl.length === 0) return img

        const hasCloudUrl = typeof img.cloudUrl === 'string' && img.cloudUrl.length > 0
        if (hasCloudUrl) {
          // 有云端 URL，去掉 dataUrl
          const { dataUrl, ...rest } = img
          return rest
        }

        // 没有 cloudUrl，检查 dataUrl 大小
        if (img.dataUrl.length > 100 * 1024) {
          // 超过 100KB：压缩而非丢弃
          const compressed = compressDataUrlForBridge(img.dataUrl)
          return { ...img, dataUrl: compressed }
        }

        // 小于 100KB 且无 cloudUrl，保留 dataUrl 作为唯一显示方式
        return img
      })
    }

    // 处理 content 数组中的 image_url（多模态格式）
    if (Array.isArray(result.content)) {
      result.content = result.content.map((part: any) => {
        if (!part || typeof part !== 'object') return part
        if (part.type === 'image_url' && part.image_url?.url) {
          const url = part.image_url.url as string
          if (url.startsWith('data:')) {
            // 压缩而非置空
            const compressed = compressDataUrlForBridge(url)
            return { ...part, image_url: { ...part.image_url, url: compressed } }
          }
        }
        return part
      })
    }

    return result
  })
}

/* ------------------------------------------------------------------ */
/*  Bridge connection handlers                                         */
/* ------------------------------------------------------------------ */

/** 使用会员 token 连接 Relay */
export function handleBridgeConnect(_event: IpcMainEvent, token: string): void {
  const mgr = getBridgeManager()
  mgr.connect(token)
}

/** 断开桥接连接 */
export function handleBridgeDisconnect(): void {
  getBridgeManager().disconnect()
}

/** 获取当前桥接状态 */
export async function handleBridgeGetStatus(): Promise<BridgeStatusPayload> {
  return getBridgeManager().getStatus()
}

/** 刷新 Token（用于 Token 过期时自动续期） */
export function handleBridgeRefreshToken(_event: IpcMainEvent, newToken: string): void {
  getBridgeManager().refreshToken(newToken)
}

/* ------------------------------------------------------------------ */
/*  Bridge status forwarding                                           */
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
  // 移动端消息转发到渲染进程
  mgr.onClientMessage((msg) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IpcChannel.BRIDGE_CLIENT_MESSAGE, msg)
      }
    }
  })
}

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

      // 同步更新 BridgeManager 的活跃项目
      const orderedProjectIds = state.threadsState.threads.map(t => t.id)
      mgr.setActiveThread(state.threadsState.activeThreadId, orderedProjectIds)

      // 同步所有项目的 modelConfigId（供 project-states 推送给移动端）
      mgr.syncProjectModelConfigs(state.threadsState.threads)

      // 不再主动推送全量快照，改为等待手机端发送 bridge:request-state 请求
      // 手机端优先从本地 SQLite 缓存加载消息，按需请求快照
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

/** 注册移动端数据查询处理器：处理移动端发送的项目列表、目录树、文件读写等请求 */
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
            activeThreadId: state.threadsState.activeThreadId,
          })
          // 同时触发即时推送，减少移动端下次等待
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
          const { getWorkspaceTree } = await import('../../tools')
          const result = await getWorkspaceTree(cwd)
          
          // 将扁平 entries 转换为嵌套树形结构（适配移动端期望的格式）
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
            // 解析文件路径：如果是相对路径，拼接当前活跃项目的 workspace 路径
            let resolvedPath = filePath
            if (!nodePath.isAbsolute(filePath)) {
              const state = await getAppState()
              const activeThread = state.threadsState.threads.find(
                (t) => t.id === state.threadsState.activeThreadId,
              )
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
            // 解析文件路径：如果是相对路径，拼接当前活跃项目的 workspace 路径
            let resolvedPath = filePath
            if (!nodePath.isAbsolute(filePath)) {
              const state = await getAppState()
              const activeThread = state.threadsState.threads.find(
                (t) => t.id === state.threadsState.activeThreadId,
              )
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
          // 先立即返回成功响应，让移动端 UI 立即响应
          respond({ type: 'bridge:project-switched', requestId, success: true })

          // 立即更新 BridgeManager 的活跃项目并推送移动端
          try {
            const mgr = getBridgeManager()
            const state = await getAppState()
            const orderedProjectIds = state.threadsState.threads.map(t => t.id)
            mgr.setActiveThread(projectId, orderedProjectIds)
            // 同步所有项目的 modelConfigId（切换项目时刷新）
            mgr.syncProjectModelConfigs(state.threadsState.threads)
          } catch { /* bridge 未初始化时忽略 */ }
          
          // 通知所有 renderer 切换项目（异步，不阻塞响应）
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) {
              win.webContents.send('bridge:switch-project-from-mobile', { projectId, sessionId })
            }
          }
          // bridge:state 推送由 renderer 完成消息加载后通过 bridge:switch-project-loaded 触发
          // 参见 setupBridgeSwitchProjectLoadedHandler()
          break
        }

        /* ---- 移动端主动请求状态快照（连接/重连后使用） ---- */
        case 'bridge:request-state': {
          try {
            const state = await getAppState()
            // 关键修复：优先使用移动端指定的 threadId，避免使用渲染进程的 activeThreadId（可能滞后）
            const requestedThreadId = String(msg.threadId || '').trim()
            const resolvedThreadId = requestedThreadId || state.threadsState.activeThreadId
            const activeThread = state.threadsState.threads.find(
              (t) => t.id === resolvedThreadId,
            )
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
              // 关键修复：只在有活跃任务时推送 activeAgentRequestId
              const activeAgentRequestId = hasActiveTask ? `agent-${resolvedSessionId}` : undefined

              respond({
                type: 'bridge:state',
                requestId,
                messages: stripDataUrlFromMessages(page.messages) as BridgeChatMessageType[],
                threadId: activeThread.id,
                workspace: activeThread.workspace,
                modelLabel: modelConfig?.model || modelConfig?.name || '',
                modelConfigId: activeThread.modelConfigId,
                threadTitle: activeThread.title,
                projectTitle: activeThread.title,
                timestamp: Date.now(),
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
            messages: stripDataUrlFromMessages(page.messages),
            totalCount: page.totalCount,
            startSeq: page.startSeq,
            endSeq: page.endSeq,
          })
          break
        }

        /* ---- 模型列表（合并本地自定义模型 + 网关内置模型） ---- */
        case 'bridge:get-models': {
          const state = await getAppState()
          const providersState = state.providersState

          // 本地自定义模型
          const localModels = providersState.modelConfigs.map((m) => ({
            id: m.id,
            provider: m.provider,
            name: m.name,
            displayName: m.name,
            model: m.model,
            supportsVision: Boolean(m.supportsVision),
            source: 'custom' as const,
          }))

          // 网关内置模型：复用桌面端已有的 handleGatewayGetModels，保持逻辑完全一致
          let gatewayModels: Array<{
            id: string; provider: string; name: string; displayName: string;
            model: string; supportsVision: boolean; source: string;
          }> = []
          try {
            const gwResult = await handleGatewayGetModels(null as any)
            // handleGatewayGetModels 返回 json.data ?? json，可能是数组或包含 data 字段的对象
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
              supportsVision: Boolean(m.supportsVision),
              source: 'system' as const,
            }))
          } catch (gwErr) {
            // 网关获取失败不阻塞，只返回本地模型
            logError('bridge', '获取网关模型失败（降级为仅本地模型）', {
              error: gwErr instanceof Error ? gwErr.message : String(gwErr),
            })
          }

          // 合并去重：本地模型优先（id 相同时保留本地）
          type ModelItem = { id: string; provider: string; name: string; displayName: string; model: string; supportsVision: boolean; source: string }
          const mergedMap = new Map<string, ModelItem>()
          for (const m of localModels) {
            mergedMap.set(m.id, m)
          }
          for (const m of gatewayModels) {
            if (!mergedMap.has(m.id)) {
              mergedMap.set(m.id, m)
            }
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

        /* ---- 轮询任务状态（手机端每2秒调用） ---- */
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
          // 通知所有 renderer 切换模型
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) {
              win.webContents.send('bridge:switch-model-from-mobile', { modelConfigId })
            }
          }
          // 不再主动推送状态快照，手机端通过 bridge:project-states 获取最新 modelLabel
          respond({ type: 'bridge:model-switched', requestId, success: true })
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
      respond({
        type: type.replace(/^bridge:get-/, 'bridge:').replace(/^bridge:file-/, 'bridge:file-'),
        requestId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })
}

/** 注册移动端连接成功回调：主动推送 bridge:state 状态快照 */
export function setupBridgeStateSnapshotResponse(): void {
  ipcMain.on('bridge:state-snapshot-response', (_event, payload: {
    messages: Array<{
      id: string
      role: string
      content: string
      hasImages?: boolean
      streaming?: boolean
      agentSteps?: any[]
      activePlan?: any
      taskTiming?: any
    }>
    threadId: string
    sessionId?: string
    workspace?: string
    modelLabel?: string
    modelConfigId?: string
    threadTitle?: string
    projectTitle?: string
    activeAgentRequestId?: string
    tokenUsage?: {
      promptTokens?: number
      completionTokens?: number
      totalTokens?: number
      cachedTokens?: number
    }
  }) => {
    try {
      const mgr = getBridgeManager()
      mgr.sendHostMessage({
        type: 'bridge:state',
        messages: stripDataUrlFromMessages(payload.messages) as BridgeChatMessageType[],
        threadId: payload.threadId,
        activeAgentRequestId: payload.activeAgentRequestId,
        workspace: payload.workspace,
        modelLabel: payload.modelLabel,
        modelConfigId: payload.modelConfigId,
        threadTitle: payload.threadTitle,
        projectTitle: payload.projectTitle,
        tokenUsage: payload.tokenUsage,
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

/* ------------------------------------------------------------------ */
/*  File read/write helpers (for bridge)                               */
/* ------------------------------------------------------------------ */

import * as fs from 'node:fs/promises'
import nodePath from 'node:path'

function isBinaryBuffer(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8192)
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

function imageMimeFromPath(filePath: string): string | null {
  const ext = nodePath.extname(filePath).toLowerCase()
  const m: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
  }
  return m[ext] ?? null
}

async function handleFileRead(filePath: string): Promise<{ content: string | null; size: number; isBinary: boolean; dataUrl?: string; truncated?: boolean }> {
  const stat = await fs.stat(filePath)
  const size = stat.size
  const imageMime = imageMimeFromPath(filePath)
  const FILE_READ_HARD_LIMIT = 5 * 1024 * 1024

  if (size > FILE_READ_HARD_LIMIT) {
    return { content: null, size, isBinary: true }
  }

  const buf = Buffer.from(await fs.readFile(filePath))
  if (isBinaryBuffer(buf)) {
    if (imageMime) {
      return {
        content: null,
        size,
        isBinary: true,
        dataUrl: `data:${imageMime};base64,${buf.toString('base64')}`,
      }
    }
    const previewLen = Math.min(buf.length, 8192)
    const hexPreview = buf.subarray(0, previewLen).toString('hex')
    const lines: string[] = []
    for (let i = 0; i < hexPreview.length; i += 64) {
      lines.push(hexPreview.slice(i, i + 64))
    }
    const hexText = lines.join('\n')
    const hexDataUrl = `data:text/plain;charset=utf-8,${encodeURIComponent(hexText)}`
    return { content: null, size, isBinary: true, dataUrl: hexDataUrl }
  }

  const text = buf.toString('utf-8')
  if (imageMime === 'image/svg+xml') {
    return {
      content: text,
      size,
      isBinary: false,
      dataUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`,
    }
  }
  return { content: text, size, isBinary: false }
}

async function handleFileWrite(filePath: string, content: string): Promise<void> {
  const dir = nodePath.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(filePath, content, 'utf-8')
}
