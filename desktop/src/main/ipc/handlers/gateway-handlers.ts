/**
 * Gateway IPC Handlers
 *
 * 包含 AI 网关相关 IPC handler。
 */

import { net, BrowserWindow } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { IpcChannel } from '../../../shared/ipc'
import { getBridgeManager } from '../../bridge/bridge-manager'

/** 检测是否为 token 失效错误 */
function isTokenExpiredError(errorMsg: string): boolean {
  const lower = errorMsg.toLowerCase()
  return lower.includes('invalid token') || lower.includes('unauthorized') || lower.includes('token expired')
}

/** 通知所有渲染进程 token 已失效 */
function notifyTokenExpiredToRenderers(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IpcChannel.BRIDGE_STATUS_CHANGED, {
        status: 'disconnected',
        clientCount: 0,
        tokenExpired: true,
      })
    }
  }
}

export async function handleGatewayGetModels(_event: IpcMainInvokeEvent): Promise<unknown> {
  const mgr = getBridgeManager()
  const token = mgr.getToken()

  if (!token) {
    throw new Error('请先登录后再获取模型列表')
  }

  return new Promise((resolve, reject) => {
    const request = net.request({
      method: 'GET',
      url: 'https://agent.bjctykj.com/api/member/models',
    })
    request.setHeader('Authorization', `Bearer ${token}`)
    request.setHeader('Content-Type', 'application/json')
    request.on('response', (response) => {
      let body = ''
      response.on('data', (chunk: Buffer) => { body += chunk.toString() })
      response.on('end', () => {
        try {
          const json = JSON.parse(body)
          console.log('[Gateway]', '获取模型列表', body)
          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve(json.data ?? json)
          } else {
            const errorMsg = json.message || json.error || `获取模型列表失败 (${response.statusCode})`
            // Token 失效时清除登录状态
            if (isTokenExpiredError(errorMsg) || response.statusCode === 401) {
              console.log('[Gateway] Token expired, clearing login state')
              mgr.disconnect()
              notifyTokenExpiredToRenderers()
            }
            reject(new Error(errorMsg))
          }
        } catch {
          const errorMsg = `获取模型列表失败 (${response.statusCode})`
          if (response.statusCode === 401) {
            console.log('[Gateway] Token expired (401), clearing login state')
            mgr.disconnect()
            notifyTokenExpiredToRenderers()
          }
          reject(new Error(errorMsg))
        }
      })
    })
    request.on('error', (err) => reject(err))
    request.end()
  })
}
