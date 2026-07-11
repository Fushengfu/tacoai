/**
 * Auth IPC Handlers
 *
 * 负责将登录 Token 持久化到文件系统（~/.taco/auth.json），
 * 防止 localStorage 被清理后丢失登录态。
 */

import { IpcChannel } from '../../../shared/ipc'
import { saveAuthToFile, loadAuthFromFile, removeAuthFile } from '../../infrastructure/auth-store'

export async function handleAuthSaveToken(
  _event: unknown,
  payload: { token: string; expiresAt?: number; memberInfo?: unknown },
): Promise<void> {
  await saveAuthToFile(payload)
}

export async function handleAuthLoadToken(): Promise<{
  token: string
  expiresAt?: number
  memberInfo?: unknown
} | null> {
  return loadAuthFromFile()
}

export async function handleAuthRemoveToken(): Promise<void> {
  await removeAuthFile()
}
