/**
 * HTML 查询模式
 *
 * tree-sitter-html AST 节点类型：
 * - element > start_tag > tag_name
 * - element > (id_attribute | class_attribute)
 */

import type { LanguageQueries, SymbolKind } from './registry'

export const queries: LanguageQueries = {
  symbolQuery: `
    [
      (element (start_tag (tag_name) @tag.name))
    ]
  `,

  captureToKind(name: string): SymbolKind | null {
    if (name.startsWith('tag')) return 'type'
    return null
  },

  isDefinitionContext(_parent, _node, _kind) {
    return true
  },
}
