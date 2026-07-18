import type { ChatMsg, TaskTiming } from '../types'

export type SessionStoreMeta = {
  projectId?: string
  workspace?: string
}

export const CHAT_STORE_FLUSH_DEBOUNCE_MS = 280
export const CHAT_STORE_INITIAL_PAGE_SIZE = 120
export const CHAT_STORE_OLDER_PAGE_SIZE = 120

export type SessionLoadMeta = {
  totalCount: number
  loadedStartSeq: number
  loadedEndSeq: number
  isLoaded: boolean
  isLoading: boolean
  isLoadingOlder: boolean
}

export function normalizeChatStoreMessages(messages: unknown[]): ChatMsg[] {
  return Array.isArray(messages) ? (messages as ChatMsg[]) : []
}

export function serializeChatStoreMessage(message: ChatMsg): string {
  try {
    return JSON.stringify(message)
  } catch {
    return ''
  }
}

export function areChatStoreMessagesEqual(prev: ChatMsg | undefined, next: ChatMsg | undefined): boolean {
  if (prev === next) return true
  if (!prev || !next) return false
  if (prev.id !== next.id) return false
  if (prev.role !== next.role) return false
  if (prev.content !== next.content) return false
  if ((prev.gitCommitHash || '') !== (next.gitCommitHash || '')) return false
  return serializeChatStoreMessage(prev) === serializeChatStoreMessage(next)
}

export function findFirstChangedMessageIndex(prevMessages: ChatMsg[], nextMessages: ChatMsg[]): number {
  const sharedLength = Math.min(prevMessages.length, nextMessages.length)
  for (let index = 0; index < sharedLength; index++) {
    if (!areChatStoreMessagesEqual(prevMessages[index], nextMessages[index])) {
      return index
    }
  }
  return sharedLength
}

export function normalizePlanStatus(status: string): 'pending' | 'in_progress' | 'done' | 'failed' {
  const s = String(status ?? '').trim().toLowerCase()
  if (s === 'in-progress' || s === 'inprogress' || s === 'running') return 'in_progress'
  if (s === 'complete' || s === 'completed' || s === 'success' || s === 'succeeded') return 'done'
  if (s === 'error') return 'failed'
  if (s === 'pending' || s === 'in_progress' || s === 'done' || s === 'failed') return s
  return 'pending'
}

export function buildTaskTiming(startedAt: number, endedAt = Date.now()): TaskTiming {
  const safeStart = Number.isFinite(startedAt) ? startedAt : Date.now()
  const safeEnd = Number.isFinite(endedAt) ? endedAt : Date.now()
  const normalizedEnd = safeEnd >= safeStart ? safeEnd : safeStart
  return {
    startedAt: safeStart,
    endedAt: normalizedEnd,
    durationMs: normalizedEnd - safeStart,
  }
}
