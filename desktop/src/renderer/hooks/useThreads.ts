import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppStateThread, AppStateThreadsPayload } from '../../shared/ipc'
import type { Session, Thread, ThreadMode } from '../types'
import { loadJson } from '../lib/storage'

const LEGACY_THREADS_KEY = 'taco.threads'
const LEGACY_ACTIVE_THREAD_KEY = 'taco.activeThreadId'
let runtimeIdSeq = 0

function nextRuntimeId(prefix: 't' | 's'): string {
  runtimeIdSeq += 1
  return `${prefix}${Date.now()}-${runtimeIdSeq.toString(36)}`
}

function createUniqueId(prefix: 't' | 's', usedIds: Set<string>, preferred?: string): string {
  const preferredId = String(preferred || '').trim()
  if (preferredId && !usedIds.has(preferredId)) {
    usedIds.add(preferredId)
    return preferredId
  }
  let id = nextRuntimeId(prefix)
  while (usedIds.has(id)) {
    id = nextRuntimeId(prefix)
  }
  usedIds.add(id)
  return id
}

function resolveActiveThreadId(threads: Thread[], activeThreadId: string): string {
  if (activeThreadId && threads.some((thread) => thread.id === activeThreadId)) {
    return activeThreadId
  }
  return threads[0]?.id ?? ''
}

/** 迁移旧数据：为没有 sessions 字段的线程补充默认会话 */
function migrateThreads(saved: Thread[]): Thread[] {
  const usedThreadIds = new Set<string>()
  const usedSessionIds = new Set<string>()

  return saved.map((t) => {
    const titleLocked = Boolean(t.titleLocked)
    const projectRules = typeof t.projectRules === 'string' ? t.projectRules : undefined
    const modelConfigId = typeof t.modelConfigId === 'string'
      ? t.modelConfigId
      : (typeof t.provider === 'string' && t.provider.trim() ? `legacy-${t.provider.trim()}-0` : undefined)
    const mode: ThreadMode = 'agent'

    const threadId = createUniqueId('t', usedThreadIds, t.id)
    const rawSessions = Array.isArray(t.sessions) && t.sessions.length > 0
      ? t.sessions
      : [{ id: threadId, title: '会话 1', createdAt: t.updatedAt }]
    const sessions: Session[] = rawSessions.map((session, index) => {
      const normalizedId = createUniqueId('s', usedSessionIds, session?.id)
      const title = String(session?.title || '').trim() || `会话 ${index + 1}`
      const createdAtRaw = Number(session?.createdAt)
      const createdAt = Number.isFinite(createdAtRaw) ? createdAtRaw : t.updatedAt
      return {
        id: normalizedId,
        title,
        createdAt,
      }
    })
    const activeSessionRaw = String(t.activeSessionId || '').trim()
    const activeSessionId = sessions.some((session) => session.id === activeSessionRaw)
      ? activeSessionRaw
      : sessions[0].id

    if (
      threadId === t.id &&
      titleLocked === Boolean(t.titleLocked) &&
      projectRules === t.projectRules &&
      modelConfigId === t.modelConfigId &&
      t.mode === mode &&
      sessions.length === (t.sessions?.length ?? 0) &&
      sessions.every((session, index) =>
        session.id === t.sessions?.[index]?.id
        && session.title === t.sessions?.[index]?.title
        && session.createdAt === t.sessions?.[index]?.createdAt
      ) &&
      activeSessionId === t.activeSessionId
    ) {
      return t
    }
    return {
      ...t,
      id: threadId,
      titleLocked,
      projectRules,
      modelConfigId,
      mode,
      sessions,
      activeSessionId,
    }
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
  const threadsRef = useRef<Thread[]>(threads)

  useEffect(() => {
    threadsRef.current = threads
  }, [threads])

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
        if (!cancelled) setHydrated(true)
      } catch (err) {
        console.error('[app-state] 加载项目列表失败:', err)
        /* 不设置 hydrated=true —— 防止空数据覆盖数据库 */
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

  useEffect(() => {
    if (threads.length <= 0) {
      if (activeThreadId) setActiveThreadId('')
      return
    }
    if (!threads.some((thread) => thread.id === activeThreadId)) {
      setActiveThreadId(threads[0].id)
    }
  }, [threads, activeThreadId])

  const activeThread = useMemo(
    () => threads.find((t) => t.id === activeThreadId),
    [threads, activeThreadId],
  )

  const sortedThreads = threads

  function createThread(title = '新项目', modelConfigId?: string): string {
    const usedThreadIds = new Set(threads.map((thread) => String(thread.id || '').trim()).filter(Boolean))
    const usedSessionIds = new Set(
      threads.flatMap((thread) => (thread.sessions ?? []).map((session) => String(session.id || '').trim()).filter(Boolean))
    )
    const id = createUniqueId('t', usedThreadIds)
    const sessionId = createUniqueId('s', usedSessionIds)
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
    const targetId = String(id || '').trim()
    if (!targetId) return
    if (!threadsRef.current.some((thread) => thread.id === targetId)) return
    setActiveThreadId(targetId)
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
    const targetId = String(threadId || '').trim()
    if (!targetId) return
    setThreads((prev) => prev.filter((t) => t.id !== targetId))
    setActiveThreadId((current) => {
      const remaining = threadsRef.current.filter((thread) => thread.id !== targetId)
      if (remaining.length <= 0) return ''
      if (current === targetId) return remaining[0].id
      if (remaining.some((thread) => thread.id === current)) return current
      return remaining[0].id
    })
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
    const usedSessionIds = new Set(
      threads.flatMap((thread) => (thread.sessions ?? []).map((session) => String(session.id || '').trim()).filter(Boolean))
    )
    const sessionId = createUniqueId('s', usedSessionIds)
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
    const targetThreadId = String(threadId || '').trim()
    const targetSessionId = String(sessionId || '').trim()
    if (!targetThreadId || !targetSessionId) return
    setThreads((prev) =>
      prev.map((t) => {
        if (t.id !== targetThreadId) return t
        if (!t.sessions.some((s) => s.id === targetSessionId)) return t
        return { ...t, activeSessionId: targetSessionId }
      }),
    )
  }

  function deleteSession(threadId: string, sessionId: string) {
    setThreads((prev) =>
      prev.map((t) => {
        if (t.id !== threadId) return t
        const remaining = t.sessions.filter((s) => s.id !== sessionId)
        if (remaining.length === 0) {
          const usedSessionIds = new Set(
            prev.flatMap((thread) => (thread.sessions ?? []).map((session) => String(session.id || '').trim()).filter(Boolean))
          )
          usedSessionIds.delete(String(sessionId || '').trim())
          const fallbackId = createUniqueId('s', usedSessionIds)
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
