/**
 * Skills Frontmatter 解析模块
 *
 * 解析 SKILL.md 中的 YAML frontmatter 块，提取技能元数据。
 * 所有函数均为纯函数，不持有模块级状态。
 */

import type { ParsedSkillMeta, SkillRequires } from './utils'
import { EMPTY_REQUIRES, dedupeList, stripQuotes, parseBoolean, parseStringList, leadingSpaces } from './utils'

/* ------------------------------------------------------------------ */
/*  主解析入口                                                          */
/* ------------------------------------------------------------------ */

export function parseSkillMeta(content: string): ParsedSkillMeta {
  const meta: ParsedSkillMeta = {
    requires: { bins: [], env: [], config: [] },
    env: {},
    tools: [],
    resources: [],
  }

  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/)
  if (fmMatch) {
    parseFrontmatterBlock(fmMatch[1], meta)
  }

  if (!meta.name) {
    const titleMatch = content.match(/^#\s+(.+)$/m)
    if (titleMatch) {
      let name = titleMatch[1].trim()
      name = name.replace(/^Skill:\s*/i, '')
      meta.name = name
    }
  }

  return meta
}

/* ------------------------------------------------------------------ */
/*  Frontmatter 块解析                                                  */
/* ------------------------------------------------------------------ */

export function parseFrontmatterBlock(block: string, out: ParsedSkillMeta) {
  const lines = block.split(/\r?\n/)

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const indent = leadingSpaces(raw)
    const kv = trimmed.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/)
    if (!kv) continue
    const key = kv[1].toLowerCase()
    const value = kv[2].trim()

    if (key === 'metadata') {
      if (value) {
        extractClawHubRequires(value, out)
      } else {
        const consumed = consumeIndentedBlock(lines, i + 1, indent)
        extractClawHubRequiresFromBlock(consumed.block, out)
        i = consumed.nextIndex - 1
      }
      continue
    }
    if (key === 'env' && !value) {
      const consumed = consumeIndentedBlock(lines, i + 1, indent)
      mergeEnvMap(out.env, parseKeyValueBlock(consumed.block))
      i = consumed.nextIndex - 1
      continue
    }
    if (key === 'requires' && !value) {
      const consumed = consumeIndentedBlock(lines, i + 1, indent)
      mergeRequires(out.requires, parseRequiresBlock(consumed.block))
      i = consumed.nextIndex - 1
      continue
    }
    if (key === 'tools' && !value) {
      const consumed = consumeIndentedBlock(lines, i + 1, indent)
      out.tools = dedupeList([...out.tools, ...parseListBlock(consumed.block)])
      i = consumed.nextIndex - 1
      continue
    }
    if (key === 'resources' && !value) {
      const consumed = consumeIndentedBlock(lines, i + 1, indent)
      out.resources = dedupeList([...out.resources, ...parseListBlock(consumed.block)])
      i = consumed.nextIndex - 1
      continue
    }

    if (key === 'name') out.name = stripQuotes(value)
    else if (key === 'description') out.description = stripQuotes(value)
    else if (key === 'version') out.version = stripQuotes(value)
    else if (key === 'author') out.author = stripQuotes(value)
    else if (key === 'enabled') out.enabled = parseBoolean(value)
    else if (key === 'requires_bins' || key === 'requires.bin' || key === 'requires.bins') out.requires.bins = dedupeList(parseStringList(value))
    else if (key === 'requires_env' || key === 'requires.environment' || key === 'requires.env') out.requires.env = dedupeList(parseStringList(value))
    else if (key === 'requires_config' || key === 'requires.config') out.requires.config = dedupeList(parseStringList(value))
    else if (key === 'tools' || key === 'allowed_tools' || key === 'tool_names') out.tools = dedupeList([...out.tools, ...parseStringList(value)])
    else if (key === 'resources' || key === 'resource_paths') out.resources = dedupeList([...out.resources, ...parseStringList(value)])
    else if (key.startsWith('env.')) out.env[key.slice(4)] = stripQuotes(value)
    else if (key === 'env_json') mergeEnvMap(out.env, parseInlineMap(value))
  }
}

/* ------------------------------------------------------------------ */
/*  缩进块消费                                                          */
/* ------------------------------------------------------------------ */

export function consumeIndentedBlock(
  lines: string[],
  startIndex: number,
  parentIndent: number,
): { block: string[]; nextIndex: number } {
  const block: string[] = []
  let i = startIndex
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()
    const indent = leadingSpaces(line)
    if (trimmed && indent <= parentIndent) break
    if (!trimmed) {
      block.push('')
      i++
      continue
    }
    const offset = Math.min(line.length, parentIndent + 2)
    block.push(line.slice(offset))
    i++
  }
  return { block, nextIndex: i }
}

/* ------------------------------------------------------------------ */
/*  requires / env / tools / resources 块解析                           */
/* ------------------------------------------------------------------ */

export function parseRequiresBlock(lines: string[]): SkillRequires {
  const out: SkillRequires = { bins: [], env: [], config: [] }
  let currentListKey: keyof SkillRequires | null = null
  for (const raw of lines) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    const listItem = trimmed.match(/^-\s*(.+)$/)
    if (listItem && currentListKey) {
      const value = stripQuotes(listItem[1].trim())
      if (value) out[currentListKey] = dedupeList([...out[currentListKey], value])
      continue
    }
    const kv = trimmed.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/)
    if (!kv) {
      currentListKey = null
      continue
    }
    const key = kv[1].toLowerCase()
    const value = kv[2].trim()
    const normalizedKey: keyof SkillRequires | null =
      key === 'bins' || key === 'bin'
        ? 'bins'
        : (key === 'env' || key === 'environment'
            ? 'env'
            : (key === 'config' ? 'config' : null))
    if (!normalizedKey) {
      currentListKey = null
      continue
    }
    if (value) out[normalizedKey] = dedupeList(parseStringList(value))
    currentListKey = normalizedKey
  }
  return out
}

export function parseKeyValueBlock(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of lines) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    const kv = trimmed.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/)
    if (!kv) continue
    out[kv[1]] = stripQuotes(kv[2].trim())
  }
  return out
}

export function parseListBlock(lines: string[]): string[] {
  const out: string[] = []
  for (const raw of lines) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    const listItem = trimmed.match(/^-\s*(.+)$/)
    if (listItem) {
      const value = stripQuotes(listItem[1].trim())
      if (value) out.push(value)
      continue
    }
    const kv = trimmed.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/)
    if (!kv) continue
    const inlineValues = parseStringList(kv[2].trim())
    for (const value of inlineValues) out.push(value)
  }
  return dedupeList(out)
}

export function parseInlineMap(raw: string): Record<string, string> {
  const text = String(raw ?? '').trim()
  if (!text) return {}
  if (text.startsWith('{') && text.endsWith('}')) {
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const out: Record<string, string> = {}
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          out[k] = String(v ?? '')
        }
        return out
      }
    } catch {
      // ignore
    }
  }
  const out: Record<string, string> = {}
  for (const pair of text.split(',')) {
    const [k, ...rest] = pair.split('=')
    const key = String(k ?? '').trim()
    if (!key) continue
    out[key] = stripQuotes(rest.join('=').trim())
  }
  return out
}

/* ------------------------------------------------------------------ */
/*  合并 / ClawHub metadata 提取                                        */
/* ------------------------------------------------------------------ */

export function mergeRequires(base: SkillRequires, next: SkillRequires) {
  base.bins = dedupeList([...base.bins, ...next.bins])
  base.env = dedupeList([...base.env, ...next.env])
  base.config = dedupeList([...base.config, ...next.config])
}

/** 从 ClawHub metadata JSON 字符串中提取 requires */
export function extractClawHubRequires(raw: string, out: ParsedSkillMeta) {
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const ocl = (parsed as Record<string, unknown>).openclaw
      if (ocl && typeof ocl === 'object' && !Array.isArray(ocl)) {
        const req = (ocl as Record<string, unknown>).requires
        if (req && typeof req === 'object' && !Array.isArray(req)) {
          const r = req as Record<string, unknown>
          if (Array.isArray(r.bins)) {
            out.requires.bins = dedupeList([...out.requires.bins, ...r.bins.map((v) => String(v ?? '').trim()).filter(Boolean)])
          }
          if (Array.isArray(r.env)) {
            out.requires.env = dedupeList([...out.requires.env, ...r.env.map((v) => String(v ?? '').trim()).filter(Boolean)])
          }
          if (Array.isArray(r.config)) {
            out.requires.config = dedupeList([...out.requires.config, ...r.config.map((v) => String(v ?? '').trim()).filter(Boolean)])
          }
        }
      }
    }
  } catch {
    // not valid JSON, silently ignore
  }
}

/** 从 ClawHub metadata 多行 YAML 块中提取 requires */
export function extractClawHubRequiresFromBlock(block: string[], out: ParsedSkillMeta) {
  for (const raw of block) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    const kv = trimmed.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/)
    if (!kv) continue
    const key = kv[1].toLowerCase()
    const value = kv[2].trim()
    if (key === 'openclaw' && value) {
      extractClawHubRequires(value, out)
    }
  }
}

export function mergeEnvMap(base: Record<string, string>, next: Record<string, string>) {
  for (const [k, v] of Object.entries(next)) {
    const key = String(k ?? '').trim()
    if (!key) continue
    base[key] = String(v ?? '')
  }
}
