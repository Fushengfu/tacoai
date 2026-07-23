/**
 * BrowserView 面板管理器
 *
 * 用 Electron 原生 BrowserView 替代 webview 标签。
 * BrowserView 完全独立于 DOM 布局，不参与 CSS reflow → 拖拽零卡顿。
 */

import { BrowserView, BrowserWindow } from 'electron'
import { IpcChannel } from '../../shared/ipc'
import { logInfo, logError } from './logger'

export interface BrowserViewBounds {
  x: number
  y: number
  width: number
  height: number
}

interface BrowserViewState {
  view: BrowserView
  currentUrl: string
}

let state: BrowserViewState | null = null

/** 获取主窗口引用 */
function getMainWindow(): BrowserWindow | null {
  // 延迟 require 以避免循环依赖
  const { mainWindow } = require('../window/window-manager')
  return mainWindow
}

/** 创建或重建 BrowserView */
export function createBrowserView(win: BrowserWindow, url: string, bounds: BrowserViewBounds): void {
  destroyBrowserView()

  const view = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.addBrowserView(view)
  view.setBounds(bounds)
  view.setAutoResize({ width: false, height: false })

  state = { view, currentUrl: url }

  const wc = view.webContents

  // 拦截新窗口：转系统浏览器
  wc.setWindowOpenHandler(({ url: newUrl }) => {
    if (/^https?:\/\//i.test(newUrl)) {
      require('electron').shell.openExternal(newUrl)
    }
    return { action: 'deny' }
  })

  // 导航事件 → 通知渲染进程
  const notifyNavigate = () => {
    const w = getMainWindow()
    if (!w || w.isDestroyed()) return
    try {
      w.webContents.send(IpcChannel.BROWSER_VIEW_NAVIGATE, {
        url: wc.getURL(),
        canGoBack: wc.canGoBack(),
        canGoForward: wc.canGoForward(),
        loading: wc.isLoading(),
      })
    } catch {
      // ignore
    }
  }

  wc.on('did-navigate', notifyNavigate)
  wc.on('did-navigate-in-page', notifyNavigate)
  wc.on('did-start-loading', notifyNavigate)
  wc.on('did-stop-loading', notifyNavigate)

  // 页面标题
  wc.on('page-title-updated', (_e, title) => {
    const w = getMainWindow()
    if (!w || w.isDestroyed()) return
    try {
      w.webContents.send(IpcChannel.BROWSER_VIEW_NAVIGATE, {
        url: wc.getURL(),
        canGoBack: wc.canGoBack(),
        canGoForward: wc.canGoForward(),
        loading: wc.isLoading(),
        title,
      })
    } catch {
      // ignore
    }
  })

  void wc.loadURL(url)

  logInfo('browser-view-panel', `BrowserView 已创建: ${url}`, {
    bounds: `${bounds.width}x${bounds.height} @ (${bounds.x},${bounds.y})`,
  })
}

/** 销毁 BrowserView */
export function destroyBrowserView(): void {
  if (!state) return
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    try {
      win.removeBrowserView(state.view)
    } catch (err) {
      logError('browser-view-panel', '移除 BrowserView 失败', err)
    }
  }
  state = null
  logInfo('browser-view-panel', 'BrowserView 已销毁')
}

/** 更新 BrowserView 位置/大小 */
export function setBrowserViewBounds(bounds: BrowserViewBounds): void {
  if (!state) return
  try {
    state.view.setBounds(bounds)
  } catch (err) {
    logError('browser-view-panel', 'setBounds 失败', err)
  }
}

/** 导航到新 URL */
export function browserViewLoadURL(url: string): void {
  if (!state) return
  state.currentUrl = url
  void state.view.webContents.loadURL(url)
}

/** 后退 */
export function browserViewGoBack(): void {
  if (!state || !state.view.webContents.canGoBack()) return
  state.view.webContents.goBack()
}

/** 前进 */
export function browserViewGoForward(): void {
  if (!state || !state.view.webContents.canGoForward()) return
  state.view.webContents.goForward()
}

/** 刷新 */
export function browserViewReload(): void {
  if (!state) return
  state.view.webContents.reload()
}

/** 停止加载 */
export function browserViewStop(): void {
  if (!state) return
  state.view.webContents.stop()
}

/** 获取当前是否已创建 */
export function hasBrowserView(): boolean {
  return state !== null
}
