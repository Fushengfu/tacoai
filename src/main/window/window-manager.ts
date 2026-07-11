import { BrowserWindow } from 'electron'
import { logError, logInfo } from '../infrastructure/logger'

/** 主窗口引用 */
export let mainWindow: BrowserWindow | null = null

/** 强制退出标志（托盘模式下区分隐藏窗口和真正退出） */
export let forceQuit = false

/** 设置主窗口引用 */
export function setMainWindow(w: BrowserWindow | null) { mainWindow = w }

/** 设置强制退出标志 */
export function setForceQuit(v: boolean) { forceQuit = v }

const rendererRecoveryTimestamps: number[] = []
const RENDERER_RECOVERY_WINDOW_MS = 30_000
const MAX_RENDERER_RECOVERIES_PER_WINDOW = 3

export type MainWindowRestoreState = {
  bounds?: Electron.Rectangle
  maximized?: boolean
  visible?: boolean
}

/** 窗口工厂（由 main.ts 注入，供 showMainWindow/recoverMainWindow 使用） */
let windowFactory: ((restoreState?: MainWindowRestoreState) => BrowserWindow) | null = null
export function setWindowFactory(fn: (restoreState?: MainWindowRestoreState) => BrowserWindow) {
  windowFactory = fn
}

/** 判断是否为外部 URL（http/https） */
export function isExternalUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

export function canRecoverRenderer(): boolean {
  const now = Date.now()
  while (rendererRecoveryTimestamps.length > 0 && (now - rendererRecoveryTimestamps[0]) > RENDERER_RECOVERY_WINDOW_MS) {
    rendererRecoveryTimestamps.shift()
  }
  if (rendererRecoveryTimestamps.length >= MAX_RENDERER_RECOVERIES_PER_WINDOW) {
    return false
  }
  rendererRecoveryTimestamps.push(now)
  return true
}

/** 显示或创建主窗口 */
export function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (!windowFactory) {
      logError('window-manager', 'windowFactory not set, cannot create window')
      return
    }
    mainWindow = windowFactory()
  }
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/** 渲染进程崩溃恢复 */
export function recoverMainWindow(
  win: BrowserWindow,
  details: Electron.RenderProcessGoneDetails,
  updateTrayMenuFn: () => void,
) {
  const restoreState: MainWindowRestoreState = {
    bounds: win.isDestroyed() ? undefined : win.getBounds(),
    maximized: !win.isDestroyed() && win.isMaximized(),
    visible: !win.isDestroyed() && win.isVisible(),
  }

  const allowRecovery = canRecoverRenderer()
  logError('renderer-process-gone', '主渲染进程退出', {
    reason: details.reason,
    exitCode: details.exitCode,
    allowRecovery,
    restoreState,
  })

  if (!allowRecovery || forceQuit) return

  if (mainWindow === win) mainWindow = null

  try {
    if (!win.isDestroyed()) win.destroy()
  } catch (err) {
    logError('renderer-process-gone', '销毁异常窗口失败', err)
  }

  setTimeout(() => {
    if (forceQuit || !windowFactory) return
    const recovered = windowFactory(restoreState)
    mainWindow = recovered
    if (restoreState.visible === false) {
      recovered.hide()
    } else {
      recovered.show()
      recovered.focus()
    }
    logInfo('renderer-process-gone', '主窗口已自动恢复', {
      reason: details.reason,
      exitCode: details.exitCode,
    })
    updateTrayMenuFn()
  }, 350)
}
