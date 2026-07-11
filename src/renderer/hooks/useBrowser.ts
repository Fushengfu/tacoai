/**
 * 浏览器窗口管理 Hook
 * 
 * 管理外部浏览器窗口、控制台日志、错误候选等
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import type { BrowserConsoleLevel } from '../../shared/ipc'

const DEV_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1'])

export type BrowserConsoleEntry = {
  id: number
  appId: string
  level: BrowserConsoleLevel
  message: string
  source?: string
  line?: number
  timestamp: number
}

type BrowserErrorCandidate = BrowserConsoleEntry & { weight: number; fingerprint: string }

function isPrivateIpv4(hostname: string): boolean {
  const m = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  if (a === 10) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return false
}

function isDevBrowserUrl(rawUrl?: string): boolean {
  if (!rawUrl) return false
  if (rawUrl.startsWith('webpack://') || rawUrl.startsWith('vite://')) return true
  try {
    const u = new URL(rawUrl)
    const host = u.hostname.toLowerCase()
    if (DEV_HOSTS.has(host)) return true
    if (host.endsWith('.localhost') || host.endsWith('.local')) return true
    if (isPrivateIpv4(host)) return true
    return false
  } catch {
    return false
  }
}

export function useBrowser(tid: string) {
  const [browserWindows, setBrowserWindows] = useState<Map<string, string>>(new Map())
  const [browserConsoleLogs, setBrowserConsoleLogs] = useState<BrowserConsoleEntry[]>([])
  const consoleIdRef = useRef(0)
  const browserWindowsRef = useRef<Map<string, string>>(new Map())
  const browserErrorCandidatesRef = useRef<BrowserErrorCandidate[]>([])

  const currentBrowserAppId = tid
    ? `project-${tid.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 64)}`
    : 'default'

  // 评估浏览器错误权重
  const scoreBrowserError = useCallback((entry: BrowserConsoleEntry): number => {
    let score = 0
    const msg = entry.message || ''
    if (entry.level === 'error') score += 50
    if (entry.level === 'network') score += 40
    if (msg.startsWith('[页面加载失败]')) score += 60
    if (/Uncaught|Unhandled/i.test(msg)) score += 45
    if (/TypeError|ReferenceError|SyntaxError|RangeError/i.test(msg)) score += 35
    if (/CORS|ERR_|Failed to fetch|NetworkError/i.test(msg)) score += 25
    return score
  }, [])

  // 记录浏览器错误候选
  const rememberBrowserErrorCandidate = useCallback((entry: BrowserConsoleEntry) => {
    const weight = scoreBrowserError(entry)
    const fingerprint = `${entry.appId}|${entry.level}|${entry.message}|${entry.source ?? ''}|${entry.line ?? ''}`
    const withScore: BrowserErrorCandidate = { ...entry, weight, fingerprint }

    const deduped = browserErrorCandidatesRef.current.filter((e) => e.fingerprint !== fingerprint)
    const ranked = [...deduped, withScore]
      .sort((a, b) => (b.weight - a.weight) || (b.timestamp - a.timestamp))
      .slice(0, 3)

    browserErrorCandidatesRef.current = ranked
  }, [scoreBrowserError])

  // 打开外部浏览器
  const openBrowser = useCallback((url: string) => {
    window.taco.browser.openExternal(url, currentBrowserAppId)
  }, [currentBrowserAppId])

  // 关闭外部浏览器
  const closeBrowser = useCallback((appId?: string) => {
    const id = appId || 'default'
    window.taco.browser.closeExternal(id)
    setBrowserWindows(prev => {
      const next = new Map(prev)
      next.delete(id)
      return next
    })
  }, [])

  // 监听外部浏览器窗口状态
  useEffect(() => {
    const unsubscribe = window.taco.browser.onExternalStatus((status) => {
      const appId = status.appId || 'default'

      if (status.type === 'console') {
        const level = status.consoleLevel || 'log'
        const message = status.consoleMessage || ''
        const pageUrl = browserWindowsRef.current.get(appId) || ''
        const fromDevEnv = isDevBrowserUrl(pageUrl) || isDevBrowserUrl(status.consoleSource)

        const entry: BrowserConsoleEntry = {
          id: ++consoleIdRef.current,
          appId,
          level,
          message,
          source: status.consoleSource,
          line: status.consoleLine,
          timestamp: Date.now(),
        }

        // 存储日志
        setBrowserConsoleLogs(prev => {
          const next = [...prev, entry]
          return next.length > 500 ? next.slice(-500) : next
        })

        // 致命错误仅记录候选
        const isFatal = level === 'error' && (
          message.startsWith('[页面加载失败]') ||
          message.includes('Uncaught') ||
          message.includes('TypeError') ||
          message.includes('ReferenceError') ||
          message.includes('SyntaxError') ||
          message.includes('CORS') ||
          message.includes('ERR_')
        )
        if (isFatal && fromDevEnv) {
          rememberBrowserErrorCandidate(entry)
        }
        return
      }

      setBrowserWindows(prev => {
        const next = new Map(prev)
        if (status.type === 'opened' && status.url) {
          next.set(appId, status.url)
        } else if (status.type === 'closed') {
          next.delete(appId)
        } else if (status.type === 'navigated' && status.url) {
          next.set(appId, status.url)
        }
        return next
      })
    })
    return unsubscribe
  }, [rememberBrowserErrorCandidate])

  useEffect(() => {
    browserWindowsRef.current = browserWindows
  }, [browserWindows])

  return {
    browserWindows,
    browserConsoleLogs,
    openBrowser,
    closeBrowser,
    browserWindowsRef,
    browserErrorCandidatesRef,
  }
}
