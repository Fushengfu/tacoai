/**
 * 网关 ASR 语音识别适配器
 *
 * 通过网关统一代理进行语音识别：客户端只提交 audioData + language，
 * 由网关封装供应商请求体、替换 API Key、转发、记录用量。
 *
 * 支持 SSE 流式响应（transcript.text.delta 事件拼接）。
 */

import type { AsrProvider, AsrProviderConfig, AsrRecognizeOptions } from './types'
import { AsrError } from './types'
import type { AsrAudioFormat } from './types'

const DEFAULT_GATEWAY_ASR_URL = 'https://aigateway.bjctykj.com/api/v1/audio/asr'

/* ---------- 保留原有独立函数接口（向后兼容） ---------- */

export interface GatewayAsrOptions {
  /** PCM s16le 16kHz mono 音频的 base64 编码 */
  pcmBase64: string
  /** 语言代码，默认 zh */
  language?: string
  /** API Key（网关 API Key），不传则报错 */
  apiKey?: string
  /** 网关 ASR 接口地址 */
  apiUrl?: string
  /** 超时毫秒数，默认 30s */
  timeout?: number
  /** 取消信号，用于中止正在进行的请求 */
  signal?: AbortSignal
  /** 指定 ASR 模型名称（可选，不传则使用网关默认配置） */
  model?: string
}

/** ASR 识别异常 */
export class GatewayAsrError extends Error {
  constructor(
    message: string,
    public readonly code: 'NO_API_KEY' | 'HTTP_ERROR' | 'TIMEOUT' | 'PARSE_ERROR',
  ) {
    super(message)
    this.name = 'GatewayAsrError'
  }
}

/**
 * 调用网关 ASR 进行语音识别（独立函数）。
 */
export async function recognizeWithGateway(options: GatewayAsrOptions): Promise<string> {
  const provider = new GatewayAsrProvider()
  return provider.recognize(
    {
      pcmBase64: options.pcmBase64,
      language: options.language,
      timeout: options.timeout,
      signal: options.signal,
    },
    {
      provider: 'gateway',
      apiKey: options.apiKey ?? '',
      apiUrl: options.apiUrl,
      model: options.model,
    },
  )
}


/* ---------- SSE 解析 ---------- */

/**
 * 解析 SSE 流中的 transcript.text.delta 事件，拼接完整识别文本。
 */
function parseSseTranscript(sseText: string): string {
  const lines = sseText.split('\n')
  let transcript = ''

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed === 'data: [DONE]') continue

    if (trimmed.startsWith('data: ')) {
      const jsonStr = trimmed.slice(6)
      try {
        const event = JSON.parse(jsonStr)
        if (event.type === 'transcript.text.delta' && event.delta) {
          transcript += event.delta
        }
      } catch {
        // 跳过无法解析的行（如 event: 行）
      }
    }
  }

  return transcript
}

/* ---------- AsrProvider 实现 ---------- */

export class GatewayAsrProvider implements AsrProvider {
  readonly id = 'gateway' as const
  readonly displayName = '网关 ASR'
  readonly defaultApiUrl = DEFAULT_GATEWAY_ASR_URL
  readonly defaultModel = 'stepaudio-2.5-asr'
  readonly audioFormat: AsrAudioFormat = 'base64-json'

  async recognize(options: AsrRecognizeOptions, config: AsrProviderConfig): Promise<string> {
    const { pcmBase64, language = 'zh', timeout = 30_000, signal } = options

    const key = config.apiKey
    if (!key) {
      throw new AsrError('网关 API Key 未配置，请先登录', 'NO_API_KEY')
    }

    const apiUrl = config.apiUrl || DEFAULT_GATEWAY_ASR_URL

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)

    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer)
        throw new AsrError('请求已被取消', 'HTTP_ERROR')
      }
      signal.addEventListener('abort', () => controller.abort(), { once: true })
    }

    try {
      // 只发送 audioData + language，由网关封装供应商请求体
      const body: Record<string, unknown> = {
        audioData: pcmBase64,
        language,
      }
      // 可选指定模型
      if (config.model) {
        body.model = config.model
      }

      const resp = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!resp.ok) {
        const bodyText = await resp.text().catch(() => '')
        throw new AsrError(
          `HTTP ${resp.status}: ${bodyText.slice(0, 300)}`,
          'HTTP_ERROR',
        )
      }

      const sseText = await resp.text()
      const transcript = parseSseTranscript(sseText)

      if (!transcript) {
        try {
          const json = JSON.parse(sseText)
          if (json.text) return json.text
          if (json.result) return json.result
        } catch {
          // 忽略，返回空字符串
        }
      }

      return transcript
    } catch (err) {
      if (err instanceof AsrError) throw err
      if ((err as Error).name === 'AbortError') {
        throw new AsrError('ASR 请求超时', 'TIMEOUT')
      }
      throw new AsrError(
        `ASR 请求失败: ${(err as Error).message}`,
        'HTTP_ERROR',
      )
    } finally {
      clearTimeout(timer)
    }
  }
}
