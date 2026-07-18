/**
 * Skills 加载器模块
 *
 * 从内置、全局、工作空间目录加载技能文件（SKILL.md），合并到技能注册表。
 */

import * as fs from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import * as path from 'node:path'
import type { SkillInfo } from '../types'
import type { PersistedSkill, SkillEntry, SkillScope } from './utils'
import {
  SKILLS_DIR,
  toSkillId,
  resolveSkillToolNames,
  dedupeList,
  fileExists,
} from './utils'
import { parseSkillMeta } from './frontmatter'

/* ------------------------------------------------------------------ */
/*  从目录加载技能                                                       */
/* ------------------------------------------------------------------ */

type BuildSkillOptions = {
  filePath: string
  scope: SkillScope
  persisted: PersistedSkill | undefined
  content: string
  meta: ReturnType<typeof parseSkillMeta>
}

function buildSkillEntry(opts: BuildSkillOptions): SkillEntry {
  const { filePath, scope, persisted, content, meta } = opts
  const dirName = path.basename(path.dirname(filePath))
  const id = dirName && dirName !== 'skills' ? toSkillId(dirName) : toSkillId(meta.name || `skill-${Date.now()}`)

  const source = resolveSkillSource(scope, filePath, persisted)
  const enabled = typeof persisted?.enabled === 'boolean'
    ? persisted.enabled
    : (typeof meta.enabled === 'boolean' ? meta.enabled : true)

  const skill: SkillInfo = {
    id,
    name: meta.name || persisted?.name || id,
    description: meta.description || persisted?.description || '',
    version: meta.version || persisted?.version || '1.0.0',
    author: meta.author || persisted?.author || 'Unknown',
    source,
    sourceUrl: source === 'remote' ? persisted?.sourceUrl : undefined,
    enabled,
    instructions: content,
    tools: resolveSkillToolNames(meta.tools.length > 0 ? meta.tools : (persisted?.tools ?? [])),
    resources: dedupeList(meta.resources.length > 0 ? meta.resources : (persisted?.resources ?? [])),
  }

  return {
    scope,
    skill,
    requires: meta.requires,
    env: meta.env,
    rootDir: path.dirname(filePath),
    tools: resolveSkillToolNames(meta.tools.length > 0 ? meta.tools : (persisted?.tools ?? [])),
    resources: dedupeList(meta.resources.length > 0 ? meta.resources : (persisted?.resources ?? [])),
  }
}

export async function loadSkillsFromDirs(
  dirs: string[],
  scope: SkillScope,
  persistedById: Map<string, PersistedSkill>,
): Promise<SkillEntry[]> {
  const merged = new Map<string, SkillEntry>()

  for (const dir of dirs) {
    const files = await findSkillFiles(dir)
    for (const filePath of files) {
      let content = ''
      try {
        content = await fs.readFile(filePath, 'utf-8')
      } catch {
        continue
      }
      if (!content.trim()) continue

      const meta = parseSkillMeta(content)
      const entry = buildSkillEntry({ filePath, scope, persisted: undefined, content, meta })
      const persisted = persistedById.get(entry.skill.id)
      const finalEntry = persisted
        ? buildSkillEntry({ filePath, scope, persisted, content, meta })
        : entry
      merged.set(finalEntry.skill.id, finalEntry)
    }
  }

  return Array.from(merged.values())
}

/* ------------------------------------------------------------------ */
/*  辅助函数                                                            */
/* ------------------------------------------------------------------ */

function resolveSkillSource(scope: SkillScope, filePath: string, persisted?: PersistedSkill): SkillInfo['source'] {
  if (scope === 'workspace') return 'remote'
  const normalizedFile = path.resolve(filePath)
  const normalizedBase = path.resolve(SKILLS_DIR)
  if (normalizedFile.startsWith(normalizedBase) && persisted && persisted.source !== 'builtin') {
    return persisted.source
  }
  return 'remote'
}

export async function findSkillFiles(dir: string): Promise<string[]> {
  try {
    const st = await fs.stat(dir)
    if (!st.isDirectory()) return []
  } catch {
    return []
  }

  const files: string[] = []
  const directFile = path.join(dir, 'SKILL.md')
  if (await fileExists(directFile)) files.push(directFile)

  let entries: Dirent[] = []
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return files
  }

  const sorted = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'zh-CN'))

  for (const name of sorted) {
    const file = path.join(dir, name, 'SKILL.md')
    if (await fileExists(file)) files.push(file)
  }

  return files
}
