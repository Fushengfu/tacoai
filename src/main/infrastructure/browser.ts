/**
 * 浏览器窗口管理 + CDP 自动化 + AppId 指纹持久化（主编排模块）
 *
 * - 基于 appId 的多窗口管理（每个 appId 独立会话/指纹）
 * - Chrome DevTools Protocol (CDP) 自动化操作
 * - 反自动化检测 (Stealth) & 指纹唯一化
 *
 * 此模块为统一对外入口，内部拆分为 6 个职责子模块。
 */

import { app, ipcMain } from 'electron'
import { IpcChannel } from '../../shared/ipc-channels'
import type {
  BrowserActionPayload,
  BrowserActionResult,
} from '../../shared/ipc-types'
import {
  DEFAULT_APP_ID,
  setForceCloseAllBrowsers,
  setBrowserDebugMode,
  setBrowserHiddenMode,
} from './browser/state'
import { executeExternalBrowserAction } from './browser/cdp'
import { getExternalBrowserWin } from './browser/state'
import type { NetworkRequestsResult, CookieEntry } from './browser/network'
import {
  getBrowserNetworkRequests as getNetReqs,
  getBrowserNetworkRequestBody as getNetReqBody,
  clearBrowserNetworkRequests as clearNetReqs,
  destroyBrowserNetworkMonitoring as destroyNetMon,
  getBrowserCookies as getCks,
  setBrowserCookie as setCk,
  clearBrowserCookies as clearCks,
} from './browser/network'

// ── 子模块重导出（保持原有 import 路径兼容）──
export {
  setBrowserDebugMode,
  setBrowserHiddenMode,
} from './browser/state'
export {
  getBrowserConsoleSnapshot,
} from './browser/console'
export {
  getBrowserNetworkRequests,
  getBrowserNetworkRequestBody,
  clearBrowserNetworkRequests,
  destroyBrowserNetworkMonitoring,
  getBrowserCookies,
  setBrowserCookie,
  clearBrowserCookies,
} from './browser/network'
export {
  openExternalBrowser,
  closeExternalBrowser,
  navigateExternalBrowser,
  focusExternalBrowser,
  listBrowserInstances,
  listBrowserAppIds,
} from './browser/window'

/* ------------------------------------------------------------------ */
/*  IPC 监听                                                          */
/* ------------------------------------------------------------------ */

ipcMain.on(IpcChannel.BROWSER_DEBUG_MODE, (_e, enabled: boolean) => {
  setBrowserDebugMode(enabled)
})
ipcMain.on(IpcChannel.BROWSER_HIDDEN_MODE, (_e, enabled: boolean) => {
  setBrowserHiddenMode(enabled)
})

/* ------------------------------------------------------------------ */
/*  应用生命周期                                                       */
/* ------------------------------------------------------------------ */

app.on('before-quit', () => {
  setForceCloseAllBrowsers(true)
})

/* ------------------------------------------------------------------ */
/*  对外 API                                                           */
/* ------------------------------------------------------------------ */

/**
 * 执行浏览器使用操作。
 * 统一使用外部 BrowserWindow + CDP 实现。
 * @param payload 操作 payload
 * @param appId   浏览器实例标识（不指定则使用 'default'）
 */
export async function executeBrowserAction(
  payload: BrowserActionPayload,
  appId?: string
): Promise<BrowserActionResult> {
  return executeExternalBrowserAction(payload, appId || DEFAULT_APP_ID)
}

/* ------------------------------------------------------------------ */
/*  网络请求 & Cookie 包装（appId → webContents 查找）                  */
/* ------------------------------------------------------------------ */

function resolveBrowserWc(appId: string): Electron.WebContents | null {
  const win = getExternalBrowserWin(appId)
  return win && !win.isDestroyed() ? win.webContents : null
}

export async function getNetworkRequests(
  appId: string = 'default',
  limit?: number,
): Promise<NetworkRequestsResult> {
  const wc = resolveBrowserWc(appId)
  if (!wc) {
    return {
      appId,
      totalStored: 0,
      returned: 0,
      requests: [],
      monitoringActive: false,
      hint: `浏览器 [${appId}] 未打开，请先 navigate 到目标页面`,
    }
  }
  return getNetReqs(wc, appId, limit)
}

export async function getNetworkRequestBody(
  appId: string,
  requestId: string,
): Promise<{ body: string; truncated: boolean; error?: string }> {
  const wc = resolveBrowserWc(appId)
  if (!wc) return { body: '', truncated: false, error: `浏览器 [${appId}] 未打开` }
  return getNetReqBody(wc, appId, requestId)
}

export function clearNetworkRequests(appId: string = 'default'): void {
  clearNetReqs(appId)
}

export function destroyNetworkMonitoring(appId: string = 'default'): void {
  destroyNetMon(appId)
}

export async function getCookies(
  appId: string,
  urls?: string[],
): Promise<{ cookies: CookieEntry[] }> {
  const wc = resolveBrowserWc(appId)
  if (!wc) return { cookies: [] }
  return getCks(wc, appId, urls)
}

export async function setCookie(
  appId: string,
  cookie: { name: string; value: string; url?: string; domain?: string; path?: string; secure?: boolean; httpOnly?: boolean; sameSite?: 'Strict' | 'Lax' | 'None'; expires?: number },
): Promise<{ success: boolean }> {
  const wc = resolveBrowserWc(appId)
  if (!wc) return { success: false }
  return setCk(wc, appId, cookie)
}

export async function clearCookies(
  appId: string,
): Promise<{ success: boolean }> {
  const wc = resolveBrowserWc(appId)
  if (!wc) return { success: false }
  return clearCks(wc, appId)
}
