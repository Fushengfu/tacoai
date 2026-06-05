import { app, Tray, Menu, nativeImage } from 'electron'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { trimTransparentPadding } from './icon'
import { mainWindow, setForceQuit, showMainWindow } from './window-manager'

export let tray: Tray | null = null

function normalizeTrayIcon(image: Electron.NativeImage): Electron.NativeImage {
  if (image.isEmpty()) return image
  const trimmed = trimTransparentPadding(image)

  if (process.platform === 'darwin') {
    return trimmed.resize({ width: 20, height: 20, quality: 'best' })
  }

  if (process.platform === 'win32') {
    return trimmed.resize({ width: 20, height: 20, quality: 'best' })
  }

  return trimmed
}

function resolveTrayIcon() {
  const candidates = [
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

  if (process.platform === 'win32') {
    const exeIcon = nativeImage.createFromPath(process.execPath)
    if (!exeIcon.isEmpty()) return normalizeTrayIcon(exeIcon)
  }

  return normalizeTrayIcon(nativeImage.createEmpty())
}

export function createTray() {
  if (tray) return
  tray = new Tray(resolveTrayIcon())
  tray.setToolTip('Taco AI')
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

export function updateTrayMenu() {
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
        setForceQuit(true)
        app.quit()
      },
    },
  ])
  tray.setContextMenu(menu)
}
