/**
 * StepFun ASR 语音识别适配器
 *
 * 基于 StepAudio-2.5-ASR 模型，将 PCM s16le 16kHz 音频转为文本。
 * 实现 AsrProvider 接口，可被工厂动态创建。
 *
 * API 文档：https://platform.stepfun.com/docs/zh/guides/models/stepaudio-2.5-asr
 */

import type { AsrProvider, AsrProviderConfig, AsrRecognizeOptions } from './types'
import { AsrError } from './types'
import type { AsrAudioFormat } from './types'

const DEFAULT_API_URL = 'https://api.stepfun.com/v1/audio/asr/sse'
const DEFAULT_MODEL = 'stepaudio-2.5-asr'

/* ---------- 保留原有独立函数接口（向后兼容） ---------- */

export interface StepFunAsrOptions {
  /** PCM s16le 16kHz mono 音频的 base64 编码 */
  pcmBase64: string
  /** 语言代码，默认 zh */
  language?: string
  /** API Key，不传则读环境变量 STEP_API_KEY */
  apiKey?: string
  /** 超时毫秒数，默认 30s */
  timeout?: number
  /** 取消信号，用于中止正在进行的请求 */
  signal?: AbortSignal
}

/** StepFun ASR 识别异常（向后兼容） */
export class StepFunAsrError extends Error {
  constructor(
    message: string,
    public readonly code: 'NO_API_KEY' | 'HTTP_ERROR' | 'TIMEOUT' | 'PARSE_ERROR',
  ) {
    super(message)
    this.name = 'StepFunAsrError'
  }
}

/**
 * 调用 StepFun ASR 进行语音识别（独立函数，向后兼容）。
 * @deprecated 推荐使用 AsrProviderFactory 获取 provider 实例后调用 recognize
 */
export async function recognizeStepFun(options: StepFunAsrOptions): Promise<string> {
  const provider = new StepFunAsrProvider()
  return provider.recognize(
    {
      pcmBase64: options.pcmBase64,
      language: options.language,
      timeout: options.timeout,
      signal: options.signal,
    },
    {
      provider: 'stepfun',
      apiKey: options.apiKey ?? '',
    },
  )
}

/* ---------- AsrProvider 实现 ---------- */

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

export class StepFunAsrProvider implements AsrProvider {
  readonly id = 'stepfun' as const
  readonly displayName = 'StepFun'
  readonly defaultApiUrl = DEFAULT_API_URL
  readonly defaultModel = DEFAULT_MODEL
  readonly audioFormat: AsrAudioFormat = 'base64-json'

  async recognize(options: AsrRecognizeOptions, config: AsrProviderConfig): Promise<string> {
    const { pcmBase64, language = 'zh', timeout = 30_000, signal } = options

    const key = config.apiKey
    if (!key) {
      throw new AsrError('ASR API Key 未配置，请在设置页面填写', 'NO_API_KEY')
    }

    const apiUrl = config.apiUrl || DEFAULT_API_URL
    const model = config.model || DEFAULT_MODEL

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
      const resp = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
        },
        body: JSON.stringify({
          audio: {
            data: pcmBase64,
            input: {
              transcription: {
                model,
                language,
                enable_itn: true,
              },
              format: {
                type: 'pcm',
                codec: 'pcm_s16le',
                rate: 16000,
                bits: 16,
                channel: 1,
              },
            },
          },
        }),
        signal: controller.signal,
      })

      if (!resp.ok) {
        const body = await resp.text().catch(() => '')
        throw new AsrError(
          `HTTP ${resp.status}: ${body.slice(0, 300)}`,
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
