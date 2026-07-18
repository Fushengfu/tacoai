/**
 * Skills 管理器（主入口）
 *
 * 模块状态 + 公共 API 组装。具体实现拆分到：
 *   builtin.ts   — 内置技能常量
 *   utils.ts     — 类型 / 路径 / 纯函数 / 日志器
 *   frontmatter.ts — YAML frontmatter 解析
 *   github.ts    — GitHub API
 *   security.ts  — 安全审核 + 需求门控
 *   search.ts    — 市场搜索 + 技能详情
 *   install.ts   — 安装/卸载/持久化/ZIP 解压
 *   loader.ts    — 技能文件加载
 *   runtime.ts   — 运行时输出（目录块 / 详情 / 资源 / 环境）
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import type { SkillInfo } from '../types'
import type { SkillEntry, PersistedSkill } from './utils'
import { EMPTY_REQUIRES, resolveSkillToolNames, dedupeList, interpolateEnv, sortSkillsForDisplay, getLogger, isClawHubSlug, SKILLS_DIR } from './utils'
import { setSkillsServiceLogger } from './utils'
import { BUILTIN_SKILLS } from './builtin'
import { parseSkillMeta } from './frontmatter'
import { parseGitHubSkillSource, downloadGitHubTextFile, downloadGitHubPathToLocal } from './github'
import { loadRuntimeConfig, resolveUnavailableReason, auditSkillSecurity } from './security'
import { searchSkills, previewSkill, getSkillDetail, getClawHubSkillDetail, getSkillHubDetail, getLocalSkillDetail } from './search'
import {
  buildClawHubDownloadUrl, buildSkillHubDownloadUrl,
  downloadAndExtractZip,
  loadPersistedSkills, savePersistedSkills, upsertPersistedSkill,
  loadSkillInstructionsFromPersisted, saveSkillInstructions,
  installSkillPackageFromLocalRoot, installSkillPackageFromGitHub,
  resolveWorkspaceSkillDirs, ensureDirs,
} from './install'
import { loadSkillsFromDirs } from './loader'
import {
  buildActiveSkillsCatalogBlock as buildCatalog,
  readActiveSkillDetail as readDetail,
  readActiveSkillResource as readResource,
  applySkillEnvironment as applyEnv,
  getSkillAllowedTools as getAllowedTools,
  getSkillRootDir as getRootDir,
} from './runtime'

/* ------------------------------------------------------------------ */
/*  日志器代理                                                          */
/* ------------------------------------------------------------------ */

export { setSkillsServiceLogger } from './utils'

/* ------------------------------------------------------------------ */
/*  模块状态                                                            */
/* ------------------------------------------------------------------ */

let allSkills: SkillInfo[] = []
let activeSkillInstructions: string[] = []
let activeSkillEnv: Record<string, string> = {}
let activeSkills: SkillInfo[] = []
let activeSkillEntries = new Map<string, SkillEntry>()
let lastWorkspaceForRefresh = ''
let refreshSeq = 0

/* ------------------------------------------------------------------ */
/*  初始化 / 刷新                                                        */
/* ------------------------------------------------------------------ */

export async function initSkills() {
  await ensureDirs()
  await refreshSkills()
}

export async function refreshSkills(workspace?: string): Promise<void> {
  const seq = ++refreshSeq
  const normalizedWorkspace = workspace
    ? path.resolve(String(workspace ?? '').trim())
    : ''
  lastWorkspaceForRefresh = normalizedWorkspace

  const persisted = await loadPersistedSkills()
  const persistedById = new Map<string, PersistedSkill>()
  for (const item of persisted) persistedById.set(item.id, item)

  const merged = new Map<string, SkillEntry>()

  for (const builtin of BUILTIN_SKILLS) {
    const saved = persistedById.get(builtin.id)
    merged.set(builtin.id, {
      scope: 'builtin' as const,
      requires: EMPTY_REQUIRES,
      env: {},
      skill: {
        ...builtin,
        enabled: typeof saved?.enabled === 'boolean' ? saved.enabled : builtin.enabled,
        tools: resolveSkillToolNames(builtin.tools ?? []),
        resources: dedupeList(builtin.resources ?? []),
      },
      tools: resolveSkillToolNames(builtin.tools ?? []),
      resources: dedupeList(builtin.resources ?? []),
    })
  }

  const globalEntries = await loadSkillsFromDirs(
    [SKILLS_DIR, path.join(os.homedir(), '.openclaw', 'skills')],
    'global',
    persistedById,
  )
  for (const entry of globalEntries) merged.set(entry.skill.id, entry)

  if (normalizedWorkspace) {
    const wsEntries = await loadSkillsFromDirs(
      resolveWorkspaceSkillDirs(normalizedWorkspace),
      'workspace',
      persistedById,
    )
    for (const entry of wsEntries) merged.set(entry.skill.id, entry)
  }

  for (const p of persisted) {
    if (p.source === 'builtin') continue
    if (merged.has(p.id)) continue
    if (p.instructionsFile) {
      const resolvedPath = path.resolve(SKILLS_DIR, p.instructionsFile)
      const alreadyLoaded = Array.from(merged.values()).some(
        (entry) => entry.rootDir && resolvedPath.startsWith(path.resolve(entry.rootDir))
      )
      if (alreadyLoaded) continue
    }
    const instructions = await loadSkillInstructionsFromPersisted(p)
    if (!instructions.trim()) continue
    merged.set(p.id, {
      scope: 'global',
      requires: EMPTY_REQUIRES,
      env: {},
      skill: {
        id: p.id,
        name: p.name,
        description: p.description,
        version: p.version,
        author: p.author,
        source: p.source,
        sourceUrl: p.sourceUrl,
        enabled: p.enabled,
        instructions,
        tools: resolveSkillToolNames(p.tools ?? []),
        resources: dedupeList(p.resources ?? []),
      },
      rootDir: path.join(SKILLS_DIR, p.id),
      tools: resolveSkillToolNames(p.tools ?? []),
      resources: dedupeList(p.resources ?? []),
    })
  }

  const runtimeConfig = await loadRuntimeConfig()
  const resolvedSkills = sortSkillsForDisplay(Array.from(merged.values()))
  const nextAllSkills = resolvedSkills.map((entry) => ({ ...entry.skill }))
  const nextInstructions: string[] = []
  const nextEnv: Record<string, string> = {}
  const nextActiveSkills: SkillInfo[] = []
  const nextActiveEntries = new Map<string, SkillEntry>()

  for (const entry of resolvedSkills) {
    const { skill } = entry
    if (!skill.enabled || !skill.instructions.trim()) continue
    const unavailable = await resolveUnavailableReason(entry.requires, runtimeConfig)
    if (unavailable) continue
    nextInstructions.push(skill.instructions)
    nextActiveSkills.push({ ...skill })
    nextActiveEntries.set(skill.id, {
      ...entry,
      skill: { ...skill },
      tools: resolveSkillToolNames(entry.tools ?? skill.tools ?? []),
      resources: dedupeList(entry.resources ?? skill.resources ?? []),
    })
    for (const [k, v] of Object.entries(entry.env)) {
      const key = String(k ?? '').trim()
      if (!key) continue
      nextEnv[key] = interpolateEnv(String(v ?? ''))
    }
  }

  if (seq !== refreshSeq) return

  allSkills = nextAllSkills
  activeSkillInstructions = nextInstructions
  activeSkillEnv = nextEnv
  activeSkills = nextActiveSkills
  activeSkillEntries = nextActiveEntries
}

/* ------------------------------------------------------------------ */
/*  公共 API — 列表 / 访问器                                             */
/* ------------------------------------------------------------------ */

export async function listSkills(workspace?: string): Promise<SkillInfo[]> {
  await refreshSkills(workspace || lastWorkspaceForRefresh || undefined)
  return allSkills.map((s) => ({ ...s }))
}

export function getActiveSkillInstructions(): string[] {
  return [...activeSkillInstructions]
}

export function getActiveSkillEnv(): Record<string, string> {
  return { ...activeSkillEnv }
}

export function getActiveSkills(): SkillInfo[] {
  return activeSkills.map((skill) => ({ ...skill }))
}

/* ------------------------------------------------------------------ */
/*  公共 API — 运行时输出（委托 runtime.ts）                              */
/* ------------------------------------------------------------------ */

export function buildActiveSkillsCatalogBlock(): string {
  return buildCatalog(activeSkills)
}

export function readActiveSkillDetail(skillId: string): { content: string; skill: SkillInfo } | null {
  return readDetail(skillId, activeSkills)
}

export async function readActiveSkillResource(
  skillId: string,
  relativePath: string,
): Promise<{ content: string; resolvedPath: string; skill: SkillInfo } | null> {
  return readResource(skillId, relativePath, activeSkillEntries)
}

export function applySkillEnvironment(envVars: Record<string, string>): () => void {
  return applyEnv(envVars)
}

export function getSkillAllowedTools(skillId: string): string[] {
  return getAllowedTools(skillId, activeSkillEntries)
}

export function getSkillRootDir(skillId: string): string | null {
  return getRootDir(skillId, activeSkillEntries)
}

/* ------------------------------------------------------------------ */
/*  公共 API — 搜索 / 预览 / 详情（委托 search.ts）                       */
/* ------------------------------------------------------------------ */

export { searchSkills, previewSkill, getSkillDetail, getClawHubSkillDetail, getSkillHubDetail, getLocalSkillDetail }

/* ------------------------------------------------------------------ */
/*  公共 API — 外部引用（executor.ts 使用）                                */
/* ------------------------------------------------------------------ */

export { isClawHubSlug } from './utils'
export { buildClawHubDownloadUrl, downloadAndExtractZip } from './install'

/* ------------------------------------------------------------------ */
/*  公共 API — 安装 / 卸载 / 切换                                        */
/* ------------------------------------------------------------------ */

export async function toggleSkill(id: string, enabled: boolean) {
  const current = allSkills.find((s) => s.id === id)
  if (!current) throw new Error(`Skill not found: ${id}`)
  const persisted = await loadPersistedSkills()
  const next = upsertPersistedSkill(persisted, {
    id,
    name: current.name,
    description: current.description,
    version: current.version,
    author: current.author,
    source: current.source,
    sourceUrl: current.sourceUrl,
    enabled,
  })
  await savePersistedSkills(next)
  await refreshSkills(lastWorkspaceForRefresh || undefined)
}

export async function uninstallSkill(id: string) {
  const current = allSkills.find((s) => s.id === id)
  if (!current) throw new Error(`Skill not found: ${id}`)
  if (current.source === 'builtin') throw new Error('Cannot uninstall builtin skill')

  const persisted = await loadPersistedSkills()
  const filtered = persisted.filter((s) => s.id !== id)
  await savePersistedSkills(filtered)

  const dir = path.join(SKILLS_DIR, id)
  try {
    await fs.rm(dir, { recursive: true })
  } catch {
    // ignore
  }

  await refreshSkills(lastWorkspaceForRefresh || undefined)
}

export async function installSkill(
  source: string,
  skipAudit?: boolean,
  preferredId?: string,
  authorOverride?: string,
): Promise<SkillInfo> {
  const _log = getLogger()
  let instructions: string
  let meta = parseSkillMeta('')
  let localSkillRoot = ''
  let clawHubTempDir = ''
  let remoteGitHubSource: ReturnType<typeof parseGitHubSkillSource> = null

  if (source.startsWith('http://') || source.startsWith('https://')) {
    remoteGitHubSource = parseGitHubSkillSource(source)
    if (remoteGitHubSource) {
      instructions = await downloadGitHubTextFile(remoteGitHubSource, remoteGitHubSource.skillMdPath)
      meta = parseSkillMeta(instructions)

      if (!skipAudit) {
        const securityCheck = auditSkillSecurity(instructions, meta)
        if (securityCheck.riskLevel === 'critical') {
          throw new Error(`拒绝安装高风险 Skill: ${securityCheck.warnings.join('; ')}`)
        }
        if (securityCheck.riskLevel === 'high') {
          _log('SKILL_SECURITY_WARNING', { source, riskLevel: securityCheck.riskLevel, warnings: securityCheck.warnings }, 'skills')
        }
      }
    } else {
      const { toRawGitHubUrl } = await import('./utils')
      const rawUrl = toRawGitHubUrl(source)
      const resp = await fetch(rawUrl)
      if (!resp.ok) throw new Error(`Failed to fetch skill: ${resp.status} ${resp.statusText}`)
      instructions = await resp.text()
      meta = parseSkillMeta(instructions)

      if (!skipAudit) {
        const securityCheck = auditSkillSecurity(instructions, meta)
        if (securityCheck.riskLevel === 'critical') {
          throw new Error(`拒绝安装高风险 Skill: ${securityCheck.warnings.join('; ')}`)
        }
        if (securityCheck.riskLevel === 'high') {
          _log('SKILL_SECURITY_WARNING', { source: rawUrl, riskLevel: securityCheck.riskLevel, warnings: securityCheck.warnings }, 'skills')
        }
      }
    }
  } else if (isClawHubSlug(source)) {
    clawHubTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'taco-skill-'))
    let installed = false

    try {
      const downloadUrl = buildClawHubDownloadUrl(source)
      await downloadAndExtractZip(downloadUrl, clawHubTempDir)
      installed = true
      _log('SKILL_INSTALL_SOURCE', { source, sourceType: 'clawhub' }, 'skills')
    } catch (clawhubErr) {
      _log('SKILL_INSTALL_CLAWHUB_FAILED', { source, error: String(clawhubErr) }, 'skills')
      try { await fs.rm(clawHubTempDir, { recursive: true, force: true }) } catch { /* ignore */ }
      clawHubTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'taco-skill-'))
      try {
        const downloadUrl = buildSkillHubDownloadUrl(source)
        await downloadAndExtractZip(downloadUrl, clawHubTempDir)
        installed = true
        _log('SKILL_INSTALL_SOURCE', { source, sourceType: 'skillhub' }, 'skills')
      } catch (skillhubErr) {
        throw new Error(`安装失败：ClawHub 和 SkillHub 均未找到技能"${source}"。ClawHub: ${String(clawhubErr)}；SkillHub: ${String(skillhubErr)}`)
      }
    }

    const findSkillMdDir = async (dir: string): Promise<string> => {
      try {
        await fs.access(path.join(dir, 'SKILL.md'))
        return dir
      } catch {
        const entries = await fs.readdir(dir)
        for (const entry of entries) {
          const subDir = path.join(dir, entry)
          try {
            const stat = await fs.stat(subDir)
            if (stat.isDirectory()) {
              const result = await findSkillMdDir(subDir)
              if (result) return result
            }
          } catch { /* ignore */ }
        }
      }
      return ''
    }

    const skillDir = await findSkillMdDir(clawHubTempDir)
    if (!skillDir) {
      throw new Error('下载的技能包中未找到 SKILL.md 文件')
    }

    instructions = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf-8')
    meta = parseSkillMeta(instructions)
    localSkillRoot = skillDir

    if (!skipAudit) {
      const securityCheck = auditSkillSecurity(instructions, meta)
      if (securityCheck.riskLevel === 'critical') {
        throw new Error(`拒绝安装高风险 Skill: ${securityCheck.warnings.join('; ')}`)
      }
      if (securityCheck.riskLevel === 'high') {
        _log('SKILL_SECURITY_WARNING', { source, riskLevel: securityCheck.riskLevel, warnings: securityCheck.warnings }, 'skills')
      }
    }
  } else {
    const { expandTilde, toSkillId } = await import('./utils')
    const filePath = source.endsWith('SKILL.md') ? source : path.join(source, 'SKILL.md')
    const resolvedPath = expandTilde(filePath)
    try {
      instructions = await fs.readFile(resolvedPath, 'utf-8')
      meta = parseSkillMeta(instructions)
      localSkillRoot = path.dirname(resolvedPath)

      if (!skipAudit) {
        const securityCheck = auditSkillSecurity(instructions, meta)
        if (securityCheck.riskLevel === 'critical') {
          throw new Error(`拒绝安装高风险 Skill: ${securityCheck.warnings.join('; ')}`)
        }
        if (securityCheck.riskLevel === 'high') {
          _log('SKILL_SECURITY_WARNING', { source: filePath, riskLevel: securityCheck.riskLevel, warnings: securityCheck.warnings }, 'skills')
        }
      }
    } catch {
      throw new Error(`Cannot read skill file: ${resolvedPath}`)
    }
  }

  const { toSkillId } = await import('./utils')
  const id = preferredId ?? (isClawHubSlug(source) ? source : toSkillId(meta.name || `skill-${Date.now()}`))
  const persisted = await loadPersistedSkills()

  if (localSkillRoot) {
    await installSkillPackageFromLocalRoot(id, localSkillRoot, instructions, meta.resources)
  } else if (remoteGitHubSource) {
    await installSkillPackageFromGitHub(id, remoteGitHubSource, instructions, meta.resources, downloadGitHubPathToLocal)
  } else {
    await saveSkillInstructions(id, instructions)
  }

  if (clawHubTempDir) {
    try { await fs.rm(clawHubTempDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }

  const existing = persisted.find((s) => s.id === id)
  const nextItem: PersistedSkill = {
    id,
    name: meta.name || existing?.name || id,
    description: meta.description || existing?.description || '',
    version: meta.version || existing?.version || '1.0.0',
    author: authorOverride || meta.author || existing?.author || 'Unknown',
    source: 'remote',
    sourceUrl: source.startsWith('http') ? source : undefined,
    enabled: true,
    instructionsFile: `${id}/SKILL.md`,
    tools: dedupeList(meta.tools),
    resources: dedupeList(meta.resources),
  }
  const next = upsertPersistedSkill(persisted, nextItem)
  await savePersistedSkills(next)
  await refreshSkills(lastWorkspaceForRefresh || undefined)

  const latest = allSkills.find((s) => s.id === id)
  return latest ? { ...latest } : {
    id: nextItem.id,
    name: nextItem.name,
    description: nextItem.description,
    version: nextItem.version,
    author: nextItem.author,
    source: nextItem.source,
    sourceUrl: nextItem.sourceUrl,
    enabled: nextItem.enabled,
    instructions,
  }
}

export async function checkSkillUpdate(id: string): Promise<{ hasUpdate: boolean; currentVersion: string; latestVersion: string; sourceUrl: string } | null> {
  const skill = allSkills.find((s) => s.id === id)
  if (!skill || !skill.sourceUrl) return null
  if (skill.source !== 'remote') return null

  const source = skill.sourceUrl
  if (!source.startsWith('http://') && !source.startsWith('https://')) return null

  try {
    const remoteGitHubSource = parseGitHubSkillSource(source)
    if (!remoteGitHubSource) return null

    const instructions = await downloadGitHubTextFile(remoteGitHubSource, remoteGitHubSource.skillMdPath)
    const meta = parseSkillMeta(instructions)
    const latestVersion = meta.version || '0.0.0'

    return {
      hasUpdate: latestVersion !== skill.version,
      currentVersion: skill.version,
      latestVersion,
      sourceUrl: source,
    }
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/*  调试                                                                */
/* ------------------------------------------------------------------ */

export function debugDumpSkillsState() {
  const _log = getLogger()
  _log('SKILLS_STATE', {
    total: allSkills.length,
    activeCount: activeSkillInstructions.length,
    activeEnvKeys: Object.keys(activeSkillEnv),
    workspace: lastWorkspaceForRefresh || null,
    ids: allSkills.map((s) => s.id),
  })
}
