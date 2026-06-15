import 'dotenv/config'
import { fixPath } from './infrastructure/fix-path'

// 尽早修复 PATH，确保后续所有子进程都能找到 npm、node、git 等命令
fixPath()

import { app, BrowserWindow, Menu, MenuItem } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { registerIpcHandlers } from './ipc'
import { logError, logInfo, getLogDir } from './infrastructure/logger'
import { IpcChannel } from '../shared/ipc'
import { shutdownAllMcp } from './infrastructure/mcp'
import { cleanupAllTerminals } from './infrastructure/terminal'
import { scheduleStartupUpdateCheck } from './infrastructure/app-updater'
import { startUsageReporter, stopUsageReporter } from './usage-reporter'
import {
  isExternalUrl,
  showMainWindow,
  recoverMainWindow,
  setWindowFactory,
  setMainWindow,
  setForceQuit,
  forceQuit,
  mainWindow,
  type MainWindowRestoreState,
} from './window/window-manager'
import { createTray, updateTrayMenu } from './window/tray'
import { getDb, MEMORY_DB_PATH } from './repositories/memory-db/schema'

/** 退出前保存等待状态 */
let quitSaveResolved = false
let quitSaveTimer: ReturnType<typeof setTimeout> | null = null

export function resolveQuitSave() {
  if (quitSaveResolved) return
  quitSaveResolved = true
  if (quitSaveTimer) {
    clearTimeout(quitSaveTimer)
    quitSaveTimer = null
  }
  // WAL checkpoint: 确保所有数据从 WAL 日志合并到主数据库文件
  try {
    const database = getDb()
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } catch (err) {
    logError('wal-checkpoint', 'WAL checkpoint 失败，数据可能未完全写入', { error: String(err) })
  }
  // fsync: 强制 OS 将文件缓冲区写入物理磁盘，防止 app.exit(0) 导致数据丢失
  try {
    const fd = fs.openSync(MEMORY_DB_PATH, 'r+')
    try {
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  } catch (err) {
    logError('fsync', '数据库文件 fsync 失败，数据可能未持久化到磁盘', { error: String(err) })
  }
  app.exit(0)
}

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL)

function createWindow(restoreState?: MainWindowRestoreState) {
  const bounds = restoreState?.bounds
  const win = new BrowserWindow({
    width: bounds?.width ?? 1280,
    height: bounds?.height ?? 820,
    ...(typeof bounds?.x === 'number' ? { x: bounds.x } : {}),
    ...(typeof bounds?.y === 'number' ? { y: bounds.y } : {}),
    minWidth: 1080,
    minHeight: 720,
    show: restoreState?.visible ?? true,
    backgroundColor: '#0b0c0e',
    ...(process.platform === 'win32'
      ? {
          frame: false,
        }
      : {
          titleBarStyle: 'hidden',
          trafficLightPosition: { x: 20, y: 18 },
        }),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      preload: path.join(__dirname, '../dist-preload/index.cjs'),
      additionalArguments: [`--taco-version=${app.getVersion()}`],
    },
  })

  console.log(`Taco version: ${app.getVersion()}`)

  if (restoreState?.maximized) {
    win.maximize()
  }

  /* ---- 拦截链接点击：通知渲染进程在内嵌浏览器中打开 ---- */
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) {
      win.webContents.send(IpcChannel.OPEN_URL, url)
    }
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    if (isDev && url.startsWith(process.env.VITE_DEV_SERVER_URL as string)) return
    if (isExternalUrl(url)) {
      event.preventDefault()
      win.webContents.send(IpcChannel.OPEN_URL, url)
    }
  })

  /* ---- 右键菜单：支持复制 / 全选 / 粘贴等 ---- */
  win.webContents.on('context-menu', (_event, params) => {
    const menu = new Menu()

    if (params.selectionText) {
      menu.append(new MenuItem({ label: '复制', role: 'copy' }))
    }

    menu.append(new MenuItem({ label: '全选', role: 'selectAll' }))

    if (params.isEditable) {
      menu.append(new MenuItem({ type: 'separator' }))
      menu.append(new MenuItem({ label: '粘贴', role: 'paste' }))
      menu.append(new MenuItem({ label: '剪切', role: 'cut' }))
      menu.append(new MenuItem({ label: '撤销', role: 'undo' }))
      menu.append(new MenuItem({ label: '重做', role: 'redo' }))
    }

    menu.popup()
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    recoverMainWindow(win, details, updateTrayMenu)
  })

  win.webContents.on('unresponsive', () => {
    logError('renderer-unresponsive', '主渲染进程无响应')
  })

  win.webContents.on('responsive', () => {
    logInfo('renderer-responsive', '主渲染进程已恢复响应')
  })

  if (isDev) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL as string)
    win.webContents.openDevTools({ mode: 'bottom' })
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  win.on('close', (event) => {
    if (forceQuit) return
    // 托盘模式：点击关闭按钮时隐藏到托盘，不直接退出
    event.preventDefault()
    win.hide()
  })
  win.on('show', () => updateTrayMenu())
  win.on('hide', () => updateTrayMenu())
  win.on('closed', () => {
    if (mainWindow === win) setMainWindow(null)
    updateTrayMenu()
  })

  return win
}

app.whenReady().then(async () => {
  logInfo('app', `Taco started (${isDev ? 'dev' : 'prod'})`, {
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    node: process.versions.node,
    logDir: getLogDir(),
  })

  setWindowFactory(createWindow)
  setMainWindow(createWindow())
  createTray()
  registerIpcHandlers()
  scheduleStartupUpdateCheck(mainWindow!)
  startUsageReporter()

  app.on('activate', () => {
    showMainWindow()
  })
})

app.on('before-quit', (event) => {
  if (quitSaveResolved) return
  // 阻止直接退出，等待 renderer 保存完成
  event.preventDefault()
  setForceQuit(true)
  // 清理所有终端进程
  cleanupAllTerminals()
  // 停止使用统计上报
  stopUsageReporter()
  // 通知 renderer 立即保存状态
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send(IpcChannel.APP_STATE_REQUEST_SAVE)
    } catch (_) {
      // renderer 已不可达，直接退出
      resolveQuitSave()
      return
    }
  } else {
    resolveQuitSave()
    return
  }
  // 超时保护：3 秒后强制退出
  quitSaveTimer = setTimeout(() => {
    resolveQuitSave()
  }, 3000)
})

app.on('window-all-closed', () => {
  // 托盘常驻：非显式退出时保持进程
  if (!forceQuit) return
  shutdownAllMcp()
  // 清理所有终端进程
  cleanupAllTerminals()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
