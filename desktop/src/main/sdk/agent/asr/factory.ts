/**
 * ASR Provider 工厂
 *
 * 根据配置创建对应的 ASR 适配器实例。
 * 内置预置平台映射表（stepfun / aliyun / tencent / baidu / openai / custom）。
 */

import type { AsrProvider, AsrProviderConfig, AsrProviderId } from './types'
import { AsrError } from './types'
import { StepFunAsrProvider } from './stepfun-asr'

/* ---------- 预置提供商注册表 ---------- */
const BUILTIN_PROVIDERS: Record<string, () => AsrProvider> = {
  stepfun: () => new StepFunAsrProvider(),
  // 后续 Phase 2 按需添加：
  // aliyun:   () => new AliyunAsrProvider(),
  // tencent:  () => new TencentAsrProvider(),
  // baidu:    () => new BaiduAsrProvider(),
  // openai:   () => new OpenAiAsrProvider(),
  // custom:   () => new CustomAsrProvider(),
}

/* ---------- 可用提供商列表（供设置页面下拉框使用） ---------- */
export const AVAILABLE_PROVIDERS: Array<{
  id: AsrProviderId
  displayName: string
  description: string
}> = [
  { id: 'stepfun', displayName: 'StepFun', description: '阶跃星辰 ASR（stepaudio-2.5-asr）' },
  // 后续 Phase 2 按需添加：
  // { id: 'aliyun',  displayName: '阿里云',  description: '阿里云一句话识别' },
  // { id: 'tencent', displayName: '腾讯云',  description: '腾讯云一句话识别' },
  // { id: 'baidu',   displayName: '百度',    description: '百度短语音识别' },
  // { id: 'openai',  displayName: 'OpenAI',  description: 'OpenAI Whisper API' },
  // { id: 'custom',  displayName: '自定义',  description: '自定义 ASR 接口（URL + 字段映射）' },
]

/* ---------- 工厂 ---------- */
export class AsrProviderFactory {
  private static cache = new Map<string, AsrProvider>()

  /**
   * 根据配置获取 ASR Provider 实例。
   * 同一 provider id + apiUrl + model 组合会被缓存复用。
   */
  static getProvider(config: AsrProviderConfig): AsrProvider {
    const cacheKey = `${config.provider}\x00${config.apiUrl ?? ''}\x00${config.model ?? ''}`

    let provider = this.cache.get(cacheKey)
    if (provider) return provider

    const ctor = BUILTIN_PROVIDERS[config.provider]
    if (!ctor) {
      throw new AsrError(
        `不支持的语音识别提供商: ${config.provider}`,
        'UNSUPPORTED_PROVIDER',
      )
    }

    provider = ctor()
    this.cache.set(cacheKey, provider)
    return provider
  }

  /**
   * 获取指定提供商的实例（不需要完整配置的情况下）。
   * 用于获取预置 URL / model 等元信息。
   */
  static getProviderById(id: AsrProviderId): AsrProvider {
    const ctor = BUILTIN_PROVIDERS[id]
    if (!ctor) {
      throw new AsrError(
        `不支持的语音识别提供商: ${id}`,
        'UNSUPPORTED_PROVIDER',
      )
    }
    return ctor()
  }

  /** 清除缓存（如切换设置后强制重建） */
  static clearCache(): void {
    this.cache.clear()
  }
}
