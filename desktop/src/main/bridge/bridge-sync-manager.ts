/**
 * BridgeSyncManager — 增强的同步管理器
 * 
 * 负责：
 * 1. 消息优先级分类和队列管理
 * 2. ACK 确认机制和重传
 * 3. 消息缓存和去重
 * 4. 批量合并和节流
 */

import {
  type BridgeHostMessage,
  type BridgeClientMessage,
  type BridgeAck,
  type BridgeMessagePriority,
} from './bridge-protocol'

/* ------------------------------------------------------------------ */
/*  消息优先级配置                                                      */
/* ------------------------------------------------------------------ */

const PRIORITY_CONFIG = {
  critical: { 
    queue: 'critical', 
    timeout: 3000,    // 3秒超时
    maxRetries: 5,    // 最多重试5次
    throttle: 0       // 不限流
  },
  high: { 
    queue: 'high', 
    timeout: 5000, 
    maxRetries: 3,
    throttle: 0 
  },
  normal: { 
    queue: 'normal', 
    timeout: 10000, 
    maxRetries: 2,
    throttle: 50      // 50ms节流
  },
  low: { 
    queue: 'low', 
    timeout: 15000, 
    maxRetries: 1,
    throttle: 200     // 200ms节流
  },
} as const

/* ------------------------------------------------------------------ */
/*  待发送消息                                                          */
/* ------------------------------------------------------------------ */

interface PendingMessage {
  id: string
  message: BridgeHostMessage
  priority: BridgeMessagePriority
  timestamp: number
  retryCount: number
  ackReceived: boolean
}

/* ------------------------------------------------------------------ */
/*  消息缓存                                                            */
/* ------------------------------------------------------------------ */

interface MessageCache {
  // 最近发送的消息ID集合（用于去重）
  sentMessageIds: Set<string>
  // 最大缓存数量
  maxSize: number
}

/* ------------------------------------------------------------------ */
/*  BridgeSyncManager                                                   */
/* ------------------------------------------------------------------ */

export class BridgeSyncManager {
  // 四个优先级的消息队列
  private queues: Record<string, PendingMessage[]> = {
    critical: [],
    high: [],
    normal: [],
    low: [],
  }

  // 待确认的消息（等待ACK）
  private pendingAcks: Map<string, PendingMessage> = new Map()
  
  // 消息缓存（去重用）
  private cache: MessageCache = {
    sentMessageIds: new Set(),
    maxSize: 1000,
  }

  // 批量合并缓冲区（针对低优先级消息）
  private mergeBuffer: Map<string, any> = new Map()
  private mergeTimer: NodeJS.Timeout | null = null

  // 节流时间戳记录
  private lastSentTime: Map<string, number> = new Map()

  // 发送函数（由外部注入）
  private sendFn: ((msg: BridgeHostMessage) => void) | null = null

  // 统计信息
  private stats = {
    totalSent: 0,
    totalAcked: 0,
    totalRetried: 0,
    totalDropped: 0,
    totalMerged: 0,
  }

  /* ------------------------------------------------------------------ */
  /*  初始化                                                              */
  /* ------------------------------------------------------------------ */

  setSendFunction(sendFn: (msg: BridgeHostMessage) => void): void {
    this.sendFn = sendFn
  }

  /* ------------------------------------------------------------------ */
  /*  发送消息（带优先级、缓存、节流）                                      */
  /* ------------------------------------------------------------------ */

  sendMessage(message: BridgeHostMessage, priority: BridgeMessagePriority = 'normal'): void {
    // 1. 生成消息ID（如果没有）
    const messageId = (message as any).messageId || `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    ;(message as any).messageId = messageId
    ;(message as any).priority = priority

    // 2. 去重检查
    if (this.cache.sentMessageIds.has(messageId)) {
      this.stats.totalDropped++
      return
    }

    // 3. 节流检查
    const config = PRIORITY_CONFIG[priority]
    const now = Date.now()
    const lastTime = this.lastSentTime.get(message.type) || 0
    
    // done=true 的 delta 消息是流式完成信号，必须立即发送，不能节流
    const isDoneDelta = message.type === 'bridge:chat-delta' && (message as any).done === true
    
    if (!isDoneDelta && config.throttle > 0 && (now - lastTime) < config.throttle) {
      this.mergeToBuffer(message, priority)
      return
    }

    // 4. 直接发送（禁用 ACK 机制，WebSocket 本身已提供可靠传输）
    this.sendImmediately(message)

    // 5. 更新缓存
    this.cache.sentMessageIds.add(messageId)
    this.limitCacheSize()
    
    // 6. 记录发送时间
    this.lastSentTime.set(message.type, Date.now())
    
    this.stats.totalSent++
  }

  /* ------------------------------------------------------------------ */
  /*  批量合并                                                            */
  /* ------------------------------------------------------------------ */

  private mergeToBuffer(message: BridgeHostMessage, priority: BridgeMessagePriority): void {
    // 对于 delta 类型消息，合并到缓冲区
    if (message.type === 'bridge:chat-delta') {
      const deltaMsg = message as any
      const key = `delta-${deltaMsg.messageId}`
      
      if (this.mergeBuffer.has(key)) {
        // 合并delta
        const existing = this.mergeBuffer.get(key)!
        existing.delta += deltaMsg.delta
        existing.timestamp = Date.now()
        // 关键修复: 如果新消息 done=true,必须覆盖 existing 的 done 标志
        // 这确保流式输出完成信号不会被丢失
        if (deltaMsg.done === true) {
          existing.done = true
        }
      } else {
        this.mergeBuffer.set(key, { ...message })
      }

      // 设置定时器，延迟发送合并后的消息
      if (!this.mergeTimer) {
        this.mergeTimer = setTimeout(() => {
          this.flushMergeBuffer()
        }, 100) // 100ms后刷新缓冲区
      }
    } else {
      // 关键修复: 非delta消息(如bridge:project-states)被节流时，不能丢弃
      // 必须加入队列等待发送，否则移动端会永久显示"处理中"
      const messageId = (message as any).messageId || `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
      ;(message as any).messageId = messageId
      
      const pendingMsg: PendingMessage = {
        id: messageId,
        message,
        priority,
        timestamp: Date.now(),
        retryCount: 0,
        ackReceived: false,
      }
      
      this.queues[priority].push(pendingMsg)
      console.log(`[BridgeSync] Throttled non-delta message queued: ${message.type}`)
    }
  }

  private flushMergeBuffer(): void {
    this.mergeTimer = null
    
    for (const [, message] of this.mergeBuffer.entries()) {
      this.sendImmediately(message)
      this.stats.totalSent++
    }
    
    this.mergeBuffer.clear()
  }

  /* ------------------------------------------------------------------ */
  /*  队列处理                                                            */
  /* ------------------------------------------------------------------ */

  private processQueues(): void {
    // 按优先级顺序处理：critical > high > normal > low
    const queueOrder = ['critical', 'high', 'normal', 'low']
    
    for (const queueName of queueOrder) {
      const queue = this.queues[queueName]
      while (queue.length > 0) {
        const msg = queue.shift()!
        this.sendImmediately(msg.message)
        
        // 更新缓存
        this.cache.sentMessageIds.add(msg.id)
        this.limitCacheSize()
        
        // 记录发送时间
        this.lastSentTime.set(msg.message.type, Date.now())
        
        this.stats.totalSent++
      }
    }
  }

  private sendImmediately(message: BridgeHostMessage): void {
    if (!this.sendFn) {
      console.warn('[BridgeSync] Send function not set')
      return
    }
    
    try {
      this.sendFn(message)
    } catch (err) {
      console.error('[BridgeSync] Send failed:', err)
    }
  }

  /* ------------------------------------------------------------------ */
  /*  ACK 确认机制（已禁用，保留接口兼容）                                */
  /* ------------------------------------------------------------------ */

  /** 已禁用：WebSocket 本身提供可靠传输，无需应用层 ACK */
  private startAckTimeout(_msg: PendingMessage): void {
    // 不再需要 ACK 超时重传
  }

  /** 已禁用：消息直接发送，无需重试 */
  private retryMessage(_msg: PendingMessage): void {
    // 不再需要重试
  }

  /** 处理收到的 ACK（保留接口兼容，实际不再使用） */
  handleAck(_ack: BridgeAck): void {
    // 不再需要处理 ACK
  }

  /** 处理重传请求（保留接口兼容，实际不再使用） */
  handleRetransmitRequest(_request: { messageId: string }): void {
    // 不再需要处理重传
  }

  /* ------------------------------------------------------------------ */
  /*  缓存管理                                                            */
  /* ------------------------------------------------------------------ */

  private limitCacheSize(): void {
    if (this.cache.sentMessageIds.size > this.cache.maxSize) {
      // 删除最早的10%缓存
      const toRemove = Math.floor(this.cache.maxSize * 0.1)
      const iterator = this.cache.sentMessageIds.values()
      for (let i = 0; i < toRemove; i++) {
        const result = iterator.next()
        if (result.done) break
        this.cache.sentMessageIds.delete(result.value)
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  统计信息                                                            */
  /* ------------------------------------------------------------------ */

  getStats(): typeof this.stats {
    return { ...this.stats }
  }

  getPendingAckCount(): number {
    return this.pendingAcks.size
  }

  getTotalQueuedMessages(): number {
    return Object.values(this.queues).reduce((sum, q) => sum + q.length, 0)
  }

  /* ------------------------------------------------------------------ */
  /*  清理                                                                */
  /* ------------------------------------------------------------------ */

  dispose(): void {
    if (this.mergeTimer) {
      clearTimeout(this.mergeTimer)
      this.mergeTimer = null
    }
    
    this.queues = { critical: [], high: [], normal: [], low: [] }
    this.pendingAcks.clear()
    this.cache.sentMessageIds.clear()
    this.mergeBuffer.clear()
    this.lastSentTime.clear()
  }
}
