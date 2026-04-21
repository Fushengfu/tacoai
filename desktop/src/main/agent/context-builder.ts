import type { ChatMessage } from '../ai/llm'
import type { PlanStepStatus } from '../../shared/ipc'

type PlanStep = {
  text: string
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

function collectPendingPlanSteps(plan: ContextBuildState['currentPlan']): Array<{ index: number; step: PlanStep }> {
  if (!plan) return []
  const out: Array<{ index: number; step: PlanStep }> = []
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i]
    if (step.status === 'pending' || step.status === 'in_progress') {
      out.push({ index: i, step })
    }
  }
  return out
}

function collectResolvedPlanSteps(plan: ContextBuildState['currentPlan']): Array<{ index: number; step: PlanStep }> {
  if (!plan) return []
  const out: Array<{ index: number; step: PlanStep }> = []
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i]
    if (step.status === 'done' || step.status === 'failed') {
      out.push({ index: i, step })
    }
  }
  return out
}

const USER_ASSETS_BLOCK_REGEX = /\s*\[USER_ASSETS\][\s\S]*?\[\/USER_ASSETS\]\s*/gi

function extractUserGoalText(goal: string): string {
  const raw = String(goal ?? '')
    .replace(USER_ASSETS_BLOCK_REGEX, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const wrapped = raw.match(/\[USER_QUERY\]([\s\S]*?)\[\/USER_QUERY\]/i)
  if (wrapped && wrapped[1]) return wrapped[1].trim()
  return raw.trim()
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

function inferIntentType(goal: string): 'qa' | 'code' | 'browser' | 'desktop' | 'mixed' {
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

function buildRuntimeStateCard(state: ContextBuildState): string {
  const toolUsage = Array.from(state.toolUsageCount.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name}x${count}`)
  const files = state.changedFiles.size > 0 ? Array.from(state.changedFiles) : Array.from(state.touchedFiles)
  const identifiers = Array.from(state.touchedIdentifiers)
  const pendingSteps = collectPendingPlanSteps(state.currentPlan)

  const lines: string[] = []
  lines.push('# 运行时上下文状态卡')
  lines.push(`- 当前轮次: ${state.round}`)
  lines.push(`- 当前意图类型: ${inferIntentType(state.goal)}`)
  lines.push(`- 工具执行证据: ${toolUsage.length > 0 ? compactList(toolUsage, 12) : '无'}`)
  lines.push(`- 影响文件: ${files.length > 0 ? compactList(files, 20) : '无'}`)
  lines.push(`- 涉及标识符: ${identifiers.length > 0 ? compactList(identifiers, 24) : '无'}`)
  lines.push(`- 失败记录: ${state.failures.length > 0 ? compactList(state.failures, 8) : '无'}`)
  if (state.currentPlan) {
    lines.push(`- 执行计划: ${state.currentPlan.summary || '（无）'}`)
    lines.push(`- 未完成计划步骤: ${pendingSteps.length}`)
    for (const item of pendingSteps.slice(0, 8)) {
      lines.push(`  - [${item.index + 1}] ${item.step.text} (${item.step.status})${item.step.note ? ` | ${item.step.note}` : ''}`)
    }
    lines.push('- 计划续跑要求: 若继续执行当前计划，开始步骤前调用 update_plan_progress(stepIndex, "in_progress")，完成后调用 update_plan_progress(stepIndex, "done"|"failed")。')
  }
  if (state.completionValidationHint) {
    lines.push(`- 完成校验提醒: 上一轮完成声明未通过（原因: ${state.completionValidationHint}）；如任务仍需执行，应继续调用工具并给出可验证证据。`)
  }
  if (state.enforceStandardToolCall) {
    lines.push('- 标准工具调用要求: 上一轮出现了非标准工具调用迹象。若需要执行工具，必须通过标准 tool_calls 触发，禁止在普通文本中拼接伪调用。')
  }
  lines.push('- 约束: 能直接回答时可直接给出最终答复；只有确实需要外部操作、读取或验证时再调用工具。')
  lines.push('- 约束: 若需要执行动作，必须先调用工具并基于工具结果回复；禁止仅凭历史总结宣称已完成。')
  return lines.join('\n')
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
      lines.push(`  - [${item.index + 1}] ${item.step.text} (${item.step.status})${item.step.note ? ` | ${item.step.note}` : ''}`)
    }
    lines.push(`- 待继续步骤: ${pendingSteps.length}`)
    for (const item of pendingSteps.slice(0, 8)) {
      lines.push(`  - [${item.index + 1}] ${item.step.text} (${item.step.status})${item.step.note ? ` | ${item.step.note}` : ''}`)
    }
    lines.push('- 计划续跑要求: 当前计划未结束，继续执行时必须持续调用 update_plan_progress 维护步骤状态。')
  } else {
    lines.push('- 当前执行计划: 无显式计划')
  }
  lines.push('- 说明: 这是当前未完成任务的状态快照，供压缩续跑使用，不代表任务已完成。')
  return lines.join('\n')
}

function isActionIntent(goal: string): boolean {
  if (isStatusConfirmationIntent(goal)) return false
  const text = extractUserGoalText(goal).toLowerCase()
  if (!text.trim()) return false
  const patterns = [
    '修改', '修复', '实现', '新增', '删除', '运行', '测试', '排查', '查看', '检查', '打开', '点击', '输入', '截图',
    '部署', '优化', '编写', '重构', '更新', '创建', '启动', '停止', '同步', '拖动', '配置', '安装',
    'fix', 'implement', 'update', 'create', 'delete', 'run', 'test', 'debug', 'check', 'open', 'click', 'type',
    'screenshot', 'deploy', 'optimize', 'refactor',
  ]
  return patterns.some((keyword) => text.includes(keyword))
}

function hasCompletionClaim(text: string): boolean {
  const content = String(text ?? '').toLowerCase()
  if (!content.trim()) return false
  const patterns = [
    '任务完成', '已完成', '完成了', '已经完成', '已修复', '修复完成', '全部完成', '搞定',
    'completed', 'done', 'fixed', 'resolved', 'all set',
  ]
  return patterns.some((keyword) => content.includes(keyword))
}

export function buildAgentRequestMessages(baseMessages: ChatMessage[], state: ContextBuildState): ChatMessage[] {
  if (baseMessages.length === 0) return baseMessages
  const systemMessages: ChatMessage[] = []
  const nonSystemMessages: ChatMessage[] = []
  for (const msg of baseMessages) {
    if (msg.role === 'system') systemMessages.push(msg)
    else nonSystemMessages.push(msg)
  }
  const runtimeCard: ChatMessage = {
    role: 'system',
    content: buildRuntimeStateCard(state),
  }
  return [...systemMessages, runtimeCard, ...nonSystemMessages]
}

export function validateCompletionClaim(
  assistantText: string,
  state: ContextBuildState,
): { pass: true } | { pass: false; reason: string } {
  const pendingSteps = collectPendingPlanSteps(state.currentPlan)
  if (pendingSteps.length > 0) {
    return { pass: false, reason: `仍有 ${pendingSteps.length} 个计划步骤未完成` }
  }

  const intentType = inferIntentType(state.goal)
  if (intentType === 'qa') return { pass: true }

  const actionIntent = isActionIntent(state.goal)
  const completionClaim = hasCompletionClaim(assistantText)
  if (!actionIntent || !completionClaim) return { pass: true }

  const evidenceCount =
    Array.from(state.toolUsageCount.values()).reduce((sum, n) => sum + n, 0) +
    state.changedFiles.size +
    state.failures.length

  if (evidenceCount <= 0) {
    return { pass: false, reason: '存在完成声明但没有任何工具执行证据' }
  }

  return { pass: true }
}
