/**
 * 更新检查 hook
 *
 * 职责：
 * - 启动时拉取更新状态
 * - 每 30 秒轮询一次
 * - 提供手动检查更新的能力
 */

import { useCallback, useEffect, useState } from 'react'
import type { AppUpdateCheckResult } from '../../shared/ipc'

export function useUpdateCheck() {
  const [updateStatus, setUpdateStatus] = useState<AppUpdateCheckResult | null>(null)
  const [updateChecking, setUpdateChecking] = useState(false)

  const refreshUpdateStatus = useCallback(async () => {
    try {
      const status = await window.taco.updater.getStatus()
      setUpdateStatus(status)
    } catch {
      // ignore
    }
  }, [])

  const handleOpenUpdateDialog = useCallback(async () => {
    if (updateChecking) return
    setUpdateChecking(true)
    try {
      const result = await window.taco.updater.check(true)
      setUpdateStatus(result)
    } catch {
      // ignore
    } finally {
      setUpdateChecking(false)
    }
  }, [updateChecking])

  // 启动时拉取 + 30 秒轮询
  useEffect(() => {
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let retries = 0

    const pull = async () => {
      if (cancelled) return
      try {
        const status = await window.taco.updater.getStatus()
        if (cancelled) return
        setUpdateStatus(status)
        if (!status && retries < 20) {
          retries += 1
          retryTimer = setTimeout(() => { void pull() }, 800)
        }
      } catch {
        // ignore
      }
    }

    void pull()
    const interval = window.setInterval(() => {
      void refreshUpdateStatus()
    }, 30_000)

    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
      window.clearInterval(interval)
    }
  }, [refreshUpdateStatus])

  return {
    updateStatus,
    updateChecking,
    handleOpenUpdateDialog,
  }
}
