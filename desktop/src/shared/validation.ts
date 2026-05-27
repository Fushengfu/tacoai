/**
 * 模型配置验证（主进程/渲染进程共用）
 */

export type ModelConfigValidation = {
  valid: boolean
  errors: string[]
}

/**
 * 验证模型配置
 */
export function validateModelConfig(config: {
  provider: string
  baseUrl?: string
  apiKey?: string
  model?: string
  contextLength?: string
  temperature?: string | number
}): ModelConfigValidation {
  const errors: string[] = []

  // 1. 提供商不能为空
  if (!config.provider || !config.provider.trim()) {
    errors.push('未选择 AI 提供商')
  }

  // 2. API Key 验证
  const apiKey = String(config.apiKey ?? '').trim()
  if (!apiKey) {
    errors.push('API Key 不能为空')
  } else if (apiKey.length < 10) {
    errors.push('API Key 格式不正确（过短）')
  } else if (apiKey.includes(' ')) {
    errors.push('API Key 不能包含空格')
  }

  // 3. Base URL 验证（如果提供）
  const baseUrl = String(config.baseUrl ?? '').trim()
  if (baseUrl) {
    try {
      new URL(baseUrl)
      if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
        errors.push('Base URL 必须以 http:// 或 https:// 开头')
      }
    } catch {
      errors.push('Base URL 格式不正确')
    }
  }

  // 4. Model 验证（如果提供）
  const model = String(config.model ?? '').trim()
  if (model) {
    if (model.length > 200) {
      errors.push('Model 名称过长')
    }
    if (/[^a-zA-Z0-9._\/\-]/.test(model)) {
      errors.push('Model 名称包含非法字符')
    }
  }

  // 5. 上下文长度验证
  const contextLength = String(config.contextLength ?? '').trim()
  if (contextLength) {
    const tokens = Number(contextLength)
    if (!Number.isInteger(tokens) || tokens <= 0) {
      errors.push('上下文长度必须是正整数')
    } else if (tokens > 10000000) {
      errors.push('上下文长度不能超过 10000000')
    }
  }

  // 6. Temperature 验证
  const temp = typeof config.temperature === 'string' 
    ? String(config.temperature).trim() 
    : config.temperature
  if (temp !== undefined && temp !== '') {
    const temperature = Number(temp)
    if (Number.isNaN(temperature)) {
      errors.push('Temperature 必须是数字')
    } else if (temperature < 0 || temperature > 2) {
      errors.push('Temperature 必须在 0-2 之间')
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

/**
 * 解析配置的 temperature 值
 */
export function parseConfiguredTemperature(raw: unknown): number | undefined {
  const text = String(raw ?? '').trim()
  if (!text) return undefined
  const value = Number(text)
  if (!Number.isFinite(value)) return undefined
  if (value < 0 || value > 2) return undefined
  return value
}
