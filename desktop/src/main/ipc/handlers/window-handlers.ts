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

const dragState = new Map<number, { offsetX: number; offsetY: number }>()

export function handleWindowDragStart(event: IpcMainEvent, pos: { screenX: number; screenY: number }) {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  const [winX, winY] = win.getPosition()
  dragState.set(win.id, {
    offsetX: pos.screenX - winX,
    offsetY: pos.screenY - winY,
  })
}

export function handleWindowDragging(event: IpcMainEvent, pos: { screenX: number; screenY: number }) {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  const state = dragState.get(win.id)
  if (!state) return
  win.setPosition(pos.screenX - state.offsetX, pos.screenY - state.offsetY)
}

export function handleWindowDragEnd(event: IpcMainEvent) {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
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
