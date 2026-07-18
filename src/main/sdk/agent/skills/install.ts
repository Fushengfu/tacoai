/**
 * Skills 安装 / 卸载 / 持久化模块
 *
 * ZIP 下载解压、安装到本地技能目录、skills.json 持久化。
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { execSync } from 'node:child_process'
import type { SkillInfo } from '../types'
import type { Logger } from '../services'
import type { PersistedSkill, SkillEntry } from './utils'
import {
  SKILLS_DIR,
  SKILLS_JSON,
  DEFAULT_SKILL_RESOURCE_DIRS,
  normalizeSkillResourcePath,
  normalizeWorkspace,
  isClawHubSlug,
  fileExists,
  dedupeList,
  getLogger,
} from './utils'
import { parseSkillMeta } from './frontmatter'

/* ------------------------------------------------------------------ */
/*  下载 URL 构建                                                        */
/* ------------------------------------------------------------------ */

export function buildClawHubDownloadUrl(slug: string): string {
  const pureSlug = slug.replace(/^@/, '').split('/').pop() ?? slug
  return `https://clawhub.ai/api/v1/download?slug=${encodeURIComponent(pureSlug)}`
}

export function buildSkillHubDownloadUrl(slug: string): string {
  const pureSlug = slug.replace(/^@/, '').split('/').pop() ?? slug
  return `https://api.skillhub.cn/api/v1/download?slug=${encodeURIComponent(pureSlug)}`
}

/* ------------------------------------------------------------------ */
/*  ZIP 下载与解压                                                       */
/* ------------------------------------------------------------------ */

export async function downloadAndExtractZip(
  url: string,
  destDir: string,
  logger?: Logger,
): Promise<void> {
  const log = logger ?? getLogger()
  const zipPath = path.join(destDir, 'skill.zip')

  log('DOWNLOAD_START', { url }, 'skills')
  const resp = await fetch(url, { headers: { 'User-Agent': 'Taco-AI' } })
  if (!resp.ok) {
    throw new Error(`下载失败: ${resp.status} ${resp.statusText}`)
  }

  const buffer = Buffer.from(await resp.arrayBuffer())
  await fs.writeFile(zipPath, buffer)
  log('DOWNLOAD_DONE', { size: buffer.length }, 'skills')

  try {
    const platform = os.platform()
    if (platform === 'win32') {
      execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`, { stdio: 'pipe' })
    } else {
      execSync(`unzip -o "${zipPath}" -d "${destDir}"`, { stdio: 'pipe' })
    }
  } catch (err) {
    throw new Error(`解压 ZIP 失败: ${err instanceof Error ? err.message : String(err)}`)
  }

  try { await fs.unlink(zipPath) } catch { /* ignore */ }

  // 解压后内容都在一个子目录 → 上移一层
  const entries = await fs.readdir(destDir)
  const nonZipEntries = entries.filter(e => e !== 'skill.zip')
  if (nonZipEntries.length === 1) {
    const innerDir = path.join(destDir, nonZipEntries[0])
    const stat = await fs.stat(innerDir)
    if (stat.isDirectory()) {
      const innerEntries = await fs.readdir(innerDir)
      for (const entry of innerEntries) {
        await fs.rename(path.join(innerDir, entry), path.join(destDir, entry))
      }
      await fs.rmdir(innerDir)
    }
  }

  // ZIP slip 防护
  const resolvedDest = path.resolve(destDir)
  await validateExtractionPaths(resolvedDest)
}

async function validateExtractionPaths(dir: string): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.resolve(dir, entry.name)
    const resolvedDest = path.resolve(dir)
    if (entry.isSymbolicLink()) {
      throw new Error(`安全风险：ZIP 包含符号链接 "${entry.name}"，已拒绝`)
    }
    if (!fullPath.startsWith(resolvedDest + path.sep) && fullPath !== resolvedDest) {
      throw new Error(`安全风险：ZIP 包含越界路径 "${fullPath}"（目录: "${resolvedDest}"），已拒绝`)
    }
    if (entry.isDirectory()) {
      await validateExtractionPaths(fullPath)
    }
  }
}

/* ------------------------------------------------------------------ */
/*  skills.json 持久化                                                   */
/* ------------------------------------------------------------------ */

export async function ensureDirs() {
  await fs.mkdir(SKILLS_DIR, { recursive: true })
}

export async function loadPersistedSkills(): Promise<PersistedSkill[]> {
  try {
    const data = await fs.readFile(SKILLS_JSON, 'utf-8')
    const parsed = JSON.parse(data)
    return Array.isArray(parsed) ? parsed as PersistedSkill[] : []
  } catch {
    return []
  }
}

export async function savePersistedSkills(skills: PersistedSkill[]) {
  await ensureDirs()
  await fs.writeFile(SKILLS_JSON, JSON.stringify(skills, null, 2), 'utf-8')
}

export function upsertPersistedSkill(items: PersistedSkill[], item: PersistedSkill): PersistedSkill[] {
  const next = [...items]
  const idx = next.findIndex((s) => s.id === item.id)
  if (idx >= 0) next[idx] = item
  else next.push(item)
  return next
}

/* ------------------------------------------------------------------ */
/*  SKILL.md 读取 / 写入                                                 */
/* ------------------------------------------------------------------ */

export async function loadSkillInstructionsFromPersisted(skill: PersistedSkill): Promise<string> {
  if (skill.instructionsFile) {
    const p = path.resolve(SKILLS_DIR, skill.instructionsFile)
    try {
      return await fs.readFile(p, 'utf-8')
    } catch {
      // fall through
    }
  }
  return loadSkillInstructions(skill.id)
}

export async function loadSkillInstructions(skillId: string): Promise<string> {
  const filePath = path.join(SKILLS_DIR, skillId, 'SKILL.md')
  try {
    return await fs.readFile(filePath, 'utf-8')
  } catch {
    return ''
  }
}

export async function saveSkillInstructions(skillId: string, content: string) {
  const dir = path.join(SKILLS_DIR, skillId)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'SKILL.md'), content, 'utf-8')
}

/* ------------------------------------------------------------------ */
/*  安装到本地技能目录                                                    */
/* ------------------------------------------------------------------ */

export async function installSkillPackageFromLocalRoot(
  skillId: string,
  sourceRoot: string,
  instructions: string,
  declaredResources: string[],
) {
  const targetRoot = path.join(SKILLS_DIR, skillId)
  await fs.rm(targetRoot, { recursive: true, force: true })
  await fs.mkdir(targetRoot, { recursive: true })
  await fs.writeFile(path.join(targetRoot, 'SKILL.md'), instructions, 'utf-8')

  const copyTargets = new Set<string>(DEFAULT_SKILL_RESOURCE_DIRS)
  for (const item of declaredResources) {
    const normalized = normalizeSkillResourcePath(item)
    const topLevel = normalized.split('/').filter(Boolean)[0]
    if (topLevel && topLevel !== 'SKILL.md') copyTargets.add(topLevel)
  }

  for (const entryName of copyTargets) {
    const sourcePath = path.join(sourceRoot, entryName)
    if (!(await fileExists(sourcePath))) continue
    await fs.cp(sourcePath, path.join(targetRoot, entryName), { recursive: true, force: true })
  }
}

export async function installSkillPackageFromGitHub(
  skillId: string,
  sourceInfo: { owner: string; repo: string; ref: string; skillRootPath: string; skillMdPath: string },
  instructions: string,
  declaredResources: string[],
  downloadGitHubPathToLocalFn: (
    sourceInfo: { owner: string; repo: string; ref: string; skillRootPath: string; skillMdPath: string },
    remotePath: string,
    targetPath: string,
    optional: boolean,
  ) => Promise<boolean>,
) {
  const targetRoot = path.join(SKILLS_DIR, skillId)
  await fs.rm(targetRoot, { recursive: true, force: true })
  await fs.mkdir(targetRoot, { recursive: true })
  await fs.writeFile(path.join(targetRoot, 'SKILL.md'), instructions, 'utf-8')

  const copyTargets = new Set<string>(DEFAULT_SKILL_RESOURCE_DIRS)
  for (const item of declaredResources) {
    const normalized = normalizeSkillResourcePath(item)
    const topLevel = normalized.split('/').filter(Boolean)[0]
    if (topLevel && topLevel !== 'SKILL.md') copyTargets.add(topLevel)
  }

  const { joinPosixPath } = await import('./utils')
  for (const entryName of copyTargets) {
    const remotePath = joinPosixPath(sourceInfo.skillRootPath, entryName)
    await downloadGitHubPathToLocalFn(sourceInfo, remotePath, path.join(targetRoot, entryName), true)
  }
}

/* ------------------------------------------------------------------ */
/*  workspace skill 目录                                                */
/* ------------------------------------------------------------------ */

export function resolveWorkspaceSkillDirs(workspace: string): string[] {
  const base = normalizeWorkspace(workspace)
  if (!base) return []

  return [
    path.join(base, '.taco', 'skills'),
    path.join(base, '.openclaw', 'skills'),
  ]
}
