import 'dotenv/config'
import { fixPath } from './fix-path'

// 尽早修复 PATH，确保后续所有子进程都能找到 npm、node、git 等命令
fixPath()

import { app, BrowserWindow, Menu, MenuItem, Tray, nativeImage } from 'electron'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { registerIpcHandlers } from './ipc'
import { logInfo, getLogDir } from './logger'
import { IpcChannel } from '../shared/ipc'
import { shutdownAllMcp } from './mcp'
import { shutdownMobileBridge } from './mobile-bridge'

// esbuild 构建后 __dirname 由 CJS 运行时提供，指向 dist-main/
// 源码开发时 tsx 也支持 __dirname

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL)
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let forceQuit = false

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

  if (process.platform === 'darwin') {
    // macOS 菜单栏图标需要小尺寸 + template image，否则会显得过大/不协调
    const resized = image.resize({ width: 24, height: 24, quality: 'best' })
    resized.setTemplateImage(true)
    return resized
  }

  if (process.platform === 'win32') {
    return image.resize({ width: 16, height: 16, quality: 'best' })
  }

  return image
}

function resolveTrayIcon() {
  const candidates = [
    path.join(process.cwd(), 'desktop', 'build', 'icon.png'),
    path.join(process.cwd(), 'desktop', 'build', 'icon.icns'),
    path.join(process.cwd(), 'build', 'icon.png'),
    path.join(process.cwd(), 'build', 'icon.icns'),
    path.join(__dirname, '../../build/icon.png'),
    path.join(__dirname, '../../build/icon.icns'),
    path.join(app.getAppPath(), 'build', 'icon.png'),
    path.join(app.getAppPath(), 'build', 'icon.icns'),
    path.join(process.resourcesPath, 'build', 'icon.png'),
    path.join(process.resourcesPath, 'build', 'icon.icns'),
    path.join(process.resourcesPath, 'icon.png'),
    path.join(process.resourcesPath, 'icon.icns'),
  ]
  for (const iconPath of candidates) {
    if (!iconPath || !existsSync(iconPath)) continue
    const img = nativeImage.createFromPath(iconPath)
    if (!img.isEmpty()) return normalizeTrayIcon(img)
  }
  return normalizeTrayIcon(nativeImage.createEmpty())
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
          return
        }
        if (mainWindow.isVisible()) mainWindow.hide()
        else showMainWindow()
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
  tray.on('click', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      showMainWindow()
      return
    }
    if (mainWindow.isVisible()) mainWindow.hide()
    else showMainWindow()
  })
  updateTrayMenu()
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: '#0b0c0e',
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 20, y: 18 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      preload: path.join(__dirname, '../dist-preload/index.cjs')
    }
  })

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

app.whenReady().then(() => {
  logInfo('app', `Taco started (${isDev ? 'dev' : 'prod'})`, {
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    node: process.versions.node,
    logDir: getLogDir(),
  })

  mainWindow = createWindow()
  createTray()
  registerIpcHandlers()

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
  void shutdownMobileBridge()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
