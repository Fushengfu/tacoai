import { useCallback, useEffect, useRef, useState } from 'react'

interface UseVoiceInputOptions {
  /** 语音识别完成后的回调，传入识别结果文本 */
  onTextReady: (text: string) => void
  /** 最大录音时长（毫秒），默认 30 秒 */
  maxDurationMs?: number
}

interface UseVoiceInputResult {
  /** 是否正在录音 */
  isRecording: boolean
  /** 已录音秒数 */
  elapsedSeconds: number
}

/** Chromium SpeechRecognition 类型声明 */
declare var SpeechRecognition: {
  new(): SpeechRecognition
}
declare var webkitSpeechRecognition: {
  new(): SpeechRecognition
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean
  interimResults: boolean
  lang: string
  start(): void
  stop(): void
  abort(): void
  onresult: ((event: SpeechRecognitionEvent) => void) | null
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null
  onend: (() => void) | null
}

interface SpeechRecognitionEvent {
  results: SpeechRecognitionResultList
  resultIndex: number
}

type SpeechRecognitionResultList = Iterable<SpeechRecognitionResult> & {
  length: number
  item(index: number): SpeechRecognitionResult
  [index: number]: SpeechRecognitionResult
}

interface SpeechRecognitionResult {
  isFinal: boolean
  length: number
  item(index: number): SpeechRecognitionAlternative
  [index: number]: SpeechRecognitionAlternative
}

interface SpeechRecognitionAlternative {
  transcript: string
  confidence: number
}

interface SpeechRecognitionErrorEvent {
  error: string
  message: string
}

/**
 * 语音输入 Hook
 * 按住 Cmd+Shift+V 开始录音，松开停止并自动填入识别结果
 * 使用 Chromium SpeechRecognition API 进行语音识别
 */
export function useVoiceInput({ onTextReady, maxDurationMs = 30_000 }: UseVoiceInputOptions): UseVoiceInputResult {
  const [isRecording, setIsRecording] = useState(false)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)

  const recognitionRef = useRef<SpeechRecognition | null>(null)
  const onTextReadyRef = useRef(onTextReady)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const maxDurationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isRecordingRef = useRef(false)
  const startedByShortcutRef = useRef(false) // 标记是否由快捷键触发

  onTextReadyRef.current = onTextReady

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

  const stopRecording = useCallback(() => {
    clearTimers()
    isRecordingRef.current = false
    startedByShortcutRef.current = false
    setIsRecording(false)
    setElapsedSeconds(0)
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop()
      } catch {
        // ignore stop errors
      }
      recognitionRef.current = null
    }
  }, [clearTimers])

  const startRecording = useCallback(() => {
    if (isRecordingRef.current) return

    const SpeechRecognitionCtor =
      (typeof SpeechRecognition !== 'undefined' ? SpeechRecognition : undefined) ??
      (typeof webkitSpeechRecognition !== 'undefined' ? webkitSpeechRecognition : undefined)

    if (!SpeechRecognitionCtor) {
      console.warn('[VoiceInput] SpeechRecognition API 不可用')
      window.taco.shell.notify({
        title: '语音输入不可用',
        body: '当前环境不支持语音识别功能',
      })
      return
    }

    try {
      const recognition = new SpeechRecognitionCtor()
      recognition.continuous = true
      recognition.interimResults = false
      recognition.lang = 'zh-CN'

      let finalText = ''

      recognition.onresult = (event: SpeechRecognitionEvent) => {
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i] as SpeechRecognitionResult
          if (result.isFinal) {
            finalText += result[0]!.transcript
          }
        }
      }

      recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
        console.warn('[VoiceInput] 识别错误:', event.error, event.message)
        const errorMessages: Record<string, string> = {
          'no-speech': '未检测到语音，请重试',
          'aborted': '录音已取消',
          'audio-capture': '无法访问麦克风，请检查系统权限',
          'network': '网络错误，语音识别需要网络连接',
          'not-allowed': '麦克风权限被拒绝，请在系统设置中允许',
          'service-not-allowed': '语音识别服务不可用',
          'bad-grammar': '语音识别配置错误',
          'language-not-supported': '当前语言不支持语音识别',
        }
        const msg = errorMessages[event.error] || `语音识别错误: ${event.error}`
        if (event.error !== 'no-speech' && event.error !== 'aborted') {
          window.taco.shell.notify({ title: '语音识别', body: msg })
        }
        stopRecording()
      }

      recognition.onend = () => {
        const text = finalText.trim()
        if (text) {
          onTextReadyRef.current(text)
        }
        stopRecording()
      }

      recognition.start()
      recognitionRef.current = recognition
      isRecordingRef.current = true
      setIsRecording(true)
      setElapsedSeconds(0)

      // 计时器：每秒更新
      timerRef.current = setInterval(() => {
        setElapsedSeconds((prev) => prev + 1)
      }, 1000)

      // 最大时长超时自动停止
      maxDurationTimerRef.current = setTimeout(() => {
        if (recognitionRef.current) {
          try {
            recognitionRef.current.stop()
          } catch {
            // ignore
          }
        }
      }, maxDurationMs)
    } catch (err) {
      console.error('[VoiceInput] 初始化失败:', err)
      window.taco.shell.notify({
        title: '语音输入初始化失败',
        body: '无法启动语音识别，请检查麦克风权限',
      })
    }
  }, [maxDurationMs, stopRecording])

  // 按住说话：DOM 级 keydown/keyup 监听 Cmd+Shift+V
  useEffect(() => {
    const isInputFocused = (target: EventTarget | null): boolean => {
      if (!target) return false
      const el = target as HTMLElement
      const tag = el.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
      if (el.isContentEditable) return true
      // Monaco 编辑器内部也是 contenteditable / textarea
      if (el.closest('.monaco-editor')) return true
      return false
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd+Shift+V 按下，且不处于输入框聚焦状态
      if (e.metaKey && e.shiftKey && e.key === 'V' && !e.repeat) {
        if (isInputFocused(e.target)) return
        e.preventDefault()
        e.stopPropagation()
        startedByShortcutRef.current = true
        startRecording()
      }
    }

    const handleKeyUp = (e: KeyboardEvent) => {
      // V 键松开时，如果是由快捷键触发的录音，则停止
      if ((e.key === 'v' || e.key === 'V') && startedByShortcutRef.current && isRecordingRef.current) {
        if (recognitionRef.current) {
          try {
            recognitionRef.current.stop()
          } catch {
            // ignore
          }
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    window.addEventListener('keyup', handleKeyUp, true)

    return () => {
      window.removeEventListener('keydown', handleKeyDown, true)
      window.removeEventListener('keyup', handleKeyUp, true)
      clearTimers()
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort()
        } catch {
          // ignore
        }
      }
    }
  }, [startRecording, clearTimers])

  return { isRecording, elapsedSeconds }
}
