/**
 * BridgeManager — WebSocket 连接管理与消息收发（新版：会员登录 + 扫码配对）
 *
 * 作为 Host（桌面端），负责：
 * - 使用会员 token 连接 Relay
 * - 接收配对码（用于生成二维码）
 * - 维持 WebSocket 长连接与心跳
 * - 广播桥接消息（对话、Agent 事件、文件变更）
 * - 接收 Client 指令（发送消息、确认/终止）
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
export type BridgePairingCodeCallback = (code: string) => void
export type BridgeClientConnectedCallback = () => void

/** 数据请求处理器 — 由 IPC 注册，处理移动端数据查询指令 */
export type BridgeDataRequestHandler = (msg: Record<string, unknown>, respond: (data: Record<string, unknown>) => void) => void

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
  private pairingCode: string | null = null
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

  /* callbacks */
  private statusCallbacks = new Set<BridgeStatusCallback>()
  private clientMessageCallbacks = new Set<BridgeClientMessageCallback>()
  private pairingCodeCallbacks = new Set<BridgePairingCodeCallback>()
  private clientConnectedCallbacks = new Set<BridgeClientConnectedCallback>()
  private dataHandler: BridgeDataRequestHandler | null = null

  constructor(relayUrl: string = DEFAULT_RELAY_URL) {
    this.relayUrl = relayUrl
  }

  /* ------------------------------------------------------------------ */
  /*  Public API                                                         */
  /* ------------------------------------------------------------------ */

  /** 设置会员 Token 并连接 Relay */
  connect(token: string): void {
    this.token = token
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
      pairingCode: this.pairingCode ?? undefined,
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
    this.pairingCode = null
    this.token = null
    this.clientCount = 0
    this.reconnectAttempts = 0
    this.setStatus('disconnected')
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

  /** 监听配对码变更 返回取消订阅函数 */
  onPairingCode(cb: BridgePairingCodeCallback): () => void {
    this.pairingCodeCallbacks.add(cb)
    return () => { this.pairingCodeCallbacks.delete(cb) }
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

      // 发送缓存的消息
      for (const msg of this.pendingMessages) {
        this.ws!.send(JSON.stringify(msg))
      }
      this.pendingMessages = []
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
      /* ---- pairing code ---- */
      case 'pairing_code': {
        this.pairingCode = (msg as any).code
        this.setStatus('connected')
        for (const cb of this.pairingCodeCallbacks) {
          try { cb(this.pairingCode!) } catch (err) { logBridgeError('pairingCode callback error', err) }
        }
        logBridge(`Pairing code received: ${this.pairingCode}`)
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
      case 'bridge:switch-project': {
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
        this.error = (msg as any).message
        logBridge(`Relay error: ${(msg as any).message}`)
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
  /*  Private: utils                                                     */
  /* ------------------------------------------------------------------ */

  private clearTimers(): void {
    this.stopHeartbeat()
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
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
