/**
 * 桥接初始化 hook
 *
 * 职责：
 * - 从 localStorage 读取浏览器设置并应用到主进程
 * - 从 localStorage 读取自动审批类别并应用到主进程
 * - 仅在组件挂载时执行一次
 */

import { useEffect } from 'react'

export function useBridgeInit() {
  useEffect(() => {
    // 浏览器调试模式
    const debugSaved = localStorage.getItem('taco.browserDebugMode') === 'true'
    if (debugSaved) window.taco.browser.setDebugMode(true)

    // 浏览器隐藏模式（默认开启）
    const hiddenSavedRaw = localStorage.getItem('taco.browserHiddenMode')
    const hiddenSaved = hiddenSavedRaw === null ? true : hiddenSavedRaw === 'true'
    window.taco.browser.setHiddenMode(hiddenSaved)
    if (hiddenSavedRaw === null) {
      localStorage.setItem('taco.browserHiddenMode', 'true')
    }

    // 自动审批类别
    try {
      const autoApprove = localStorage.getItem('taco.autoApproveCategories')
      if (autoApprove) {
        const categories = JSON.parse(autoApprove) as string[]
        if (categories.length > 0) window.taco.agent.setAutoApprove(categories)
      }
    } catch {
      // ignore
    }
  }, [])
}
