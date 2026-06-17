import { useEffect, useRef, useState } from 'react'
import type { GatewayModelItem } from '../../shared/ipc'

/** 模型列表定时刷新间隔（30 分钟） */
const MODEL_REFRESH_INTERVAL_MS = 30 * 60 * 1000

/**
 * Hook to fetch gateway models from /api/member/models when logged in.
 * Waits for bridge connection before fetching.
 * 支持定时自动刷新（每 30 分钟）以保持模型列表与网关同步。
 */
export function useGatewayModels() {
  const [models, setModels] = useState<GatewayModelItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fetchedRef = useRef(false)
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  /** 启动定时刷新 */
  const startAutoRefresh = () => {
    stopAutoRefresh()
    refreshTimerRef.current = setInterval(() => {
      // 定时刷新时不清除 fetchedRef，直接重新请求
      void doFetchModels(true)
    }, MODEL_REFRESH_INTERVAL_MS)
  }

  /** 停止定时刷新 */
  const stopAutoRefresh = () => {
    if (refreshTimerRef.current) {
      clearInterval(refreshTimerRef.current)
      refreshTimerRef.current = null
    }
  }

  /** 实际请求函数 */
  const doFetchModels = async (isAutoRefresh = false) => {
    if (!isAutoRefresh && fetchedRef.current) return
    if (!isAutoRefresh) fetchedRef.current = true

    // 自动刷新时不改动 loading / error 状态，避免 UI 闪屏
    if (!isAutoRefresh) {
      setLoading(true)
      setError(null)
    }
    try {
      const res = await window.taco.gateway.getModels()
      const list = Array.isArray(res?.data) ? res.data : (Array.isArray(res) ? res : [])
      setModels(prev => {
        // 数据未变化则返回旧引用，React 不会触发重渲染 → 避免闪屏
        if (JSON.stringify(prev) === JSON.stringify(list)) return prev
        return list
      })
    } catch (err) {
      // 自动刷新失败时保持现有模型列表不动
      if (!isAutoRefresh) {
        const msg = err instanceof Error ? err.message : String(err)
        setError(msg)
        setModels([])
      }
    } finally {
      if (!isAutoRefresh) setLoading(false)
    }
  }

  useEffect(() => {
    let mounted = true

    // Check initial bridge status
    window.taco.bridge.getStatus().then((s) => {
      if (!mounted) return
      if (s.status === 'connected' || s.status === 'connecting') {
        void doFetchModels()
        startAutoRefresh()
      }
    }).catch(() => {})

    // Listen for bridge status changes
    const unsub = window.taco.bridge.onStatusChange((s) => {
      if (!mounted) return
      if (s.tokenExpired) {
        fetchedRef.current = false
        setModels([])
        setError(null)
        setLoading(false)
        stopAutoRefresh()
      } else if (s.status === 'connected' || s.status === 'connecting') {
        void doFetchModels()
        startAutoRefresh()
      } else if (s.status === 'disconnected') {
        fetchedRef.current = false
        setModels([])
        setError(null)
        setLoading(false)
        stopAutoRefresh()
      }
    })

    return () => {
      mounted = false
      unsub()
      stopAutoRefresh()
    }
  }, [])

  const refetch = async () => {
    fetchedRef.current = false
    await doFetchModels()
  }

  return { models, loading, error, refetch }
}
