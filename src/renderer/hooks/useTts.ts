import { useCallback, useRef, useState } from 'react'

/**
 * TTS（文字转语音）Hook
 *
 * 双通道设计：
 * 1. 首选：window.speechSynthesis（Web Speech API）→ Electron = Chromium，原生可用，零开销
 * 2. 降级：IPC → 系统命令（macOS say / Linux espeak / Windows PowerShell SAPI）
 *
 * 用法：
 *   const { speak, stop, isSpeaking, isSupported } = useTts()
 *   speak('你好世界')  // 朗读文字（自动使用 localStorage 中保存的音色）
 *   stop()             // 停止朗读
 */

interface UseTtsOptions {
  /** 指定 voiceURI（不传则从 localStorage 读取用户设置） */
  voiceUri?: string
  /** 语速 0.5-2.0，默认 1.0（优先读取 localStorage 'taco-tts-rate'） */
  rate?: number
  /** 音高 0-2，默认 1.0 */
  pitch?: number
}

interface UseTtsResult {
  /** 开始朗读指定文字（自动去除 markdown/emoji/图标） */
  speak: (text: string, options?: UseTtsOptions) => void
  /** 停止当前朗读 */
  stop: () => void
  /** 是否正在朗读 */
  isSpeaking: boolean
  /** 是否支持 TTS */
  isSupported: boolean
}

/**
 * 清洗文本用于朗读：去 markdown、去 emoji、去特殊符号、去表格、去 HTML、去垃圾碎片
 */
export function stripMarkdown(text: string): string {
  let result = text
  // 去掉代码块
  result = result.replace(/```[\s\S]*?```/g, '')
  // 去掉行内代码
  result = result.replace(/`([^`]+)`/g, '$1')
  // 去掉图片
  result = result.replace(/!\[.*?\]\(.*?\)/g, '')
  // 链接 [text](url) → text
  result = result.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  // 去掉加粗/斜体/删除线标记
  result = result.replace(/\*\*([^*]+)\*\*/g, '$1')
  result = result.replace(/__([^_]+)__/g, '$1')
  result = result.replace(/\*([^*]+)\*/g, '$1')
  result = result.replace(/_([^_]+)_/g, '$1')
  result = result.replace(/~~([^~]+)~~/g, '$1')
  // 去掉标题 #
  result = result.replace(/^#{1,6}\s+/gm, '')
  // 去掉列表标记
  result = result.replace(/^[\s]*[-*+]\s+/gm, '')
  result = result.replace(/^[\s]*\d+\.\s+/gm, '')
  // 去掉水平线
  result = result.replace(/^[-*_]{3,}\s*$/gm, '')
  // 去掉引用 >
  result = result.replace(/^>\s?/gm, '')
  // 去掉 Markdown 表格分隔行: |---|---|
  result = result.replace(/^\|[\s\-:|]+\|$/gm, '')
  // 替换表格竖线为顿号
  result = result.replace(/\|/g, '、')
  // 去掉 FILE 标签
  result = result.replace(/\[FILE\][^\[]*\[\/FILE\]/g, '')
  // 去掉 HTML 标签
  result = result.replace(/<[^>]+>/g, '')
  // 去掉 emoji 和特殊图标符号（保留中文、英文、数字、基础标点）
  result = result.replace(/[\u{1F600}-\u{1F9FF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B50}\u{2B55}\u{2702}-\u{27B0}\u{1F000}-\u{1F02F}\u{1F0A0}-\u{1F0FF}\u{1F100}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{FE0F}]/gu, '')
  result = result.replace(/[✔✅❌❎✖⚠⏳⌛⏹▶⬆⬇➡←→↑↓↗↘↙↖🔄🔁🔊🔇📋📄📁📂🔒🔓🔑🔥💡⭐🌟☀☁☂☃☄★☆☎☏☕☘☠☢☣☤☥☦☧☨☩☪☫☬☭☮☯☸☹☺☻☼☽☾]/g, '')
  // 合并空白
  result = result.replace(/\n{3,}/g, '\n\n')
  result = result.replace(/[ \t]{2,}/g, ' ')
  const final = result.trim()
  // 过滤明显的非自然语言碎片（LLM 内部 token/配置泄露）
  if (!/[\u4e00-\u9fff]/.test(final)) {
    const words = final.split(/\s+/).filter(w => w.length > 0)
    if (words.length < 3) return ''
    if (words.length === 1 && /^[a-zA-Z0-9]+$/.test(words[0])) return ''
  }
  return final
}

export function useTts(): UseTtsResult {
  const [isSpeaking, setIsSpeaking] = useState(false)
  const isSpeakingRef = useRef(false)
  const systemSpeakingRef = useRef(false)

  const isSupported = typeof window !== 'undefined' && 'speechSynthesis' in window

  const stop = useCallback(() => {
    if (!isSupported) {
      if (systemSpeakingRef.current) {
        systemSpeakingRef.current = false
        setIsSpeaking(false)
      }
      return
    }
    window.speechSynthesis.cancel()
    isSpeakingRef.current = false
    setIsSpeaking(false)
    systemSpeakingRef.current = false
  }, [isSupported])

  /**
   * 获取用户设定的音色
   * 优先级：options.voiceUri > localStorage 保存的 > 自动检测中文
   */
  const resolveVoice = useCallback((text: string, options?: UseTtsOptions): SpeechSynthesisVoice | undefined => {
    const voices = window.speechSynthesis.getVoices()
    if (voices.length === 0) return undefined

    // 1. 显式传入的 voiceUri
    if (options?.voiceUri) {
      return voices.find(v => v.voiceURI === options.voiceUri)
    }

    // 2. localStorage 中用户选择的音色
    const savedUri = typeof localStorage !== 'undefined' ? localStorage.getItem('taco-tts-voice') : null
    if (savedUri) {
      const saved = voices.find(v => v.voiceURI === savedUri)
      if (saved) return saved
    }

    // 3. 自动检测中文 → 选 Tingting（macOS 高质量女声）
    const hasChinese = /[\u4e00-\u9fff]/.test(text)
    if (hasChinese) {
      const zh = voices.find(v =>
        v.name.includes('Tingting') ||
        v.name.includes('Sin-Ji') ||
        v.name.includes('Mei-Jia') ||
        v.lang.startsWith('zh-CN')
      ) || voices.find(v => v.lang.startsWith('zh'))
      if (zh) return zh
    }

    return undefined
  }, [])

  const speakWithWebSpeech = useCallback((text: string, options?: UseTtsOptions) => {
    const synth = window.speechSynthesis
    synth.cancel()

    const utterance = new SpeechSynthesisUtterance(text)
    utterance.rate = options?.rate ?? parseFloat((typeof localStorage !== 'undefined' ? localStorage.getItem('taco-tts-rate') : null) || '1.0')
    utterance.pitch = options?.pitch ?? parseFloat((typeof localStorage !== 'undefined' ? localStorage.getItem('taco-tts-pitch') : null) || '1.0')
    utterance.volume = 1.0

    const voice = resolveVoice(text, options)
    if (voice) utterance.voice = voice

    utterance.onstart = () => {
      isSpeakingRef.current = true
      setIsSpeaking(true)
    }

    utterance.onend = () => {
      isSpeakingRef.current = false
      setIsSpeaking(false)
    }

    utterance.onerror = (event) => {
      console.warn('[TTS] Web Speech 朗读失败:', event.error)
      isSpeakingRef.current = false
      setIsSpeaking(false)

      if (event.error !== 'canceled' && event.error !== 'interrupted') {
        speakWithSystem(text)
      }
    }

    synth.speak(utterance)
  }, [resolveVoice])

  const speakWithSystem = useCallback((text: string) => {
    systemSpeakingRef.current = true
    setIsSpeaking(true)

    try {
      window.taco.voice.speak(text)
    } catch (err) {
      console.error('[TTS] 系统 TTS 调用失败:', err)
    }

    const estimatedMs = Math.min(text.length * 80, 60000)
    setTimeout(() => {
      if (systemSpeakingRef.current) {
        systemSpeakingRef.current = false
        setIsSpeaking(false)
      }
    }, estimatedMs)
  }, [])

  const speak = useCallback((text: string, options?: UseTtsOptions) => {
    const cleanText = stripMarkdown(text)
    if (!cleanText) return

    stop()

    if (isSupported) {
      if (window.speechSynthesis.getVoices().length === 0) {
        const handler = () => {
          window.speechSynthesis.removeEventListener('voiceschanged', handler)
          speakWithWebSpeech(cleanText, options)
        }
        window.speechSynthesis.addEventListener('voiceschanged', handler)
      } else {
        speakWithWebSpeech(cleanText, options)
      }
    } else {
      speakWithSystem(cleanText)
    }
  }, [isSupported, stop, speakWithWebSpeech, speakWithSystem])

  return { speak, stop, isSpeaking, isSupported }
}
