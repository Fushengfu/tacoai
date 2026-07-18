/**
 * Skills 工具模块：类型定义 + 路径常量 + 纯工具函数 + 日志器
 */

import * as fs from 'node:fs/promises'
import { homedir } from 'node:os'
import * as path from 'node:path'
import type { SkillInfo } from '../types'
import type { Logger } from '../services'

/* ------------------------------------------------------------------ */
/*  日志器                                                              */
/* ------------------------------------------------------------------ */

let _log: Logger = () => {}
export function setSkillsServiceLogger(logger: Logger) { _log = logger }
export function getLogger(): Logger { return _log }

/* ------------------------------------------------------------------ */
/*  路径常量                                                            */
/* ------------------------------------------------------------------ */

const HOME_DIR = homedir()
export const TACO_DIR = path.join(HOME_DIR, '.taco')
export const SKILLS_DIR = path.join(TACO_DIR, 'skills')
export const SKILLS_JSON = path.join(TACO_DIR, 'skills.json')
export const SKILLS_CONFIG_JSON = path.join(TACO_DIR, 'skills-config.json')
export const OPENCLAW_SKILLS_DIR = path.join(HOME_DIR, '.openclaw', 'skills')

export const DEFAULT_SKILL_RESOURCE_DIRS = ['references', 'scripts', 'assets', 'templates']
export const SKILL_TOOL_GROUPS: Record<string, string[]> = {
  files: ['read_file', 'write_file', 'edit_file', 'delete_file', 'list_dir', 'find_file'],
  command: ['run_command'],
  planning: ['propose_plan', 'update_plan_progress'],
  notes: ['save_note', 'delete_note'],
}

/* ------------------------------------------------------------------ */
/*  类型定义                                                            */
/* ------------------------------------------------------------------ */

export type PersistedSkill = Omit<SkillInfo, 'instructions'> & { instructionsFile?: string }

export type SkillRequires = {
  bins: string[]
  env: string[]
  config: string[]
}

export type ParsedSkillMeta = {
  name?: string
  description?: string
  version?: string
  author?: string
  enabled?: boolean
  requires: SkillRequires
  env: Record<string, string>
  tools: string[]
  resources: string[]
}

export type SkillScope = 'builtin' | 'global' | 'workspace'

export type SkillEntry = {
  skill: SkillInfo
  scope: SkillScope
  requires: SkillRequires
  env: Record<string, string>
  rootDir?: string
  tools: string[]
  resources: string[]
}

export type GitHubSkillSource = {
  owner: string
  repo: string
  ref: string
  skillRootPath: string
  skillMdPath: string
}

export type SkillSecurityCheck = {
  safe: boolean
  warnings: string[]
  riskLevel: 'low' | 'medium' | 'high' | 'critical'
}

export const EMPTY_REQUIRES: SkillRequires = { bins: [], env: [], config: [] }

/* ------------------------------------------------------------------ */
/*  字符串 / ID 工具                                                    */
/* ------------------------------------------------------------------ */

/** 将路径中的 ~ 展开为实际主目录路径 */
export function expandTilde(filePath: string): string {
  if (filePath.startsWith('~/') || filePath === '~') {
    return path.join(HOME_DIR, filePath.slice(filePath.startsWith('~/') ? 2 : 1))
  }
  return filePath
}

export function stripQuotes(input: string): string {
  const text = String(input ?? '').trim()
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith('\'') && text.endsWith('\''))) {
    return text.slice(1, -1)
  }
  return text
}

export function parseBoolean(raw: string): boolean | undefined {
  const text = String(raw ?? '').trim().toLowerCase()
  if (text === 'true' || text === 'yes' || text === 'on' || text === '1') return true
  if (text === 'false' || text === 'no' || text === 'off' || text === '0') return false
  return undefined
}

export function leadingSpaces(line: string): number {
  const m = line.match(/^\s*/)
  return m ? m[0].length : 0
}

export function toSkillId(input: string): string {
  const slug = String(input ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || `skill-${Date.now()}`
}

/* ------------------------------------------------------------------ */
/*  数组 / 列表工具                                                     */
/* ------------------------------------------------------------------ */

export function dedupeList(items: string[]): string[] {
  const out: string[] = []
  for (const item of items) {
    const val = String(item ?? '').trim()
    if (!val || out.includes(val)) continue
    out.push(val)
  }
  return out
}

export function parseStringList(raw: string): string[] {
  const text = String(raw ?? '').trim()
  if (!text) return []
  let body = text
  if ((body.startsWith('[') && body.endsWith(']')) || (body.startsWith('(') && body.endsWith(')'))) {
    body = body.slice(1, -1)
  }
  const parts = body.includes(',') ? body.split(',') : body.split(/\s+/)
  return dedupeList(parts.map((s) => stripQuotes(s.trim())).filter(Boolean))
}

/* ------------------------------------------------------------------ */
/*  技能工具名解析                                                       */
/* ------------------------------------------------------------------ */

export function resolveSkillToolNames(rawTools: string[]): string[] {
  const out: string[] = []
  for (const item of rawTools) {
    const normalized = String(item ?? '').trim().toLowerCase()
    if (!normalized) continue
    if (SKILL_TOOL_GROUPS[normalized]) {
      for (const toolName of SKILL_TOOL_GROUPS[normalized]) {
        if (!out.includes(toolName)) out.push(toolName)
      }
      continue
    }
    const canonical = normalized === 'list_directory' ? 'list_dir' : normalized
    if (!out.includes(canonical)) out.push(canonical)
  }
  return out
}

/* ------------------------------------------------------------------ */
/*  路径 / POSIX 工具                                                   */
/* ------------------------------------------------------------------ */

export function joinPosixPath(...parts: string[]): string {
  return parts
    .map((part) => String(part ?? '').replace(/\\/g, '/'))
    .filter(Boolean)
    .join('/')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '')
}

export function dirnamePosix(filePath: string): string {
  const normalized = String(filePath ?? '').replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index >= 0 ? normalized.slice(0, index) : ''
}

export function normalizeWorkspace(workspace?: string): string {
  const raw = String(workspace ?? '').trim()
  if (!raw) return ''
  return path.resolve(raw)
}

export function normalizeSkillResourcePath(input: string): string {
  const normalized = String(input ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
  return normalized
}

export function isSkillResourceAllowed(relativePath: string, declared: string[]): boolean {
  const normalized = normalizeSkillResourcePath(relativePath)
  if (!normalized || normalized.includes('..')) return false
  const prefixes = new Set<string>(DEFAULT_SKILL_RESOURCE_DIRS.map((item) => `${item}/`))
  for (const item of dedupeList(declared)) {
    const normalizedItem = normalizeSkillResourcePath(item).replace(/\*+$/, '')
    if (!normalizedItem) continue
    prefixes.add(normalizedItem.endsWith('/') ? normalizedItem : `${normalizedItem}${normalizedItem.includes('.') ? '' : '/'}`)
  }
  for (const prefix of prefixes) {
    if (normalized === prefix.replace(/\/$/, '') || normalized.startsWith(prefix)) return true
  }
  return false
}

/* ------------------------------------------------------------------ */
/*  技能摘要 / 分类 / 标签                                               */
/* ------------------------------------------------------------------ */

export function buildSkillSummary(skill: SkillInfo): string {
  const description = String(skill.description ?? '').replace(/\s+/g, ' ').trim()
  if (description) return description
  const firstLine = String(skill.instructions ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean)
  return firstLine || skill.id
}

export function inferCategory(name?: string, description?: string, tools?: string[]): string {
  const text = `${name ?? ''} ${description ?? ''} ${(tools ?? []).join(' ')}`.toLowerCase()
  if (/\bdocker\b|\bcontainer\b|\bkubernetes\b|\bdevops\b/.test(text)) return 'devops'
  if (/\bsecurity\b|\baudit\b|\bvulnerability\b|\bpenetration\b/.test(text)) return 'security'
  if (/\btest\b|\bqa\b|\bquality\b|\bcoverage\b|\blint/.test(text)) return 'testing'
  if (/\bdoc\b|\breadme\b|\bapi\s*doc|documentation/.test(text)) return 'documentation'
  if (/\bgit\b|\bcommit\b|\bversion\s*control|\brepository/.test(text)) return 'development'
  if (/\bapi\b|\brest\b|\bgraphql\b/.test(text)) return 'api'
  if (/\bdatabase\b|\bsql\b|\bmongodb\b|\bredis\b/.test(text)) return 'database'
  if (/\bdeploy\b|\bci\s*\/\s*cd|\bgithub\s*actions/.test(text)) return 'devops'
  return 'development'
}

export function inferTags(name?: string, description?: string, tools?: string[]): string[] {
  const text = `${name ?? ''} ${description ?? ''}`.toLowerCase()
  const tags: string[] = []
  if (/\bgit\b/.test(text)) tags.push('git')
  if (/\bcommit\b/.test(text)) tags.push('commit')
  if (/\bdocker\b/.test(text)) tags.push('docker')
  if (/\bsecurity\b|\baudit\b/.test(text)) tags.push('security')
  if (/\btest\b/.test(text)) tags.push('testing')
  if (/\bdoc\b|\breadme\b/.test(text)) tags.push('documentation')
  if (/\bapi\b/.test(text)) tags.push('api')
  return tags.length > 0 ? tags : ['utility']
}

/* ------------------------------------------------------------------ */
/*  环境变量 / 配置工具                                                  */
/* ------------------------------------------------------------------ */

export function interpolateEnv(value: string): string {
  return String(value ?? '').replace(/\$\{([A-Za-z_]\w*)\}/g, (_, name: string) => {
    return process.env[name] ?? ''
  })
}

export function isTruthyConfigValue(v: unknown): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase()
    return t !== '' && t !== '0' && t !== 'false' && t !== 'off' && t !== 'no'
  }
  return Boolean(v)
}

export function getConfigValue(obj: Record<string, unknown>, keyPath: string): unknown {
  const parts = String(keyPath ?? '').split('.').map((s) => s.trim()).filter(Boolean)
  if (parts.length === 0) return undefined
  let current: unknown = obj
  for (const part of parts) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

export function isPathLikeCommand(input: string): boolean {
  return input.includes('/') || input.includes('\\') || path.isAbsolute(input)
}

/* ------------------------------------------------------------------ */
/*  排序 / 文件 / Slug 工具                                              */
/* ------------------------------------------------------------------ */

export function sortSkillsForDisplay(entries: SkillEntry[]): SkillEntry[] {
  const score = (entry: SkillEntry): number => {
    if (entry.scope === 'workspace') return 0
    if (entry.scope === 'global') return 1
    return 2
  }
  return [...entries].sort((a, b) => {
    const sa = score(a)
    const sb = score(b)
    if (sa !== sb) return sa - sb
    return a.skill.name.localeCompare(b.skill.name, 'zh-CN')
  })
}

export async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** 判断一个 source 是否是 ClawHub/SkillHub slug（非 URL、非本地路径） */
export function isClawHubSlug(source: string): boolean {
  if (source.startsWith('http://') || source.startsWith('https://')) return false
  if (source.startsWith('/') || source.startsWith('.') || source.startsWith('~')) return false
  if (/^@?[\w-]+\/[\w-]+$/.test(source)) return true
  if (/^[\w-]+$/.test(source)) return true
  return false
}

/** 将 GitHub URL 转为 raw 地址 */
export function toRawGitHubUrl(url: string): string {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/(?:blob\/)?(.+)/)
  if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`
  return url
}
