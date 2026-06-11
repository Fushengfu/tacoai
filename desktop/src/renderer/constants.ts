import type { ModelConfig, ProviderId, ProviderForm, ProviderForms } from './types'
import { buildSystemPrompt as buildSystemPromptCore } from '../shared/prompt-builder'
import type { SystemEnv } from '../shared/prompt-builder'

/* ------------------------------------------------------------------ */
/*  Provider 常量                                                       */
/* ------------------------------------------------------------------ */

export const providers: readonly { id: ProviderId; label: string; contextLength: number }[] = [
  { id: 'deepseek', label: 'DeepSeek', contextLength: 131072 },
  { id: 'kimi', label: 'Kimi', contextLength: 131072 },
  { id: 'minimax', label: 'MiniMax', contextLength: 1048576 },
  { id: 'glm', label: 'GLM', contextLength: 131072 },
  { id: 'qwen', label: 'Qwen', contextLength: 131072 },
  { id: 'mimo', label: 'MiMo', contextLength: 1048576 }
]

/** 各服务商默认接口地址（添加模型时自动填入，用户可修改） */
export const PROVIDER_DEFAULT_BASE_URLS: Record<ProviderId, string> = {
  deepseek: 'https://api.deepseek.com/beta',
  kimi: 'https://api.moonshot.cn/v1',
  minimax: 'https://api.minimaxi.com/v1',
  glm: 'https://open.bigmodel.cn/api/coding/paas/v4',
  qwen: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
  mimo: 'https://api.xiaomimimo.com/v1',
}

export function resolveProviderDisplayLabel(providerId: ProviderId, form?: Partial<ProviderForm>): string {
  const model = String(form?.model ?? '').trim()
  if (model) return model
  return providers.find((p) => p.id === providerId)?.label ?? providerId
}

export function resolveModelConfigDisplayLabel(config: Pick<ModelConfig, 'model' | 'provider'>): string {
  const model = String(config.model ?? '').trim()
  if (model) return model
  const providerLabel = providers.find((p) => p.id === config.provider)?.label
  const providerId = String(config.provider || '').trim()
  return providerLabel ?? (providerId || '模型')
}

/* ------------------------------------------------------------------ */
/*  Token 估算                                                          */
/* ------------------------------------------------------------------ */

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
  deepseek: { baseUrl: 'https://api.deepseek.com/beta', apiKey: 'sk-...', model: '填写官方模型 ID（以控制台为准）', contextLength: '131072（示例）', temperature: '0.05（可选）' },
  kimi: { baseUrl: 'https://api.moonshot.cn/v1', apiKey: 'sk-...', model: '填写官方模型 ID（以控制台为准）', contextLength: '131072（示例）', temperature: '0.05（可选）' },
  minimax: { baseUrl: 'https://api.minimaxi.com/v1', apiKey: 'sk-...', model: '填写官方模型 ID（以控制台为准）', contextLength: '1048576（示例）', temperature: '0.05（可选）' },
  glm: { baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', apiKey: 'sk-...', model: '填写官方模型 ID（以控制台为准）', contextLength: '131072（示例）', temperature: '0.05（可选）' },
  qwen: { baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', apiKey: 'sk-...', model: '填写官方模型 ID（以控制台为准）', contextLength: '131072（示例）', temperature: '0.05（可选）' },
  mimo: { baseUrl: 'https://api.xiaomimimo.com/v1', apiKey: 'sk-...', model: '填写官方模型 ID（以控制台为准）', contextLength: '1048576（示例）', temperature: '0.05（可选）' }
}

export function defaultProviderForms(): ProviderForms {
  return {
    deepseek: { baseUrl: '', apiKey: '', model: '', contextLength: '', temperature: '' },
    kimi: { baseUrl: '', apiKey: '', model: '', contextLength: '', temperature: '' },
    minimax: { baseUrl: '', apiKey: '', model: '', contextLength: '', temperature: '' },
    glm: { baseUrl: '', apiKey: '', model: '', contextLength: '', temperature: '' },
    qwen: { baseUrl: '', apiKey: '', model: '', contextLength: '', temperature: '' },
    mimo: { baseUrl: '', apiKey: '', model: '', contextLength: '', temperature: '' }
  }
}

export function resolveProviderContextLength(providerId: ProviderId, form?: Partial<ProviderForm>): number {
  const fallback = providers.find((p) => p.id === providerId)?.contextLength ?? 65536
  const raw = String(form?.contextLength ?? '').trim()
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  const n = Math.floor(parsed)
  if (n <= 0) return fallback
  return n
}

export function resolveModelConfigContextLength(config?: Pick<ModelConfig, 'provider' | 'contextLength'> | null): number {
  if (!config) return 65536
  return resolveProviderContextLength(config.provider, { contextLength: config.contextLength })
}

/* ------------------------------------------------------------------ */
/*  System Prompt 构建（渲染进程包装）                                   */
/* ------------------------------------------------------------------ */

/** 从 window.taco.system 获取系统环境信息 */
function getSystemEnv(): SystemEnv {
  const sys = globalThis.window?.taco?.system
  return {
    workspace: '',
    platform: sys?.platform ?? 'unknown',
    arch: sys?.arch ?? 'unknown',
    osVersion: sys?.osVersion ?? 'unknown',
    homeDir: sys?.homeDir ?? '~',
    shell: sys?.shell ?? '/bin/sh',
    // 优先读取下拉框语言设置（localStorage），OS locale 作为 fallback
    locale: (() => {
      try {
        const saved = localStorage.getItem('taco_app_language')
        if (saved === 'zh-CN' || saved === 'en-US') return saved
      } catch { /* ignore */ }
      return sys?.locale || 'unknown'
    })(),
    supportsVision: false,
  }
}

/** 构建包含系统环境的 system prompt（渲染进程用） */
export function buildSystemPrompt(options?: {
  workspace?: string
  provider?: ProviderId
  model?: string
  supportsVision?: boolean
  projectRules?: string
}): string {
  const env = getSystemEnv()
  if (options?.workspace) env.workspace = options.workspace
  if (options?.supportsVision !== undefined) env.supportsVision = options.supportsVision

  return buildSystemPromptCore({
    env,
    projectRules: options?.projectRules,
  })
}
