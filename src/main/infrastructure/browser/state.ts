/**
 * 浏览器共享状态 + 窗口工具函数
 *
 * - 所有模块级可变状态集中管理（单一事实源）
 * - 窗口工具函数（多模块共用）
 * - CDP debugger 附加与 Stealth 注入
 *
 * 设计原则：此模块被所有子模块导入，不导入任何兄弟子模块（避免循环）。
 * 仅导入叶子模块（console、stealth）和外部依赖。
 */

import { BrowserWindow, ipcMain } from 'electron'
import { mainWindow } from '../../window/window-manager'
import { IpcChannel } from '../../../shared/ipc-channels'
import type { ExternalBrowserStatus } from '../../../shared/ipc-types'
import { buildStealthJS, generateChromeUA, generateFingerprintSeed } from './stealth'

/* ------------------------------------------------------------------ */
/*  类型定义                                                           */
/* ------------------------------------------------------------------ */

/** 运行时浏览器窗口实例信息 */
export interface BrowserInstance {
  win: BrowserWindow
  appId: string
  seed: string
  ua: string
  /** AI 自定义备注标签（仅用于 list 时辨认用途，不影响 appId 定位） */
  windowLabel?: string
}

/* ------------------------------------------------------------------ */
/*  模块级状态                                                         */
/* ------------------------------------------------------------------ */

/** 浏览器调试模式（是否自动打开 DevTools） */
export let browserDebugMode = false
/** 浏览器隐藏窗口模式（默认开启） */
export let browserHiddenMode = true
/** appId → BrowserWindow 实例映射 */
export const browserInstances = new Map<string, BrowserInstance>()
/** 标记哪些 appId 正在被程序主动关闭（例如点击浏览器 tab 的关闭按钮） */
export const forceCloseAppIds = new Set<string>()
/** 进程退出时允许关闭所有外部浏览器窗口 */
export let forceCloseAllBrowsers = false

/** 设置 forceCloseAllBrowsers（供 browser.ts 的 before-quit 钩子使用） */
export function setForceCloseAllBrowsers(value: boolean) {
  forceCloseAllBrowsers = value
}

/** 默认 appId（当工具调用未指定 appId 时使用） */
export const DEFAULT_APP_ID = 'default'

/* ------------------------------------------------------------------ */
/*  CDP debugger 附加与 Stealth 注入（放在 state 中以打破 cdp ↔ window 循环依赖） */
/* ------------------------------------------------------------------ */

/** 确保 CDP debugger 已附加到浏览器窗口，并执行反检测 CDP 命令 */
export async function ensureCdpAttached(
  wc: Electron.WebContents,
  appId: string = DEFAULT_APP_ID
): Promise<void> {
  if (!wc.debugger.isAttached()) {
    try {
      wc.debugger.attach('1.3')
    } catch (err) {
      if (!(err instanceof Error && err.message.includes('Already attached'))) {
        throw err
      }
    }
    // CDP 级别的反自动化检测
    try {
      // 使用该 appId 实例的 seed/UA 构建脚本（保证指纹一致）
      const inst = getBrowserInstance(appId)
      const seed = inst?.seed || generateFingerprintSeed()
      const ua = inst?.ua || generateChromeUA()
      const script = buildStealthJS(seed, ua)

      // 必须 await 确保命令完成
      await wc.debugger.sendCommand('Page.enable')

      await wc.debugger
        .sendCommand('Page.addScriptToEvaluateOnNewDocument', {
          source: script,
        })
        .catch(() => {})

      await wc.debugger
        .sendCommand('Emulation.setUserAgentOverride', {
          userAgent: ua,
          platform:
            process.platform === 'darwin'
              ? 'MacIntel'
              : process.platform === 'win32'
                ? 'Win32'
                : 'Linux x86_64',
        })
        .catch(() => {})
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ */
/*  窗口工具函数                                                       */
/* ------------------------------------------------------------------ */

/** 向渲染进程发送外部浏览器状态 */
export function sendExternalStatus(status: ExternalBrowserStatus) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IpcChannel.EXTERNAL_BROWSER_STATUS, status)
  }
}

export function getMainWindow(): BrowserWindow | null {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow
  return null
}

export function setMainWindowPriority(enabled: boolean) {
  void enabled
  const mainWin = getMainWindow()
  if (!mainWin) return
  // 主窗口不再使用置顶策略，避免出现"始终在最前"的问题。
  if (mainWin.isAlwaysOnTop()) {
    mainWin.setAlwaysOnTop(false)
  }
}

export function syncMainWindowPriority() {
  setMainWindowPriority(browserInstances.size > 0 && !browserHiddenMode)
}

/** 通过 BrowserWindow 反查 appId */
export function getAppIdByWin(win: BrowserWindow): string {
  for (const [id, inst] of browserInstances) {
    if (inst.win === win) return id
  }
  return ''
}

/**
 * 比较两个 URL 是否指向同一个页面（忽略尾部斜杠、hash、多余空格）。
 * 同源同路径视为相同，不需要重新加载。
 */
export function isSameOriginUrl(a: string, b: string): boolean {
  try {
    const ua = new URL(a)
    const ub = new URL(b)
    // 比较 origin + pathname（去掉尾部斜杠）+ search
    const normalize = (u: URL) =>
      `${u.origin}${u.pathname.replace(/\/+$/, '')}${u.search}`
    return normalize(ua) === normalize(ub)
  } catch {
    return a === b
  }
}

/** 获取指定 appId 的浏览器窗口引用 */
export function getExternalBrowserWin(
  appId: string = DEFAULT_APP_ID
): BrowserWindow | null {
  const inst = browserInstances.get(appId)
  if (inst && !inst.win.isDestroyed()) return inst.win
  return null
}

/** 获取指定 appId 窗口实例的指纹信息 */
export function getBrowserInstance(
  appId: string = DEFAULT_APP_ID
): BrowserInstance | null {
  const inst = browserInstances.get(appId)
  if (inst && !inst.win.isDestroyed()) return inst
  return null
}

/* ------------------------------------------------------------------ */
/*  模式设置器                                                        */
/* ------------------------------------------------------------------ */

/** 设置浏览器调试模式 */
export function setBrowserDebugMode(enabled: boolean) {
  browserDebugMode = enabled
  // 对已打开的窗口立即生效
  for (const inst of browserInstances.values()) {
    if (!inst.win.isDestroyed()) {
      if (enabled) {
        inst.win.webContents.openDevTools({ mode: 'bottom' })
      } else {
        inst.win.webContents.closeDevTools()
      }
    }
  }
}

/** 设置浏览器隐藏窗口模式 */
export function setBrowserHiddenMode(enabled: boolean) {
  browserHiddenMode = enabled
  for (const inst of browserInstances.values()) {
    if (inst.win.isDestroyed()) continue
    if (enabled) {
      if (inst.win.isVisible()) inst.win.hide()
    } else {
      if (!inst.win.isVisible()) inst.win.showInactive()
    }
  }
  syncMainWindowPriority()
}
