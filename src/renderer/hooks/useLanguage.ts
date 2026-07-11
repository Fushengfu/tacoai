/**
 * 语言切换 Hook
 * 支持中英文切换,持久化到localStorage
 */

import { useState, useEffect, useCallback } from 'react'

export type Language = 'zh-CN' | 'en-US'

const STORAGE_KEY = 'taco_app_language'

const translations: Record<Language, Record<string, string>> = {
  'zh-CN': {
    // 输入框相关
    'input.placeholder.default': '输入消息, Enter 发送, Shift+Enter 换行, 可粘贴图片/添加附件',
    'input.placeholder.no_workspace': '请先选择工作空间...',
    'input.placeholder.sending': '输入消息, Enter 加入队列等待发送',
    'input.attach_file': '添加文件(图片自动上传,其他文件作为附件)',
    'input.select_workspace': '选择工作空间',
    'input.send': '发送消息',
    'input.stop': '停止生成',
    'input.no_provider': '请先配置模型',
    // Token 统计
    'stats.input': '输入',
    'stats.output': '输出',
    'stats.cacheHit': '缓存命中',
    'stats.turns': '轮次',
    'stats.thisRun': '本轮',
    'stats.total': '累计',
    // 通用
    'common.language': '语言',
    'common.language_zh': '中文',
    'common.language_en': 'English',
  },
  'en-US': {
    // Input related
    'input.placeholder.default': 'Type a message, Enter to send, Shift+Enter for new line, paste images/attachments supported',
    'input.placeholder.no_workspace': 'Please select a workspace first...',
    'input.placeholder.sending': 'Type a message, Enter to queue for sending',
    'input.attach_file': 'Add files (images auto-upload, others as attachments)',
    'input.select_workspace': 'Select workspace',
    'input.send': 'Send message',
    'input.stop': 'Stop generation',
    'input.no_provider': 'Please configure a model first',
    // Token stats
    'stats.input': 'In',
    'stats.output': 'Out',
    'stats.cacheHit': 'Cache Hit',
    'stats.turns': 'Rounds',
    'stats.thisRun': 'Run',
    'stats.total': 'Total',
    // Common
    'common.language': 'Language',
    'common.language_zh': '中文',
    'common.language_en': 'English',
  },
}

export function useLanguage() {
  const [language, setLanguage] = useState<Language>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved === 'zh-CN' || saved === 'en-US') return saved
    } catch {
      // ignore
    }
    return 'zh-CN' // 默认中文
  })

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, language)
    } catch {
      // ignore
    }
  }, [language])

  const toggleLanguage = useCallback(() => {
    setLanguage((prev) => (prev === 'zh-CN' ? 'en-US' : 'zh-CN'))
  }, [])

  const t = useCallback(
    (key: string): string => {
      return translations[language][key] || key
    },
    [language]
  )

  return {
    language,
    setLanguage,
    toggleLanguage,
    t,
    isZhCN: language === 'zh-CN',
    isEnUS: language === 'en-US',
  }
}
