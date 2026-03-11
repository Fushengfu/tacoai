import { useEffect, useMemo, useState } from 'react'
import type { ProviderId, Session, Thread, ThreadMode } from '../types'
import { loadJson, saveJson } from '../lib/storage'
import { providers } from '../constants'

/** 迁移旧数据：为没有 sessions 字段的线程补充默认会话 */
function migrateThreads(saved: Thread[]): Thread[] {
  const validProviders = new Set(providers.map((p) => p.id))
  return saved.map((t) => {
    const provider = t.provider && validProviders.has(t.provider) ? t.provider : undefined
    const titleLocked = Boolean(t.titleLocked)
    const projectRules = typeof t.projectRules === 'string' ? t.projectRules : undefined
    const mode: ThreadMode = 'agent'
    if (!t.sessions || t.sessions.length === 0) {
      // 使用 threadId 作为首个 sessionId，这样旧的消息存储键无需迁移
      return {
        ...t,
        provider,
        titleLocked,
        projectRules,
        mode,
        sessions: [{ id: t.id, title: '会话 1', createdAt: t.updatedAt }],
        activeSessionId: t.id,
      }
    }
    if (
      provider === t.provider &&
      titleLocked === Boolean(t.titleLocked) &&
      projectRules === t.projectRules &&
      t.mode === mode
    ) return t
    return { ...t, provider, titleLocked, projectRules, mode }
  })
}

export function useThreads() {
  const [threads, setThreads] = useState<Thread[]>(() =>
    migrateThreads(loadJson('taco.threads', []))
  )
  const [activeThreadId, setActiveThreadId] = useState<string>(() => {
    const saved = migrateThreads(loadJson<Thread[]>('taco.threads', []))
    // 优先恢复上次活跃的项目
    const lastActiveId = loadJson<string>('taco.activeThreadId', '')
    if (lastActiveId && saved.some((t) => t.id === lastActiveId)) {
      return lastActiveId
    }
    return saved[0]?.id ?? ''
  })
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')

  // 持久化 threads
  useEffect(() => {
    saveJson('taco.threads', threads)
  }, [threads])

  // 持久化 active thread ID
  useEffect(() => {
    if (activeThreadId) {
      saveJson('taco.activeThreadId', activeThreadId)
    }
  }, [activeThreadId])

  // 派生
  const activeThread = useMemo(
    () => threads.find((t) => t.id === activeThreadId),
    [threads, activeThreadId]
  )

  // 保持创建顺序（新建在最前），不按 updatedAt 重新排序
  const sortedThreads = threads

  // --- 项目（线程）操作 ---

  /** 创建新项目，可指定初始 provider，返回 id */
  function createThread(title = '新项目', provider?: ProviderId): string {
    const id = `t${Date.now()}`
    const sessionId = `s${Date.now()}`
    const session: Session = { id: sessionId, title: '会话 1', createdAt: Date.now() }
    const thread: Thread = {
      id,
      title,
      titleLocked: false,
      updatedAt: Date.now(),
      provider,
      mode: 'agent',
      sessions: [session],
      activeSessionId: sessionId,
    }
    setThreads((prev) => [thread, ...prev])
    setActiveThreadId(id)
    return id
  }

  function switchThread(id: string) {
    setActiveThreadId(id)
  }

  function startRename(thread: Thread) {
    setEditingThreadId(thread.id)
    setEditingTitle(thread.title)
  }

  function commitRename(threadId: string) {
    const title = editingTitle.trim()
    if (title) {
      setThreads((prev) =>
        prev.map((t) => (t.id === threadId ? { ...t, title, titleLocked: true, updatedAt: Date.now() } : t))
      )
    }
    setEditingThreadId(null)
  }

  function cancelRename() {
    setEditingThreadId(null)
  }

  function deleteThread(threadId: string) {
    setThreads((prev) => prev.filter((t) => t.id !== threadId))
    if (activeThreadId === threadId) {
      const next = threads.find((t) => t.id !== threadId)
      setActiveThreadId(next?.id ?? '')
    }
  }

  /** 局部更新某个线程字段 */
  function updateThread(id: string, patch: Partial<Omit<Thread, 'id'>>) {
    setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)))
  }

  /** 调整项目顺序（拖拽排序） */
  function reorderThread(sourceId: string, targetId: string) {
    if (!sourceId || !targetId || sourceId === targetId) return
    setThreads((prev) => {
      const from = prev.findIndex((t) => t.id === sourceId)
      const to = prev.findIndex((t) => t.id === targetId)
      if (from < 0 || to < 0) return prev
      const next = [...prev]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
  }

  /** 确保当前有活跃项目，没有则创建，返回线程 id */
  function ensureActiveThread(): string {
    if (activeThreadId && threads.some((t) => t.id === activeThreadId)) {
      return activeThreadId
    }
    return createThread()
  }

  // --- 会话操作 ---

  /** 在指定项目内创建新会话，返回新会话 id */
  function createSession(threadId: string): string {
    const sessionId = `s${Date.now()}`
    let newTitle = '会话 1'
    setThreads((prev) =>
      prev.map((t) => {
        if (t.id !== threadId) return t
        newTitle = `会话 ${t.sessions.length + 1}`
        const session: Session = { id: sessionId, title: newTitle, createdAt: Date.now() }
        return {
          ...t,
          sessions: [...t.sessions, session],
          activeSessionId: sessionId,
          updatedAt: Date.now(),
        }
      })
    )
    return sessionId
  }

  /** 切换项目内的活跃会话 */
  function switchSession(threadId: string, sessionId: string) {
    setThreads((prev) =>
      prev.map((t) => (t.id === threadId ? { ...t, activeSessionId: sessionId } : t))
    )
  }

  /** 删除项目内的某个会话 */
  function deleteSession(threadId: string, sessionId: string) {
    setThreads((prev) =>
      prev.map((t) => {
        if (t.id !== threadId) return t
        const remaining = t.sessions.filter((s) => s.id !== sessionId)
        // 如果删光了，自动创建一个新的
        if (remaining.length === 0) {
          const fallbackId = `s${Date.now()}`
          remaining.push({ id: fallbackId, title: '会话 1', createdAt: Date.now() })
          return { ...t, sessions: remaining, activeSessionId: fallbackId }
        }
        // 如果删的是当前活跃会话，切到最后一个
        const nextActive =
          t.activeSessionId === sessionId
            ? remaining[remaining.length - 1].id
            : t.activeSessionId
        return { ...t, sessions: remaining, activeSessionId: nextActive }
      })
    )
  }

  return {
    threads,
    sortedThreads,
    activeThreadId,
    activeThread,
    editingThreadId,
    editingTitle,
    setEditingTitle,
    createThread,
    switchThread,
    startRename,
    commitRename,
    cancelRename,
    deleteThread,
    updateThread,
    reorderThread,
    ensureActiveThread,
    createSession,
    switchSession,
    deleteSession,
  }
}
