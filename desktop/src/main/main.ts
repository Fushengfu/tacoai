import 'dotenv/config'
import { fixPath } from './system/fix-path'

// 尽早修复 PATH，确保后续所有子进程都能找到 npm、node、git 等命令
fixPath()

import { app, BrowserWindow, Menu, MenuItem, Tray, nativeImage } from 'electron'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { registerIpcHandlers } from './ipc'
import { logError, logInfo, getLogDir } from './system/logger'
import { IpcChannel } from '../shared/ipc'
import { shutdownAllMcp } from './automation/mcp'
import { ensurePromptConfigInitialized } from './project/prompt-config'
import { scheduleStartupUpdateCheck } from './system/app-updater'

// esbuild 构建后 __dirname 由 CJS 运行时提供，指向 dist-main/
// 源码开发时 tsx 也支持 __dirname

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL)
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let forceQuit = false
const rendererRecoveryTimestamps: number[] = []
const RENDERER_RECOVERY_WINDOW_MS = 30_000
const MAX_RENDERER_RECOVERIES_PER_WINDOW = 3

type MainWindowRestoreState = {
  bounds?: Electron.Rectangle
  maximized?: boolean
  visible?: boolean
}

/** 判断是否为外部 URL（http/https） */
function isExternalUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

function normalizeTrayIcon(image: Electron.NativeImage): Electron.NativeImage {
  if (image.isEmpty()) return image
  const trimmed = trimTransparentPadding(image)

  if (process.platform === 'darwin') {
    // macOS: 使用真实应用图标（非 template），避免显示白点
    return trimmed.resize({ width: 20, height: 20, quality: 'best' })
  }

  if (process.platform === 'win32') {
    // Windows: 适当放大，避免托盘里过小
    return trimmed.resize({ width: 20, height: 20, quality: 'best' })
  }

  return trimmed
}

function resolveTrayIcon() {
  const candidates = [
    // macOS 优先 icns，Windows 优先 ico，减少格式兼容问题
    ...(process.platform === 'darwin' ? [
      path.join(process.cwd(), 'desktop', 'build', 'icon.icns'),
      path.join(process.cwd(), 'build', 'icon.icns'),
      path.join(__dirname, '../../build/icon.icns'),
      path.join(app.getAppPath(), 'build', 'icon.icns'),
      path.join(process.resourcesPath, 'build', 'icon.icns'),
      path.join(process.resourcesPath, 'icon.icns'),
    ] : []),
    ...(process.platform === 'win32' ? [
      path.join(process.cwd(), 'desktop', 'build', 'icon.ico'),
      path.join(process.cwd(), 'build', 'icon.ico'),
      path.join(__dirname, '../../build/icon.ico'),
      path.join(app.getAppPath(), 'build', 'icon.ico'),
      path.join(process.resourcesPath, 'build', 'icon.ico'),
      path.join(process.resourcesPath, 'icon.ico'),
    ] : []),
    path.join(process.cwd(), 'desktop', 'build', 'icon.png'),
    path.join(process.cwd(), 'desktop', 'build', 'icon.ico'),
    path.join(process.cwd(), 'desktop', 'build', 'icon.icns'),
    path.join(process.cwd(), 'build', 'icon.png'),
    path.join(process.cwd(), 'build', 'icon.ico'),
    path.join(process.cwd(), 'build', 'icon.icns'),
    path.join(__dirname, '../../build/icon.png'),
    path.join(__dirname, '../../build/icon.ico'),
    path.join(__dirname, '../../build/icon.icns'),
    path.join(app.getAppPath(), 'build', 'icon.png'),
    path.join(app.getAppPath(), 'build', 'icon.ico'),
    path.join(app.getAppPath(), 'build', 'icon.icns'),
    path.join(process.resourcesPath, 'build', 'icon.png'),
    path.join(process.resourcesPath, 'build', 'icon.ico'),
    path.join(process.resourcesPath, 'build', 'icon.icns'),
    path.join(process.resourcesPath, 'icon.png'),
    path.join(process.resourcesPath, 'icon.ico'),
    path.join(process.resourcesPath, 'icon.icns'),
  ]
  for (const iconPath of candidates) {
    if (!iconPath || !existsSync(iconPath)) continue
    const img = nativeImage.createFromPath(iconPath)
    if (!img.isEmpty()) return normalizeTrayIcon(img)
  }

  // Windows 打包场景兜底：直接使用 exe 自带图标，避免托盘空白
  if (process.platform === 'win32') {
    const exeIcon = nativeImage.createFromPath(process.execPath)
    if (!exeIcon.isEmpty()) return normalizeTrayIcon(exeIcon)
  }

  return normalizeTrayIcon(nativeImage.createEmpty())
}

function trimTransparentPadding(image: Electron.NativeImage): Electron.NativeImage {
  try {
    const { width, height } = image.getSize()
    if (width <= 0 || height <= 0) return image

    const bitmap = image.toBitmap()
    let minX = width
    let minY = height
    let maxX = -1
    let maxY = -1

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // toBitmap: BGRA 顺序，alpha 在第 4 个字节
        const alpha = bitmap[(y * width + x) * 4 + 3]
        if (alpha > 8) {
          if (x < minX) minX = x
          if (y < minY) minY = y
          if (x > maxX) maxX = x
          if (y > maxY) maxY = y
        }
      }
    }

    if (maxX < minX || maxY < minY) return image
    if (minX === 0 && minY === 0 && maxX === width - 1 && maxY === height - 1) return image
    return image.crop({ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 })
  } catch {
    return image
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow()
  }
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function updateTrayMenu() {
  if (!tray) return
  const isVisible = Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible())
  const menu = Menu.buildFromTemplate([
    {
      label: isVisible ? '隐藏窗口' : '显示窗口',
      click: () => {
        if (!mainWindow || mainWindow.isDestroyed()) {
          showMainWindow()
          updateTrayMenu()
          return
        }
        if (mainWindow.isVisible()) mainWindow.hide()
        else showMainWindow()
        updateTrayMenu()
      },
    },
    {
      label: '退出 Taco AI',
      click: () => {
        forceQuit = true
        app.quit()
      },
    },
  ])
  tray.setContextMenu(menu)
}

function createTray() {
  if (tray) return
  tray = new Tray(resolveTrayIcon())
  tray.setToolTip('Taco AI')
  // macOS 左键点击默认打开上下文菜单，不触发 click 事件
  // Windows/Linux 左键点击触发 click 事件，需要切换窗口并更新菜单标签
  tray.on('click', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      showMainWindow()
      updateTrayMenu()
      return
    }
    if (mainWindow.isVisible()) mainWindow.hide()
    else showMainWindow()
    updateTrayMenu()
  })
  updateTrayMenu()
}

function canRecoverRenderer(): boolean {
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

function recoverMainWindow(win: BrowserWindow, details: Electron.RenderProcessGoneDetails) {
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

  if (!allowRecovery || forceQuit) {
    return
  }

  if (mainWindow === win) {
    mainWindow = null
  }

  try {
    if (!win.isDestroyed()) win.destroy()
  } catch (err) {
    logError('renderer-process-gone', '销毁异常窗口失败', err)
  }

  setTimeout(() => {
    if (forceQuit) return
    const recovered = createWindow(restoreState)
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
    updateTrayMenu()
  }, 350)
}

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
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 20, y: 18 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      preload: path.join(__dirname, '../dist-preload/index.cjs'),
      additionalArguments: [`--taco-version=${app.getVersion()}`],
    }
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
    recoverMainWindow(win, details)
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
    if (mainWindow === win) mainWindow = null
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

  try {
    await ensurePromptConfigInitialized()
    logInfo('prompt-config', 'prompt-config.json initialized')
  } catch (err) {
    logInfo('prompt-config', 'prompt-config.json init failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  mainWindow = createWindow()
  createTray()
  registerIpcHandlers()
  scheduleStartupUpdateCheck(mainWindow)

  app.on('activate', () => {
    showMainWindow()
  })
})

app.on('before-quit', () => {
  forceQuit = true
})

app.on('window-all-closed', () => {
  // 托盘常驻：非显式退出时保持进程
  if (!forceQuit) return
  shutdownAllMcp()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
