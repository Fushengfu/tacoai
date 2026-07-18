import { useEffect, useState } from 'react'
import type { ActivePlan, ChatMsg } from '../../types'

/* ------------------------------------------------------------------ */
/*  PlanTracker — 实时计划进度追踪器                                      */
/* ------------------------------------------------------------------ */

const planStepIcons: Record<string, string> = {
  pending: '○',
  in_progress: '◉',
  done: '✓',
  failed: '✗',
}

export const INITIAL_VISIBLE_MESSAGE_COUNT = 60
export const LOAD_MORE_MESSAGE_BATCH = 40
export const LOAD_MORE_SCROLL_THRESHOLD_PX = 72

export function normalizePlanStepStatus(status: string): 'pending' | 'in_progress' | 'done' | 'failed' {
  const s = String(status ?? '').trim().toLowerCase()
  if (s === 'in-progress' || s === 'inprogress' || s === 'running') return 'in_progress'
  if (s === 'complete' || s === 'completed' || s === 'success' || s === 'succeeded') return 'done'
  if (s === 'error') return 'failed'
  if (s === 'pending' || s === 'in_progress' || s === 'done' || s === 'failed') return s
  return 'pending'
}

export function formatElapsedHms(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  return `${h}h${m}m${s}s`
}

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export function formatTaskTimingLabel(
  taskTiming?: ChatMsg['taskTiming'] | null,
  nowTs?: number,
  fallbackStartedAt?: number,
): string | null {
  const startedAtRaw = Number(taskTiming?.startedAt ?? fallbackStartedAt)
  if (!Number.isFinite(startedAtRaw) || startedAtRaw <= 0) return null
  const startedAt = startedAtRaw
  const direct = Number(taskTiming?.durationMs)
  const endedAt = Number(taskTiming?.endedAt)
  let durationMs = Number.NaN
  if (Number.isFinite(direct)) durationMs = direct
  else if (Number.isFinite(endedAt) && endedAt >= startedAt) durationMs = endedAt - startedAt
  else durationMs = (Number.isFinite(nowTs) ? Number(nowTs) : Date.now()) - startedAt
  if (!Number.isFinite(durationMs)) return null
  return `本轮耗时 ${formatElapsedHms(Math.max(0, durationMs))}`
}

export function PlanTracker({ plan }: { plan: ActivePlan }) {
  const [nowTs, setNowTs] = useState(() => Date.now())
  useEffect(() => {
    if (plan.endedAt) return
    const timer = window.setInterval(() => setNowTs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [plan.endedAt])

  const normalizedSteps = plan.steps.map((s) => ({
    ...s,
    text: s.title || s.content || '',
    status: normalizePlanStepStatus(s.status),
  }))
  const doneCount = normalizedSteps.filter((s) => s.status === 'done').length
  const failedCount = normalizedSteps.filter((s) => s.status === 'failed').length
  const totalCount = plan.steps.length
  const progress = totalCount > 0 ? Math.round(((doneCount + failedCount) / totalCount) * 100) : 0
  const allDone = doneCount + failedCount === totalCount && totalCount > 0
  const startedAt = plan.startedAt ?? nowTs
  const endedAt = plan.endedAt ?? nowTs
  const elapsedText = formatElapsedHms(Math.max(0, endedAt - startedAt))

  return (
    <div className={`plan-tracker ${allDone ? 'completed' : ''}`}>
      <div className="plan-tracker-header">
        <span className="plan-tracker-title">执行计划</span>
        <span className="plan-tracker-elapsed">耗时 {elapsedText}</span>
        <span className="plan-tracker-progress">{doneCount}/{totalCount}</span>
      </div>
      {plan.summary && (
        <div className="plan-tracker-summary">{plan.summary}</div>
      )}
      <div className="plan-tracker-bar">
        <div
          className={`plan-tracker-bar-fill ${allDone ? 'done' : ''}`}
          style={{ width: `${progress}%` }}
        />
      </div>
      <ol className="plan-tracker-steps">
        {normalizedSteps.map((step, i) => (
          <li key={i} className={`plan-tracker-step ${step.status}`}>
            <span className={`plan-step-icon ${step.status}`}>{planStepIcons[step.status]}</span>
            <div className="plan-step-content">
              <span className="plan-step-title">{step.title || step.text}</span>
              {step.content && <span className="plan-step-desc">{step.content}</span>}
              {step.note && <span className="plan-step-note">{step.note}</span>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}
