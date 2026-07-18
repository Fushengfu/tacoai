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
} from './browser-state'
import { executeExternalBrowserAction } from './browser-cdp'

// ── 子模块重导出（保持原有 import 路径兼容）──
export {
  setBrowserDebugMode,
  setBrowserHiddenMode,
} from './browser-state'
export {
  getBrowserConsoleSnapshot,
} from './browser-console'
export {
  openExternalBrowser,
  closeExternalBrowser,
  navigateExternalBrowser,
  focusExternalBrowser,
  listBrowserInstances,
  listBrowserAppIds,
} from './browser-window'

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
