/**
 * tree-sitter AST 查询引擎
 *
 * 支持多语言的符号搜索。通过 LanguageInfo 路由到对应语言的查询模式。
 * 查询字符串由 LanguageQueries 缓存，避免重复编译。
 */

import Parser from 'tree-sitter'
import type { LanguageInfo, SymbolKind } from './languages/registry'

// Re-export for consumers
export type { SymbolKind }

export interface SymbolInfo {
  name: string
  kind: SymbolKind
  filePath: string
  line: number       // 1-based
  column: number     // 1-based
  parentName?: string
}

/* ------------------------------------------------------------------ */
/*  Query cache                                                        */
/* ------------------------------------------------------------------ */

const queryCache = new Map<string, Parser.Query>()

function getQuery(lang: any, pattern: string): Parser.Query {
  const key = `${pattern}`
  let q = queryCache.get(key)
  if (!q) {
    q = new Parser.Query(lang, pattern)
    queryCache.set(key, q)
  }
  return q
}

/** 引用查询缓存：按语言对象引用缓存，避免 node type ID 跨语言冲突 */
const referenceQueryCache = new Map<any, Parser.Query>()

/**
 * 获取当前语言的引用查询。
 *
 * 不同语言的标识符节点名：
 * - C/Java/Python/Ruby/Scala: identifier
 * - C++:               identifier(free func) / field_identifier(method call)
 * - Go:                identifier(plain func) / field_identifier(method)
 * - TS/JS:             identifier(plain) / property_identifier(obj.method)
 * - Rust:              identifier / field_identifier(method)
 * - PHP:               name（函数/方法调用）
 * - Swift/Kotlin:      simple_identifier
 * - Bash:              word（命令名）
 * - Haskell:           variable
 *
 * 实现：逐个探测该语言支持哪些标识符节点类型，然后构建复合查询。
 * 结果按语言缓存，只探测一次。
 */
function getReferenceQuery(lang: any): Parser.Query {
  let q = referenceQueryCache.get(lang)
  if (q) return q

  const candidates = [
    'identifier',           // C, Go(plain func), Java, Python, Ruby, Scala, Rust, TS/JS(plain)
    'field_identifier',     // C++, Go(method), Rust(method)
    'property_identifier',  // TS/JS (obj.prop, obj.method())
    'type_identifier',      // TS/JS(type refs)
    'name',                 // PHP (function/method call)
    'simple_identifier',    // Swift, Kotlin
    'word',                 // Bash (command name)
    'variable',             // Haskell (variable reference)
    'function',             // Perl (function call name)
  ]
  const supported: string[] = []
  for (const nodeType of candidates) {
    try {
      new Parser.Query(lang, `(${nodeType}) @ref`)
      supported.push(nodeType)
    } catch {
      // 该语言不支持此节点类型，跳过
    }
  }

  const pattern = `[${supported.map((t) => `(${t})`).join(' ')}] @ref`
  q = new Parser.Query(lang, pattern)
  referenceQueryCache.set(lang, q)
  return q
}

/* ------------------------------------------------------------------ */
/*  Queries                                                             */
/* ------------------------------------------------------------------ */

/** 查找所有命名符号（函数/方法/类/接口/类型/枚举/变量） */
export function findAllSymbols(
  root: Parser.SyntaxNode,
  filePath: string,
  langInfo: LanguageInfo,
): SymbolInfo[] {
  const { lang, queries } = langInfo
  let query: Parser.Query
  try {
    query = getQuery(lang, queries.symbolQuery)
  } catch {
    // 查询模式不兼容当前 tree-sitter 版本（如节点类型不存在），返回空结果
    return []
  }

  const symbols: SymbolInfo[] = []
  for (const match of query.matches(root)) {
    for (const capture of match.captures) {
      const kind = queries.captureToKind(capture.name)
      if (!kind) continue
      symbols.push({
        name: capture.node.text,
        kind,
        filePath,
        line: capture.node.startPosition.row + 1,
        column: capture.node.startPosition.column + 1,
      })
    }
  }
  return symbols
}

/** 查找指定符号的所有引用（调用/使用位置） */
export function findReferences(
  root: Parser.SyntaxNode,
  symbolName: string,
  symbolKind: SymbolKind,
  langInfo: LanguageInfo,
): Array<{ filePath: string; line: number; column: number; context: string }> {
  const { lang, queries } = langInfo
  const results: Array<{ filePath: string; line: number; column: number; context: string }> = []

  // 查找所有标识符引用（复合查询：覆盖 identifier / field_identifier / property_identifier / type_identifier）
  const refQuery = getReferenceQuery(lang)
  for (const match of refQuery.matches(root)) {
    for (const capture of match.captures) {
      if (capture.node.text !== symbolName) continue

      // 跳过定义本身
      const parent = capture.node.parent
      if (parent && queries.isDefinitionContext(parent, capture.node, symbolKind)) continue

      const line = capture.node.startPosition.row + 1
      const column = capture.node.startPosition.column + 1
      const source = root.text
      const lineStart = source.lastIndexOf('\n', capture.node.startIndex) + 1
      const lineEnd = source.indexOf('\n', capture.node.endIndex)
      const context = source.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim()

      results.push({ filePath: '', line, column, context })
    }
  }
  return results
}

/** 查找指定符号的定义（精确匹配名称+种类） */
export function findDefinition(
  root: Parser.SyntaxNode,
  symbolName: string,
  filePath: string,
  langInfo: LanguageInfo,
): SymbolInfo | null {
  const symbols = findAllSymbols(root, filePath, langInfo)
  const match = symbols.find((s) => s.name === symbolName)
  return match ?? null
}
