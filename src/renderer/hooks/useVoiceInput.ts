import { useCallback, useRef, useState } from 'react'

interface UseVoiceInputOptions {
  /** 语音识别文本就绪时的回调 */
  onTextReady: (text: string) => void
  /** 最大录音时长（毫秒），默认 30 秒 */
  maxDurationMs?: number
}

interface UseVoiceInputResult {
  /** 是否正在录音 */
  isRecording: boolean
  /** 已录音秒数 */
  elapsedSeconds: number
  /** 点击切换：开始录音 / 结束录音并识别 */
  toggleRecording: () => void
}

/**
 * 语音输入 Hook
 *
 * 按住录音 → 松开识别：用户按住麦克风按钮开始录音，松开后发送完整 PCM 到 ASR，
 * 获取完整识别文本后插入输入框。
 *
 * 音频处理流程：AudioContext 采集 → Float32 PCM → 重采样到 16kHz → s16le → base64 → IPC → 网关 ASR
 *
 * 语音识别统一走网关代理，供应商由后台管理页面配置，客户端无需关心具体使用哪个服务。
 *
 * 降级方案：网关 Token 未配置时自动使用 Chromium SpeechRecognition
 * （国内 Google 服务不可达，会报 network 错误）。
 */
export function useVoiceInput({ onTextReady, maxDurationMs = 30_000 }: UseVoiceInputOptions): UseVoiceInputResult {
  const [isRecording, setIsRecording] = useState(false)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)

  const onTextReadyRef = useRef(onTextReady)
  onTextReadyRef.current = onTextReady

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const maxDurationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isRecordingRef = useRef(false)

  // AudioContext 相关
  const audioContextRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const pcmChunksRef = useRef<Float32Array[]>([])

  // SpeechRecognition 降级
  const recognitionRef = useRef<any>(null)
  const finalTextRef = useRef('')
  // ASR 可用性缓存：null=未探测, true=可用, false=不可用
  const asrAvailableRef = useRef<boolean | null>(null)

  const clearTimers = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    if (maxDurationTimerRef.current) {
      clearTimeout(maxDurationTimerRef.current)
      maxDurationTimerRef.current = null
    }
  }, [])

  /** 释放音频资源 */
  const releaseAudioResources = useCallback(() => {
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {})
      audioContextRef.current = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
    if (recognitionRef.current) {
      try { recognitionRef.current.abort() } catch { /* ignore */ }
      recognitionRef.current = null
    }
  }, [])

  /**
   * Float32Array PCM chunks → base64 字符串。
   *
   * 处理步骤：
   * 1. 拼接所有 chunk
   * 2. 重采样到 16kHz
   * 3. Float32 [-1,1] → Int16 s16le
   * 4. Int16 buffer → base64
   */
  const pcmToBase64 = useCallback((chunks: Float32Array[], inputSampleRate: number): string => {
    if (chunks.length === 0) return ''

    // 1. 拼接
    let totalSamples = 0
    for (const c of chunks) totalSamples += c.length
    const allSamples = new Float32Array(totalSamples)
    let offset = 0
    for (const c of chunks) {
      allSamples.set(c, offset)
      offset += c.length
    }

    // 2. 重采样到 16kHz（线性插值）
    const targetRate = 16_000
    let samples: Float32Array
    if (inputSampleRate !== targetRate) {
      const ratio = inputSampleRate / targetRate
      const newLength = Math.floor(totalSamples / ratio)
      samples = new Float32Array(newLength)
      for (let i = 0; i < newLength; i++) {
        samples[i] = allSamples[Math.floor(i * ratio)]
      }
    } else {
      samples = allSamples
    }

    // 3. Float32 → Int16 s16le
    const int16 = new Int16Array(samples.length)
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]))
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF
    }

    // 4. Int16 buffer → base64
    const bytes = new Uint8Array(int16.buffer)
    let binary = ''
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i])
    }
    return btoa(binary)
  }, [])

  /**
   * 发送完整 PCM 到 ASR 服务，返回识别文本。
   * 统一走网关代理，API Key 由主进程自动注入。
   */
  const recognizeAsr = useCallback(async (): Promise<string> => {
    if (pcmChunksRef.current.length === 0) return ''
    const sampleRate = audioContextRef.current?.sampleRate ?? 44_100
    const base64 = pcmToBase64(pcmChunksRef.current, sampleRate)

    try {
      // 不传 apiKey，主进程会自动使用网关 API Key
      const result = await window.taco.voice.recognize(base64)

      if (result.error === 'NO_TOKEN' || result.error === 'NO_API_KEY') {
        console.warn('[VoiceInput] 网关 Token 未配置，后续将使用 SpeechRecognition 降级')
        asrAvailableRef.current = false
        return ''
      }

      asrAvailableRef.current = true
      return (result.text ?? '').trim()
    } catch (err) {
      console.error('[VoiceInput] ASR 识别失败:', err)
      return ''
    }
  }, [pcmToBase64])

  /** 内部清理：停止录音、释放资源、重置状态 */
  const stopRecording = useCallback(() => {
    clearTimers()
    isRecordingRef.current = false
    setIsRecording(false)
    setElapsedSeconds(0)
    releaseAudioResources()
    pcmChunksRef.current = []
  }, [clearTimers, releaseAudioResources])

  /**
   * 降级方案：Chromium SpeechRecognition
   * 当 ASR API Key 未配置时自动使用。
   */
  const fallbackToSpeechRecognition = useCallback(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SpeechRecognitionCtor: any =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition

    if (!SpeechRecognitionCtor) {
      console.warn('[VoiceInput] SpeechRecognition API 不可用')
      window.taco.shell.notify({
        title: '语音输入不可用',
        body: '语音识别服务不可用，请确认网关连接正常',
      })
      return
    }

    try {
      const recognition = new SpeechRecognitionCtor()
      recognitionRef.current = recognition
      recognition.continuous = true
      recognition.interimResults = true
      recognition.lang = 'zh-CN'
      finalTextRef.current = ''

      recognition.onresult = (event: any) => {
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i]
          if (result.isFinal) {
            finalTextRef.current += result[0].transcript
          }
        }
      }

      recognition.onerror = (event: any) => {
        console.warn('[VoiceInput] SpeechRecognition 错误:', event.error)
        if (event.error !== 'no-speech' && event.error !== 'aborted') {
          const msgs: Record<string, string> = {
            'network': '语音识别服务不可用，请确认网关连接正常',
            'not-allowed': '麦克风权限被拒绝',
            'audio-capture': '无法访问麦克风',
          }
          window.taco.shell.notify({
            title: '语音识别',
            body: msgs[event.error] || `语音识别错误: ${event.error}`,
          })
        }
        if (finalTextRef.current.trim()) {
          onTextReadyRef.current(finalTextRef.current.trim())
        }
        stopRecording()
      }

      recognition.onend = () => {
        if (finalTextRef.current.trim() && isRecordingRef.current) {
          onTextReadyRef.current(finalTextRef.current.trim())
        }
        if (isRecordingRef.current) {
          stopRecording()
        }
      }

      recognition.start()
      isRecordingRef.current = true
      setIsRecording(true)
      setElapsedSeconds(0)

      timerRef.current = setInterval(() => {
        setElapsedSeconds((prev) => prev + 1)
      }, 1000)

      maxDurationTimerRef.current = setTimeout(() => {
        if (recognitionRef.current) {
          try { recognitionRef.current.stop() } catch { /* ignore */ }
        }
      }, maxDurationMs)
    } catch (err) {
      console.error('[VoiceInput] SpeechRecognition 初始化失败:', err)
    }
  }, [maxDurationMs, stopRecording])

  /**
   * 发送完整 PCM 到 ASR 并输出结果，然后清理状态。
   */
  const finishRecording = useCallback(async () => {
    if (!isRecordingRef.current) return

    // 先置标志，阻止 onaudioprocess 继续写入
    isRecordingRef.current = false
    clearTimers()

    // 发送完整 PCM → 识别
    const text = await recognizeAsr()

    releaseAudioResources()
    pcmChunksRef.current = []
    setIsRecording(false)
    setElapsedSeconds(0)

    if (text) {
      onTextReadyRef.current(text)
    }
  }, [clearTimers, releaseAudioResources, recognizeAsr])

  // 用 ref 让 startRecording 的 timeout 能调用 finishRecording（解决循环依赖）
  const finishRecordingRef = useRef(finishRecording)
  finishRecordingRef.current = finishRecording

  const startRecording = useCallback(async () => {
    if (isRecordingRef.current) return

    // 如果已探测到 ASR 不可用，直接降级
    if (asrAvailableRef.current === false) {
      fallbackToSpeechRecognition()
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      const audioContext = new AudioContext()
      audioContextRef.current = audioContext

      const source = audioContext.createMediaStreamSource(stream)
      const processor = audioContext.createScriptProcessor(4096, 1, 1)
      pcmChunksRef.current = []

      processor.onaudioprocess = (event) => {
        if (!isRecordingRef.current) return
        const inputData = event.inputBuffer.getChannelData(0)
        pcmChunksRef.current.push(new Float32Array(inputData))
      }

      source.connect(processor)
      processor.connect(audioContext.destination)

      isRecordingRef.current = true
      setIsRecording(true)
      setElapsedSeconds(0)

      // 每秒更新计时
      timerRef.current = setInterval(() => {
        setElapsedSeconds((prev) => prev + 1)
      }, 1000)

      // 最大录音时长 → 自动停止并识别
      maxDurationTimerRef.current = setTimeout(() => {
        finishRecordingRef.current()
      }, maxDurationMs)
    } catch (err) {
      console.error('[VoiceInput] 麦克风初始化失败:', err)
      // NotAllowedError → 尝试 SpeechRecognition 降级（可能已有权限）
      // 其他错误 → 回退到 SpeechRecognition
      fallbackToSpeechRecognition()
    }
  }, [maxDurationMs, fallbackToSpeechRecognition])

  /** 点击切换：未录音时开始，录音中则结束并识别 */
  const toggleRecording = useCallback(() => {
    if (isRecordingRef.current) {
      finishRecording()
    } else {
      startRecording()
    }
  }, [startRecording, finishRecording])

  return { isRecording, elapsedSeconds, toggleRecording }
}
