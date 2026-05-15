/**
 * 路径工具函数
 *
 * 统一 resolveHomeDir、TACO_HOME、workspaceHash、projectScope，
 * 消除 memory-db.ts 和 notes.ts 中的重复定义。
 *
 * 注意：此模块仅限主进程使用（依赖 electron.app）。
 */

import path from 'node:path'
import { createHash } from 'node:crypto'
import { app } from 'electron'

/** 解析用户主目录（优先使用 Electron API，降级到环境变量/os 模块） */
export function resolveHomeDir(): string {
  try {
    const electronHome = app.getPath('home')
    if (electronHome && electronHome.trim()) return electronHome.trim()
  } catch {
    // ignore: fallback to env/os
  }
  const envHome = (process.env.HOME || process.env.USERPROFILE || '').trim()
  if (envHome) return envHome
  const osHome = (require('os').homedir() || '').trim()
  if (osHome) return osHome
  return process.cwd()
}

/** Taco 配置根目录 */
export const TACO_HOME = path.join(resolveHomeDir(), '.taco')

/** 将工作空间路径转为稳定的文件名 hash */
export function workspaceHash(workspace: string): string {
  return createHash('sha256').update(path.resolve(workspace)).digest('hex').slice(0, 16)
}

/** 将项目 ID 转为稳定的作用域标识 */
export function projectScope(projectId: string): string {
  return 'project-' + createHash('sha256').update(projectId).digest('hex').slice(0, 16)
}
