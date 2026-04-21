import { app } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'

export type RewardChannel = 'agent' | 'chat'
export type RewardOutcome = 'success' | 'aborted' | 'error'

type RewardBreakdownItem = {
  label: string
  delta: number
}

type RewardLedgerEntry = {
  id: string
  createdAt: string
  channel: RewardChannel
  outcome: RewardOutcome
  delta: number
  pointsAfter: number
  debtUsdAfter: number
  breakdown: RewardBreakdownItem[]
  meta?: {
    requestId?: string
    projectId?: string
    workspace?: string
    toolCalls?: number
    changedFiles?: number
    failures?: number
  }
}

type RewardScoreState = {
  points: number
  debtUsd: number
  totalReward: number
  totalPenalty: number
  turnCount: number
  updatedAt: string
  entries: RewardLedgerEntry[]
}

export type RewardApplyInput = {
  channel: RewardChannel
  outcome: RewardOutcome
  workspace?: string
  projectId?: string
  requestId?: string
  toolCalls?: number
  changedFiles?: number
  failures?: number
  elapsedMs?: number
}

type RewardApplyResult = {
  delta: number
  state: RewardScoreState
  entry: RewardLedgerEntry
}

const REWARD_DIR = path.join(resolveDataHome(), 'reward-score')
const SCORE_STATE_MAX_ENTRIES = 500
const DEFAULT_POINTS = 100
const USD_PER_POINT_DEBT = 1000

function resolveDataHome(): string {
  try {
    const userData = app.getPath('userData')
    if (userData && userData.trim()) return userData.trim()
  } catch {
    // ignore
  }
  const envHome = (process.env.HOME || process.env.USERPROFILE || '').trim()
  if (envHome) return path.join(envHome, '.taco')
  const osHome = (os.homedir() || '').trim()
  if (osHome) return path.join(osHome, '.taco')
  return path.join(process.cwd(), '.taco')
}

function scopeKey(workspace?: string, projectId?: string): string {
  const pid = String(projectId ?? '').trim()
  if (pid) return `project-${createHash('sha256').update(pid).digest('hex').slice(0, 16)}`
  const ws = String(workspace ?? '').trim()
  if (ws) return `ws-${createHash('sha256').update(path.resolve(ws)).digest('hex').slice(0, 16)}`
  return 'global'
}

function stateFilePath(workspace?: string, projectId?: string): string {
  return path.join(REWARD_DIR, `${scopeKey(workspace, projectId)}.json`)
}

async function ensureRewardDir(): Promise<void> {
  await fs.mkdir(REWARD_DIR, { recursive: true })
}

function normalizeInt(value: unknown, fallback = 0): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.floor(n)
}

function normalizeState(raw: unknown): RewardScoreState {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const now = new Date().toISOString()
  const points = Math.max(0, normalizeInt(obj.points, DEFAULT_POINTS))
  const debtUsd = Math.max(0, normalizeInt(obj.debtUsd, 0))
  const totalReward = Math.max(0, normalizeInt(obj.totalReward, 0))
  const totalPenalty = Math.max(0, normalizeInt(obj.totalPenalty, 0))
  const turnCount = Math.max(0, normalizeInt(obj.turnCount, 0))
  const updatedAt = String(obj.updatedAt || now)
  const entriesRaw = Array.isArray(obj.entries) ? obj.entries : []

  const entries: RewardLedgerEntry[] = entriesRaw
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const r = item as Record<string, unknown>
      const breakdownRaw = Array.isArray(r.breakdown) ? r.breakdown : []
      const breakdown: RewardBreakdownItem[] = breakdownRaw
        .map((part) => {
          if (!part || typeof part !== 'object') return null
          const p = part as Record<string, unknown>
          const label = String(p.label || '').trim()
          const delta = normalizeInt(p.delta, 0)
          if (!label || delta === 0) return null
          return { label, delta }
        })
        .filter((v): v is RewardBreakdownItem => Boolean(v))

      const channel = String(r.channel) === 'chat' ? 'chat' : 'agent'
      const outcomeText = String(r.outcome)
      const outcome: RewardOutcome = outcomeText === 'aborted' ? 'aborted' : outcomeText === 'error' ? 'error' : 'success'
      return {
        id: String(r.id || randomUUID()),
        createdAt: String(r.createdAt || now),
        channel,
        outcome,
        delta: normalizeInt(r.delta, 0),
        pointsAfter: Math.max(0, normalizeInt(r.pointsAfter, points)),
        debtUsdAfter: Math.max(0, normalizeInt(r.debtUsdAfter, debtUsd)),
        breakdown,
        meta: r.meta && typeof r.meta === 'object' ? (r.meta as RewardLedgerEntry['meta']) : undefined,
      }
    })
    .filter((v): v is RewardLedgerEntry => Boolean(v))
    .slice(-SCORE_STATE_MAX_ENTRIES)

  return {
    points,
    debtUsd,
    totalReward,
    totalPenalty,
    turnCount,
    updatedAt,
    entries,
  }
}

async function loadState(workspace?: string, projectId?: string): Promise<RewardScoreState> {
  const file = stateFilePath(workspace, projectId)
  try {
    const raw = await fs.readFile(file, 'utf-8')
    return normalizeState(JSON.parse(raw))
  } catch {
    const now = new Date().toISOString()
    return {
      points: DEFAULT_POINTS,
      debtUsd: 0,
      totalReward: 0,
      totalPenalty: 0,
      turnCount: 0,
      updatedAt: now,
      entries: [],
    }
  }
}

async function saveState(workspace: string | undefined, projectId: string | undefined, state: RewardScoreState): Promise<void> {
  await ensureRewardDir()
  const file = stateFilePath(workspace, projectId)
  await fs.writeFile(file, JSON.stringify(state, null, 2), 'utf-8')
}

function clampNonNegative(n: number): number {
  if (!Number.isFinite(n)) return 0
  return n < 0 ? 0 : Math.floor(n)
}

function computeTurnDelta(input: RewardApplyInput): { delta: number; breakdown: RewardBreakdownItem[] } {
  const parts: RewardBreakdownItem[] = []
  const toolCalls = clampNonNegative(input.toolCalls ?? 0)
  const changedFiles = clampNonNegative(input.changedFiles ?? 0)
  const failures = clampNonNegative(input.failures ?? 0)
  const elapsedMs = clampNonNegative(input.elapsedMs ?? 0)

  const base = input.outcome === 'success'
    ? (input.channel === 'agent' ? 8 : 3)
    : input.outcome === 'aborted'
      ? -4
      : -10
  parts.push({ label: `base:${input.channel}:${input.outcome}`, delta: base })

  if (input.channel === 'agent') {
    if (toolCalls > 0) {
      parts.push({ label: 'evidence:tool_calls', delta: Math.min(6, toolCalls) })
    } else if (input.outcome === 'success') {
      // agent 成功但没有工具证据，按低质量结算
      parts.push({ label: 'penalty:missing_tool_evidence', delta: -6 })
    }

    if (changedFiles > 0) {
      parts.push({ label: 'evidence:changed_files', delta: Math.min(4, changedFiles) })
    }

    if (failures > 0) {
      parts.push({ label: 'penalty:failures', delta: -Math.min(12, failures * 2) })
    }

    // 使用了工具但没有有效解决问题（最终非 success）时追加扣分
    if (toolCalls > 0 && input.outcome !== 'success') {
      const ineffectivePenalty = Math.min(12, 2 + Math.ceil(toolCalls / 2) * 2)
      parts.push({ label: 'penalty:tools_without_effective_resolution', delta: -ineffectivePenalty })
    }
  } else if (input.channel === 'chat') {
    if (input.outcome === 'error') {
      parts.push({ label: 'penalty:chat_error', delta: -2 })
    }
  }

  // 用时效率奖励：仅在成功轮次生效
  if (input.outcome === 'success' && elapsedMs > 0) {
    const elapsedSec = elapsedMs / 1000
    if (input.channel === 'agent') {
      // agent 按“每个执行单元耗时”评估，避免任务复杂度差异过大
      const executionUnits = Math.max(1, toolCalls)
      const secPerUnit = elapsedSec / executionUnits
      if (secPerUnit <= 18) {
        parts.push({ label: 'bonus:speed_fast', delta: 6 })
      } else if (secPerUnit <= 35) {
        parts.push({ label: 'bonus:speed_good', delta: 4 })
      } else if (secPerUnit <= 60) {
        parts.push({ label: 'bonus:speed_ok', delta: 2 })
      }
    } else {
      if (elapsedSec <= 8) {
        parts.push({ label: 'bonus:speed_fast', delta: 3 })
      } else if (elapsedSec <= 20) {
        parts.push({ label: 'bonus:speed_good', delta: 2 })
      } else if (elapsedSec <= 40) {
        parts.push({ label: 'bonus:speed_ok', delta: 1 })
      }
    }
  }

  const delta = parts.reduce((sum, part) => sum + part.delta, 0)
  return { delta, breakdown: parts.filter((part) => part.delta !== 0) }
}

export async function applyRewardScore(input: RewardApplyInput): Promise<RewardApplyResult> {
  const workspace = String(input.workspace ?? '').trim()
  const projectId = String(input.projectId ?? '').trim()
  const prev = await loadState(workspace, projectId)
  const { delta, breakdown } = computeTurnDelta(input)

  let nextPoints = prev.points
  let nextDebtUsd = prev.debtUsd
  if (delta >= 0) {
    nextPoints += delta
  } else {
    const penalty = Math.abs(delta)
    if (nextPoints >= penalty) {
      nextPoints -= penalty
    } else {
      const deficit = penalty - nextPoints
      nextPoints = 0
      nextDebtUsd += deficit * USD_PER_POINT_DEBT
    }
  }

  const now = new Date().toISOString()
  const entry: RewardLedgerEntry = {
    id: randomUUID(),
    createdAt: now,
    channel: input.channel,
    outcome: input.outcome,
    delta,
    pointsAfter: nextPoints,
    debtUsdAfter: nextDebtUsd,
    breakdown,
    meta: {
      ...(input.requestId ? { requestId: input.requestId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(workspace ? { workspace } : {}),
      ...(typeof input.toolCalls === 'number' ? { toolCalls: clampNonNegative(input.toolCalls) } : {}),
      ...(typeof input.changedFiles === 'number' ? { changedFiles: clampNonNegative(input.changedFiles) } : {}),
      ...(typeof input.failures === 'number' ? { failures: clampNonNegative(input.failures) } : {}),
      ...(typeof input.elapsedMs === 'number' ? { elapsedMs: clampNonNegative(input.elapsedMs) } : {}),
    },
  }

  const next: RewardScoreState = {
    points: nextPoints,
    debtUsd: nextDebtUsd,
    totalReward: prev.totalReward + (delta > 0 ? delta : 0),
    totalPenalty: prev.totalPenalty + (delta < 0 ? Math.abs(delta) : 0),
    turnCount: prev.turnCount + 1,
    updatedAt: now,
    entries: [...prev.entries, entry].slice(-SCORE_STATE_MAX_ENTRIES),
  }

  await saveState(workspace, projectId, next)
  return { delta, state: next, entry }
}
