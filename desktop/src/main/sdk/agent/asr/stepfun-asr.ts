/**
 * StepFun ASR 语音识别服务
 *
 * 基于 StepAudio-2.5-ASR 模型，将 PCM s16le 16kHz 音频转为文本。
 * 价格：0.15 元/小时。
 * API Key 由用户在设置页面配置，通过 IPC 传入。
 *
 * API 文档：https://platform.stepfun.com/docs/zh/guides/models/stepaudio-2.5-asr
 */

const STEPFUN_ASR_URL = 'https://api.stepfun.com/v1/audio/asr/sse'
const STEPFUN_ASR_MODEL = 'stepaudio-2.5-asr'

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

/** StepFun ASR 识别异常 */
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
 * 解析 SSE 流中的 transcript.text.delta 事件，拼接完整识别文本。
 *
 * SSE 格式示例：
 *   data: {"type":"transcript.text.delta","delta":"你"}
 *   data: {"type":"transcript.text.delta","delta":"好"}
 *   data: [DONE]
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

/**
 * 调用 StepFun ASR 进行语音识别。
 *
 * @throws {StepFunAsrError} NO_API_KEY / HTTP_ERROR / TIMEOUT / PARSE_ERROR
 * @returns 识别文本
 */
export async function recognizeStepFun(options: StepFunAsrOptions): Promise<string> {
  const { pcmBase64, language = 'zh', apiKey, timeout = 30_000, signal } = options

  const key = apiKey
  if (!key) {
    throw new StepFunAsrError('StepFun API Key 未配置，请在设置页面填写', 'NO_API_KEY')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)

  // 合并外部 signal：外部 abort 时也取消请求
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer)
      throw new StepFunAsrError('请求已被取消', 'HTTP_ERROR')
    }
    signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  try {
    const resp = await fetch(STEPFUN_ASR_URL, {
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
              model: STEPFUN_ASR_MODEL,
              language: 'zh',
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
      throw new StepFunAsrError(
        `HTTP ${resp.status}: ${body.slice(0, 300)}`,
        'HTTP_ERROR',
      )
    }

    const sseText = await resp.text()
    const transcript = parseSseTranscript(sseText)

    if (!transcript) {
      // 尝试从 JSON 格式解析（非 SSE 响应）
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
    if (err instanceof StepFunAsrError) throw err
    if ((err as Error).name === 'AbortError') {
      throw new StepFunAsrError('ASR 请求超时', 'TIMEOUT')
    }
    throw new StepFunAsrError(
      `ASR 请求失败: ${(err as Error).message}`,
      'HTTP_ERROR',
    )
  } finally {
    clearTimeout(timer)
  }
}
