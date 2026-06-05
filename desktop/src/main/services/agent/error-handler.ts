/**
 * Agent 错误处理与用户确认机制
 *
 * - 网络/超时/空响应等可恢复错误的自动重试 + 用户确认回退
 * - 危险操作的用户确认等待
 * - Abort 信号检测
 */

import { log } from '../../system/logger'

/* ------------------------------------------------------------------ */
/*  确认等待机制                                                        */
/* ------------------------------------------------------------------ */

const CONFIRM_TIMEOUT_MS = 10 * 60 * 1000 // 10分钟超时
const RETRY_TIMEOUT_MS = 24 * 60 * 60 * 1000 // 重试确认 24 小时超时

/** 待处理的确认请求：confirmId → resolve(approved) */
const pendingConfirms = new Map<string, { resolve: (approved: boolean) => void; timer: NodeJS.Timeout }>()

/** 待处理的重试请求：retryId → resolve(shouldRetry) */
const pendingRetries = new Map<string, { resolve: (shouldRetry: boolean) => void; timer: NodeJS.Timeout }>()

/* ------------------------------------------------------------------ */
/*  Abort 检测                                                          */
/* ------------------------------------------------------------------ */

export function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return err.name === 'AbortError' || err.message === 'AbortError' || err.message === 'Aborted'
}

/* ------------------------------------------------------------------ */
/*  外部调用接口                                                        */
/* ------------------------------------------------------------------ */

/** 外部调用：用户响应了确认请求 */
export function resolveConfirm(confirmId: string, approved: boolean) {
  const pending = pendingConfirms.get(confirmId)
  if (pending) {
    clearTimeout(pending.timer)
    pending.resolve(approved)
    pendingConfirms.delete(confirmId)
  }
}

/** 外部调用：用户响应了重试请求 */
export function resolveRetry(retryId: string, shouldRetry: boolean) {
  const pending = pendingRetries.get(retryId)
  if (pending) {
    clearTimeout(pending.timer)
    pending.resolve(shouldRetry)
    pendingRetries.delete(retryId)
  }
}

/* ------------------------------------------------------------------ */
/*  等待确认 / 等待重试                                                  */
/* ------------------------------------------------------------------ */

/** 创建一个确认请求并等待用户响应 */
export function waitForConfirm(confirmId: string, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    // 超时自动拒绝
    const timer = setTimeout(() => {
      log('CONFIRM_TIMEOUT', { confirmId, timeout: CONFIRM_TIMEOUT_MS }, 'agent')
      pendingConfirms.delete(confirmId)
      resolve(false) // 超时默认拒绝
    }, CONFIRM_TIMEOUT_MS)

    pendingConfirms.set(confirmId, { resolve, timer })

    // 如果 signal 已被中断，立即 resolve(false) 以跳出等待
    if (signal?.aborted) {
      clearTimeout(timer)
      pendingConfirms.delete(confirmId)
      resolve(false)
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      pendingConfirms.delete(confirmId)
      resolve(false)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 创建一个重试确认请求并等待用户响应 */
export function waitForRetry(retryId: string, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      log('RETRY_TIMEOUT', { retryId, timeout: RETRY_TIMEOUT_MS }, 'agent')
      pendingRetries.delete(retryId)
      resolve(false) // 超时默认取消重试
    }, RETRY_TIMEOUT_MS)

    pendingRetries.set(retryId, { resolve, timer })

    if (signal?.aborted) {
      clearTimeout(timer)
      pendingRetries.delete(retryId)
      resolve(false)
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      pendingRetries.delete(retryId)
      resolve(false)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
