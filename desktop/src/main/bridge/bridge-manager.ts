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
} from './bridge-protocol'

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

  /* token refresh */
  private tokenExpiresAt = 0
  private tokenRefreshTimer: ReturnType<typeof setTimeout> | null = null
  private readonly TOKEN_REFRESH_BEFORE_MS = 5 * 60 * 1000 // 到期前 5 分钟刷新
  private readonly DEFAULT_TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000 // 默认 24 小时

  /* project state cache */
  private projectStates = new Map<string, ProjectStateInfo>()
  private stateReportTimer: ReturnType<typeof setInterval> | null = null
  private readonly STATE_REPORT_INTERVAL_MS = 5000 // 每 5 秒上报一次项目状态

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
  connect(token: string, expiresAt?: number): void {
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
    this.connectToRelay()
  }

  /** 获取当前桥接状态快照 */
  getStatus(): BridgeStatus {
    return {
      status: this.status,
      clientCount: this.clientCount,
      error: this.error,
    }
  }

  /** 发送 Host 消息到 Relay */
  sendHostMessage(msg: BridgeHostMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    } else {
      // 离线时缓存消息（限制数量）
      if (this.pendingMessages.length < this.maxPendingMessages) {
        this.pendingMessages.push(msg)
      }
    }
  }

  /** 断开连接 */
  disconnect(): void {
    this.clearTimers()
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.pendingMessages = []
    this.token = null
    this.clientCount = 0
    this.reconnectAttempts = 0
    this.setStatus('disconnected')
  }

  /** 刷新 Token（由外部调用，用于 Token 过期时自动续期） */
  refreshToken(newToken: string): void {
    logBridge('Token refresh requested')
    this.token = newToken
    // 断开当前连接，使用新 Token 重连
    this.clearTimers()
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.reconnectAttempts = 0
    this.connectToRelay()
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
  updateProjectState(projectId: string, updates: Partial<Pick<ProjectStateInfo, 'title' | 'workspace' | 'isProcessing' | 'activeTaskId'>>): void {
    const existing = this.projectStates.get(projectId)
    const now = Date.now()
    if (existing) {
      this.projectStates.set(projectId, {
        ...existing,
        ...updates,
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

  /** 获取所有项目状态列表 */
  getProjectStates(): ProjectStateInfo[] {
    return Array.from(this.projectStates.values())
  }

  /** 获取单个项目状态 */
  getProjectState(projectId: string): ProjectStateInfo | undefined {
    return this.projectStates.get(projectId)
  }

  /** 启动定期状态上报定时器 */
  startStateReportTimer(): void {
    this.stopStateReportTimer()
    this.stateReportTimer = setInterval(() => {
      this.reportProjectStates()
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
  private reportProjectStates(): void {
    if (this.projectStates.size === 0) return
    const states = Array.from(this.projectStates.values()).map((s) => ({
      id: s.id,
      title: s.title,
      workspace: s.workspace,
      isProcessing: s.isProcessing,
      activeTaskId: s.activeTaskId,
      lastActivityAt: s.lastActivityAt,
    }))
    this.sendHostMessage({
      type: 'bridge:project-states',
      states,
      timestamp: Date.now(),
    } as any)
  }

  /** 按需立即推送项目列表（不等定时器），用于项目变更时即时通知移动端 */
  pushProjectsOnDemand(): void {
    if (this.projectStates.size === 0) return
    const states = Array.from(this.projectStates.values()).map((s) => ({
      id: s.id,
      title: s.title,
      workspace: s.workspace,
      isProcessing: s.isProcessing,
      activeTaskId: s.activeTaskId,
      lastActivityAt: s.lastActivityAt,
    }))
    this.sendHostMessage({
      type: 'bridge:project-states',
      states,
      timestamp: Date.now(),
    } as any)
    logBridge(`Pushed project states on demand (${states.length} projects)`)
  }

  /* ------------------------------------------------------------------ */
  /*  Private: connection                                                */
  /* ------------------------------------------------------------------ */

  private connectToRelay(): void {
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
      this.startStateReportTimer()
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
      this.attemptReconnect()
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

      /* ---- client → host data requests ---- */
      case 'bridge:get-projects':
      case 'bridge:get-workspace-tree':
      case 'bridge:file-read':
      case 'bridge:file-write':
      case 'bridge:switch-project':
      case 'bridge:get-models':
      case 'bridge:switch-model': {
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

  private attemptReconnect(): void {
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
      this.connectToRelay()
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
