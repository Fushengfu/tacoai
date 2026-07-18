/**
 * 浏览器窗口生命周期管理
 *
 * - 基于 appId 的多窗口管理（每个 appId 独立会话/指纹）
 * - 打开/关闭/导航/聚焦/列表（CRUD）
 * - 页面事件监听（控制台/导航/标题/加载失败/新窗口拦截）
 */

import { BrowserWindow } from 'electron'
import {
  browserInstances,
  forceCloseAppIds,
  forceCloseAllBrowsers,
  browserDebugMode,
  browserHiddenMode,
  DEFAULT_APP_ID,
  BrowserInstance,
  sendExternalStatus,
  syncMainWindowPriority,
  isSameOriginUrl,
  ensureCdpAttached,
} from './browser-state'
import { rememberBrowserConsole } from './browser-console'
import { loadOrCreateProfile } from './browser-profile'

/** 打开浏览器窗口（指定 appId），如已存在则复用。windowLabel 仅作备注，不影响 appId 定位 */
export function openExternalBrowser(
  url: string,
  appId: string = DEFAULT_APP_ID,
  windowLabel?: string
) {
  console.log(
    `[Browser] openExternalBrowser called: url="${url}", appId="${appId}", windowLabel="${windowLabel || ''}"`
  )

  const existing = browserInstances.get(appId)
  if (existing && !existing.win.isDestroyed()) {
    // 更新 windowLabel 备注
    if (windowLabel) existing.windowLabel = windowLabel
    const currentUrl = existing.win.webContents.getURL()
    console.log(`[Browser] 已有窗口, currentUrl="${currentUrl}"`)
    if (isSameOriginUrl(currentUrl, url)) {
      if (!browserHiddenMode) {
        if (existing.win.isMinimized()) existing.win.restore()
        existing.win.show()
        existing.win.focus()
      }
      syncMainWindowPriority()
      return
    }
    console.log(`[Browser] 已有窗口导航到: ${url}`)
    existing.win.loadURL(url)
    if (!browserHiddenMode) existing.win.focus()
    syncMainWindowPriority()
    return
  }

  const profile = loadOrCreateProfile(appId)

  const win = new BrowserWindow({
    width: 1920,
    height: 1080,
    show: !browserHiddenMode,
    paintWhenInitiallyHidden: true,
    autoHideMenuBar: true,
    title: `浏览器 [${appId}]`,
    backgroundColor: '#1e1e1e',
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      partition: `persist:browser-${appId}`,
    },
  })
  // 外部浏览器窗口不显示系统菜单（Windows/Linux）
  win.setMenuBarVisibility(false)
  win.removeMenu()

  const instance: BrowserInstance = {
    win,
    appId,
    seed: profile.seed,
    ua: profile.ua,
    windowLabel: windowLabel || undefined,
  }
  browserInstances.set(appId, instance)
  syncMainWindowPriority()

  const wc = win.webContents

  // 设置 UA
  wc.setUserAgent(profile.ua)

  // SSL 证书错误直接放行
  wc.on('certificate-error', (event, certUrl, error, _cert, callback) => {
    console.log(`[Browser] certificate-error: ${error} @ ${certUrl}`)
    event.preventDefault()
    callback(true)
  })

  // 页面加载失败 → 通知渲染进程 + 显示友好错误页
  wc.on(
    'did-fail-load',
    (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      console.error(
        `[Browser] did-fail-load: code=${errorCode} desc="${errorDescription}" url="${validatedURL}"`
      )
      rememberBrowserConsole({
        appId,
        level: 'error',
        message: `[页面加载失败] ${validatedURL} — ${errorCode} ${errorDescription}`,
        source: validatedURL,
        pageUrl: validatedURL,
      })
      // 把错误信息发给渲染进程，自动反馈给 AI
      sendExternalStatus({
        type: 'console',
        appId,
        consoleLevel: 'error',
        consoleMessage: `[页面加载失败] ${validatedURL} — ${errorCode} ${errorDescription}`,
      })
      if (!isMainFrame || !validatedURL) return
      // 在窗口中显示友好的错误提示页面
      const errorHtml = `data:text/html;charset=utf-8,${encodeURIComponent(`
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>页面加载失败</title>
<style>
  body { background: #1e1e1e; color: #ccc; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  .container { text-align: center; max-width: 500px; }
  h1 { color: #e06c75; font-size: 24px; margin-bottom: 16px; }
  .url { color: #61afef; word-break: break-all; margin: 16px 0; font-size: 14px; background: #282c34; padding: 12px; border-radius: 6px; }
  .error { color: #e5c07b; font-size: 13px; margin: 8px 0; }
  .hint { color: #888; font-size: 13px; margin-top: 20px; line-height: 1.6; }
  button { margin-top: 20px; padding: 8px 24px; background: #61afef; color: #1e1e1e; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; }
  button:hover { background: #528bce; }
</style>
</head>
<body>
<div class="container">
  <h1>⚠ 页面加载失败</h1>
  <div class="url">${validatedURL}</div>
  <div class="error">错误码: ${errorCode} — ${errorDescription}</div>
  <div class="hint">
    ${
      errorCode === -102
        ? '连接被拒绝 — 目标服务可能未启动，请确认服务已运行在该地址。'
        : errorCode === -105
          ? '域名无法解析 — 请检查网址是否正确。'
          : errorCode === -106
            ? '无网络连接 — 请检查网络设置。'
            : '请检查网址是否正确或稍后重试。'
    }
  </div>
  <button onclick="location.href='${validatedURL}'">重试</button>
</div>
</body>
</html>`)}`
      win.loadURL(errorHtml)
    }
  )

  // CDP 级别的 stealth 注入由 ensureCdpAttached 统一管理（首次交互操作时触发），
  // 此处不再通过 dom-ready + executeJavaScript 重复注入，避免双重注入竞态。
  wc.on('dom-ready', () => {
    // 页面加载完成的轻量标记，不再注入 stealth
  })

  // 拦截新窗口请求（target="_blank"、window.open 等）→ 在当前窗口导航
  wc.setWindowOpenHandler(({ url: newUrl }) => {
    console.log(`[Browser] setWindowOpenHandler: newUrl="${newUrl}"`)
    if (newUrl && newUrl !== 'about:blank') {
      setTimeout(() => {
        if (!win.isDestroyed()) {
          console.log(`[Browser] 重定向到: ${newUrl}`)
          win.loadURL(newUrl)
        }
      }, 50)
    }
    return { action: 'deny' }
  })

  console.log(`[Browser] 开始加载: ${url}`)
  win.loadURL(url)

  // 如果调试模式开启，自动打开 DevTools
  if (browserDebugMode) {
    wc.openDevTools({ mode: 'bottom' })
  }

  // 监听浏览器控制台输出，转发到渲染进程
  wc.on('console-message', (event) => {
    const levelMap: Record<string, 'log' | 'warn' | 'error' | 'info'> = {
      info: 'info',
      warning: 'warn',
      error: 'error',
      debug: 'log',
    }
    const consoleLevel = levelMap[event.level as string] ?? 'log'
    rememberBrowserConsole({
      appId,
      level: consoleLevel,
      message: event.message,
      source: event.sourceId,
      line: event.lineNumber,
      pageUrl: wc.getURL(),
    })
    sendExternalStatus({
      type: 'console',
      appId,
      consoleLevel,
      consoleMessage: event.message,
      consoleSource: event.sourceId,
      consoleLine: event.lineNumber,
    })
  })

  // 追踪导航
  wc.on('did-navigate', (_e, navUrl) => {
    sendExternalStatus({ type: 'navigated', url: navUrl, appId })
  })
  wc.on('did-navigate-in-page', (_e, navUrl) => {
    sendExternalStatus({ type: 'navigated', url: navUrl, appId })
  })
  wc.on('page-title-updated', (_e, title) => {
    sendExternalStatus({ type: 'title-changed', title, appId })
  })

  // 窗口关闭 — 用户点击系统关闭按钮时仅隐藏窗口，保持会话和窗口实例不丢失
  win.on('close', (event) => {
    const allowClose = forceCloseAllBrowsers || forceCloseAppIds.has(appId)
    if (allowClose) return
    event.preventDefault()
    if (!win.isDestroyed()) win.hide()
  })

  // 窗口关闭 — 分离 CDP debugger，清理实例
  win.on('closed', () => {
    try {
      if (wc.debugger?.isAttached()) wc.debugger.detach()
    } catch {
      /* ignore */
    }
    forceCloseAppIds.delete(appId)
    // 仅在 closeExternalBrowser 还未清理时才清理（避免重复发送 closed 通知）
    const current = browserInstances.get(appId)
    if (current && current.win === win) {
      browserInstances.delete(appId)
      sendExternalStatus({ type: 'closed', appId })
    }
    syncMainWindowPriority()
  })

  sendExternalStatus({ type: 'opened', url, appId })
}

/** 关闭指定 appId 的浏览器窗口 */
export function closeExternalBrowser(appId: string = DEFAULT_APP_ID) {
  const inst = browserInstances.get(appId)
  if (inst && !inst.win.isDestroyed()) {
    try {
      if (inst.win.webContents.debugger.isAttached()) {
        inst.win.webContents.debugger.detach()
      }
    } catch {
      /* ignore */
    }
    forceCloseAppIds.add(appId)
    inst.win.close()
  }
  // 无论窗口状态如何，清理实例并通知渲染进程
  browserInstances.delete(appId)
  syncMainWindowPriority()
  // 始终通知渲染进程清除标签（不再依赖 closed 事件可能送达）
  sendExternalStatus({ type: 'closed', appId })
}

/** 在指定 appId 的浏览器窗口中导航 */
export function navigateExternalBrowser(
  url: string,
  appId: string = DEFAULT_APP_ID
) {
  const inst = browserInstances.get(appId)
  if (inst && !inst.win.isDestroyed()) {
    inst.win.loadURL(url)
    if (!browserHiddenMode) inst.win.focus()
  }
}

/** 聚焦/显示指定 appId 的浏览器窗口（不重新加载） */
export function focusExternalBrowser(appId: string = DEFAULT_APP_ID) {
  const inst = browserInstances.get(appId)
  if (inst && !inst.win.isDestroyed()) {
    if (inst.win.isMinimized()) inst.win.restore()
    inst.win.show()
    inst.win.focus()
  }
}

/** 列出所有活跃的浏览器窗口详细信息（含备注标签） */
export function listBrowserInstances(): Array<{
  appId: string
  windowLabel?: string
  url: string
  title: string
  width: number
  height: number
}> {
  const infos: Array<{
    appId: string
    windowLabel?: string
    url: string
    title: string
    width: number
    height: number
  }> = []
  for (const [appId, inst] of browserInstances) {
    if (!inst.win.isDestroyed()) {
      const bounds = inst.win.getBounds()
      infos.push({
        appId,
        windowLabel: inst.windowLabel,
        url: inst.win.webContents.getURL(),
        title: inst.win.getTitle(),
        width: bounds.width,
        height: bounds.height,
      })
    }
  }
  return infos
}

/** 列出所有活跃的浏览器窗口 appId */
export function listBrowserAppIds(): string[] {
  const ids: string[] = []
  for (const [appId, inst] of browserInstances) {
    if (!inst.win.isDestroyed()) ids.push(appId)
  }
  return ids
}
