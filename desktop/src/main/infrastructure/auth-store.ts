/**
 * Token 文件持久化存储
 *
 * 将登录成功后的 token / expiresAt / memberInfo 写入 ~/.taco/auth.json，
 * 防止 Electron 渲染进程 localStorage 被清理后丢失登录态。
 */

import { app } from 'electron'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

const TACO_DIR = path.join(app.getPath('home'), '.taco')
const AUTH_FILE = path.join(TACO_DIR, 'auth.json')

interface AuthFileData {
  token: string
  expiresAt?: number
  memberInfo?: unknown
  updatedAt: string
}

/** 确保 ~/.taco/ 目录存在 */
async function ensureDir(): Promise<void> {
  await fs.mkdir(TACO_DIR, { recursive: true })
}

/** 保存 Token 及关联信息到文件 */
export async function saveAuthToFile(data: {
  token: string
  expiresAt?: number
  memberInfo?: unknown
}): Promise<void> {
  await ensureDir()
  const payload: AuthFileData = {
    token: data.token,
    expiresAt: data.expiresAt,
    memberInfo: data.memberInfo,
    updatedAt: new Date().toISOString(),
  }
  await fs.writeFile(AUTH_FILE, JSON.stringify(payload, null, 2), 'utf-8')
  console.log('[AuthStore] Token saved to', AUTH_FILE)
}

/** 从文件读取 Token。如果文件不存在或已过期则返回 null */
export async function loadAuthFromFile(): Promise<AuthFileData | null> {
  try {
    const raw = await fs.readFile(AUTH_FILE, 'utf-8')
    const data = JSON.parse(raw) as AuthFileData
    if (!data.token) return null

    // 检查是否过期
    if (data.expiresAt && data.expiresAt > 0 && data.expiresAt < Date.now()) {
      console.log('[AuthStore] Stored token expired at', new Date(data.expiresAt).toISOString())
      return null
    }

    return data
  } catch {
    // 文件不存在或解析失败
    return null
  }
}

/** 删除 Token 文件 */
export async function removeAuthFile(): Promise<void> {
  try {
    await fs.unlink(AUTH_FILE)
    console.log('[AuthStore] Token file removed')
  } catch {
    // 文件不存在，忽略
  }
}
