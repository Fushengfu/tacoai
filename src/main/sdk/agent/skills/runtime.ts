/**
 * Skills 运行时输出模块
 *
 * 构建技能目录块、读取技能详情/资源、环境变量注入。
 * 这些函数读取模块状态（activeSkills、activeSkillEntries），
 * 状态由 service.ts 统一管理，通过参数传入。
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { SkillInfo } from '../types'
import type { SkillEntry } from './utils'
import {
  buildSkillSummary,
  resolveSkillToolNames,
  normalizeSkillResourcePath,
  isSkillResourceAllowed,
} from './utils'

/* ------------------------------------------------------------------ */
/*  技能目录块                                                          */
/* ------------------------------------------------------------------ */

export function buildActiveSkillsCatalogBlock(activeSkills: SkillInfo[]): string {
  if (activeSkills.length === 0) return ''

  const lines: string[] = ['[SKILLS_CATALOG]']
  for (const skill of activeSkills) {
    const summary = buildSkillSummary(skill)
    lines.push(`- id: ${skill.id}`)
    lines.push(`  name: ${skill.name}`)
    lines.push(`  summary: ${summary}`)
  }
  lines.push('[/SKILLS_CATALOG]')
  lines.push('规则：以上只包含当前已开启且当前环境可用的技能目录。')
  lines.push('当本轮任务需要使用某个技能时，先调用 `read_skill` 查看该技能的完整内容。')
  lines.push('若技能详情提到了 references/scripts/assets/templates 等附属资源，请在读取该技能详情后使用 `read_skill_resource` 按需查看具体文件。')
  lines.push('未读取完整技能内容前，不得按该技能协议执行。')
  return lines.join('\n')
}

/* ------------------------------------------------------------------ */
/*  技能详情                                                            */
/* ------------------------------------------------------------------ */

export function readActiveSkillDetail(
  skillId: string,
  activeSkills: SkillInfo[],
): { content: string; skill: SkillInfo } | null {
  const normalizedId = String(skillId ?? '').trim()
  if (!normalizedId) return null
  const skill = activeSkills.find((item) => item.id === normalizedId)
  if (!skill) return null

  const detailLines = [
    `[SKILL_DETAIL id="${skill.id}"]`,
    `name: ${skill.name}`,
    `description: ${buildSkillSummary(skill)}`,
    ...(skill.tools?.length ? ['', '[SKILL_ALLOWED_TOOLS]', ...skill.tools.map((tool) => `- ${tool}`), '[/SKILL_ALLOWED_TOOLS]'] : []),
    ...(skill.resources?.length ? ['', '[SKILL_RESOURCES]', ...skill.resources.map((item) => `- ${item}`), '[/SKILL_RESOURCES]'] : []),
    '',
    skill.instructions.trim(),
    '[/SKILL_DETAIL]',
  ]

  return {
    skill: { ...skill },
    content: detailLines.join('\n'),
  }
}

/* ------------------------------------------------------------------ */
/*  技能资源读取                                                         */
/* ------------------------------------------------------------------ */

export async function readActiveSkillResource(
  skillId: string,
  relativePath: string,
  activeSkillEntries: Map<string, SkillEntry>,
): Promise<{ content: string; resolvedPath: string; skill: SkillInfo } | null> {
  const normalizedId = String(skillId ?? '').trim()
  const requested = normalizeSkillResourcePath(relativePath)
  if (!normalizedId || !requested) return null

  const entry = activeSkillEntries.get(normalizedId)
  if (!entry?.rootDir) return null

  if (!isSkillResourceAllowed(requested, entry.resources ?? [])) return null

  const resolvedPath = path.resolve(entry.rootDir, requested)
  const normalizedRoot = path.resolve(entry.rootDir)
  if (!resolvedPath.startsWith(normalizedRoot + path.sep) && resolvedPath !== normalizedRoot) return null

  try {
    const stat = await fs.stat(resolvedPath)
    if (!stat.isFile()) return null
    if (stat.size > 256 * 1024) return null
    const content = await fs.readFile(resolvedPath, 'utf-8')
    return {
      content,
      resolvedPath,
      skill: { ...entry.skill },
    }
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/*  技能环境注入                                                         */
/* ------------------------------------------------------------------ */

export function applySkillEnvironment(envVars: Record<string, string>): () => void {
  const backups = new Map<string, string | undefined>()
  for (const [rawKey, rawValue] of Object.entries(envVars ?? {})) {
    const key = String(rawKey ?? '').trim()
    if (!key) continue
    backups.set(key, process.env[key])
    process.env[key] = String(rawValue ?? '')
  }

  return () => {
    for (const [key, value] of backups.entries()) {
      if (typeof value === 'undefined') delete process.env[key]
      else process.env[key] = value
    }
  }
}

/* ------------------------------------------------------------------ */
/*  工具访问器                                                          */
/* ------------------------------------------------------------------ */

export function getSkillAllowedTools(
  skillId: string,
  activeSkillEntries: Map<string, SkillEntry>,
): string[] {
  const normalizedId = String(skillId ?? '').trim()
  if (!normalizedId) return []
  const entry = activeSkillEntries.get(normalizedId)
  if (!entry) return []
  return resolveSkillToolNames(entry.tools ?? [])
}

export function getSkillRootDir(
  skillId: string,
  activeSkillEntries: Map<string, SkillEntry>,
): string | null {
  const normalizedId = String(skillId ?? '').trim()
  if (!normalizedId) return null
  const entry = activeSkillEntries.get(normalizedId)
  return entry?.rootDir ?? null
}
