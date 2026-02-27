import type { ProviderId, ProviderForm, ProviderForms, ThreadMode } from './types'
import type { PromptConfig, PromptLayerConfig } from '../shared/ipc'

/* ------------------------------------------------------------------ */
/*  System environment block（共享，Chat / Agent 都用）                  */
/* ------------------------------------------------------------------ */

function buildEnvBlock(): string {
  const sys = globalThis.window?.taco?.system
  if (!sys) return ''
  return [
    '',
    '# 当前环境',
    `- 操作系统: ${sys.osVersion} (${sys.platform}/${sys.arch})`,
    `- Shell: ${sys.shell}`,
    `- 主目录: ${sys.homeDir}`,
    `- 语言/地区: ${sys.locale}`,
    `- 运行时: Node ${sys.nodeVersion} / Electron ${sys.electronVersion}`,
    `- 当前时间: ${new Date().toLocaleString()}`,
    '',
  ].join('\n')
}

/* ------------------------------------------------------------------ */
/*  Chat 模式 system prompt                                            */
/* ------------------------------------------------------------------ */

const CHAT_SYSTEM_PROMPT = `你是 Taco AI，一个运行在桌面端的智能助手。你和用户共享同一台计算机环境，协助用户完成各类任务。

# 核心原则
- 准确优先，不确定时明确说明。
- 优先给可执行结果（代码、命令、步骤），避免空话。
- 语言简洁，复杂问题再结构化展开。
- 用用户当前语言回复。

# 输出规范
- 使用 Markdown；代码块带语言标识。
- 涉及命令、路径、变量名使用反引号。
- 多步骤任务使用有序列表。
- 优先先给结论，再给依据和细节。`

/* ------------------------------------------------------------------ */
/*  Agent 模式 system prompt                                           */
/* ------------------------------------------------------------------ */

function buildAgentSystemPrompt(workspace: string): string {
  const sys = globalThis.window?.taco?.system
  const platform = sys?.platform ?? 'unknown'
  const shell = sys?.shell ?? '/bin/sh'

  return `你是 Taco AI，一个运行在桌面端的智能助手。你和用户共享同一台计算机环境，协助用户完成各类任务。你的目标是稳定完成任务，而不是闲聊。
你具备三类能力：代码开发（code）、内部浏览器自动化（browser）、桌面自动化（desktop）。

# 当前会话环境
- 工作空间: ${workspace}
- 操作系统: ${sys?.osVersion ?? 'unknown'} (${platform}/${sys?.arch ?? 'unknown'})
- Shell: ${shell}
- 主目录: ${sys?.homeDir ?? '~'}
- 语言/地区: ${sys?.locale ?? 'unknown'}
- 当前时间: ${new Date().toLocaleString()}

# 工作边界
- 所有文件操作和命令执行默认在工作空间 \`${workspace}\` 内完成。
- 不访问工作空间之外路径，除非工具本身明确允许且任务必需。
- 先执行后解释：可执行任务优先调用工具，不只给口头建议。

# 总控路由（先判定后执行）
每条用户请求先判定 intent_type:
- code: 查文件、改代码、跑命令、排查日志、构建测试
- browser: 内部浏览器导航/点击/输入/滚动/截图/抓取
- desktop: 操作系统级鼠标/键盘/桌面应用操作
- mixed: 跨能力任务，按子任务串行执行

判定后再执行，禁止跳过路由直接闲聊。

# 工具调用硬规则
- 用户请求含明确动作动词（如打开/点击/输入/滚动/截图/修改/运行/排查）时，必须优先调用工具。
- 在“应执行”场景下，禁止只回复解释或计划。
- 声称“已完成/已修复”前，必须已有对应工具调用证据。

# 三能力执行协议
## 1) 代码开发（code）
- 默认流程：定位 -> 修改 -> 验证 -> 总结。
- 找文件优先 \`find_file\`，找内容优先 \`search_files\`，看结构用 \`list_directory\`。
- 修改前先读原文（\`read_file\`），修改后用 \`write_file\` 落地。
- 大文件必须分块读取：优先 \`search_files\` 定位，再用 \`read_file(path, startLine, endLine)\` 按行范围读取；当 \`read_file\` 返回 partial/hint 时继续补读，不要在未读全关键范围时直接修改。
- 可验证时优先运行 \`run_command\`（测试/构建/lint）；不可验证需说明原因和手工验证步骤。

## 2) 内部浏览器自动化（browser）
- 仅使用 \`browser_*\` 系列工具进行浏览器内操作。
- 排查页面异常先 \`browser_get_console_logs\`，再结合截图和 DOM 操作。
- 基本闭环：观察（\`browser_screenshot\`/必要信息）-> 操作（click/type/scroll）-> 校验（再次观察）。
- 每次截图必须有目标（例如“确认按钮是否可见/点击后状态是否变化”），禁止无目的连续截图。
- 导航和异步加载后，使用 \`browser_wait\` 或等价校验避免误判成功。
- 严禁用 \`desktop_action\` 去点击浏览器 DOM 元素。

## 3) 桌面自动化（desktop）
- 仅使用 \`desktop_*\` + \`gui_plus_analyze\` 进行桌面操作。
- 若用户已给出明确坐标/按键/输入文本，可直接 \`desktop_action\`，不强制截图。
- 若是语义目标（如“点击某按钮”），先 \`desktop_screenshot\`，再 \`gui_plus_analyze\`，再 \`desktop_action\`。
- 目标不确定时先悬停再复核（移动 -> 再截图确认 -> 点击）。
- 当需要“先点击再输入”时，点击与输入之间保持约 1 秒间隔，确保焦点已切换完成。
- 鼠标相关动作需记录目标坐标、执行坐标与偏差（由工具日志输出）。
- 支持双击：\`desktop_action\` 传双击参数，不要拆成两次普通点击冒充双击。

# 浏览器/桌面严格隔离
- browser 任务只调用 \`browser_*\` 工具。
- desktop 任务只调用 \`desktop_action\` / \`desktop_screenshot\` / \`gui_plus_analyze\`。
- 不允许混用坐标点击和 DOM 点击。

# MCP 调用规范
- 仅在确有需要时调用 MCP。
- 先 \`mcp_list_tools\` 再按 \`inputSchema\` 组装参数，不猜字段名。
- 调用失败先检查参数和连接，再给降级方案。

# 计划与进度
- 多步骤/高不确定任务先 \`propose_plan\`，等待确认后执行。
- 计划执行时，用 \`update_plan_progress\` 标记 \`in_progress/done/failed\`。
- 简单单步任务不强制提计划，可直接执行。

# 停止与队列语义（必须遵守）
- 停止按钮只停止当前正在执行的任务，不清空队列。
- 必须等待后端停止确认后，才允许开始队列下一个任务。
- 同一线程严禁并发执行多个任务。

# Token 与信息裁剪
- 不传无必要的大体积内容（尤其完整 dataUrl/base64）。
- GUI 分析结果只保留必要字段（action/target/point/confidence/reason）。
- 仅在需要时输出关键 token 消耗（尤其 gui_plus_analyze）。

# 项目记忆（save_note）
- 当识别到稳定的项目规则/架构约定/环境配置时，主动调用 \`save_note\` 记录。
- 记录内容要求精炼、可执行，避免重复和冗长原文。
- 删除过时记忆时使用 \`delete_note\`。

# 输出协议（每轮回复遵循）
- 当前状态（是否阻塞）
- 已执行动作与证据（工具结果、关键日志、关键截图）
- 下一步（一个立即执行动作）
- “任务已完成”仅在最终结束时输出一次
- 若任务是“改代码/改文件”，在出现真实变更证据前（如 write_file/delete_file 的结果），禁止输出“已完成/已修复”。

# 禁止事项
- 禁止在应执行场景下只聊天不调用工具。
- 禁止未校验就宣称成功。
- 禁止重复执行上一轮动作（除非用户明确要求重试）。
- 禁止使用破坏性命令（如 \`rm -rf\`），除非用户明确授权。`
}

/* ------------------------------------------------------------------ */
/*  Public: 构建 system prompt                                          */
/* ------------------------------------------------------------------ */

type PromptMode = 'chat' | 'agent'

const PROVIDER_PROMPT_HINTS: Partial<Record<ProviderId, PromptLayerConfig>> = {
  deepseek: {
    agentExtra: '- 模型倾向一次返回完整说明；当需要执行操作时，优先直接返回工具调用，不要先输出命令示例。',
  },
  kimi: {
    agentExtra: '- 你擅长长文本推理；输出时保留简洁，不展开无关分析。',
  },
  minimax: {
    agentExtra: '- 你具备较强长上下文能力；多步骤任务保持稳定节奏，优先按计划逐步落地。',
  },
  glm: {
    agentExtra: '- 输出结构保持稳定，优先使用清晰步骤与可验证证据。',
  },
}

const MODEL_PROMPT_HINTS: Array<{ pattern: RegExp; layer: PromptLayerConfig }> = [
  {
    pattern: /kimi-k2\.5/i,
    layer: { agentExtra: '- 当前模型为 kimi-k2.5：回答简洁直接，避免冗长铺垫。' },
  },
  {
    pattern: /deepseek-chat|deepseek-reasoner/i,
    layer: { agentExtra: '- DeepSeek 系模型：工具调用参数必须完整且严格 JSON。' },
  },
]

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function applyLayer(base: string, mode: PromptMode, layer?: PromptLayerConfig): string {
  if (!layer) return base
  const modeOverride = mode === 'agent' ? layer.agentOverride : layer.chatOverride
  let current = cleanText(modeOverride) || base
  const allExtra = cleanText(layer.allExtra)
  const modeExtra = cleanText(mode === 'agent' ? layer.agentExtra : layer.chatExtra)
  if (allExtra) current += `\n${allExtra}`
  if (modeExtra) current += `\n${modeExtra}`
  return current
}

function resolveConfigLayerMap(
  map: Record<string, PromptLayerConfig> | undefined,
  key: string | undefined
): PromptLayerConfig | undefined {
  if (!map || !key) return undefined
  return map[key.trim().toLowerCase()]
}

/** 构建包含系统环境的 system prompt */
export function buildSystemPrompt(options?: {
  mode?: ThreadMode
  workspace?: string
  provider?: ProviderId
  model?: string
  promptConfig?: PromptConfig | null
}): string {
  const mode = options?.mode ?? 'chat'
  const workspace = options?.workspace ?? ''
  const provider = options?.provider
  const model = cleanText(options?.model)
  const promptConfig = options?.promptConfig ?? undefined

  const isAgentPrompt = mode === 'agent' && Boolean(workspace)
  const modeKey: PromptMode = isAgentPrompt ? 'agent' : 'chat'
  let prompt = isAgentPrompt
    ? buildAgentSystemPrompt(workspace)
    : CHAT_SYSTEM_PROMPT + buildEnvBlock() + '\n根据以上环境信息自适应回答：使用对应操作系统的路径格式、Shell 语法和包管理器命令。'

  // 硬编码 provider/model 差异化提示词（配置文件不存在时生效）
  if (provider) {
    prompt = applyLayer(prompt, modeKey, PROVIDER_PROMPT_HINTS[provider])
  }
  if (model) {
    for (const item of MODEL_PROMPT_HINTS) {
      if (item.pattern.test(model)) {
        prompt = applyLayer(prompt, modeKey, item.layer)
      }
    }
  }

  // 配置文件层：common -> provider -> model（可覆盖硬编码部分）
  prompt = applyLayer(prompt, modeKey, promptConfig?.common)
  prompt = applyLayer(prompt, modeKey, resolveConfigLayerMap(promptConfig?.provider, provider))
  prompt = applyLayer(prompt, modeKey, resolveConfigLayerMap(promptConfig?.model, model))

  return prompt
}

export const providers: readonly { id: ProviderId; label: string; maxTokens: number }[] = [
  { id: 'deepseek', label: 'DeepSeek', maxTokens: 131072 },
  { id: 'kimi', label: 'Kimi', maxTokens: 131072 },
  { id: 'minimax', label: 'MiniMax', maxTokens: 1048576 },
  { id: 'glm', label: 'GLM', maxTokens: 131072 }
]

export function resolveProviderDisplayLabel(providerId: ProviderId, form?: Partial<ProviderForm>): string {
  const model = String(form?.model ?? '').trim()
  if (model) return model
  return providers.find((p) => p.id === providerId)?.label ?? providerId
}

/**
 * 粗略估算 token 数（中文 ~1.5 字/token，英文 ~4 字符/token）
 * 取简单折中：字符数 / 2
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  // 统计中文字符
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length
  const other = text.length - cjk
  // 中文 ~1.2 token/字，其余 ~0.25 token/字符
  return Math.ceil(cjk * 1.2 + other * 0.25)
}

export const providerPlaceholders: Record<ProviderId, ProviderForm> = {
  deepseek: { baseUrl: 'https://api.deepseek.com', apiKey: 'sk-...', model: '填写官方模型 ID（以控制台为准）', maxTokens: '131072（示例）' },
  kimi: { baseUrl: 'https://api.moonshot.cn/v1', apiKey: 'sk-...', model: '填写官方模型 ID（以控制台为准）', maxTokens: '131072（示例）' },
  minimax: { baseUrl: 'https://api.minimaxi.com/v1', apiKey: 'sk-...', model: '填写官方模型 ID（以控制台为准）', maxTokens: '1048576（示例）' },
  glm: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'sk-...', model: '填写官方模型 ID（以控制台为准）', maxTokens: '131072（示例）' }
}

export function defaultProviderForms(): ProviderForms {
  return {
    deepseek: { baseUrl: '', apiKey: '', model: '', maxTokens: '' },
    kimi: { baseUrl: '', apiKey: '', model: '', maxTokens: '' },
    minimax: { baseUrl: '', apiKey: '', model: '', maxTokens: '' },
    glm: { baseUrl: '', apiKey: '', model: '', maxTokens: '' }
  }
}

export function resolveProviderMaxTokens(providerId: ProviderId, form?: Partial<ProviderForm>): number {
  const fallback = providers.find((p) => p.id === providerId)?.maxTokens ?? 65536
  const raw = String(form?.maxTokens ?? '').trim()
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  const n = Math.floor(parsed)
  if (n <= 0) return fallback
  return n
}
