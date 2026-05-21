/**
 * BridgeManager — WebSocket 连接管理与消息收发（新版：会员登录 + 扫码登录）
 *
 * 作为 Host（桌面端），负责：
 * - 使用会员 token 连接 Relay
 * - 维持 WebSocket 长连接与心跳
 * - 广播桥接消息（对话、Agent 事件、文件变更）
 * - 接收 Client 指令（发送消息、确认、终止）
 * - 自动重连与状态恢复
 */

import WebSocket from 'ws'
import {
  DEFAULT_RELAY_URL,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  RECONNECT_INTERVAL_MS,
  MAX_RECONNECT_ATTEMPTS,
  type BridgeConnectionStatus,
  type BridgeStatus,
  type BridgeHostMessage,
  type BridgeClientMessage,
  type BridgeMessage,
  type BridgeMessagePriority,
} from './bridge-protocol'
import { BridgeSyncManager } from './bridge-sync-manager'

/* ------------------------------------------------------------------ */
/*  Event callbacks                                                    */
/* ------------------------------------------------------------------ */

export type BridgeStatusCallback = (status: BridgeStatus) => void
export type BridgeClientMessageCallback = (msg: BridgeClientMessage) => void
export type BridgeClientConnectedCallback = () => void

/** 数据请求处理器 — 由 IPC 注册，处理移动端数据查询指令 */
export type BridgeDataRequestHandler = (msg: Record<string, unknown>, respond: (data: Record<string, unknown>) => void) => void

/** 项目状态信息 */
export interface ProjectStateInfo {
  id: string
  title: string
  workspace?: string
  isProcessing: boolean
  activeTaskId?: string
  lastActivityAt: number
  // 新增：最后一条消息的状态（用于移动端侧边栏和消息气泡显示）
  lastMessageId?: string        // 最后一条消息 ID
  lastMessageRole?: string      // 最后一条消息角色（user/assistant）
  lastMessageHasContent?: boolean  // 最后一条消息是否有内容
  lastMessageIsStreaming?: boolean  // 最后一条消息是否正在流式输出
  lastMessageHasPlan?: boolean     // 最后一条消息是否有执行计划
}

/* ------------------------------------------------------------------ */
/*  BridgeManager                                                      */
/* ------------------------------------------------------------------ */

export class BridgeManager {
  /* config */
  private relayUrl: string
  private token: string | null = null

  /* state */
  private ws: WebSocket | null = null
  private status: BridgeConnectionStatus = 'disconnected'
  private clientCount = 0
  private error: string | undefined

  /* heartbeat */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private lastHeartbeatReceived = 0
  private heartbeatCheckTimer: ReturnType<typeof setInterval> | null = null

  /* reconnect */
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pendingMessages: BridgeHostMessage[] = []
  private readonly maxPendingMessages = 200
  /** 重连前的客户端数量，用于判断重连后是否需要推送状态 */
  private previousClientCount = 0

  /* token refresh */
  private tokenExpiresAt = 0
  private tokenRefreshTimer: ReturnType<typeof setTimeout> | null = null
  private readonly TOKEN_REFRESH_BEFORE_MS = 5 * 60 * 1000 // 到期前 5 分钟刷新
  private readonly DEFAULT_TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000 // 默认 24 小时

  /* project state cache */
  private projectStates = new Map<string, ProjectStateInfo>()
  private _activeThreadId: string | null = null
  private stateReportTimer: ReturnType<typeof setInterval> | null = null
  private readonly STATE_REPORT_INTERVAL_MS = 5000 // 每 5 秒上报一次项目状态

  /* sync manager */
  private syncManager = new BridgeSyncManager()

  /* callbacks */
  private statusCallbacks = new Set<BridgeStatusCallback>()
  private clientMessageCallbacks = new Set<BridgeClientMessageCallback>()
  private clientConnectedCallbacks = new Set<BridgeClientConnectedCallback>()
  private dataHandler: BridgeDataRequestHandler | null = null

  constructor(relayUrl: string = DEFAULT_RELAY_URL) {
    this.relayUrl = relayUrl
  }

  /* ------------------------------------------------------------------ */
  /*  Public API                                                         */
  /* ------------------------------------------------------------------ */

  /** 设置会员 Token 并连接 Relay */
  connect(token: string, expiresAt?: number, orderedProjectIds?: string[]): void {
    this.token = token
    // 从 JWT 中解析过期时间，或使用传入的 expiresAt，或默认 24h
    if (expiresAt && expiresAt > 0) {
      this.tokenExpiresAt = expiresAt
    } else {
      const parsed = this.parseJwtExpiry(token)
      this.tokenExpiresAt = parsed || Date.now() + this.DEFAULT_TOKEN_LIFETIME_MS
    }
    if (this.status === 'connected' || this.status === 'connecting') {
      this.disconnect()
    }
    this.reconnectAttempts = 0
    this.pendingMessages = []
    
    // 设置同步管理器的发送函数
    this.syncManager.setSendFunction((msg) => this.sendHostMessageDirect(msg))
    
    this.connectToRelay(orderedProjectIds)
  }

  /** 获取当前桥接状态快照 */
  getStatus(): BridgeStatus {
    return {
      status: this.status,
      clientCount: this.clientCount,
      error: this.error,
    }
  }

  /** 发送 Host 消息到 Relay（支持优先级） */
  sendHostMessage(msg: BridgeHostMessage, priority: BridgeMessagePriority = 'normal'): void {
    // 使用同步管理器处理优先级、ACK、缓存、节流
    this.syncManager.sendMessage(msg, priority)
  }

  /** 直接发送消息（不经过同步管理器，用于内部使用） */
  private sendHostMessageDirect(msg: BridgeHostMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    } else {
      // 离线时缓存消息（限制数量）
      if (this.pendingMessages.length < this.maxPendingMessages) {
        this.pendingMessages.push(msg)
      }
    }
  }

  /** 获取当前 Token（用于网关接口调用） */
  getToken(): string | null {
    return this.token
  }

  /** 断开连接 */
  disconnect(): void {
    this.clearTimers()
    this.previousClientCount = this.clientCount
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.pendingMessages = []
    this.token = null
    this.clientCount = 0
    this.reconnectAttempts = 0
    this.syncManager.dispose()
    this.setStatus('disconnected')
  }

  /** 刷新 Token（由外部调用，用于 Token 过期时自动续期） */
  refreshToken(newToken: string, orderedProjectIds?: string[]): void {
    logBridge('Token refresh requested')
    this.token = newToken
    // 断开当前连接，使用新 Token 重连
    this.clearTimers()
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.reconnectAttempts = 0
    this.connectToRelay(orderedProjectIds)
  }

  /** 监听状态变更 返回取消订阅函数 */
  onStatusChange(cb: BridgeStatusCallback): () => void {
    this.statusCallbacks.add(cb)
    return () => { this.statusCallbacks.delete(cb) }
  }

  /** 监听 Client 消息 返回取消订阅函数 */
  onClientMessage(cb: BridgeClientMessageCallback): () => void {
    this.clientMessageCallbacks.add(cb)
    return () => { this.clientMessageCallbacks.delete(cb) }
  }

  /** 监听移动端连接成功事件 返回取消订阅函数 */
  onClientConnected(cb: BridgeClientConnectedCallback): () => void {
    this.clientConnectedCallbacks.add(cb)
    return () => { this.clientConnectedCallbacks.delete(cb) }
  }

  /** 发送心跳（对外暴露，供外部定时器使用） */
  sendHeartbeat(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }))
    }
  }

  /** 设置数据请求处理器（由 IPC 注册层调用） */
  setDataHandler(handler: BridgeDataRequestHandler | null): void {
    this.dataHandler = handler
  }

  /** 直接发送原始消息到 Relay */
  sendRawMessage(data: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data))
    }
  }

  /** 更新项目状态（由 IPC 层调用，当 Agent 开始/结束任务时） */
  updateProjectState(projectId: string, updates: Partial<Pick<ProjectStateInfo, 'title' | 'workspace' | 'isProcessing' | 'activeTaskId' | 'lastMessageId' | 'lastMessageRole' | 'lastMessageHasContent' | 'lastMessageIsStreaming' | 'lastMessageHasPlan'>>): void {
    const existing = this.projectStates.get(projectId)
    const now = Date.now()
    if (existing) {
      this.projectStates.set(projectId, {
        ...existing,
        ...updates,
        activeTaskId: updates.activeTaskId, // 显式覆盖，包括 undefined（清除）
        lastActivityAt: now,
      })
    } else {
      this.projectStates.set(projectId, {
        id: projectId,
        title: updates.title || '',
        workspace: updates.workspace,
        isProcessing: updates.isProcessing ?? false,
        activeTaskId: updates.activeTaskId,
        lastActivityAt: now,
      })
    }
    logBridge(`Project state updated: ${projectId} (processing: ${updates.isProcessing})`)
  }

  /** 更新项目状态并立即推送给移动端（由 IPC 层调用，当 Agent 开始/结束任务时） */
  updateProjectStateAndPush(projectId: string, updates: Partial<Pick<ProjectStateInfo, 'title' | 'workspace' | 'isProcessing' | 'activeTaskId' | 'lastMessageId' | 'lastMessageRole' | 'lastMessageHasContent' | 'lastMessageIsStreaming' | 'lastMessageHasPlan'>>): void {
    this.updateProjectState(projectId, updates)
    // 立即推送给移动端，确保状态即时同步
    this.pushProjectsOnDemand()
    logBridge(`Project state updated and pushed: ${projectId} (processing: ${updates.isProcessing})`)
  }

  /** 获取所有项目状态列表 */
  getProjectStates(): ProjectStateInfo[] {
    return Array.from(this.projectStates.values())
  }

  /** 获取单个项目状态 */
  getProjectState(projectId: string): ProjectStateInfo | undefined {
    return this.projectStates.get(projectId)
  }

  /** 判断指定项目是否正在处理任务 */
  isProjectProcessing(projectId: string): boolean {
    const state = this.projectStates.get(projectId)
    return state?.isProcessing ?? false
  }

  /** 获取指定项目的活跃任务 ID */
  getActiveTaskForProject(projectId: string): string | undefined {
    const state = this.projectStates.get(projectId)
    return state?.activeTaskId
  }

  /** 设置当前活跃项目（由 IPC 层调用，当桌面端切换项目时） */
  setActiveThread(threadId: string | null, orderedProjectIds?: string[]): void {
    this._activeThreadId = threadId
    logBridge(`Active thread set to: ${threadId}`)
    // 立即推送一次项目状态，使移动端同步更新活跃项目
    this.pushProjectsOnDemand(orderedProjectIds)
  }

  /** 获取当前活跃项目 ID */
  getActiveThreadId(): string | null {
    return this._activeThreadId
  }

  /** 启动定期状态上报定时器 */
  startStateReportTimer(orderedProjectIds?: string[]): void {
    this.stopStateReportTimer()
    this.stateReportTimer = setInterval(() => {
      this.reportProjectStates(orderedProjectIds)
    }, this.STATE_REPORT_INTERVAL_MS)
  }

  /** 停止定期状态上报定时器 */
  stopStateReportTimer(): void {
    if (this.stateReportTimer) {
      clearInterval(this.stateReportTimer)
      this.stateReportTimer = null
    }
  }

  /** 向移动端推送当前所有项目状态 */
  private reportProjectStates(orderedProjectIds?: string[]): void {
    if (this.projectStates.size === 0) return
    let states = Array.from(this.projectStates.values()).map((s) => ({
      id: s.id,
      title: s.title,
      workspace: s.workspace,
      isProcessing: s.isProcessing,
      activeTaskId: s.activeTaskId,
      lastActivityAt: s.lastActivityAt,
      // 新增：最后一条消息的状态
      lastMessageId: s.lastMessageId,
      lastMessageRole: s.lastMessageRole,
      lastMessageHasContent: s.lastMessageHasContent,
      lastMessageIsStreaming: s.lastMessageIsStreaming,
      lastMessageHasPlan: s.lastMessageHasPlan,
    }))
    
    // 如果提供了顺序信息，按照指定顺序排序项目状态
    if (orderedProjectIds && orderedProjectIds.length > 0 && states.length > 0) {
      states.sort((a, b) => {
        const indexA = orderedProjectIds.indexOf(a.id)
        const indexB = orderedProjectIds.indexOf(b.id)
        // 如果两个项目都在顺序列表中，按指定顺序排
        if (indexA !== -1 && indexB !== -1) {
          return indexA - indexB
        }
        // 如果只有 a 在顺序列表中，a 排前面
        if (indexA !== -1) return -1
        // 如果只有 b 在顺序列表中，b 排前面
        if (indexB !== -1) return 1
        // 都不在顺序列表中，保持原顺序
        return 0
      })
    }
    
    this.sendHostMessage({
      type: 'bridge:project-states',
      states,
      activeThreadId: this._activeThreadId || '',
      timestamp: Date.now(),
    } as any)
  }

  /** 按需立即推送项目列表（不等定时器），用于项目变更时即时通知移动端 */
  pushProjectsOnDemand(orderedProjectIds?: string[]): void {
    let states = this.projectStates.size > 0
      ? Array.from(this.projectStates.values()).map((s) => ({
          id: s.id,
          title: s.title,
          workspace: s.workspace,
          isProcessing: s.isProcessing,
          activeTaskId: s.activeTaskId,
          lastActivityAt: s.lastActivityAt,
          // 新增：最后一条消息的状态
          lastMessageId: s.lastMessageId,
          lastMessageRole: s.lastMessageRole,
          lastMessageHasContent: s.lastMessageHasContent,
          lastMessageIsStreaming: s.lastMessageIsStreaming,
          lastMessageHasPlan: s.lastMessageHasPlan,
        }))
      : []
    
    // 如果提供了顺序信息，按照指定顺序排序项目状态
    if (orderedProjectIds && orderedProjectIds.length > 0 && states.length > 0) {
      states.sort((a, b) => {
        const indexA = orderedProjectIds.indexOf(a.id)
        const indexB = orderedProjectIds.indexOf(b.id)
        // 如果两个项目都在顺序列表中，按指定顺序排
        if (indexA !== -1 && indexB !== -1) {
          return indexA - indexB
        }
        // 如果只有 a 在顺序列表中，a 排前面
        if (indexA !== -1) return -1
        // 如果只有 b 在顺序列表中，b 排前面
        if (indexB !== -1) return 1
        // 都不在顺序列表中，保持原顺序
        return 0
      })
    }
    
    // 关键修复: 使用 critical 优先级，确保项目状态变更立即发送到移动端
    // 避免被节流导致移动端永久显示"处理中"
    this.sendHostMessage({
      type: 'bridge:project-states',
      states,
      activeThreadId: this._activeThreadId || '',
      timestamp: Date.now(),
    } as any, 'critical')
    logBridge(`Pushed project states on demand (${states.length} projects, activeThread: ${this._activeThreadId})`)
  }

  /* ------------------------------------------------------------------ */
  /*  Private: connection                                                */
  /* ------------------------------------------------------------------ */

  private connectToRelay(orderedProjectIds?: string[]): void {
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }

    if (!this.token) {
      this.error = '未设置会员 Token'
      this.setStatus('disconnected')
      return
    }

    this.setStatus('connecting')
    const url = `${this.relayUrl}?token=${encodeURIComponent(this.token)}&role=host`
    this.ws = new WebSocket(url)

    this.ws.on('open', () => {
      logBridge('WebSocket connected')
      this.reconnectAttempts = 0
      this.startHeartbeat()
      // 连接成功后立即更新状态，避免 UI 显示"未连接"但实际已连接
      this.setStatus('connected')

      // 发送缓存的消息
      for (const msg of this.pendingMessages) {
        this.ws!.send(JSON.stringify(msg))
      }
      this.pendingMessages = []

      // 启动 Token 自动刷新定时器
      this.startTokenRefreshTimer()

      // 启动项目状态定期上报
      this.startStateReportTimer(orderedProjectIds)

      // 重连后如果有之前连接的客户端，主动推送状态快照
      // （移动端也会通过 bridge:request-state 主动请求，这里作为兜底）
      if (this.previousClientCount > 0) {
        logBridge(`Reconnected with ${this.previousClientCount} previous clients, will push state on client_connected`)
      }
      this.previousClientCount = 0
    })

    this.ws.on('message', (raw: WebSocket.Data) => {
      try {
        const msg = JSON.parse(raw.toString()) as BridgeMessage
        this.handleRelayMessage(msg)
      } catch (err) {
        logBridgeError('Failed to parse relay message', err)
      }
    })

    this.ws.on('close', (code: number, reason: Buffer) => {
      logBridge(`WebSocket closed: ${code} ${reason.toString()}`)
      this.stopHeartbeat()
      this.ws = null
      this.setStatus('disconnected')
      this.attemptReconnect(orderedProjectIds)
    })

    this.ws.on('error', (err: Error) => {
      logBridgeError('WebSocket error', err)
      this.error = err.message || 'WebSocket 连接错误'
      this.setStatus('disconnected')
    })
  }

  /* ------------------------------------------------------------------ */
  /*  Private: message dispatch                                          */
  /* ------------------------------------------------------------------ */

  private handleRelayMessage(msg: BridgeMessage): void {
    if (!msg || typeof (msg as any).type !== 'string') return

    switch ((msg as any).type) {
      /* ---- connection established ---- */
      case 'connected': {
        this.setStatus('connected')
        break
      }

      /* ---- client management ---- */
      case 'client_connected': {
        this.clientCount++
        this.notifyStatus()
        logBridge('Client connected')
        // 通知所有监听者：移动端已连接
        for (const cb of this.clientConnectedCallbacks) {
          try { cb() } catch (err) { logBridgeError('clientConnected callback error', err) }
        }
        break
      }
      case 'client_disconnected': {
        this.clientCount = Math.max(0, this.clientCount - 1)
        this.notifyStatus()
        logBridge('Client disconnected')
        break
      }
      case 'host_disconnected': {
        // Host 收到自己断开？不应该出现
        break
      }

      /* ---- client → host messages ---- */
      case 'bridge:chat-send':
      case 'bridge:agent-confirm':
      case 'bridge:agent-abort': {
        this.lastHeartbeatReceived = Date.now()
        for (const cb of this.clientMessageCallbacks) {
          try { cb(msg as BridgeClientMessage) } catch (err) { logBridgeError('clientMessage callback error', err) }
        }
        break
      }

      /* ---- ACK 确认消息 ---- */
      case 'bridge:ack': {
        this.syncManager.handleAck(msg as any)
        break
      }

      /* ---- 重传请求 ---- */
      case 'bridge:retransmit-request': {
        this.syncManager.handleRetransmitRequest(msg as any)
        break
      }

      /* ---- client → host data requests ---- */
      case 'bridge:get-projects':
      case 'bridge:get-workspace-tree':
      case 'bridge:file-read':
      case 'bridge:file-write':
      case 'bridge:switch-project':
      case 'bridge:get-models':
      case 'bridge:switch-model':
      case 'bridge:request-state':
      case 'bridge:load-older-messages':
      case 'bridge:poll-task-status': {
        this.lastHeartbeatReceived = Date.now()
        if (this.dataHandler) {
          const respond = (data: Record<string, unknown>) => {
            this.sendRawMessage(data)
          }
          try {
            this.dataHandler(msg as unknown as Record<string, unknown>, respond)
          } catch (err) {
            logBridgeError('dataHandler error', err)
            respond({
              type: (msg as any).type?.toString().replace(/^bridge:/, 'bridge:') || 'error',
              requestId: (msg as any).requestId || '',
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
        break
      }

      /* ---- heartbeat ---- */
      case 'ping': {
        this.lastHeartbeatReceived = Date.now()
        break
      }

      /* ---- error ---- */
      case 'error': {
        const errMsg = (msg as any).message || ''
        this.error = errMsg
        logBridge(`Relay error: ${errMsg}`)
        // 401 错误：Token 过期，停止重连，上报 token 失效事件
        if (errMsg.includes('401') || errMsg.includes('unauthorized') || errMsg.includes('invalid token')) {
          logBridge('Token expired, stopping reconnect')
          this.reconnectAttempts = MAX_RECONNECT_ATTEMPTS // 阻止重连
          this.setStatus('disconnected')
          // 通知渲染进程 Token 失效
          const status = this.getStatus()
          for (const cb of this.statusCallbacks) {
            try { cb({ ...status, tokenExpired: true } as any) } catch (err) { logBridgeError('status callback error', err) }
          }
        }
        break
      }

      default:
        break
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Private: heartbeat                                                 */
  /* ------------------------------------------------------------------ */

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.lastHeartbeatReceived = Date.now()

    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat()
    }, HEARTBEAT_INTERVAL_MS)

    this.heartbeatCheckTimer = setInterval(() => {
      const elapsed = Date.now() - this.lastHeartbeatReceived
      if (elapsed > HEARTBEAT_TIMEOUT_MS) {
        logBridge('Heartbeat timeout, reconnecting...')
        this.ws?.close()
      }
    }, 10_000)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
    if (this.heartbeatCheckTimer) { clearInterval(this.heartbeatCheckTimer); this.heartbeatCheckTimer = null }
  }

  /* ------------------------------------------------------------------ */
  /*  Private: reconnect                                                 */
  /* ------------------------------------------------------------------ */

  private attemptReconnect(orderedProjectIds?: string[]): void {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.error = '重连次数已达上限'
      this.setStatus('disconnected')
      return
    }

    this.reconnectAttempts++
    this.setStatus('reconnecting')

    const delay = Math.min(RECONNECT_INTERVAL_MS * Math.pow(1.5, this.reconnectAttempts - 1), 30_000)
    logBridge(`Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`)

    this.reconnectTimer = setTimeout(() => {
      this.connectToRelay(orderedProjectIds)
    }, delay)
  }

  /* ------------------------------------------------------------------ */
  /*  Private: token refresh                                             */
  /* ------------------------------------------------------------------ */

  /** 启动 Token 自动刷新定时器，在过期前 TOKEN_REFRESH_BEFORE_MS 触发 */
  private startTokenRefreshTimer(): void {
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer)
      this.tokenRefreshTimer = null
    }

    if (!this.tokenExpiresAt || this.tokenExpiresAt <= 0) return

    const now = Date.now()
    const refreshAt = this.tokenExpiresAt - this.TOKEN_REFRESH_BEFORE_MS
    const delay = Math.max(0, refreshAt - now)

    logBridge(`Token refresh scheduled in ${Math.round(delay / 1000)}s (expires at ${new Date(this.tokenExpiresAt).toISOString()})`)

    this.tokenRefreshTimer = setTimeout(() => {
      this.doTokenRefresh()
    }, delay)
  }

  /** 调用 /api/bridge/refresh_token 获取新 Token */
  private async doTokenRefresh(): Promise<void> {
    if (!this.token) {
      logBridge('Token refresh skipped: no token')
      return
    }

    // 将 ws/wss URL 转换为 http/https URL
    const apiBase = this.relayUrl
      .replace(/^ws:/, 'http:')
      .replace(/^wss:/, 'https:')
      .replace(/\/ws\/?$/, '') // 移除 /ws 路径后缀
    const refreshUrl = `${apiBase}/api/bridge/refresh_token`

    logBridge(`Refreshing token via ${refreshUrl}`)

    try {
      const https = await import('https')
      const http = await import('http')
      const isHttps = refreshUrl.startsWith('https:')
      const lib = isHttps ? https : http

      const urlObj = new URL(refreshUrl)
      const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
        const req = lib.request({
          hostname: urlObj.hostname,
          port: urlObj.port || (isHttps ? 443 : 80),
          path: urlObj.pathname + urlObj.search,
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json',
          },
        }, (res) => {
          let body = ''
          res.on('data', (chunk: Buffer) => { body += chunk.toString() })
          res.on('end', () => resolve({ statusCode: res.statusCode || 0, body }))
        })
        req.on('error', reject)
        req.setTimeout(10_000, () => { req.destroy(); reject(new Error('timeout')) })
        req.end()
      })

      if (response.statusCode !== 200) {
        logBridgeError(`Token refresh failed: HTTP ${response.statusCode}`, response.body)
        // 如果 Token 已过期（401），不重试；否则 30 分钟后重试
        if (response.statusCode === 401) {
          this.handleTokenExpired()
          return
        }
        this.scheduleRetryRefresh(30 * 60 * 1000)
        return
      }

      const data = JSON.parse(response.body)
      const newToken = data.token as string
      if (!newToken) {
        logBridgeError('Token refresh: no token in response', data)
        this.scheduleRetryRefresh(30 * 60 * 1000)
        return
      }

      // 更新过期时间
      if (data.expires_at) {
        this.tokenExpiresAt = (data.expires_at as number) * 1000
      } else if (data.expires_in) {
        this.tokenExpiresAt = Date.now() + (data.expires_in as number) * 1000
      } else {
        this.tokenExpiresAt = Date.now() + this.DEFAULT_TOKEN_LIFETIME_MS
      }

      logBridge(`Token refreshed successfully, new expiry: ${new Date(this.tokenExpiresAt).toISOString()}`)

      // 使用新 Token 重连
      this.refreshToken(newToken)
    } catch (err) {
      logBridgeError('Token refresh error', err)
      this.scheduleRetryRefresh(30 * 60 * 1000)
    }
  }

  /** Token 刷新失败后的重试调度 */
  private scheduleRetryRefresh(delayMs: number): void {
    if (this.tokenRefreshTimer) clearTimeout(this.tokenRefreshTimer)
    this.tokenRefreshTimer = setTimeout(() => {
      this.doTokenRefresh()
    }, delayMs)
  }

  /** 处理 Token 过期：通知渲染进程，停止自动重连 */
  private handleTokenExpired(): void {
    logBridge('Token expired, notifying renderer')
    this.token = null
    this.tokenExpiresAt = 0
    this.reconnectAttempts = MAX_RECONNECT_ATTEMPTS // 阻止自动重连
    this.setStatus('disconnected')
    // 通知渲染进程弹出登录框
    const status = this.getStatus()
    for (const cb of this.statusCallbacks) {
      try { cb({ ...status, tokenExpired: true } as any) } catch (err) { logBridgeError('status callback error', err) }
    }
  }

  /** 从 JWT Token 中解析过期时间（不验证签名） */
  private parseJwtExpiry(token: string): number | null {
    try {
      const parts = token.split('.')
      if (parts.length !== 3) return null
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
      if (payload.exp && typeof payload.exp === 'number') {
        return payload.exp * 1000 // JWT exp 是秒，转为毫秒
      }
      return null
    } catch {
      return null
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Private: utils                                                     */
  /* ------------------------------------------------------------------ */

  private clearTimers(): void {
    this.stopHeartbeat()
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    if (this.tokenRefreshTimer) { clearTimeout(this.tokenRefreshTimer); this.tokenRefreshTimer = null }
    this.stopStateReportTimer()
  }

  private setStatus(status: BridgeConnectionStatus): void {
    this.status = status
    if (status !== 'reconnecting') {
      this.error = undefined
    }
    this.notifyStatus()
  }

  private notifyStatus(): void {
    const snap = this.getStatus()
    for (const cb of this.statusCallbacks) {
      try { cb(snap) } catch (_) { /* ignore */ }
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Singleton                                                          */
/* ------------------------------------------------------------------ */

let instance: BridgeManager | null = null

export function getBridgeManager(): BridgeManager {
  if (!instance) {
    instance = new BridgeManager()
  }
  return instance
}

export function resetBridgeManager(): void {
  if (instance) {
    instance.disconnect()
    instance = null
  }
}

/* ------------------------------------------------------------------ */
/*  Logger shims                                                       */
/* ------------------------------------------------------------------ */

function logBridge(msg: string): void {
  console.log(`[BridgeManager] ${msg}`)
}

function logBridgeError(msg: string, err?: unknown): void {
  console.error(`[BridgeManager] ${msg}`, err ?? '')
}
