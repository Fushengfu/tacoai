/**
 * 剪切板 IPC Handler
 *
 * 将图片 dataURL / 文本写入系统剪切板。
 * 必须在主进程调用（渲染进程的 navigator.clipboard 在 file:// 协议下不可用）。
 */

import { clipboard, nativeImage } from 'electron'

export async function handleClipboardWriteImage(
  _event: Electron.IpcMainInvokeEvent,
  dataUrl: string,
): Promise<void> {
  const img = nativeImage.createFromDataURL(dataUrl)
  clipboard.writeImage(img)
}

export async function handleClipboardWriteText(
  _event: Electron.IpcMainInvokeEvent,
  text: string,
): Promise<void> {
  clipboard.writeText(text)
}
