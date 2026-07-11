/**
 * Window IPC Handlers
 *
 * 包含窗口拖拽、最小化、最大化、关闭等 IPC handler。
 */

import { BrowserWindow } from 'electron'
import type { IpcMainEvent } from 'electron'

/* ------------------------------------------------------------------ */
/*  Window drag                                                        */
/* ------------------------------------------------------------------ */

interface DragEntry {
  offsetX: number
  offsetY: number
  /** 拖动开始时窗口宽度，Windows 上用于 setBounds 固定尺寸 */
  width: number
  /** 拖动开始时窗口高度 */
  height: number
  /** 拖动前窗口是否可调整大小，拖动结束后恢复 */
  wasResizable: boolean
}

const dragState = new Map<number, DragEntry>()

export function handleWindowDragStart(event: IpcMainEvent, pos: { screenX: number; screenY: number }) {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  const [winX, winY] = win.getPosition()
  const [winW, winH] = win.getSize()
  const wasResizable = win.isResizable()
  dragState.set(win.id, {
    offsetX: pos.screenX - winX,
    offsetY: pos.screenY - winY,
    width: winW,
    height: winH,
    wasResizable,
  })
  // Windows: 拖动时禁止窗口大小调整，避免 DWM 阴影补偿导致位置漂移
  if (process.platform === 'win32') {
    win.setResizable(false)
  }
}

export function handleWindowDragging(event: IpcMainEvent, pos: { screenX: number; screenY: number }) {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  const state = dragState.get(win.id)
  if (!state) return
  const newX = pos.screenX - state.offsetX
  const newY = pos.screenY - state.offsetY
  if (process.platform === 'win32') {
    // Windows: setBounds 显式固定宽高，避免 DWM 阴影补偿导致位置逐帧漂移（窗口"逐渐变大"）
    win.setBounds({ x: newX, y: newY, width: state.width, height: state.height })
  } else {
    win.setPosition(newX, newY)
  }
}

export function handleWindowDragEnd(event: IpcMainEvent) {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  const state = dragState.get(win.id)
  if (state && process.platform === 'win32') {
    // 拖动结束，恢复窗口可调整大小
    if (state.wasResizable) {
      win.setResizable(true)
    }
  }
  dragState.delete(win.id)
}

export function handleWindowToggleMaximize(event: IpcMainEvent) {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  if (win.isMaximized()) win.unmaximize()
  else win.maximize()
}

export function handleWindowMinimize(event: IpcMainEvent) {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  win.minimize()
}

export function handleWindowClose(event: IpcMainEvent) {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  win.close()
}
