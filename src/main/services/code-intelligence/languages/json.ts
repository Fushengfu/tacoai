/**
 * JSON 查询模式
 *
 * tree-sitter-json AST 节点类型：
 * - pair key: (string)
 * - object / array 嵌套结构
 */

import type { LanguageQueries, SymbolKind } from './registry'

export const queries: LanguageQueries = {
  symbolQuery: `
    [
      (pair key: (string) @key.name)
    ]
  `,

  captureToKind(name: string): SymbolKind | null {
    if (name.startsWith('key')) return 'variable'
    return null
  },

  isDefinitionContext(_parent, _node, _kind) {
    return true
  },
}
