/**
 * ASR Provider 工厂
 *
 * 根据配置创建对应的 ASR 适配器实例。
 * 当前仅支持网关代理模式（gateway provider）。
 */

import type { AsrProvider, AsrProviderConfig, AsrProviderId } from './types'
import { AsrError } from './types'
import { GatewayAsrProvider } from './client'

/* ---------- 预置提供商注册表 ---------- */
const BUILTIN_PROVIDERS: Record<string, () => AsrProvider> = {
  gateway: () => new GatewayAsrProvider(),
}

/* ---------- 工厂 ---------- */
export class AsrProviderFactory {
  private static cache = new Map<string, AsrProvider>()

  /**
   * 根据配置获取 ASR Provider 实例。
   * 同一 provider id 组合会被缓存复用。
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
