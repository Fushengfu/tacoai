import { useEffect, useMemo, useState } from 'react'
import type { AppStateThread, AppStateThreadsPayload } from '../../shared/ipc'
import type { Session, Thread, ThreadMode } from '../types'
import { loadJson } from '../lib/storage'

const LEGACY_THREADS_KEY = 'taco.threads'
const LEGACY_ACTIVE_THREAD_KEY = 'taco.activeThreadId'

function resolveActiveThreadId(threads: Thread[], activeThreadId: string): string {
  if (activeThreadId && threads.some((thread) => thread.id === activeThreadId)) {
    return activeThreadId
  }
  return threads[0]?.id ?? ''
}

/** 迁移旧数据：为没有 sessions 字段的线程补充默认会话 */
function migrateThreads(saved: Thread[]): Thread[] {
  return saved.map((t) => {
    const titleLocked = Boolean(t.titleLocked)
    const projectRules = typeof t.projectRules === 'string' ? t.projectRules : undefined
    const modelConfigId = typeof t.modelConfigId === 'string'
      ? t.modelConfigId
      : (typeof t.provider === 'string' && t.provider.trim() ? `legacy-${t.provider.trim()}-0` : undefined)
    const mode: ThreadMode = 'agent'
    if (!t.sessions || t.sessions.length === 0) {
      return {
        ...t,
        titleLocked,
        projectRules,
        modelConfigId,
        mode,
        sessions: [{ id: t.id, title: '会话 1', createdAt: t.updatedAt }],
        activeSessionId: t.id,
      }
    }
    if (
      titleLocked === Boolean(t.titleLocked) &&
      projectRules === t.projectRules &&
      modelConfigId === t.modelConfigId &&
      t.mode === mode
    ) return t
    return { ...t, titleLocked, projectRules, modelConfigId, mode }
  })
}

function toThreadsPayload(threads: Thread[], activeThreadId: string): AppStateThreadsPayload {
  return {
    threads: threads as AppStateThread[],
    activeThreadId: resolveActiveThreadId(threads, activeThreadId),
  }
}

export function useThreads() {
  const [threads, setThreads] = useState<Thread[]>([])
  const [activeThreadId, setActiveThreadId] = useState<string>('')
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    let cancelled = false

    const hydrate = async () => {
      try {
        const stored = await window.taco.appState.get()
        if (cancelled) return

        let nextThreads = migrateThreads(stored.threadsState.threads as Thread[])
        let nextActiveThreadId = resolveActiveThreadId(nextThreads, stored.threadsState.activeThreadId)

        if (nextThreads.length <= 0) {
          const legacyThreads = migrateThreads(loadJson<Thread[]>(LEGACY_THREADS_KEY, []))
          const legacyActiveThreadId = loadJson<string>(LEGACY_ACTIVE_THREAD_KEY, '')
          if (legacyThreads.length > 0) {
            const saved = await window.taco.appState.saveThreads(
              toThreadsPayload(legacyThreads, legacyActiveThreadId),
            )
            if (cancelled) return
            nextThreads = migrateThreads(saved.threads as Thread[])
            nextActiveThreadId = resolveActiveThreadId(nextThreads, saved.activeThreadId)
            localStorage.removeItem(LEGACY_THREADS_KEY)
            localStorage.removeItem(LEGACY_ACTIVE_THREAD_KEY)
          }
        }

        setThreads(nextThreads)
        setActiveThreadId(nextActiveThreadId)
      } catch (err) {
        console.error('[app-state] 加载项目列表失败:', err)
      } finally {
        if (!cancelled) setHydrated(true)
      }
    }

    void hydrate()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!hydrated) return
    void window.taco.appState.saveThreads(toThreadsPayload(threads, activeThreadId)).catch((err) => {
      console.error('[app-state] 保存项目列表失败:', err)
    })
  }, [threads, activeThreadId, hydrated])

  const activeThread = useMemo(
    () => threads.find((t) => t.id === activeThreadId),
    [threads, activeThreadId],
  )

  const sortedThreads = threads

  function createThread(title = '新项目', modelConfigId?: string): string {
    const id = `t${Date.now()}`
    const sessionId = `s${Date.now()}`
    const session: Session = { id: sessionId, title: '会话 1', createdAt: Date.now() }
    const thread: Thread = {
      id,
      title,
      titleLocked: false,
      updatedAt: Date.now(),
      modelConfigId,
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
        prev.map((t) => (t.id === threadId ? { ...t, title, titleLocked: true, updatedAt: Date.now() } : t)),
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

  function updateThread(id: string, patch: Partial<Omit<Thread, 'id'>>) {
    setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)))
  }

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

  function ensureActiveThread(): string {
    if (activeThreadId && threads.some((t) => t.id === activeThreadId)) {
      return activeThreadId
    }
    return createThread()
  }

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
      }),
    )
    return sessionId
  }

  function switchSession(threadId: string, sessionId: string) {
    setThreads((prev) =>
      prev.map((t) => (t.id === threadId ? { ...t, activeSessionId: sessionId } : t)),
    )
  }

  function deleteSession(threadId: string, sessionId: string) {
    setThreads((prev) =>
      prev.map((t) => {
        if (t.id !== threadId) return t
        const remaining = t.sessions.filter((s) => s.id !== sessionId)
        if (remaining.length === 0) {
          const fallbackId = `s${Date.now()}`
          remaining.push({ id: fallbackId, title: '会话 1', createdAt: Date.now() })
          return { ...t, sessions: remaining, activeSessionId: fallbackId }
        }
        const nextActive =
          t.activeSessionId === sessionId
            ? remaining[remaining.length - 1].id
            : t.activeSessionId
        return { ...t, sessions: remaining, activeSessionId: nextActive }
      }),
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
