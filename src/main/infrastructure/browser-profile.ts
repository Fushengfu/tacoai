/**
 * 浏览器指纹持久化模块
 * - 每个 appId 绑定独立指纹配置（seed + UA）
 * - 配置文件缓存到磁盘（~/.taco/browser-profiles/）
 * - 首次使用自动生成，后续复用
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import * as nodePath from 'node:path'
import { app } from 'electron'
import { generateFingerprintSeed, generateChromeUA } from './browser-stealth'

/* ------------------------------------------------------------------ */
/*  常量                                                               */
/* ------------------------------------------------------------------ */

/** 浏览器配置持久化目录 */
export const BROWSER_PROFILES_DIR = nodePath.join(
  app.getPath('home'),
  '.taco',
  'browser-profiles'
)

/* ------------------------------------------------------------------ */
/*  类型定义                                                           */
/* ------------------------------------------------------------------ */

/** 单个 appId 的持久化指纹配置 */
export interface BrowserProfile {
  appId: string
  seed: string
  ua: string
  createdAt: string
  lastUsedAt: string
}

/* ------------------------------------------------------------------ */
/*  内部函数                                                           */
/* ------------------------------------------------------------------ */

/** 确保配置目录存在 */
function ensureProfilesDir() {
  if (!existsSync(BROWSER_PROFILES_DIR)) {
    mkdirSync(BROWSER_PROFILES_DIR, { recursive: true })
  }
}

/* ------------------------------------------------------------------ */
/*  公共 API                                                           */
/* ------------------------------------------------------------------ */

/** 加载或创建 appId 的浏览器指纹配置 */
export function loadOrCreateProfile(appId: string): BrowserProfile {
  ensureProfilesDir()
  const profilePath = nodePath.join(BROWSER_PROFILES_DIR, `${appId}.json`)

  if (existsSync(profilePath)) {
    try {
      const data = JSON.parse(readFileSync(profilePath, 'utf-8')) as BrowserProfile
      // 更新最后使用时间
      data.lastUsedAt = new Date().toISOString()
      writeFileSync(profilePath, JSON.stringify(data, null, 2), 'utf-8')
      return data
    } catch {
      /* 配置损坏，重新生成 */
    }
  }

  // 首次使用，生成并持久化
  const profile: BrowserProfile = {
    appId,
    seed: generateFingerprintSeed(),
    ua: generateChromeUA(),
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
  }
  writeFileSync(profilePath, JSON.stringify(profile, null, 2), 'utf-8')
  return profile
}
