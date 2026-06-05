import type { ChatMessage } from '../llm/llm-client'
import type { PlanStepStatus } from '../../../shared/ipc-types'
import { stripUserAssetsBlock, extractUserQueryText } from '../../../shared/user-assets'

type PlanStep = {
  index: number
  title: string
  content: string
  status: PlanStepStatus
  note?: string
}

export type ContextBuildState = {
  round: number
  goal: string
  toolUsageCount: Map<string, number>
  changedFiles: Set<string>
  touchedFiles: Set<string>
  touchedIdentifiers: Set<string>
  failures: string[]
  enforceStandardToolCall?: boolean
  completionValidationHint?: string
  currentPlan?: {
    summary: string
    reasoning?: string
    steps: PlanStep[]
  } | null
}

function compactList(items: string[], limit: number): string {
  if (items.length === 0) return '无'
  const sliced = items.slice(0, limit)
  const suffix = items.length > limit ? ` 等${items.length}项` : ''
  return `${sliced.join('、')}${suffix}`
}

export function collectPendingPlanSteps(plan: ContextBuildState['currentPlan']): Array<{ index: number; step: PlanStep }> {
  if (!plan) return []
  const out: Array<{ index: number; step: PlanStep }> = []
  for (const step of plan.steps) {
    if (step.status === 'pending' || step.status === 'in_progress') {
      out.push({ index: step.index, step })
    }
  }
  return out
}

function collectResolvedPlanSteps(plan: ContextBuildState['currentPlan']): Array<{ index: number; step: PlanStep }> {
  if (!plan) return []
  const out: Array<{ index: number; step: PlanStep }> = []
  for (const step of plan.steps) {
    if (step.status === 'done' || step.status === 'failed') {
      out.push({ index: step.index, step })
    }
  }
  return out
}

function extractUserGoalText(goal: string): string {
  return extractUserQueryText(goal)
}

function hasRequestSignal(text: string): boolean {
  if (!text.trim()) return false
  const patterns = [
    '?', '？', '请', '帮', '麻烦', '需要', '能否', '能不能', '可否', '如何', '怎么',
    'please', 'can you', 'could you', 'how to', 'why', 'help me',
  ]
  const lower = text.toLowerCase()
  return patterns.some((keyword) => lower.includes(keyword))
}

function isStatusConfirmationIntent(goal: string): boolean {
  const text = extractUserGoalText(goal)
  if (!text.trim()) return true
  if (hasRequestSignal(text)) return false

  const lower = text.toLowerCase()
  const patterns = [
    '已修复', '已经修复', '已完成', '已经完成', '已解决', '已经解决',
    '问题已', '根因', '原因是', '确认', '没问题', '好了', 'ok了',
    'fixed', 'resolved', 'done',
  ]
  return patterns.some((keyword) => lower.includes(keyword))
}

export function inferIntentType(goal: string): 'qa' | 'code' | 'browser' | 'desktop' | 'mixed' {
  if (isStatusConfirmationIntent(goal)) return 'qa'
  const text = extractUserGoalText(goal).toLowerCase()
  if (!text.trim()) return 'qa'

  const browserKeywords = ['浏览器', '页面', 'dom', 'selector', 'browser_', 'url', '网页', '截图页面', 'console', 'click', 'type']
  const desktopKeywords = ['桌面', '鼠标', '键盘', 'desktop_', '拖动', '双击', '坐标', '系统窗口']
  const codeKeywords = ['代码', '文件', '函数', '变量', '编译', '构建', '测试', '修复', 'read_file', 'edit_file', 'write_file', 'run_command']

  const hasBrowser = browserKeywords.some((k) => text.includes(k))
  const hasDesktop = desktopKeywords.some((k) => text.includes(k))
  const hasCode = codeKeywords.some((k) => text.includes(k))

  const hitCount = Number(hasBrowser) + Number(hasDesktop) + Number(hasCode)
  if (hitCount >= 2) return 'mixed'
  if (hasBrowser) return 'browser'
  if (hasDesktop) return 'desktop'
  if (hasCode) return 'code'
  return 'qa'
}

export function buildCurrentTaskCompressionStateCard(state: ContextBuildState): string {
  const toolUsage = Array.from(state.toolUsageCount.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name}x${count}`)
  const files = state.changedFiles.size > 0 ? Array.from(state.changedFiles) : Array.from(state.touchedFiles)
  const identifiers = Array.from(state.touchedIdentifiers)
  const pendingSteps = collectPendingPlanSteps(state.currentPlan)
  const resolvedSteps = collectResolvedPlanSteps(state.currentPlan)

  const lines: string[] = []
  lines.push('# 当前任务状态')
  lines.push(`- 当前目标: ${extractUserGoalText(state.goal) || state.goal}`)
  lines.push(`- 当前轮次: ${state.round}`)
  lines.push(`- 当前意图类型: ${inferIntentType(state.goal)}`)
  lines.push(`- 已有工具证据: ${toolUsage.length > 0 ? compactList(toolUsage, 12) : '无'}`)
  lines.push(`- 当前影响文件: ${files.length > 0 ? compactList(files, 20) : '无'}`)
  lines.push(`- 当前涉及标识符: ${identifiers.length > 0 ? compactList(identifiers, 24) : '无'}`)
  lines.push(`- 当前失败记录: ${state.failures.length > 0 ? compactList(state.failures, 8) : '无'}`)
  if (state.currentPlan) {
    lines.push(`- 当前执行计划: ${state.currentPlan.summary || '（无）'}`)
    lines.push(`- 已完成/已结束步骤: ${resolvedSteps.length}`)
    for (const item of resolvedSteps.slice(-6)) {
      lines.push(`  - [${item.index}] ${item.step.title || item.step.content} (${item.step.status})${item.step.note ? ` | ${item.step.note}` : ''}`)
    }
    lines.push(`- 待继续步骤: ${pendingSteps.length}`)
    for (const item of pendingSteps.slice(0, 8)) {
      lines.push(`  - [${item.index}] ${item.step.title || item.step.content} (${item.step.status})${item.step.note ? ` | ${item.step.note}` : ''}`)
    }
    lines.push('- 计划续跑要求: 当前计划未结束，继续执行时必须持续调用 update_plan_progress 维护步骤状态。')
  } else {
    lines.push('- 当前执行计划: 无显式计划')
  }
  lines.push('- 说明: 这是当前未完成任务的状态快照，供压缩续跑使用，不代表任务已完成。')
  return lines.join('\n')
}

export { validateCompletionClaim } from './completion-validator'
