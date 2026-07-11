/**
 * ASR Provider 接口与配置类型
 *
 * 定义语音识别适配器的标准接口，支持多平台接入。
 * 内置预置平台：StepFun、阿里云、腾讯云、百度、OpenAI，以及自定义配置。
 */

/* ---------- 提供商标识 ---------- */
export type AsrProviderId =
  | 'stepfun'
  | 'aliyun'
  | 'tencent'
  | 'baidu'
  | 'openai'
  | 'custom'

/* ---------- 音频格式 ---------- */
export type AsrAudioFormat =
  | 'base64-json'    // base64 音频内嵌 JSON body
  | 'raw-binary'     // 原始 PCM 二进制（WebSocket）
  | 'multipart'      // multipart/form-data 文件上传

/* ---------- 请求字段映射（仅 custom 提供商使用） ---------- */
export interface CustomRequestMapping {
  /** 请求体中音频字段名，如 "audio"、"speech"、"data" */
  audioField: string
  /** 请求体中模型字段名，如 "model"、"model_name"（可选，不填则不放模型字段） */
  modelField?: string
  /** 音频传输格式 */
  audioFormat: AsrAudioFormat
  /** 自定义请求头，如 { "X-AppKey": "xxx" } */
  headers?: Record<string, string>
  /** HTTP method，默认 POST */
  method?: 'POST' | 'PUT'
}

/* ---------- 响应字段映射（仅 custom 提供商使用） ---------- */
export interface CustomResponseMapping {
  /** 响应中文本字段路径，如 "text"、"Result"、"result[0]" */
  textField: string
  /** 是否 SSE 流式响应，默认 false */
  isStream?: boolean
  /** 流式 delta 字段路径，如 "transcript.text.delta" */
  deltaField?: string
}

/* ---------- 提供商配置 ---------- */
export interface AsrProviderConfig {
  /** 提供商标识 */
  provider: AsrProviderId
  /** API 接口地址，为空则使用预置默认地址 */
  apiUrl?: string
  /** 模型名称，为空则使用预置默认模型 */
  model?: string
  /** API 密钥 */
  apiKey: string
  /**
   * 自定义适配器映射（仅 provider='custom' 时生效）。
   * 非 custom 提供商忽略此字段，使用预置映射。
   */
  requestMapping?: CustomRequestMapping
  responseMapping?: CustomResponseMapping
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
  /** 音频格式（base64-json / raw-binary / multipart） */
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
