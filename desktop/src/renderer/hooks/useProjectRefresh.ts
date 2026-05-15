/**
 * 项目刷新调度 Hook
 * 
 * 管理 Git 状态刷新、Live Diff 同步的队列调度
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'

type ProjectRefreshFlags = {
  gitStatus: boolean
  liveDiff: boolean
}

export function useProjectRefresh(
  currentWorkspace: string,
  currentMode: string,
  liveDiffPriorityPaths: string[],
  sessionSending: boolean,
  refreshGitStatus: () => Promise<void>,
  syncLiveNewContentByPath: () => Promise<void>,
) {
  const [gitStatusLoaded, setGitStatusLoaded] = useState(false)

  const autoRefreshFlags = useMemo<ProjectRefreshFlags>(() => ({
    gitStatus: false,
    liveDiff: currentMode === 'agent' && liveDiffPriorityPaths.length > 0,
  }), [currentMode, liveDiffPriorityPaths.length])

  const shouldWatchWorkspace = autoRefreshFlags.liveDiff

  const refreshQueueRef = useRef<{
    pending: ProjectRefreshFlags
    timer: number | null
    running: boolean
    lastGitStatusAt: number
  }>({
    pending: { gitStatus: false, liveDiff: false },
    timer: null,
    running: false,
    lastGitStatusAt: 0,
  })

  const refreshFnsRef = useRef({
    refreshGitStatus,
    syncLiveNewContentByPath,
    sessionSending,
  })

  useEffect(() => {
    refreshFnsRef.current = {
      refreshGitStatus,
      syncLiveNewContentByPath,
      sessionSending,
    }
  }, [refreshGitStatus, syncLiveNewContentByPath, sessionSending])

  const runQueuedProjectRefresh = useCallback(async () => {
    const yieldToUI = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    const state = refreshQueueRef.current
    if (state.running) return
    state.running = true
    if (state.timer) {
      window.clearTimeout(state.timer)
      state.timer = null
    }
    try {
      while (true) {
        const pending = state.pending
        const shouldGitStatus = pending.gitStatus
        const shouldLiveDiff = pending.liveDiff

        state.pending = { gitStatus: false, liveDiff: false }

        if (!shouldGitStatus && !shouldLiveDiff) break

        const refreshFns = refreshFnsRef.current
        let didWork = false
        if (shouldGitStatus) {
          const now = Date.now()
          const minGitStatusInterval = refreshFns.sessionSending ? 1400 : 600
          if ((now - state.lastGitStatusAt) >= minGitStatusInterval) {
            didWork = true
            state.lastGitStatusAt = now
            await refreshFns.refreshGitStatus()
            await yieldToUI()
          } else {
            state.pending.gitStatus = true
          }
        }
        if (shouldLiveDiff) {
          didWork = true
          await refreshFns.syncLiveNewContentByPath()
          await yieldToUI()
        }

        if (!didWork && state.pending.gitStatus) {
          await new Promise<void>((resolve) => {
            window.setTimeout(resolve, 220)
          })
        }
      }
    } finally {
      state.running = false
      const hasPending = state.pending.gitStatus || state.pending.liveDiff
      if (hasPending && !state.timer) {
        state.timer = window.setTimeout(() => {
          state.timer = null
          void runQueuedProjectRefresh()
        }, 80)
      }
    }
  }, [])

  const queueProjectRefresh = useCallback((flags: Partial<ProjectRefreshFlags>, debounceMs = 120) => {
    const state = refreshQueueRef.current
    state.pending.gitStatus = state.pending.gitStatus || !!flags.gitStatus
    state.pending.liveDiff = state.pending.liveDiff || !!flags.liveDiff

    if (debounceMs <= 0) {
      if (state.timer) {
        window.clearTimeout(state.timer)
        state.timer = null
      }
      void runQueuedProjectRefresh()
      return
    }

    if (state.timer) return
    state.timer = window.setTimeout(() => {
      state.timer = null
      void runQueuedProjectRefresh()
    }, debounceMs)
  }, [runQueuedProjectRefresh])

  // 切换工作区时刷新 git status
  useEffect(() => {
    setGitStatusLoaded(false)
    queueProjectRefresh({ gitStatus: true }, 0)
  }, [currentWorkspace, queueProjectRefresh])

  // 监听工作区文件变化
  useEffect(() => {
    if (!currentWorkspace || !shouldWatchWorkspace) return
    window.taco.workspace.watch(currentWorkspace)
    return () => {
      window.taco.workspace.unwatch()
    }
  }, [currentWorkspace, shouldWatchWorkspace])

  // 清理定时器
  useEffect(() => {
    return () => {
      const state = refreshQueueRef.current
      if (state.timer) {
        window.clearTimeout(state.timer)
        state.timer = null
      }
    }
  }, [])

  return {
    gitStatusLoaded,
    queueProjectRefresh,
    autoRefreshFlags,
  }
}
