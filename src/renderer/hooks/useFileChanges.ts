/**
 * 文件变更管理 Hook
 * 
 * 管理 Agent 文件变更、手动编辑变更、Git 状态、文件审核等
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import type { FileChangeInfo, FileChangeStatus } from '../types'
import type { GitWorkingTreeStatus } from '../../shared/ipc'
import { normalizeWorkspaceRelativePath, resolveFilePath } from '../utils/path-utils'
import { loadJson, saveJson } from '../lib/storage'

export function useFileChanges(
  sessionId: string,
  currentWorkspace: string,
  currentMode: string,
  messages: any[],
  sessionSending: boolean,
) {
  // 手动编辑产生的文件变更
  const [manualFileChangesBySession, setManualFileChangesBySession] = useState<Record<string, FileChangeInfo[]>>({})
  
  // 变更基线下标(避免跨目录历史变更污染)
  const [changeStartIndexBySession, setChangeStartIndexBySession] = useState<Record<string, number>>({})
  const lastWorkspaceBySessionRef = useRef<Record<string, string>>({})
  
  // Git 工作区状态
  const [gitWorkingStatus, setGitWorkingStatus] = useState<GitWorkingTreeStatus>({ staged: [], unstaged: [], fileStatuses: {} })
  const [gitStatusLoaded, setGitStatusLoaded] = useState(false)
  const gitStatusRefreshSeqRef = useRef(0)
  
  // 文件审核状态
  const fileStatusKey = `taco.fileStatuses.${sessionId}`
  const [fileStatuses, setFileStatuses] = useState<Record<string, FileChangeStatus>>(() =>
    loadJson(fileStatusKey, {})
  )
  const sessionIdRef = useRef(sessionId)
  sessionIdRef.current = sessionId
  
  // 选中的文件
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  
  // 实时文件差异覆盖层
  const [liveFileChangeOverrides, setLiveFileChangeOverrides] = useState<Record<string, FileChangeInfo | null>>({})
  const liveFileChangeSyncSeqRef = useRef(0)
  const liveDiffLastRunAtRef = useRef(0)
  const liveDiffLastTargetKeyRef = useRef('')

  // 变更基线下标
  const changeStartIndex = useMemo(() => {
    const raw = changeStartIndexBySession[sessionId] ?? 0
    if (!Number.isFinite(raw) || raw < 0) return 0
    return raw > messages.length ? messages.length : raw
  }, [changeStartIndexBySession, sessionId, messages.length])

  // Agent 文件变更
  const agentFileChanges: FileChangeInfo[] = useMemo(() => {
    if (currentMode !== 'agent') return []
    const changes: FileChangeInfo[] = []
    for (let i = changeStartIndex; i < messages.length; i++) {
      const msg = messages[i]
      if (!msg.agentSteps) continue
      for (const step of msg.agentSteps) {
        for (const tr of step.toolResults) {
          if (tr.fileChange) {
            const normalizedPath = normalizeWorkspaceRelativePath(tr.fileChange.filePath, currentWorkspace)
            if (!normalizedPath) continue
            changes.push({
              ...tr.fileChange,
              filePath: normalizedPath,
            })
          }
        }
      }
    }
    return changes
  }, [messages, currentMode, currentWorkspace, changeStartIndex])

  // 当前会话手动编辑变更
  const manualFileChanges = useMemo(
    () => manualFileChangesBySession[sessionId] ?? [],
    [manualFileChangesBySession, sessionId],
  )

  // 合并变更
  const fileChanges: FileChangeInfo[] = useMemo(
    () => [...agentFileChanges, ...manualFileChanges],
    [agentFileChanges, manualFileChanges],
  )

  // 去重合并
  const dedupedFileChanges = useMemo(() => {
    if (fileChanges.length === 0) return []
    const map = new Map<string, FileChangeInfo>()
    for (const fc of fileChanges) {
      const existing = map.get(fc.filePath)
      if (existing) {
        map.set(fc.filePath, {
          filePath: fc.filePath,
          oldContent: existing.oldContent,
          newContent: fc.newContent,
        })
      } else {
        map.set(fc.filePath, { ...fc })
      }
    }
    return Array.from(map.values()).filter(
      (fc) => fc.oldContent !== fc.newContent
    )
  }, [fileChanges])

  // Git 文件列表
  const gitStagedFiles = useMemo(() => {
    const seen = new Set<string>()
    for (const filePath of gitWorkingStatus.staged ?? []) {
      const normalized = normalizeWorkspaceRelativePath(filePath, currentWorkspace)
      if (normalized) seen.add(normalized)
    }
    return Array.from(seen).sort((a, b) => a.localeCompare(b))
  }, [gitWorkingStatus.staged, currentWorkspace])

  const gitUnstagedFiles = useMemo(() => {
    const seen = new Set<string>()
    for (const filePath of gitWorkingStatus.unstaged ?? []) {
      const normalized = normalizeWorkspaceRelativePath(filePath, currentWorkspace)
      if (normalized) seen.add(normalized)
    }
    return Array.from(seen).sort((a, b) => a.localeCompare(b))
  }, [gitWorkingStatus.unstaged, currentWorkspace])

  const stagedFileSet = useMemo(() => new Set(gitStagedFiles), [gitStagedFiles])
  const unstagedFileSet = useMemo(() => new Set(gitUnstagedFiles), [gitUnstagedFiles])

  // 实时差异优先级路径
  const liveDiffPriorityPaths = useMemo(() => {
    if (currentMode !== 'agent') return []
    const ordered: string[] = []
    const seen = new Set<string>()
    const pushPath = (filePath: string | null) => {
      if (!filePath || seen.has(filePath)) return
      seen.add(filePath)
      ordered.push(filePath)
    }

    pushPath(selectedFile)
    // 注意: viewingFile 需要从外部传入,这里简化处理
    if (currentMode === 'agent') {
      for (let i = dedupedFileChanges.length - 1; i >= 0 && ordered.length < 18; i--) {
        pushPath(dedupedFileChanges[i]?.filePath ?? null)
      }
    }

    return ordered
  }, [currentMode, selectedFile, dedupedFileChanges])

  const liveDiffTargetKey = liveDiffPriorityPaths.join('|')

  // 刷新 Git 状态
  const refreshGitStatus = useCallback(async () => {
    const seq = ++gitStatusRefreshSeqRef.current
    if (!currentWorkspace) {
      setGitWorkingStatus({ staged: [], unstaged: [], fileStatuses: {} })
      setGitStatusLoaded(false)
      return
    }
    try {
      const status = await window.taco.git.status(currentWorkspace)
      if (seq !== gitStatusRefreshSeqRef.current) return
      setGitWorkingStatus({
        staged: Array.isArray(status?.staged) ? status.staged : [],
        unstaged: Array.isArray(status?.unstaged) ? status.unstaged : [],
        fileStatuses: status?.fileStatuses ?? {},
      })
      setGitStatusLoaded(true)
    } catch (err) {
      if (seq !== gitStatusRefreshSeqRef.current) return
      console.error('获取 Git 工作区状态失败:', err)
      setGitWorkingStatus({ staged: [], unstaged: [], fileStatuses: {} })
      setGitStatusLoaded(true)
    }
  }, [currentWorkspace])

  // 读取文件状态
  const readFileStatus = useCallback((filePath: string): FileChangeStatus => {
    return (
      fileStatuses[filePath]
      ?? fileStatuses[filePath.replace(/\//g, '\\')]
      ?? 'pending'
    )
  }, [fileStatuses])

  // 移除手动变更
  const removeManualChanges = useCallback((paths: string[]) => {
    if (!sessionId || paths.length === 0) return
    const normalizedTargets = new Set(
      paths.map((p) => normalizeWorkspaceRelativePath(p, currentWorkspace)).filter(Boolean)
    )
    if (normalizedTargets.size === 0) return
    setManualFileChangesBySession((prev) => {
      const current = prev[sessionId] ?? []
      const next = current.filter((fc) => !normalizedTargets.has(normalizeWorkspaceRelativePath(fc.filePath, currentWorkspace)))
      if (next.length === current.length) return prev
      return { ...prev, [sessionId]: next }
    })
  }, [sessionId, currentWorkspace])

  // 构建 Git stage 候选路径
  const buildGitStageCandidates = useCallback((filePath: string): string[] => {
    const set = new Set<string>()
    const push = (value: string) => {
      const v = String(value ?? '').trim()
      if (!v) return
      set.add(v)
      set.add(v.replace(/\\/g, '/'))
      set.add(v.replace(/\//g, '\\'))
    }

    const raw = String(filePath ?? '').trim()
    const normalized = normalizeWorkspaceRelativePath(raw, currentWorkspace) || raw
    push(raw)
    push(normalized)

    if (currentWorkspace) {
      const workspaceNorm = currentWorkspace.replace(/[\\/]+$/, '')
      const workspaceBase = workspaceNorm.split('/').pop() ?? ''
      if (workspaceBase) {
        const lowNorm = normalized.toLowerCase()
        const lowBase = workspaceBase.toLowerCase()
        if (lowNorm.startsWith(`${lowBase}/`)) {
          push(normalized.slice(workspaceBase.length + 1))
        }
      }
    }

    const abs = resolveFilePath(normalized || raw, currentWorkspace)
    push(abs)
    return Array.from(set).filter(Boolean)
  }, [currentWorkspace])

  // Stage 单个文件
  const stageSingleFileWithFallback = useCallback(async (filePath: string) => {
    if (!currentWorkspace) throw new Error('未选择工作区')
    const candidates = buildGitStageCandidates(filePath)
    let lastErr: unknown = null
    for (const candidate of candidates) {
      try {
        await window.taco.git.stageFiles(currentWorkspace, [candidate])
        return
      } catch (err) {
        lastErr = err
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('暂存失败')
  }, [currentWorkspace, buildGitStageCandidates])

  // 接受单个文件
  const handleAcceptFile = useCallback(async (filePath: string) => {
    if (!currentWorkspace) return
    const normalizedPath = normalizeWorkspaceRelativePath(filePath, currentWorkspace)
    const candidatePath = normalizedPath || filePath
    setGitWorkingStatus((prev) => {
      const staged = new Set(prev.staged ?? [])
      const unstaged = new Set(prev.unstaged ?? [])
      staged.add(candidatePath)
      unstaged.delete(candidatePath)
      unstaged.delete(candidatePath.replace(/\//g, '\\'))
      unstaged.delete(candidatePath.replace(/\\/g, '/'))
      return { staged: Array.from(staged), unstaged: Array.from(unstaged), fileStatuses: prev.fileStatuses }
    })
    setFileStatuses((prev) => ({ ...prev, [filePath]: 'accepted' }))
    try {
      await stageSingleFileWithFallback(filePath)
      await refreshGitStatus()
    } catch (err) {
      setFileStatuses((prev) => ({ ...prev, [filePath]: 'pending', [candidatePath]: 'pending' }))
      await refreshGitStatus()
      console.error('暂存文件失败:', filePath, err)
    }
  }, [currentWorkspace, stageSingleFileWithFallback, refreshGitStatus])

  // 记录编辑器变更
  const handleFileEdited = useCallback((change: FileChangeInfo) => {
    if (!sessionId) return
    const normalizedPath = normalizeWorkspaceRelativePath(change.filePath, currentWorkspace)
    if (!normalizedPath) return
    const normalizedChange: FileChangeInfo = {
      filePath: normalizedPath,
      oldContent: change.oldContent,
      newContent: change.newContent,
    }
    setManualFileChangesBySession((prev) => {
      const current = prev[sessionId] ?? []
      const map = new Map<string, FileChangeInfo>()
      for (const item of current) map.set(item.filePath, item)
      const existing = map.get(normalizedPath)
      if (existing) {
        map.set(normalizedPath, {
          filePath: normalizedPath,
          oldContent: existing.oldContent,
          newContent: normalizedChange.newContent,
        })
      } else {
        map.set(normalizedPath, normalizedChange)
      }
      const merged = Array.from(map.values()).filter((fc) => fc.oldContent !== fc.newContent)
      return { ...prev, [sessionId]: merged }
    })
  }, [sessionId, currentWorkspace])

  // 拒绝单个文件
  const handleRejectFile = useCallback(async (filePath: string) => {
    const change = dedupedFileChanges.find((fc) => fc.filePath === filePath)
    if (!change) return
    const absPath = resolveFilePath(filePath, currentWorkspace)
    try {
      if (change.oldContent === null && change.newContent !== null) {
        await window.taco.file.delete(absPath)
      } else if (change.oldContent !== null && change.newContent === null) {
        await window.taco.file.revert(absPath, change.oldContent)
      } else if (change.oldContent !== null && change.newContent !== null) {
        await window.taco.file.revert(absPath, change.oldContent)
      }
      setFileStatuses((prev) => ({ ...prev, [filePath]: 'rejected' }))
      removeManualChanges([filePath])
      await refreshGitStatus()
    } catch (err) {
      console.error('撤销文件变更失败:', filePath, err)
    }
  }, [currentWorkspace, dedupedFileChanges, removeManualChanges, refreshGitStatus])

  // 接受所有文件
  const handleAcceptAll = useCallback(async () => {
    if (!currentWorkspace) return
    setGitWorkingStatus((prev) => {
      const staged = new Set(prev.staged ?? [])
      for (const p of prev.unstaged ?? []) staged.add(p)
      for (const fc of dedupedFileChanges) {
        const normalized = normalizeWorkspaceRelativePath(fc.filePath, currentWorkspace)
        if (normalized) staged.add(normalized)
      }
      return { staged: Array.from(staged), unstaged: [], fileStatuses: prev.fileStatuses }
    })
    setFileStatuses((prev) => {
      const next = { ...prev }
      for (const fc of dedupedFileChanges) next[fc.filePath] = 'accepted'
      return next
    })
    try {
      try {
        await window.taco.git.stageAll(currentWorkspace)
      } catch (errAll) {
        const fallbackTargets = Array.from(new Set([
          ...gitUnstagedFiles,
          ...dedupedFileChanges.map((fc) => fc.filePath),
        ])).filter(Boolean)
        let successAny = false
        for (const p of fallbackTargets) {
          try {
            await stageSingleFileWithFallback(p)
            successAny = true
          } catch {
            // continue
          }
        }
        if (!successAny) throw errAll
      }
      await refreshGitStatus()
    } catch (err) {
      setFileStatuses((prev) => {
        const next = { ...prev }
        for (const fc of dedupedFileChanges) next[fc.filePath] = 'pending'
        return next
      })
      await refreshGitStatus()
      console.error('暂存全部失败:', err)
    }
  }, [currentWorkspace, dedupedFileChanges, gitUnstagedFiles, stageSingleFileWithFallback, refreshGitStatus])

  // 拒绝所有文件
  const handleRejectAll = useCallback(async () => {
    const pending = dedupedFileChanges.filter(
      (fc) => readFileStatus(fc.filePath) === 'pending'
    )
    for (const change of pending) {
      const absPath = resolveFilePath(change.filePath, currentWorkspace)
      try {
        if (change.oldContent === null && change.newContent !== null) {
          await window.taco.file.delete(absPath)
        } else if (change.oldContent !== null && change.newContent === null) {
          await window.taco.file.revert(absPath, change.oldContent)
        } else if (change.oldContent !== null && change.newContent !== null) {
          await window.taco.file.revert(absPath, change.oldContent)
        }
        setFileStatuses((prev) => ({ ...prev, [change.filePath]: 'rejected' }))
      } catch (err) {
        console.error('撤销文件变更失败:', change.filePath, err)
      }
    }
    removeManualChanges(pending.map((fc) => fc.filePath))
    await refreshGitStatus()
  }, [currentWorkspace, dedupedFileChanges, readFileStatus, removeManualChanges, refreshGitStatus])

  // 持久化文件审核状态
  useEffect(() => {
    if (sessionIdRef.current) {
      saveJson(`taco.fileStatuses.${sessionIdRef.current}`, fileStatuses)
    }
  }, [fileStatuses])

  // 切换会话时加载审核状态
  useEffect(() => {
    if (sessionId) {
      setFileStatuses(loadJson(`taco.fileStatuses.${sessionId}`, {}))
    }
  }, [sessionId])

  // 切换工作区时重置状态
  useEffect(() => {
    if (!sessionId) return
    const prevWorkspace = lastWorkspaceBySessionRef.current[sessionId]
    if (prevWorkspace === undefined) {
      lastWorkspaceBySessionRef.current[sessionId] = currentWorkspace
      return
    }
    if (prevWorkspace !== currentWorkspace) {
      const baseline = messages.length
      setChangeStartIndexBySession((prev) => ({ ...prev, [sessionId]: baseline }))
      setManualFileChangesBySession((prev) => ({ ...prev, [sessionId]: [] }))
      setLiveFileChangeOverrides({})
      setFileStatuses({})
      setSelectedFile(null)
    }
    lastWorkspaceBySessionRef.current[sessionId] = currentWorkspace
  }, [sessionId, currentWorkspace, messages.length])

  return {
    selectedFile,
    setSelectedFile,
    manualFileChangesBySession,
    setManualFileChangesBySession,
    changeStartIndexBySession,
    setChangeStartIndexBySession,
    fileStatuses,
    setFileStatuses,
    gitWorkingStatus,
    gitStatusLoaded,
    gitStagedFiles,
    gitUnstagedFiles,
    stagedFileSet,
    unstagedFileSet,
    changeStartIndex,
    dedupedFileChanges,
    readFileStatus,
    refreshGitStatus,
    handleAcceptFile,
    handleRejectFile,
    handleAcceptAll,
    handleRejectAll,
    handleFileEdited,
    removeManualChanges,
  }
}
