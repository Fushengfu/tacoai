import type { PromptLayerConfig } from './ipc'

export const DEFAULT_PROVIDER_PROMPT_LAYER_MAP: Record<string, PromptLayerConfig> = {
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

export const DEFAULT_MODEL_PROMPT_LAYER_MAP: Record<string, PromptLayerConfig> = {
  'kimi-k2.5': {
    agentExtra: '- 当前模型为 kimi-k2.5：回答简洁直接，避免冗长铺垫。',
  },
  'deepseek-chat': {
    agentExtra: '- DeepSeek 系模型：工具调用参数必须完整且严格 JSON。',
  },
  'deepseek-reasoner': {
    agentExtra: '- DeepSeek 系模型：工具调用参数必须完整且严格 JSON。',
  },
}
