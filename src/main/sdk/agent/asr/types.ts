/**
 * ASR Provider 接口与配置类型
 *
 * 语音识别统一走网关代理，供应商由后台管理页面配置。
 */

/* ---------- 提供商标识 ---------- */
export type AsrProviderId = 'gateway'

/* ---------- 音频格式 ---------- */
export type AsrAudioFormat = 'base64-json'

/* ---------- 提供商配置 ---------- */
export interface AsrProviderConfig {
  /** 提供商标识 */
  provider: AsrProviderId
  /** API 接口地址（可选，默认使用网关地址） */
  apiUrl?: string
  /** 模型名称（可选） */
  model?: string
  /** API 密钥 */
  apiKey: string
}

/* ---------- 识别选项 ---------- */
export interface AsrRecognizeOptions {
  /** PCM s16le 16kHz mono 音频的 base64 编码 */
  pcmBase64: string
  /** 语言代码，默认 zh */
  language?: string
  /** 超时毫秒数，默认 30s */
  timeout?: number
  /** 取消信号 */
  signal?: AbortSignal
}

/* ---------- Provider 接口 ---------- */
export interface AsrProvider {
  /** 提供商标识 */
  readonly id: AsrProviderId
  /** 提供商显示名称 */
  readonly displayName: string
  /** 预置默认 API URL */
  readonly defaultApiUrl: string
  /** 预置默认模型 */
  readonly defaultModel: string
  /** 音频格式 */
  readonly audioFormat: AsrAudioFormat

  /**
   * 执行语音识别
   * @returns 识别文本
   */
  recognize(options: AsrRecognizeOptions, config: AsrProviderConfig): Promise<string>
}

/* ---------- ASR 通用异常 ---------- */
export class AsrError extends Error {
  constructor(
    message: string,
    public readonly code: 'NO_API_KEY' | 'HTTP_ERROR' | 'TIMEOUT' | 'PARSE_ERROR' | 'UNSUPPORTED_PROVIDER',
  ) {
    super(message)
    this.name = 'AsrError'
  }
}
