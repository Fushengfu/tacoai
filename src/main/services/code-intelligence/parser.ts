/**
 * tree-sitter 解析器封装 + LRU 缓存
 *
 * 解析一次，缓存 N 个文件的 AST。文件变更后缓存自动失效。
 * 支持多语言（TS/TSX/JS/JSX/Python/Go/Rust），通过语言注册表路由。
 */

import Parser from 'tree-sitter'
import { detectLanguage, supportedExtensions } from './languages/registry'
import type { LanguageInfo } from './languages/registry'

/* ------------------------------------------------------------------ */
/*  LRU Cache                                                          */
/* ------------------------------------------------------------------ */

interface CacheEntry {
  tree: Parser.Tree
  langInfo: LanguageInfo
  timestamp: number
}

const MAX_CACHE_SIZE = 64
const cache = new Map<string, CacheEntry>()

function evictLru(): void {
  let oldestKey = ''
  let oldestTime = Infinity
  for (const [key, entry] of cache) {
    if (entry.timestamp < oldestTime) {
      oldestTime = entry.timestamp
      oldestKey = key
    }
  }
  if (oldestKey) cache.delete(oldestKey)
}

/* ------------------------------------------------------------------ */
/*  Public API                                                          */
/* ------------------------------------------------------------------ */

/** 解析文件，返回 AST。结果会被 LRU 缓存。 */
export function parseFile(filePath: string, source: string): Parser.Tree {
  const cached = cache.get(filePath)
  if (cached) {
    cached.tree = parseWithLang(source, cached.langInfo.lang)
    cached.timestamp = Date.now()
    return cached.tree
  }

  const langInfo = detectLanguage(filePath)
  if (!langInfo) {
    throw new Error(`Unsupported language for file: ${filePath}. Supported extensions: ${supportedExtensions().join(' ')}`)
  }

  if (cache.size >= MAX_CACHE_SIZE) evictLru()

  const tree = parseWithLang(source, langInfo.lang)
  cache.set(filePath, { tree, langInfo, timestamp: Date.now() })
  return tree
}

/** 获取文件的语言信息（如果已缓存则返回缓存的，否则从扩展名检测） */
export function getLanguageInfo(filePath: string): LanguageInfo | null {
  const cached = cache.get(filePath)
  if (cached) return cached.langInfo
  return detectLanguage(filePath)
}

/** 使指定文件的缓存失效 */
export function invalidateCache(filePath: string): void {
  cache.delete(filePath)
}

/** 清空全部缓存 */
export function clearCache(): void {
  cache.clear()
}

/** 获取缓存大小（供测试使用） */
export function getCacheSize(): number {
  return cache.size
}

/* ------------------------------------------------------------------ */
/*  Internal helpers                                                    */
/* ------------------------------------------------------------------ */

const parserPool: Parser[] = []

function getParser(): Parser {
  return parserPool.pop() ?? new Parser()
}

function releaseParser(parser: Parser): void {
  if (parserPool.length < 4) parserPool.push(parser)
}

function parseWithLang(source: string, lang: any): Parser.Tree {
  const parser = getParser()
  parser.setLanguage(lang)
  const tree = parser.parse(source)
  releaseParser(parser)
  return tree
}
