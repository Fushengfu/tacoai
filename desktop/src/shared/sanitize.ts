/**
 * 文本清理工具
 *
 * 统一处理内部上下文标签剥离、伪工具调用清理、用户可见文本净化等，
 * 消除 agent/index.ts、ipc/index.ts、data/notes.ts 中的重复定义。
 */

/* ------------------------------------------------------------------ */
/*  内部上下文标签剥离                                                    */
/* ------------------------------------------------------------------ */

const INTERNAL_CONTEXT_BLOCK_TAGS = [
  'CURRENT_TASK_SUMMARY',
  'HISTORICAL_TASK_RESULT',
  'HISTORICAL_PENDING_STATE',
  'MEMORY_SNAPSHOT',
  'BACKGROUND_CONTEXT',
  'SKILLS_CATALOG',
  'SKILL_ALLOWED_TOOLS',
  'SKILL_RESOURCES',
  'USER_QUERY',
  'USER_ASSETS',
  'RUNTIME_TOOL_PROMPT',
]

const INTERNAL_CONTEXT_ATTR_BLOCK_TAGS = [
  'SKILL_DETAIL',
  'SKILL_RESOURCE',
]

const INTERNAL_CONTEXT_TAG_NAME_RULES: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\bCURRENT_TASK_SUMMARY\b/g, replacement: '当前任务续跑摘要' },
  { pattern: /\bHISTORICAL_TASK_RESULT\b/g, replacement: '历史任务总结' },
  { pattern: /\bHISTORICAL_PENDING_STATE\b/g, replacement: '历史待继续状态' },
  { pattern: /\bMEMORY_SNAPSHOT\b/g, replacement: '历史记忆快照' },
  { pattern: /\bSKILLS_CATALOG\b/g, replacement: '技能目录' },
  { pattern: /\bSKILL_DETAIL\b/g, replacement: '技能详情' },
  { pattern: /\bSKILL_RESOURCE\b/g, replacement: '技能资源' },
]

/** 剥离内部上下文标记块（如 [BACKGROUND_CONTEXT]...[/BACKGROUND_CONTEXT]） */
export function stripInternalContextTags(input: string): string {
  let output = String(input ?? '')

  output = output.replace(/<!--TACO_RUNTIME_TOOL_PROMPT_START-->[\s\S]*?<!--TACO_RUNTIME_TOOL_PROMPT_END-->/gi, '')
  output = output.replace(/<!--TACO_RUNTIME_TOOL_PROMPT_START-->/gi, '')
  output = output.replace(/<!--TACO_RUNTIME_TOOL_PROMPT_END-->/gi, '')

  for (const tag of INTERNAL_CONTEXT_ATTR_BLOCK_TAGS) {
    output = output.replace(new RegExp(`\\[${tag}[^\\]]*\\][\\s\\S]*?\\[\\/${tag}\\]`, 'gi'), '')
  }
  for (const tag of INTERNAL_CONTEXT_BLOCK_TAGS) {
    output = output.replace(new RegExp(`\\[${tag}\\][\\s\\S]*?\\[\\/${tag}\\]`, 'gi'), '')
  }

  // 兜底：只移除未配对的独立标签本身，不删除后面的内容
  // 避免模型讨论这些标签名称时整段内容被贪婪截断
  for (const tag of INTERNAL_CONTEXT_ATTR_BLOCK_TAGS) {
    output = output.replace(new RegExp(`\\[${tag}[^\\]]*\\]`, 'gi'), '')
  }
  for (const tag of INTERNAL_CONTEXT_BLOCK_TAGS) {
    output = output.replace(new RegExp(`\\[${tag}\\]`, 'gi'), '')
  }

  output = output.replace(/\[(?:\/)?(?:CURRENT_TASK_SUMMARY|HISTORICAL_TASK_RESULT|HISTORICAL_PENDING_STATE|MEMORY_SNAPSHOT|BACKGROUND_CONTEXT|SKILLS_CATALOG|SKILL_ALLOWED_TOOLS|SKILL_RESOURCES|USER_QUERY|USER_ASSETS|RUNTIME_TOOL_PROMPT|SKILL_DETAIL|SKILL_RESOURCE)[^\]]*\]/gi, '')

  for (const rule of INTERNAL_CONTEXT_TAG_NAME_RULES) {
    output = output.replace(rule.pattern, rule.replacement)
  }

  return output.replace(/\n{3,}/g, '\n\n')
}

/* ------------------------------------------------------------------ */
/*  伪工具调用清理                                                       */
/* ------------------------------------------------------------------ */

const PSEUDO_TOOL_CALL_BLOCK_PATTERNS: RegExp[] = [
  /\[TOOL_CALL[^\]]*\][\s\S]*?\[\/TOOL_CALL\]/gi,
  /<invoke\b[^>]*>[\s\S]*?<\/invoke>/gi,
  /<minimax:tool_call\b[^>]*>[\s\S]*?<\/minimax:tool_call>/gi,
  /<parameter\b[^>]*>[\s\S]*?<\/parameter>/gi,
]

const PSEUDO_TOOL_CALL_INLINE_PATTERNS: RegExp[] = [
  /\[(?:\/)?TOOL_CALL[^\]]*\]/gi,
  /<\/?minimax:tool_call\b[^>]*>/gi,
  /<\/?invoke\b[^>]*>/gi,
  /<\/?parameter\b[^>]*>/gi,
]

/** 剥离伪工具调用语法（如 [TOOL_CALL]、<invoke> 等） */
export function stripPseudoToolCallArtifacts(input: string): string {
  let output = String(input ?? '')
  for (const pattern of PSEUDO_TOOL_CALL_BLOCK_PATTERNS) {
    output = output.replace(pattern, '\n')
  }
  for (const pattern of PSEUDO_TOOL_CALL_INLINE_PATTERNS) {
    output = output.replace(pattern, ' ')
  }
  return output
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/* ------------------------------------------------------------------ */
/*  用户可见文本净化                                                      */
/* ------------------------------------------------------------------ */

const USER_VISIBLE_SOURCE_PHRASE_RULES: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /从(?:项目)?历史(?:记录|记忆|信息|上下文)来看/g, replacement: '结合当前上下文来看' },
  { pattern: /根据(?:项目)?历史(?:记录|记忆|信息|上下文)(?:显示|来看|可知|可见)?/g, replacement: '结合当前上下文' },
  { pattern: /基于(?:项目)?历史(?:记录|记忆|信息|上下文)/g, replacement: '结合当前上下文' },
  { pattern: /根据(?:背景|上下文)信息/g, replacement: '结合当前上下文' },
  { pattern: /根据\s*BACKGROUND_CONTEXT/gi, replacement: '结合当前上下文' },
  { pattern: /based on (?:the )?(?:project )?(?:history|historical (?:records?|memory|context))/gi, replacement: 'based on current context' },
  { pattern: /from (?:the )?background context/gi, replacement: 'from current context' },
]

/** 清理推理标签 + 伪工具调用 + 内部标签，并替换"历史/背景"措辞 */
export function sanitizeUserFacingText(input: string): string {
  let output = stripPseudoToolCallArtifacts(stripInternalContextTags(String(input ?? '')))
  for (const rule of USER_VISIBLE_SOURCE_PHRASE_RULES) {
    output = output.replace(rule.pattern, rule.replacement)
  }
  return output
}

/** 清理上下文中的推理产物（<think>、<reflection>、<tool_code>） */
export function sanitizeContextArtifacts(input: string): string {
  let output = stripReasoningArtifacts(stripPseudoToolCallArtifacts(stripInternalContextTags(String(input ?? ''))))
  output = output
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return output
}

/** 剥离推理标签（<think>、<reflection>、<tool_code>） */
export function stripReasoningArtifacts(input: string): string {
  return String(input ?? '')
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '\n')
    .replace(/<reflection\b[^>]*>[\s\S]*?<\/reflection>/gi, '\n')
    .replace(/<tool_code\b[^>]*>[\s\S]*?<\/tool_code>/gi, '\n')
    .replace(/<\/?(?:think|reflection|tool_code)\b[^>]*>/gi, ' ')
}

/** 清理推理文本用于上下文展示 */
export function sanitizeReasoningForContext(input: string): string {
  let output = stripPseudoToolCallArtifacts(stripInternalContextTags(String(input ?? '')))
  output = output
    .replace(/<\/?(?:think|reflection|tool_code)\b[^>]*>/gi, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return output
}

/** 清理回放原始文本 */
export function sanitizeReplayRawText(input: string): string {
  return stripPseudoToolCallArtifacts(stripInternalContextTags(String(input ?? '')))
    .replace(/\r/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 检查是否包含伪工具调用语法 */
export function containsPseudoToolCallSyntax(input: string): boolean {
  const text = String(input ?? '')
  const patterns = [
    /\[TOOL_CALL[^\]]*\]/i,
    /<invoke\b/i,
    /<minimax:tool_call\b/i,
    /<parameter\b/i,
  ]
  return patterns.some((pattern) => pattern.test(text))
}
