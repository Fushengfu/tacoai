/**
 * 语音识别 IPC Handler
 *
 * 路由层，委托给 ASR Provider 工厂执行实际识别。
 * 支持多平台提供商，通过配置驱动切换。
 */

import type { AsrProviderConfig } from '../../sdk/agent/asr/types'
import { AsrProviderFactory } from '../../sdk/agent/asr/factory'

/**
 * StepFun 专用 API Key 缓存（向后兼容旧版 VOICE_REGISTER_API_KEY IPC）。
 * 未来迁移到 VOICE_REGISTER_CONFIG 后废弃。
 */
let _cachedApiKey: string | null = null

/** 缓存的 ASR 配置（提供商 + URL + Model） */
let _cachedAsrConfig: Partial<AsrProviderConfig> = { provider: 'stepfun' }

/** 设置缓存的 API Key（向后兼容） */
export function setCachedAsrApiKey(key: string | null): void {
  _cachedApiKey = key
}

/** 设置缓存的 ASR 配置 */
export function setCachedAsrConfig(config: Partial<AsrProviderConfig>): void {
  _cachedAsrConfig = { ..._cachedAsrConfig, ...config }
}

/** 获取当前缓存的 ASR 配置 */
export function getCachedAsrConfig(): Partial<AsrProviderConfig> {
  return { ..._cachedAsrConfig }
}

/**
 * 语音识别 Handler。
 * 优先级：payload.apiKey > 缓存 _cachedApiKey > 默认空
 */
export async function handleVoiceRecognize(
  _event: Electron.IpcMainInvokeEvent,
  payload: { audioBase64: string; apiKey?: string },
): Promise<{ text: string; error?: string }> {
  try {
    const apiKey = payload.apiKey || _cachedApiKey || process.env.STEP_API_KEY || ''

    const config: AsrProviderConfig = {
      provider: (_cachedAsrConfig.provider as any) || 'stepfun',
      apiKey,
      apiUrl: _cachedAsrConfig.apiUrl,
      model: _cachedAsrConfig.model,
    }

    const provider = AsrProviderFactory.getProvider(config)
    const text = await provider.recognize(
      { pcmBase64: payload.audioBase64 },
      config,
    )

    console.log(`[VoiceRecognize] ${provider.id} ASR 识别成功: "${text.slice(0, 100)}"`)
    return { text }
  } catch (err: any) {
    if (err?.code === 'NO_API_KEY') {
      return { text: '', error: 'NO_API_KEY' }
    }
    console.error('[VoiceRecognize] ASR 失败:', err)
    return { text: '' }
  }
}
