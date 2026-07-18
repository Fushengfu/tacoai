/**
 * Skills 安全审核与需求门控模块
 */

import * as fs from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import type { SkillRequires, ParsedSkillMeta, SkillSecurityCheck } from './utils'
import { SKILLS_CONFIG_JSON, isTruthyConfigValue, getConfigValue, isPathLikeCommand } from './utils'

const execFile = promisify(execFileCb)

/* ------------------------------------------------------------------ */
/*  运行时配置                                                          */
/* ------------------------------------------------------------------ */

export async function loadRuntimeConfig(): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(SKILLS_CONFIG_JSON, 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // ignore
  }
  return {}
}

/* ------------------------------------------------------------------ */
/*  需求门控：检查 requires.bins / requires.env / requires.config       */
/* ------------------------------------------------------------------ */

export async function resolveUnavailableReason(
  requires: SkillRequires,
  runtimeConfig: Record<string, unknown>,
): Promise<string | null> {
  const missingBins: string[] = []
  const missingEnv: string[] = []
  const missingConfig: string[] = []

  for (const bin of requires.bins) {
    if (!(await hasBinary(bin))) missingBins.push(bin)
  }

  for (const key of requires.env) {
    if (!String(process.env[key] ?? '').trim()) missingEnv.push(key)
  }

  for (const key of requires.config) {
    const value = getConfigValue(runtimeConfig, key)
    if (!isTruthyConfigValue(value)) missingConfig.push(key)
  }

  if (missingBins.length === 0 && missingEnv.length === 0 && missingConfig.length === 0) return null
  return [
    missingBins.length > 0 ? `缺少命令: ${missingBins.join(', ')}` : '',
    missingEnv.length > 0 ? `缺少环境变量: ${missingEnv.join(', ')}` : '',
    missingConfig.length > 0 ? `缺少配置: ${missingConfig.join(', ')}` : '',
  ].filter(Boolean).join(' | ')
}

const binCheckCache = new Map<string, boolean>()

export async function hasBinary(bin: string): Promise<boolean> {
  const key = String(bin ?? '').trim()
  if (!key) return false
  if (binCheckCache.has(key)) return Boolean(binCheckCache.get(key))

  let ok = false
  try {
    if (isPathLikeCommand(key)) {
      await fs.access(key, fsConstants.X_OK)
      ok = true
    } else {
      const cmd = process.platform === 'win32' ? 'where' : 'which'
      await execFile(cmd, [key], { windowsHide: true })
      ok = true
    }
  } catch {
    ok = false
  }
  binCheckCache.set(key, ok)
  return ok
}

/* ------------------------------------------------------------------ */
/*  安全审核                                                            */
/* ------------------------------------------------------------------ */

/**
 * 安全审核 Skill 内容
 *
 * 检测潜在的危险操作:
 * - 执行任意命令
 * - 删除文件/目录
 * - 修改系统配置
 * - 网络请求
 * - 敏感文件访问
 */
export function auditSkillSecurity(instructions: string, meta: ParsedSkillMeta): SkillSecurityCheck {
  const warnings: string[] = []
  let riskScore = 0

  const text = instructions.toLowerCase()
  const combinedTools = [...meta.tools, ...meta.requires.bins].map(t => t.toLowerCase())

  // 1. 检查危险命令执行
  const dangerousCommands = [
    { pattern: /rm\s+-rf|rm\s+-f|rm\s+-r\b(?!f)|rm\s+--recursive|rmdir\s+\/s|del\s+\/[sf]/g, weight: 10, msg: '包含强制删除命令' },
    { pattern: /chmod\s+[0-7]{3,4}|chown|icacls/g, weight: 8, msg: '包含权限修改命令' },
    { pattern: /sudo\s+|runas\s+/g, weight: 9, msg: '包含提权操作' },
    { pattern: /mkfs|fdisk|diskpart|format\s+/g, weight: 10, msg: '包含磁盘格式化命令' },
    { pattern: /curl\s.*\|.*sh|wget.*\|.*bash/g, weight: 10, msg: '包含管道执行网络脚本' },
    { pattern: /eval\s*\(|exec\s*\(/g, weight: 9, msg: '包含动态代码执行' },
  ]

  for (const { pattern, weight, msg } of dangerousCommands) {
    if (pattern.test(text)) {
      warnings.push(msg)
      riskScore += weight
    }
  }

  // 2. 检查危险工具使用
  const dangerousTools = {
    run_command: 5,
    delete_file: 6,
    write_file: 4,
    edit_file: 3,
  }

  for (const [tool, weight] of Object.entries(dangerousTools)) {
    if (combinedTools.includes(tool.toLowerCase())) {
      warnings.push(`使用了高危工具: ${tool}`)
      riskScore += weight
    }
  }

  // 3. 检查敏感文件路径访问
  const sensitivePaths = [
    { pattern: /\/etc\/passwd|\/etc\/shadow/g, weight: 8, msg: '尝试访问系统敏感文件' },
    { pattern: /\.ssh\/|\.gitconfig|\.npmrc|\.pypirc/g, weight: 7, msg: '尝试访问凭证文件' },
    { pattern: /\/root\/|\/home\/[^/]+\/Documents/g, weight: 6, msg: '尝试访问用户私有目录' },
    { pattern: /node_modules\/.*\.env|\.env\.local/g, weight: 7, msg: '尝试访问环境变量文件' },
  ]

  for (const { pattern, weight, msg } of sensitivePaths) {
    if (pattern.test(text)) {
      warnings.push(msg)
      riskScore += weight
    }
  }

  // 4. 检查网络请求
  const networkPatterns = [
    { pattern: /https?:\/\/[^\s]+/g, weight: 2, msg: '包含外部网络请求' },
    { pattern: /fetch\s*\(|axios\s*\(|request\s*\(/g, weight: 4, msg: '包含 HTTP 请求调用' },
  ]

  for (const { pattern, weight, msg } of networkPatterns) {
    if (pattern.test(text)) {
      warnings.push(msg)
      riskScore += weight
    }
  }

  // 5. 检查环境变量注入
  if (Object.keys(meta.env).length > 5) {
    warnings.push(`注入大量环境变量 (${Object.keys(meta.env).length} 个)`)
    riskScore += 3
  }

  for (const [key, value] of Object.entries(meta.env)) {
    if (key.toLowerCase().includes('token') || key.toLowerCase().includes('secret') || key.toLowerCase().includes('key')) {
      warnings.push(`注入敏感环境变量: ${key}`)
      riskScore += 5
    }
    if (value.includes('$(') || value.includes('`')) {
      warnings.push(`环境变量包含命令替换（一票否决）: ${key}`)
      riskScore += 15
    }
  }

  // 确定风险等级
  let riskLevel: 'low' | 'medium' | 'high' | 'critical'
  if (riskScore >= 15) {
    riskLevel = 'critical'
  } else if (riskScore >= 10) {
    riskLevel = 'high'
  } else if (riskScore >= 5) {
    riskLevel = 'medium'
  } else {
    riskLevel = 'low'
  }

  const safe = riskLevel !== 'critical' && riskLevel !== 'high'

  return {
    safe,
    warnings,
    riskLevel,
  }
}
