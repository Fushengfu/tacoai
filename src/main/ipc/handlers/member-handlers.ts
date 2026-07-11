/**
 * Member IPC Handlers
 *
 * 包含登录、注册等会员相关 IPC handler。
 */

import { net } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'

const MEMBER_BASE_URL = 'https://agent.bjctykj.com'

/** 登录请求通过主进程代理，避免渲染进程直接 fetch 时的 CORS 问题 */
export async function handleMemberLogin(
  _event: IpcMainInvokeEvent,
  payload: { username: string; password: string },
) {
  return new Promise((resolve, reject) => {
    const request = net.request({
      method: 'POST',
      url: `${MEMBER_BASE_URL}/api/member/login`,
    })
    request.setHeader('Content-Type', 'application/json')
    request.on('response', (response) => {
      let body = ''
      response.on('data', (chunk: Buffer) => { body += chunk.toString() })
      response.on('end', () => {
        try {
          const json = JSON.parse(body)
          if (response.statusCode >= 200 && response.statusCode < 300 && json.data) {
            resolve(json.data)
          } else {
            reject(new Error(json.message || json.error || `登录失败 (${response.statusCode})`))
          }
        } catch {
          reject(new Error(`登录失败 (${response.statusCode})`))
        }
      })
    })
    request.on('error', (err) => reject(err))
    request.write(JSON.stringify(payload))
    request.end()
  })
}

export async function handleMemberRegister(
  _event: IpcMainInvokeEvent,
  payload: { username: string; password: string; nickname?: string; phone?: string; email?: string },
) {
  return new Promise((resolve, reject) => {
    const request = net.request({
      method: 'POST',
      url: `${MEMBER_BASE_URL}/api/member/register`,
    })
    request.setHeader('Content-Type', 'application/json')
    request.on('response', (response) => {
      let body = ''
      response.on('data', (chunk: Buffer) => { body += chunk.toString() })
      response.on('end', () => {
        try {
          const json = JSON.parse(body)
          if (response.statusCode >= 200 && response.statusCode < 300 && json.data) {
            resolve(json.data)
          } else {
            reject(new Error(json.message || json.error || `注册失败 (${response.statusCode})`))
          }
        } catch {
          reject(new Error(`注册失败 (${response.statusCode})`))
        }
      })
    })
    request.on('error', (err) => reject(err))
    request.write(JSON.stringify(payload))
    request.end()
  })
}
