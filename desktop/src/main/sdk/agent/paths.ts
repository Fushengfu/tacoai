/**
 * Agent SDK — 路径工具
 *
 * 统一 resolveHomeDir、TACO_HOME、workspaceHash、projectScope。
 * 原先定义在 shared/paths.ts，移入 SDK 后 shared/paths.ts 改为 re-export。
 *
 * 无外部依赖，纯 Node.js 实现。降级链：env HOME → os.homedir() → cwd。
 */

import path from 'node:path'
import { createHash } from 'node:crypto'

/** 解析用户主目录。内存缓存，仅计算一次。 */
let _cachedHomeDir: string | null = null

export function resolveHomeDir(): string {
  if (_cachedHomeDir) return _cachedHomeDir
  const envHome = (process.env.HOME || process.env.USERPROFILE || '').trim()
  if (envHome) {
    _cachedHomeDir = envHome
    return envHome
  }
  try {
    const osHome = (require('os').homedir() || '').trim()
    if (osHome) {
      _cachedHomeDir = osHome
      return osHome
    }
  } catch {
    // ignore
  }
  _cachedHomeDir = process.cwd()
  return _cachedHomeDir
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
