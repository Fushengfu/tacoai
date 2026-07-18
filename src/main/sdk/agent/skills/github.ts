/**
 * Skills GitHub API 模块
 *
 * 解析 GitHub URL、获取仓库内容、下载 SKILL.md 与附属资源。
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { GitHubSkillSource } from './utils'
import { joinPosixPath, dirnamePosix, toRawGitHubUrl } from './utils'

/* ------------------------------------------------------------------ */
/*  GitHub URL 解析                                                     */
/* ------------------------------------------------------------------ */

export function parseGitHubSkillSource(source: string): GitHubSkillSource | null {
  let url: URL
  try {
    url = new URL(source)
  } catch {
    return null
  }

  const host = url.hostname.toLowerCase()
  const parts = url.pathname.split('/').filter(Boolean)

  if (host === 'raw.githubusercontent.com') {
    if (parts.length < 4) return null
    const [owner, repo, ref, ...rest] = parts
    const remotePath = rest.join('/')
    if (!remotePath) return null
    const skillMdPath = remotePath.endsWith('SKILL.md') ? remotePath : joinPosixPath(remotePath, 'SKILL.md')
    return {
      owner,
      repo,
      ref,
      skillMdPath,
      skillRootPath: dirnamePosix(skillMdPath),
    }
  }

  if (host !== 'github.com') return null
  if (parts.length < 2) return null

  const [owner, repo, mode, ref, ...rest] = parts
  if (!mode) {
    return {
      owner,
      repo,
      ref: 'main',
      skillMdPath: 'SKILL.md',
      skillRootPath: '',
    }
  }

  if ((mode === 'blob' || mode === 'tree') && ref) {
    const remotePath = rest.join('/')
    const skillMdPath = mode === 'blob'
      ? (remotePath.endsWith('SKILL.md') ? remotePath : '')
      : (remotePath ? joinPosixPath(remotePath, 'SKILL.md') : 'SKILL.md')
    if (!skillMdPath) return null
    return {
      owner,
      repo,
      ref,
      skillMdPath,
      skillRootPath: dirnamePosix(skillMdPath),
    }
  }

  return {
    owner,
    repo,
    ref: 'main',
    skillMdPath: 'SKILL.md',
    skillRootPath: '',
  }
}

/* ------------------------------------------------------------------ */
/*  GitHub API 请求工具                                                 */
/* ------------------------------------------------------------------ */

export function getGitHubAuthHeaders(): Record<string, string> {
  const token = String(process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '').trim()
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'taco-ai-agent',
  }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

export function buildGitHubContentsApiUrl(sourceInfo: GitHubSkillSource, remotePath: string): string {
  const encodedPath = remotePath
    .split('/')
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/')
  const base = `https://api.github.com/repos/${sourceInfo.owner}/${sourceInfo.repo}/contents`
  const pathPart = encodedPath ? `/${encodedPath}` : ''
  return `${base}${pathPart}?ref=${encodeURIComponent(sourceInfo.ref)}`
}

export async function fetchGitHubContents(
  sourceInfo: GitHubSkillSource,
  remotePath: string,
): Promise<{ ok: true; payload: unknown } | { ok: false; status: number; statusText: string }> {
  const resp = await fetch(buildGitHubContentsApiUrl(sourceInfo, remotePath), {
    headers: getGitHubAuthHeaders(),
  })
  if (!resp.ok) {
    return { ok: false, status: resp.status, statusText: resp.statusText }
  }
  return { ok: true, payload: await resp.json() }
}

/* ------------------------------------------------------------------*/
/*  文件下载                                                            */
/* ------------------------------------------------------------------ */

export async function downloadGitHubTextFile(sourceInfo: GitHubSkillSource, remotePath: string): Promise<string> {
  const result = await fetchGitHubContents(sourceInfo, remotePath)
  if (!result.ok) {
    throw new Error(`Failed to fetch GitHub skill file: ${result.status} ${result.statusText}`)
  }
  const payload = result.payload as Record<string, unknown>
  if (payload.type !== 'file') {
    throw new Error(`GitHub path is not a file: ${remotePath}`)
  }
  return (await readGitHubFileBuffer(payload)).toString('utf-8')
}

export async function downloadGitHubPathToLocal(
  sourceInfo: GitHubSkillSource,
  remotePath: string,
  targetPath: string,
  optional = false,
): Promise<boolean> {
  const result = await fetchGitHubContents(sourceInfo, remotePath)
  if (!result.ok) {
    if (optional && result.status === 404) return false
    throw new Error(`Failed to fetch GitHub skill resource: ${remotePath} (${result.status} ${result.statusText})`)
  }

  const payload = result.payload
  if (Array.isArray(payload)) {
    await fs.mkdir(targetPath, { recursive: true })
    for (const entry of payload) {
      const item = entry as Record<string, unknown>
      const childPath = String(item.path ?? '').trim()
      const childName = String(item.name ?? '').trim()
      const childType = String(item.type ?? '').trim()
      if (!childPath || !childName || !childType || childType === 'symlink' || childType === 'submodule') continue
      await downloadGitHubPathToLocal(sourceInfo, childPath, path.join(targetPath, childName), false)
    }
    return true
  }

  const item = payload as Record<string, unknown>
  if (item.type !== 'file') {
    if (optional) return false
    throw new Error(`Unsupported GitHub skill resource type at ${remotePath}: ${String(item.type ?? 'unknown')}`)
  }
  await fs.mkdir(path.dirname(targetPath), { recursive: true })
  await fs.writeFile(targetPath, await readGitHubFileBuffer(item))
  return true
}

export async function readGitHubFileBuffer(payload: Record<string, unknown>): Promise<Buffer> {
  const content = payload.content
  const encoding = String(payload.encoding ?? '').trim()
  if (typeof content === 'string' && encoding === 'base64') {
    return Buffer.from(content.replace(/\n/g, ''), 'base64')
  }
  const downloadUrl = String(payload.download_url ?? '').trim()
  if (downloadUrl) {
    const resp = await fetch(downloadUrl, {
      headers: getGitHubAuthHeaders(),
    })
    if (!resp.ok) {
      throw new Error(`Failed to download GitHub file: ${resp.status} ${resp.statusText}`)
    }
    return Buffer.from(await resp.arrayBuffer())
  }
  throw new Error('GitHub file payload does not contain readable content')
}
