import type { ChatMsg, AgentStep } from '../../types'
import { MarkdownBubble } from './MarkdownBubble'
import { ToolResultContent } from '../ToolResultContent'
import { maskToolNamesForUser, parseArgs, toolCallSummary } from './agent-helpers'

/* ------------------------------------------------------------------ */
/*  AgentStepBody — 渲染单个步骤的展开内容（思考 / 确认 / 重试 / 工具结果）   */
/* ------------------------------------------------------------------ */

interface AgentStepBodyProps {
  msg: ChatMsg
  step: AgentStep
  isStepRunning: boolean
  isStepConfirm: boolean
  /** 思考块展开状态 */
  expandedThinkBlocks: Set<string>
  /** 工具块展开状态 */
  expandedToolBlocks: Set<string>
  /** 思考块切换 */
  toggleThinkBlock: (key: string) => void
  /** 工具块切换 */
  toggleToolBlock: (key: string) => void
  /** 已响应的确认 */
  respondedConfirms: Map<string, boolean>
  /** 已响应的重试 */
  respondedRetries: Map<string, boolean>
  /** Agent 是否正在运行 */
  sending: boolean
  /** 确认响应回调 */
  handleConfirmResponse: (confirmId: string, approved: boolean) => void
  /** 重试响应回调 */
  handleRetryResponse: (retryId: string, shouldRetry: boolean) => void
  /** 工作空间 */
  workspace: string
  /** 打开文件回调 */
  openFile: (filePath: string) => void
  /** 图片预览 */
  setPreviewImageUrl: (url: string | null) => void
}

export function AgentStepBody({
  msg,
  step,
  isStepRunning,
  isStepConfirm,
  expandedThinkBlocks,
  expandedToolBlocks,
  toggleThinkBlock,
  toggleToolBlock,
  respondedConfirms,
  respondedRetries,
  sending,
  handleConfirmResponse,
  handleRetryResponse,
  workspace,
  openFile,
  setPreviewImageUrl,
}: AgentStepBodyProps) {
  return (
    <div className="agent-step-body">
      {renderStepThinking()}
      {renderStepConfirm()}
      {renderStepRetryConfirm()}
      {renderStepToolResults()}
    </div>
  )

  function renderStepThinking() {
    if (!step.thinking) return null
    const toolNames = step.toolCalls.map((tc) => tc.name)
    const cleaned = maskToolNamesForUser(
      step.thinking.replace(/<think>/gi, '').replace(/<\/think>/gi, '').trim(),
      toolNames,
    )
    if (!cleaned) return null
    const thinkKey = `think-${msg.id}-${step.round}`
    const isThinkOpen = expandedThinkBlocks.has(thinkKey)
    const preview = cleaned.length > 80 ? cleaned.slice(0, 80).replace(/\n/g, ' ') + '...' : cleaned.replace(/\n/g, ' ')
    return (
      <div className={`step-thinking-block ${isStepRunning ? 'streaming' : 'done'}`}>
        <button type="button" className="step-thinking-header" onClick={() => toggleThinkBlock(thinkKey)}>
          <span className={`step-thinking-chevron ${isThinkOpen ? 'open' : ''}`}>›</span>
          <span className="step-thinking-label">
            💭 思考
            {isStepRunning && <span className="dot-pulse inline" />}
          </span>
          {!isThinkOpen && <span className="step-thinking-preview">{preview}</span>}
        </button>
        {isThinkOpen && (
          <div className="step-thinking-body">
            <MarkdownBubble content={cleaned} workspace={workspace} onOpenProjectFile={(path) => openFile(path)} onImagePreview={setPreviewImageUrl} />
          </div>
        )}
      </div>
    )
  }

  function renderStepConfirm() {
    if (!step.risks || !step.confirmId) return null
    const isPlanConfirm = step.risks.some((r) => r.toolName === 'propose_plan')

    const resolveConfirmStatus = (): 'pending' | 'approved' | 'denied' | 'expired' => {
      const responded = respondedConfirms.get(step.confirmId!)
      if (responded === true) return 'approved'
      if (responded === false) return 'denied'
      if (!isStepConfirm) return 'approved'
      if (!sending) return 'expired'
      return 'pending'
    }
    const confirmStatus = resolveConfirmStatus()

    const renderConfirmStatusUI = () => {
      if (confirmStatus === 'expired') {
        return (
          <div className="agent-confirm-responded expired">
            <span className="agent-confirm-responded-icon">⏱</span>
            {isPlanConfirm ? '该计划确认已过期（程序已重启，如需执行请重新发起）' : '该授权已过期（程序已重启，如需操作请重新发起）'}
          </div>
        )
      }
      if (confirmStatus === 'approved') {
        return (
          <div className="agent-confirm-responded">
            {isStepRunning ? <span className="agent-confirm-responded-icon spinning">⏳</span> : <span className="agent-confirm-responded-icon">✓</span>}
            {isPlanConfirm ? (isStepRunning ? '已确认，正在执行中...' : '已确认执行') : (isStepRunning ? '已授权，正在执行中...' : '已授权执行')}
          </div>
        )
      }
      if (confirmStatus === 'denied') {
        return (
          <div className="agent-confirm-responded denied">
            {isStepRunning ? <span className="agent-confirm-responded-icon spinning">⏳</span> : <span className="agent-confirm-responded-icon">✗</span>}
            {isPlanConfirm ? (isStepRunning ? '已要求调整，等待 AI 响应...' : '已要求调整') : (isStepRunning ? '已拒绝，等待 AI 响应...' : '已拒绝')}
          </div>
        )
      }
      return (
        <div className="agent-confirm-actions">
          <button type="button" className="agent-confirm-btn approve" onClick={() => handleConfirmResponse(step.confirmId!, true)}>
            {isPlanConfirm ? '确认执行' : '允许执行'}
          </button>
          <button type="button" className="agent-confirm-btn deny" onClick={() => handleConfirmResponse(step.confirmId!, false)}>
            {isPlanConfirm ? '需要调整' : '拒绝'}
          </button>
        </div>
      )
    }

    if (isPlanConfirm) {
      let plan: { summary?: string; steps?: Array<{ index?: number; title?: string; content?: string; text?: string }>; reasoning?: string } = {}
      try { plan = JSON.parse(step.risks[0].detail) } catch { /* ignore */ }
      const normalizedPlanSteps = Array.isArray(plan.steps)
        ? plan.steps.map((s) => {
            if (typeof s === 'string') return s
            if (s && typeof s === 'object') {
              return s.title || s.content || (s as { text?: string }).text || String(s)
            }
            return String(s)
          })
        : []
      return (
        <div className="agent-confirm-card plan">
          <div className="agent-confirm-title">
            <span className="agent-confirm-icon">📋</span>
            {confirmStatus === 'expired' ? '执行计划已过期' : confirmStatus === 'pending' ? '执行计划 — 需要你的确认' : '执行计划'}
          </div>
          {plan.summary && <div className="agent-plan-summary">{plan.summary}</div>}
          {normalizedPlanSteps.length > 0 && (
            <ol className="agent-plan-steps">{normalizedPlanSteps.map((s, i) => <li key={i}>{s}</li>)}</ol>
          )}
          {plan.reasoning && (
            <div className="agent-plan-reasoning"><span className="agent-plan-reasoning-label">理由：</span>{plan.reasoning}</div>
          )}
          {renderConfirmStatusUI()}
        </div>
      )
    }

    return (
      <div className="agent-confirm-card">
        <div className="agent-confirm-title">
          <span className="agent-confirm-icon">⚠</span>
          {confirmStatus === 'expired' ? '授权已过期' : confirmStatus === 'pending' ? '需要你的授权' : '授权信息'}
        </div>
        <div className="agent-confirm-risks">
          {step.risks.map((risk) => (
            <div key={risk.toolCallId} className={`agent-confirm-risk ${risk.level}`}>
              <span className="agent-confirm-risk-badge">{risk.level === 'danger' ? '危险' : '注意'}</span>
              <span className="agent-confirm-risk-reason">
                {maskToolNamesForUser(risk.reason, step.risks?.map((r) => r.toolName) ?? [])}
              </span>
              <pre className="agent-confirm-risk-detail">
                {maskToolNamesForUser(risk.detail, step.risks?.map((r) => r.toolName) ?? [])}
              </pre>
            </div>
          ))}
        </div>
        {renderConfirmStatusUI()}
      </div>
    )
  }

  function renderStepRetryConfirm() {
    if (!step.retryId) return null

    const responded = respondedRetries.get(step.retryId)
    const isPending = responded === undefined

    const errorTypeLabels: Record<string, string> = {
      network: '网络连接异常',
      timeout: '请求超时',
      empty_response: '模型未返回有效数据',
      interrupted: '请求中断',
    }
    const errorLabel = errorTypeLabels[step.retryErrorType ?? 'network'] || '未知错误'

    const resolveRetryStatus = (): 'pending' | 'retried' | 'cancelled' => {
      if (responded === true) return 'retried'
      if (responded === false) return 'cancelled'
      return 'pending'
    }
    const retryStatus = resolveRetryStatus()

    const renderRetryStatusUI = () => {
      if (retryStatus === 'retried') {
        return (
          <div className="agent-confirm-responded">
            {isStepRunning
              ? <span className="agent-confirm-responded-icon spinning">⏳</span>
              : <span className="agent-confirm-responded-icon">✓</span>}
            {isStepRunning ? '正在重试中...' : '已重试'}
          </div>
        )
      }
      if (retryStatus === 'cancelled') {
        return (
          <div className="agent-confirm-responded denied">
            <span className="agent-confirm-responded-icon">✗</span>
            已取消重试
          </div>
        )
      }
      return (
        <div className="agent-confirm-actions">
          <button type="button" className="agent-confirm-btn approve" onClick={() => handleRetryResponse(step.retryId!, true)}>
            重试
          </button>
          <button type="button" className="agent-confirm-btn deny" onClick={() => handleRetryResponse(step.retryId!, false)}>
            取消
          </button>
        </div>
      )
    }

    const errorSummary = (step.retryErrorMessage || '').length > 200
      ? `${(step.retryErrorMessage || '').slice(0, 200)}...`
      : (step.retryErrorMessage || '')

    return (
      <div className="agent-confirm-card retry">
        <div className="agent-confirm-title">
          <span className="agent-confirm-icon">⚠</span>
          {retryStatus === 'pending' ? `${errorLabel} — 需要你的确认` : errorLabel}
        </div>
        <div className="agent-confirm-risks">
          <div className="agent-confirm-risk warning">
            <span className="agent-confirm-risk-badge">错误</span>
            <span className="agent-confirm-risk-reason">{errorLabel}</span>
            {errorSummary && (
              <pre className="agent-confirm-risk-detail">{errorSummary}</pre>
            )}
          </div>
        </div>
        {retryStatus === 'pending' && (
          <div className="agent-retry-hint" style={{ fontSize: '12px', color: 'var(--text-secondary, #888)', marginTop: '8px', lineHeight: '1.5' }}>
            任务遇到可恢复的错误，是否重新发起请求？选择"重试"将继续当前任务，选择"取消"将终止任务。
          </div>
        )}
        {renderRetryStatusUI()}
      </div>
    )
  }

  function renderStepToolResults() {
    if (step.toolCalls.length === 1) {
      const tc = step.toolCalls[0]
      const result = step.toolResults.find((r) => r.tool_call_id === tc.id)
      const isToolRunning = !result && isStepRunning
      return result ? (
        <div className={`agent-step-result ${result.success ? 'success' : 'error'}`}>
          <ToolResultContent toolName={tc.name} toolArgs={parseArgs(tc.arguments)} result={result} />
        </div>
      ) : isToolRunning ? (
        <div className="agent-step-running-hint"><span className="agent-step-spinner" />执行中...</div>
      ) : null
    }
    if (step.toolCalls.length > 1) {
      return (
        <>
          {step.toolCalls.map((tc, index) => {
            const sm = toolCallSummary(tc)
            const result = step.toolResults.find((r) => r.tool_call_id === tc.id)
            const tbKey = `${msg.id}-${step.round}-${tc.id}`
            const isToolRunning = !result && isStepRunning
            const isToolBlockOpen = isToolRunning || expandedToolBlocks.has(tbKey)
            const actionLabel = sm.label && sm.label.trim() ? sm.label : '执行操作'
            const actionDetail = sm.detail && sm.detail.trim() ? sm.detail : '无附加信息'
            return (
              <div key={tc.id} className={`agent-tool-block ${isToolRunning ? 'running' : ''}`}>
                <div className="agent-tool-block-header">
                  <button type="button" className="agent-tool-block-toggle" onClick={() => toggleToolBlock(tbKey)}>
                    <span className="agent-tool-block-label">{actionLabel}</span>
                    <span className="agent-tool-block-seq">{index + 1}/{step.toolCalls.length}</span>
                  </button>
                  <span className="agent-tool-block-path" onClick={() => toggleToolBlock(tbKey)}>
                    {sm.filePath ? (
                      <span className="agent-step-path-link" title="点击预览打开" onClick={(e) => { e.stopPropagation(); openFile(sm.filePath!) }}>{actionDetail}</span>
                    ) : actionDetail}
                  </span>
                  <button type="button" className="agent-tool-block-chevron-btn" onClick={() => toggleToolBlock(tbKey)}>
                    <span className={`agent-tool-block-chevron ${isToolBlockOpen ? 'open' : ''}`}>›</span>
                  </button>
                </div>
                {isToolBlockOpen && (
                  <div className="agent-tool-block-body">
                    {result ? (
                      <div className={`agent-step-result ${result.success ? 'success' : 'error'}`}>
                        <ToolResultContent toolName={tc.name} toolArgs={parseArgs(tc.arguments)} result={result} />
                      </div>
                    ) : isToolRunning ? (
                      <div className="agent-step-running-hint"><span className="agent-step-spinner" />执行中...</div>
                    ) : null}
                  </div>
                )}
              </div>
            )
          })}
        </>
      )
    }
    if (isStepRunning) {
      return <div className="agent-step-running-hint"><span className="agent-step-spinner" />执行中...</div>
    }
    return null
  }
}
