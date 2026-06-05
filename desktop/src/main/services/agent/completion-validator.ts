import type { ContextBuildState } from './context-builder'
import { collectPendingPlanSteps, inferIntentType } from './context-builder'

function hasCompletionClaim(text: string): boolean {
  const content = String(text ?? '').toLowerCase()
  if (!content.trim()) return false
  const patterns = [
    '任务完成', '已完成', '完成了', '已经完成', '已修复', '修复完成', '全部完成', '搞定',
    'completed', 'done', 'fixed', 'resolved', 'all set',
  ]
  return patterns.some((keyword) => content.includes(keyword))
}

function isActionIntent(goal: string): boolean {
  // 复用了 context-builder 中的 isStatusConfirmationIntent + extractUserGoalText
  // 这里内联实现以避免循环导入
  const text = extractUserGoalTextInline(goal).toLowerCase()
  if (!text.trim()) return false
  if (isStatusConfirmationIntentInline(goal)) return false
  const patterns = [
    '修改', '修复', '实现', '新增', '删除', '运行', '测试', '排查', '查看', '检查', '打开', '点击', '输入', '截图',
    '部署', '优化', '编写', '重构', '更新', '创建', '启动', '停止', '同步', '拖动', '配置', '安装',
    'fix', 'implement', 'update', 'create', 'delete', 'run', 'test', 'debug', 'check', 'open', 'click', 'type',
    'screenshot', 'deploy', 'optimize', 'refactor',
  ]
  return patterns.some((keyword) => text.includes(keyword))
}

function extractUserGoalTextInline(goal: string): string {
  // 简单实现：如果 goal 包含 [USER_QUERY] 标签，提取内部文本
  const match = goal.match(/\[USER_QUERY\]([\s\S]*?)\[\/USER_QUERY\]/)
  if (match) return match[1].trim()
  return goal
}

function isStatusConfirmationIntentInline(goal: string): boolean {
  const text = extractUserGoalTextInline(goal)
  if (!text.trim()) return true
  if (hasRequestSignalInline(text)) return false
  const lower = text.toLowerCase()
  const patterns = [
    '已修复', '已经修复', '已完成', '已经完成', '已解决', '已经解决',
    '问题已', '根因', '原因是', '确认', '没问题', '好了', 'ok了',
    'fixed', 'resolved', 'done',
  ]
  return patterns.some((keyword) => lower.includes(keyword))
}

function hasRequestSignalInline(text: string): boolean {
  if (!text.trim()) return false
  const patterns = [
    '?', '？', '请', '帮', '麻烦', '需要', '能否', '能不能', '可否', '如何', '怎么',
    'please', 'can you', 'could you', 'how to', 'why', 'help me',
  ]
  const lower = text.toLowerCase()
  return patterns.some((keyword) => lower.includes(keyword))
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
