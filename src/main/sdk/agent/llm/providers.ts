/**
 * LLM Provider 配置管理
 * 
 * 内置 6 个 provider（deepseek/kimi/minimax/glm/qwen/mimo）的默认配置，
 * 以及 provider 识别和配置获取函数。
 */

import type { Logger } from '../services'
import type { BuiltinProviderKey, ProviderConfig, ProviderOverrides } from './types'

/** 模块级 logger，由外部通过 setLLMLogger 注入。默认静默。 */
let _log: Logger = () => {}
export function setLLMLogger(logger: Logger) { _log = logger }
export function llmLog(tag: string, meta?: Record<string, unknown>, scope?: string) { _log(tag, meta, scope) }

const builtinProviderConfigs: Record<BuiltinProviderKey, ProviderConfig> = {
  deepseek: {
    baseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
    apiKey: process.env.DEEPSEEK_API_KEY ?? '',
    model: process.env.DEEPSEEK_MODEL ?? ''
  },
  kimi: {
    baseUrl: process.env.KIMI_BASE_URL ?? 'https://api.moonshot.cn/v1',
    apiKey: process.env.KIMI_API_KEY ?? '',
    model: process.env.KIMI_MODEL ?? ''
  },
  minimax: {
    baseUrl: process.env.MINIMAX_BASE_URL ?? 'https://api.minimaxi.com/v1',
    apiKey: process.env.MINIMAX_API_KEY ?? '',
    model: process.env.MINIMAX_MODEL ?? ''
  },
  glm: {
    baseUrl: process.env.GLM_BASE_URL ?? 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: process.env.GLM_API_KEY ?? '',
    model: process.env.GLM_MODEL ?? ''
  },
  qwen: {
    baseUrl: process.env.QWEN_BASE_URL ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: process.env.QWEN_API_KEY ?? '',
    model: process.env.QWEN_MODEL ?? ''
  },
  mimo: {
    baseUrl: process.env.MIMO_BASE_URL ?? 'https://api.xiaomimimo.com/v1',
    apiKey: process.env.MIMO_API_KEY ?? '',
    model: process.env.MIMO_MODEL ?? ''
  }
}

/** 判断是否为内置 provider */
export function isBuiltinProvider(provider: string): provider is BuiltinProviderKey {
  return provider in builtinProviderConfigs
}

/** 获取 provider 完整配置（内置默认值 + 用户覆盖） */
export function getProviderConfig(
  provider: string,
  overrides?: ProviderOverrides
): ProviderConfig {
  const builtinKey = provider as BuiltinProviderKey
  const base = builtinProviderConfigs[builtinKey] ?? { baseUrl: '', apiKey: '', model: '' }
  const patch = overrides?.[provider]
  const cfg: ProviderConfig = {
    ...base,
    ...(patch ?? {}),
    headers: {
      ...(base.headers ?? {}),
      ...(patch?.headers ?? {})
    }
  }
  return cfg
}
