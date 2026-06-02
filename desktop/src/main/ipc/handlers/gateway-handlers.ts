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

/** 执行单次网关请求 */
function doGatewayRequest(token: string): Promise<{ statusCode: number; body: string }> {
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
      response.on('end', () => resolve({ statusCode: response.statusCode || 0, body }))
    })
    request.on('error', reject)
    request.end()
  })
}

export async function handleGatewayGetModels(_event: IpcMainInvokeEvent): Promise<unknown> {
  const mgr = getBridgeManager()
  let token = mgr.getToken()

  if (!token) {
    throw new Error('请先登录后再获取模型列表')
  }

  // 最多重试 1 次（401 刷新 Token 后重试）
  let retryCount = 0
  const maxRetries = 1

  while (true) {
    try {
      const response = await doGatewayRequest(token)
      const json = JSON.parse(response.body)
      console.log('[Gateway]', '获取模型列表', response.body)

      if (response.statusCode >= 200 && response.statusCode < 300) {
        return json.data ?? json
      }

      // 401 或 Token 失效错误：尝试刷新 Token 后重试
      const errorMsg = json.message || json.error || `获取模型列表失败 (${response.statusCode})`
      if ((response.statusCode === 401 || isTokenExpiredError(errorMsg)) && retryCount < maxRetries) {
        console.log('[Gateway] Token expired (401), attempting refresh...')
        const refreshed = await mgr.forceRefreshToken()
        if (refreshed) {
          const newToken = mgr.getToken()
          if (newToken) {
            token = newToken
            retryCount++
            console.log('[Gateway] Token refreshed, retrying request...')
            continue // 重试
          }
        }
        // 刷新失败，清除登录状态并报错
        mgr.disconnect()
        notifyTokenExpiredToRenderers()
        throw new Error('Token 刷新失败，请重新登录')
      }

      // 非 401 错误或重试次数已达上限
      if (isTokenExpiredError(errorMsg) || response.statusCode === 401) {
        mgr.disconnect()
        notifyTokenExpiredToRenderers()
      }
      throw new Error(errorMsg)
    } catch (err) {
      // 如果是网络错误且未重试过，尝试刷新 Token 后重试
      if (retryCount < maxRetries && err instanceof Error && isTokenExpiredError(err.message)) {
        const refreshed = await mgr.forceRefreshToken()
        if (refreshed) {
          const newToken = mgr.getToken()
          if (newToken) {
            token = newToken
            retryCount++
            continue
          }
        }
        mgr.disconnect()
        notifyTokenExpiredToRenderers()
        throw new Error('Token 刷新失败，请重新登录')
      }
      throw err
    }
  }
}
