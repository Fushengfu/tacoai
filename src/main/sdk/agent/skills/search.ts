/**
 * Skills 市场搜索模块
 *
 * 搜索 ClawHub / SkillHub 技能市场，获取技能详情与预览。
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { SkillPreview, ClawHubSearchResult, SkillHubSearchResult, SkillSearchResult } from '../types'
import { SKILLS_DIR, isClawHubSlug, expandTilde, toSkillId, inferCategory, inferTags, getLogger } from './utils'
import { parseSkillMeta } from './frontmatter'
import { auditSkillSecurity } from './security'
import { parseGitHubSkillSource, downloadGitHubTextFile } from './github'
import { toRawGitHubUrl } from './utils'

/* ------------------------------------------------------------------ */
/*  分类映射                                                            */
/* ------------------------------------------------------------------ */

/** 本地分类 ID → SkillHub API category key 映射 */
export const CATEGORY_TO_SKILLHUB_KEY: Record<string, string> = {
  'office':    'office-efficiency',
  'content':   'content-creation',
  'dev':       'dev-programming',
  'data':      'data-analysis',
  'design':    'design-media',
  'ai-agent':  'ai-agent',
  'knowledge': 'knowledge-management',
  'business':  'business-ops',
  'edu':       'education',
  'pro':       'professional',
  'itops':     'it-ops-security',
  'life':      'life-service',
}

/* ------------------------------------------------------------------ */
/*  结果标准化                                                          */
/* ------------------------------------------------------------------ */

function normalizeClawHubResult(item: ClawHubSearchResult): SkillSearchResult {
  return {
    slug: item.slug,
    displayName: item.displayName,
    summary: item.summary,
    downloads: item.downloads,
    version: item.version,
    authorName: item.owner?.displayName || item.ownerHandle || '未知',
    authorAvatar: item.owner?.image,
    source: 'clawhub',
  }
}

function normalizeSkillHubResult(item: SkillHubSearchResult): SkillSearchResult {
  return {
    slug: item.slug,
    displayName: item.name,
    summary: item.description_zh || item.description,
    downloads: item.downloads,
    version: item.version,
    authorName: item.ownerName || '未知',
    authorAvatar: item.ownerAvatar,
    source: 'skillhub',
    stars: item.stars,
    installs: item.installs,
    category: item.category,
    subCategories: item.subCategories?.map((c) => c.name),
  }
}

/* ------------------------------------------------------------------ */
/*  API 搜索                                                            */
/* ------------------------------------------------------------------ */

async function searchClawHub(query: string): Promise<ClawHubSearchResult[]> {
  const q = String(query ?? '').trim()
  if (!q) return []

  const _log = getLogger()
  try {
    const apiUrl = `https://clawhub.ai/api/v1/search?q=${encodeURIComponent(q)}`
    const resp = await fetch(apiUrl, {
      headers: { Accept: 'application/json', 'User-Agent': 'taco-ai-agent' },
    })
    if (!resp.ok) {
      _log('SKILLS_SEARCH_FAILED', { status: resp.status, statusText: resp.statusText, source: 'clawhub' }, 'skills')
      return []
    }
    const data = await resp.json() as { results?: ClawHubSearchResult[] }
    const results = Array.isArray(data?.results) ? data.results : []
    _log('SKILLS_SEARCH_SUCCESS', { query: q, count: results.length, source: 'clawhub' }, 'skills')
    return results
  } catch (err) {
    _log('SKILLS_SEARCH_ERROR', { error: String(err), source: 'clawhub' }, 'skills')
    return []
  }
}

async function searchSkillHubApi(query: string, pageSize = 20, category?: string): Promise<SkillHubSearchResult[]> {
  const q = String(query ?? '').trim()
  if (!q && !category) return []

  const _log = getLogger()
  try {
    let apiUrl = `https://api.skillhub.cn/api/skills?keyword=${encodeURIComponent(q)}&sortBy=score&pageSize=${pageSize}`
    if (category) {
      const skillHubKey = CATEGORY_TO_SKILLHUB_KEY[category] || category
      apiUrl += `&category=${encodeURIComponent(skillHubKey)}`
    }
    const resp = await fetch(apiUrl, {
      headers: { Accept: 'application/json', 'User-Agent': 'taco-ai-agent' },
    })
    if (!resp.ok) {
      _log('SKILLS_SEARCH_FAILED', { status: resp.status, statusText: resp.statusText, source: 'skillhub' }, 'skills')
      return []
    }
    const data = await resp.json() as { code?: number; data?: { skills?: SkillHubSearchResult[]; total?: number } }
    const results = Array.isArray(data?.data?.skills) ? data.data.skills : []
    _log('SKILLS_SEARCH_SUCCESS', { query: q, count: results.length, total: data?.data?.total, source: 'skillhub', category }, 'skills')
    return results
  } catch (err) {
    _log('SKILLS_SEARCH_ERROR', { error: String(err), source: 'skillhub' }, 'skills')
    return []
  }
}

/* ------------------------------------------------------------------ */
/*  公开搜索 API                                                        */
/* ------------------------------------------------------------------ */

/**
 * 搜索技能市场（支持多源）
 */
export async function searchSkills(
  query: string,
  source: 'clawhub' | 'skillhub' | 'all' = 'all',
  category?: string,
): Promise<SkillSearchResult[]> {
  const q = String(query ?? '').trim()
  if (!q && !category) return []

  const _log = getLogger()
  let unified: SkillSearchResult[] = []

  if (source === 'clawhub') {
    const clawhubResults = await searchClawHub(q)
    unified = clawhubResults.map(normalizeClawHubResult)
  } else if (source === 'skillhub') {
    const skillHubResults = await searchSkillHubApi(q, 20, category)
    unified = skillHubResults.map(normalizeSkillHubResult)
  } else {
    // all: 并行搜索两个源
    const [clawhubResults, skillHubResults] = await Promise.all([
      searchClawHub(q).catch(() => [] as ClawHubSearchResult[]),
      searchSkillHubApi(q, 20, category).catch(() => [] as SkillHubSearchResult[]),
    ])

    const seen = new Set<string>()
    const merged: SkillSearchResult[] = []

    for (const item of clawhubResults) {
      const r = normalizeClawHubResult(item)
      if (!seen.has(r.slug)) {
        seen.add(r.slug)
        merged.push(r)
      }
    }
    for (const item of skillHubResults) {
      const r = normalizeSkillHubResult(item)
      if (!seen.has(r.slug)) {
        seen.add(r.slug)
        merged.push(r)
      }
    }

    merged.sort((a, b) => b.downloads - a.downloads)
    unified = merged
  }

  _log('SKILLS_SEARCH_UNIFIED', { query: q, source, category, count: unified.length }, 'skills')
  return unified
}

/* ------------------------------------------------------------------ */
/*  技能详情获取（按来源路由）                                            */
/* ------------------------------------------------------------------ */

export async function getSkillDetail(source: string, slug: string): Promise<string> {
  if (source === 'skillhub') return getSkillHubDetail(slug)
  return getClawHubSkillDetail(slug)
}

export async function getClawHubSkillDetail(slug: string): Promise<string> {
  const normalizedSlug = String(slug ?? '').trim()
  if (!normalizedSlug) return ''

  const _log = getLogger()
  try {
    const apiUrl = `https://clawhub.ai/api/v1/skills/${encodeURIComponent(normalizedSlug)}/file?path=SKILL.md`
    const resp = await fetch(apiUrl, {
      headers: { Accept: 'text/plain', 'User-Agent': 'taco-ai-agent' },
    })
    if (!resp.ok) {
      _log('SKILLS_GET_DETAIL_FAILED', { slug: normalizedSlug, status: resp.status }, 'skills')
      return ''
    }
    const text = await resp.text()
    _log('SKILLS_GET_DETAIL_SUCCESS', { slug: normalizedSlug, length: text.length }, 'skills')
    return text
  } catch (err) {
    _log('SKILLS_GET_DETAIL_ERROR', { slug: normalizedSlug, error: String(err), source: 'clawhub' }, 'skills')
    return ''
  }
}

export async function getSkillHubDetail(slug: string): Promise<string> {
  const normalizedSlug = String(slug ?? '').trim()
  if (!normalizedSlug) return ''

  const _log = getLogger()
  try {
    const apiUrl = `https://api.skillhub.cn/api/v1/skills/${encodeURIComponent(normalizedSlug)}/file?path=SKILL.md`
    const resp = await fetch(apiUrl, {
      headers: { Accept: 'text/plain', 'User-Agent': 'taco-ai-agent' },
    })
    if (!resp.ok) {
      _log('SKILLS_GET_DETAIL_FAILED', { slug: normalizedSlug, status: resp.status, source: 'skillhub' }, 'skills')
      return ''
    }
    const text = await resp.text()
    _log('SKILLS_GET_DETAIL_SUCCESS', { slug: normalizedSlug, length: text.length, source: 'skillhub' }, 'skills')
    return text
  } catch (err) {
    _log('SKILLS_GET_DETAIL_ERROR', { slug: normalizedSlug, error: String(err), source: 'skillhub' }, 'skills')
    return ''
  }
}

export async function getLocalSkillDetail(id: string): Promise<string> {
  const normalizedId = String(id ?? '').trim()
  if (!normalizedId) return ''

  const _log = getLogger()
  try {
    const filePath = path.join(SKILLS_DIR, normalizedId, 'SKILL.md')
    const content = await fs.readFile(filePath, 'utf-8')
    return content
  } catch (err) {
    _log('SKILLS_GET_LOCAL_DETAIL_ERROR', { id: normalizedId, error: String(err) }, 'skills')
    return ''
  }
}

/* ------------------------------------------------------------------ */
/*  技能预览（安装前）                                                   */
/* ------------------------------------------------------------------ */

export async function previewSkill(source: string): Promise<SkillPreview> {
  let instructions: string
  let meta = parseSkillMeta('')
  let remoteGitHubSource = null

  if (source.startsWith('http://') || source.startsWith('https://')) {
    remoteGitHubSource = parseGitHubSkillSource(source)
    if (remoteGitHubSource) {
      instructions = await downloadGitHubTextFile(remoteGitHubSource, remoteGitHubSource.skillMdPath)
      meta = parseSkillMeta(instructions)
    } else {
      const rawUrl = toRawGitHubUrl(source)
      const resp = await fetch(rawUrl)
      if (!resp.ok) throw new Error(`Failed to fetch skill: ${resp.status} ${resp.statusText}`)
      instructions = await resp.text()
      meta = parseSkillMeta(instructions)
    }
  } else {
    const filePath = source.endsWith('SKILL.md') ? source : path.join(source, 'SKILL.md')
    const resolvedPath = expandTilde(filePath)
    try {
      instructions = await fs.readFile(resolvedPath, 'utf-8')
      meta = parseSkillMeta(instructions)
    } catch {
      throw new Error(`Cannot read skill file: ${resolvedPath}`)
    }
  }

  const id = isClawHubSlug(source) ? source : toSkillId(meta.name || `skill-${Date.now()}`)
  const securityCheck = auditSkillSecurity(instructions, meta)

  return {
    id,
    name: meta.name || id,
    description: meta.description || '',
    version: meta.version || '1.0.0',
    author: meta.author || 'Unknown',
    category: inferCategory(meta.name, meta.description, meta.tools),
    tags: inferTags(meta.name, meta.description, meta.tools),
    tools: meta.tools,
    resources: meta.resources,
    requiresBins: meta.requires.bins,
    requiresEnv: meta.requires.env,
    sourceUrl: source.startsWith('http') ? source : source,
    security: {
      riskLevel: securityCheck.riskLevel,
      warnings: securityCheck.warnings,
    },
  }
}
