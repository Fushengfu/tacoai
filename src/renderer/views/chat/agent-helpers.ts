import type { AgentStep, ChatMsg } from '../../types'

/* ------------------------------------------------------------------ */
/*  文本清洗 / 脱敏工具函数                                              */
/* ------------------------------------------------------------------ */

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function stripInternalSummaryBlocks(text: string): string {
  let output = String(text ?? '')
  const headers = [
    '【历史助手回复（仅供上下文，不代表当前轮结论）】',
    '【执行过程摘要】',
    '【计划状态】',
    '【Git 提交】',
  ]
  for (const header of headers) {
    const pattern = new RegExp(`${escapeRegExp(header)}[\\s\\S]*?(?=\\n【|$)`, 'g')
    output = output.replace(pattern, '')
  }
  return output
}

export function maskToolNamesForUser(text: string, toolNames: string[]): string {
  let output = String(text ?? '')
  const names = Array.from(new Set(toolNames.filter(Boolean)))
  for (const name of names) {
    const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`, 'gi')
    output = output.replace(pattern, '工具操作')
  }
  output = output
    .replace(/\[TOOL_CALL\][\s\S]*?\[\/TOOL_CALL\]/gi, '')
    .replace(/<invoke[\s\S]*?<\/invoke>/gi, '')
    .replace(/<tool_calls\b[^>]*>[\s\S]*?<\/tool_calls>/gi, '')
    .replace(/<\/?tool_calls\b[^>]*>/gi, '')
    .replace(/<\/?minimax:tool_call>/gi, '')
  return output
}

export function sanitizeAssistantContentForDisplay(content: string, toolNames: string[]): string {
  const withoutInternalSummary = stripInternalSummaryBlocks(content)
  const withoutThink = withoutInternalSummary
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think\b[^>]*>/gi, '')
  const masked = maskToolNamesForUser(withoutThink, toolNames)
  return masked
    .replace(/\[DONE\]\s*$/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function maskSensitiveText(text: string): string {
  let masked = text
  const keyValuePattern = /((?:token|access_token|api[_-]?key|authorization|bearer|password|passwd|pwd|secret)\s*[:=]\s*)([^\s'"]+)/ig
  masked = masked.replace(keyValuePattern, (_m, prefix: string) => `${prefix}***`)
  const bearerPattern = /(bearer\s+)([a-zA-Z0-9._\-]+)/ig
  masked = masked.replace(bearerPattern, (_m, prefix: string) => `${prefix}***`)
  return masked
}

/* ------------------------------------------------------------------ */
/*  路径处理                                                            */
/* ------------------------------------------------------------------ */

export function isWindowsAbsolutePath(text: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(text) || text.startsWith('\\\\')
}

export function normalizeScreenshotPath(raw: unknown): string | null {
  const text = String(raw ?? '').trim()
  if (!text) return null
  if (text.startsWith('/') || isWindowsAbsolutePath(text)) return text
  return null
}

export function toImageUrl(raw: string): string {
  if (raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('data:') || raw.startsWith('file://')) {
    return raw
  }
  if (raw.startsWith('\\\\')) {
    const uncPath = raw.replace(/^\\\\+/, '').replace(/\\/g, '/')
    return `file://${encodeURI(uncPath)}`
  }
  if (/^[a-zA-Z]:[\\/]/.test(raw)) {
    const winPath = raw.replace(/\\/g, '/')
    return `file:///${encodeURI(winPath)}`
  }
  if (raw.startsWith('/')) return `file://${encodeURI(raw)}`
  return raw
}

export function extractScreenshotPathsFromResultContent(content: string): string[] {
  const paths = new Set<string>()
  const text = String(content ?? '')
  if (!text) return []
  try {
    const parsed = JSON.parse(text) as { screenshotPath?: unknown; screenshotPaths?: unknown }
    if (Array.isArray(parsed?.screenshotPaths)) {
      for (const p of parsed.screenshotPaths) {
        const normalized = normalizeScreenshotPath(p)
        if (normalized) paths.add(normalized)
      }
    }
    const single = normalizeScreenshotPath(parsed?.screenshotPath)
    if (single) paths.add(single)
  } catch {
    // ignore non-json tool result
  }
  const regex = /"screenshotPath"\s*:\s*"([^"]+)"/g
  let match: RegExpExecArray | null = null
  while ((match = regex.exec(text)) !== null) {
    const normalized = normalizeScreenshotPath(match[1])
    if (normalized) paths.add(normalized)
  }
  return Array.from(paths)
}

export function collectMessageScreenshotUrls(msg: ChatMsg): string[] {
  const urls = new Set<string>()
  if (msg.agentSteps) {
    for (const step of msg.agentSteps) {
      for (const result of step.toolResults) {
        const text = String(result.content ?? '')
        try {
          const parsed = JSON.parse(text) as { screenshotPath?: string; cloudUrl?: string }
          if (parsed.cloudUrl && (parsed.cloudUrl.startsWith('http://') || parsed.cloudUrl.startsWith('https://'))) {
            urls.add(parsed.cloudUrl)
            continue
          }
        } catch { /* 非 JSON 内容 */ }
        for (const p of extractScreenshotPathsFromResultContent(text)) {
          urls.add(toImageUrl(p))
        }
      }
    }
  }
  return Array.from(urls)
}

/* ------------------------------------------------------------------ */
/*  工具调用摘要                                                        */
/* ------------------------------------------------------------------ */

export function parseArgs(argsStr: string): Record<string, unknown> {
  try { return JSON.parse(argsStr) } catch { return {} }
}

export function summarizeRunCommand(command: string): string {
  const masked = maskSensitiveText(command.trim())
  if (!masked) return ''

  const curlMatch = masked.match(/\bcurl\b[\s\S]*?(?:-X\s+([A-Z]+))?[\s\S]*?(https?:\/\/[^\s'"]+)/i)
  if (curlMatch) {
    const method = (curlMatch[1] || 'GET').toUpperCase()
    const urlText = curlMatch[2]
    try {
      const u = new URL(urlText)
      return `请求接口 ${method} ${u.pathname}`
    } catch {
      return `请求接口 ${method} ${urlText}`
    }
  }

  if (/npm\s+run\s+dev/i.test(masked)) return '启动前端开发服务'
  if (/npm\s+(run\s+)?build/i.test(masked)) return '构建项目'
  if (/go\s+test|npm\s+test|pnpm\s+test|yarn\s+test/i.test(masked)) return '执行测试'

  return masked.length > 60 ? `${masked.slice(0, 57)}...` : masked
}

export function toolCallSummary(tc: { name: string; arguments: string }): { label: string; detail: string; filePath?: string } {
  const args = parseArgs(tc.arguments)
  switch (tc.name) {
    case 'read_file': {
      const p = String(args.path ?? '')
      return { label: '查看文件', detail: p, filePath: p }
    }
    case 'write_file': {
      const p = String(args.path ?? '')
      return { label: '写入文件', detail: p, filePath: p }
    }
    case 'edit_file': {
      const p = String(args.path ?? '')
      return { label: '编辑文件', detail: p, filePath: p }
    }
    case 'delete_file': {
      const p = String(args.path ?? '')
      return { label: '删除文件', detail: p, filePath: p }
    }
    case 'list_dir':
    case 'list_directory': {
      const p = String(args.path ?? '.')
      return { label: '查看目录', detail: p, filePath: p }
    }
    case 'run_command': {
      const cmd = String(args.command ?? '')
      return { label: '执行命令', detail: summarizeRunCommand(cmd) }
    }
    case 'codebase_search': {
      const query = String(args.query ?? args.pattern ?? '')
      const dir = String(args.path ?? args.directory ?? '.')
      const glob = String(args.glob ?? args.filePattern ?? '').trim()
      const isRegex = Boolean(args.regex) || /[|()[\]{}.*+?\\]/.test(query)
      const compactQuery = query.length > 80 ? `${query.slice(0, 77)}...` : query
      const scope = glob ? `${dir} (${glob})` : dir
      return {
        label: isRegex ? '正则搜索' : '搜索代码',
        detail: `${compactQuery || '(空查询)'} @ ${scope}`,
      }
    }
    case 'browser_navigate': {
      const url = String(args.url ?? '')
      return { label: '浏览器操作', detail: url }
    }
    case 'browser_screenshot': {
      const goal = String(args.goal ?? '').trim()
      return { label: '浏览器操作', detail: goal ? `目标：${goal}` : '状态确认' }
    }
    case 'browser_wait': {
      const selector = String(args.selector ?? '')
      return { label: '浏览器操作', detail: selector || '等待页面加载完成' }
    }
    case 'browser_get_content': {
      const selector = String(args.selector ?? '')
      return { label: '浏览器操作', detail: selector || '读取页面主体内容' }
    }
    case 'browser_get_console_logs': {
      return { label: '浏览器操作', detail: '检查控制台日志' }
    }
    case 'browser_click': {
      const selector = String(args.selector ?? '').trim()
      const x = Number(args.x)
      const y = Number(args.y)
      const clickCount = Number(args.clickCount ?? 1)
      if (selector) {
        return { label: '浏览器操作', detail: clickCount >= 2 ? `双击 ${selector}` : `点击 ${selector}` }
      }
      if (Number.isFinite(x) && Number.isFinite(y)) {
        return { label: '浏览器操作', detail: `${clickCount >= 2 ? '双击' : '点击'} (${Math.round(x)}, ${Math.round(y)})` }
      }
      return { label: '浏览器操作', detail: clickCount >= 2 ? '双击页面' : '点击页面' }
    }
    case 'browser_type': {
      const selector = String(args.selector ?? '')
      const text = String(args.text ?? '')
      const displayText = text.length > 18 ? `${text.slice(0, 18)}...` : text
      return { label: '浏览器操作', detail: `${selector}${displayText ? ` ← ${displayText}` : ''}`.trim() }
    }
    case 'browser_scroll': {
      const direction = String(args.direction ?? 'down')
      return { label: '浏览器操作', detail: `滚动(${direction})` }
    }
    case 'browser_hover': {
      const selector = String(args.selector ?? '')
      return { label: '浏览器操作', detail: selector || '悬停指定位置' }
    }
    case 'browser_keypress': {
      const key = String(args.key ?? '')
      return { label: '浏览器操作', detail: `按键 ${key}` }
    }
    case 'browser_drag': {
      return { label: '浏览器操作', detail: '拖拽操作' }
    }
    case 'browser_select': {
      const selector = String(args.selector ?? '')
      const value = String(args.value ?? args.label ?? '')
      return { label: '浏览器操作', detail: `${selector}${value ? ` → ${value}` : ''}`.trim() }
    }
    default:
      return { label: '执行操作', detail: '' }
  }
}

/* ------------------------------------------------------------------ */
/*  步骤摘要                                                            */
/* ------------------------------------------------------------------ */

export function stepStatusIcon(step: AgentStep): string {
  if (step.status === 'calling') return '⏳'
  if (step.status === 'running') return '⚡'
  if (step.status === 'confirm') return '🔒'
  if (step.status === 'retry_confirm') return '⚠'
  const allSuccess = step.toolResults.every((r) => r.success)
  return allSuccess ? '✓' : '⚠'
}

export function stepHeaderSummary(step: AgentStep): { label: string; detail: string; filePath?: string } {
  if (step.systemTitle) {
    return { label: step.systemTitle, detail: step.systemDetail || '' }
  }
  if (step.status === 'retry_confirm') {
    const errorTypeLabels: Record<string, string> = {
      network: '网络连接异常',
      timeout: '请求超时',
      empty_response: '模型未返回有效数据',
      interrupted: '请求中断',
    }
    return {
      label: errorTypeLabels[step.retryErrorType ?? 'network'] || '可恢复错误',
      detail: '等待用户确认是否重试',
    }
  }
  if (step.toolCalls.length === 0) return { label: '思考中', detail: '...' }
  if (step.toolCalls.length === 1) {
    const tc = step.toolCalls[0]
    const base = toolCallSummary(tc)
    const result = step.toolResults.find((r) => r.tool_call_id === tc.id)
    const fc = result?.fileChange
    if (!fc) return base
    if (fc.oldContent === null && fc.newContent !== null) {
      return { ...base, label: '新建文件' }
    }
    if (fc.oldContent !== null && fc.newContent === null) {
      return { ...base, label: '删除文件' }
    }
    if (tc.name === 'edit_file') {
      return { ...base, label: '编辑文件' }
    }
    if (tc.name === 'write_file') {
      return { ...base, label: '覆盖文件' }
    }
    return base
  }
  const names = [...new Set(step.toolCalls.map((tc) => toolCallSummary(tc).label))]
  return { label: names.join(' + '), detail: `(${step.toolCalls.length} 个操作)` }
}

export function stepGroupOperationSummary(steps: AgentStep[]): string {
  if (steps.length === 0) return '暂无操作'
  const active = [...steps].reverse().find((s) =>
    s.status === 'running' || s.status === 'calling' || s.status === 'confirm' || s.status === 'retry_confirm'
  )
  const recent = active
    ?? [...steps].reverse().find((s) => s.toolCalls.length > 0 || s.toolResults.length > 0)
    ?? steps[steps.length - 1]
  const summary = stepHeaderSummary(recent)
  if (summary.detail.trim()) return `${summary.label} · ${summary.detail}`
  return summary.label
}
