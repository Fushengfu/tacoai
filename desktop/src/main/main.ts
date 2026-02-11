import 'dotenv/config'
import { fixPath } from './fix-path'

// 尽早修复 PATH，确保后续所有子进程都能找到 npm、node、git 等命令
fixPath()

import { app, BrowserWindow, Menu, MenuItem } from 'electron'
import path from 'node:path'
import { registerIpcHandlers } from './ipc'
import { logInfo, getLogDir } from './logger'
import { IpcChannel } from '../shared/ipc'
import { shutdownAllMcp } from './mcp'
import { shutdownMobileBridge } from './mobile-bridge'

// esbuild 构建后 __dirname 由 CJS 运行时提供，指向 dist-main/
// 源码开发时 tsx 也支持 __dirname

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL)

/** 判断是否为外部 URL（http/https） */
function isExternalUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
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
}

app.whenReady().then(() => {
  logInfo('app', `Taco started (${isDev ? 'dev' : 'prod'})`, {
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    node: process.versions.node,
    logDir: getLogDir(),
  })

  createWindow()
  registerIpcHandlers()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  shutdownAllMcp()
  void shutdownMobileBridge()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
