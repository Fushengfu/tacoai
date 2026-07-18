/**
 * Kotlin 查询模式
 *
 * Kotlin tree-sitter 节点不使用 field name，名称作为直接子节点出现。
 * class/interface/enum → type_identifier，function → simple_identifier。
 */

import type { LanguageQueries, SymbolKind } from './registry'

export const queries: LanguageQueries = {
  symbolQuery: `
    [
      (function_declaration (simple_identifier) @func.name)
      (class_declaration (type_identifier) @class.name)
      (object_declaration (type_identifier) @class.name)
    ]
  `,

  captureToKind(name: string): SymbolKind | null {
    if (name.startsWith('func')) return 'function'
    if (name.startsWith('class')) return 'class'
    return null
  },

  isDefinitionContext(parent, node, kind) {
    const defTypes = new Set([
      'function_declaration',
      'class_declaration',
      'object_declaration',
    ])
    if (!defTypes.has(parent.type)) return false
    // Kotlin 节点没有 field name，直接检查 node 是否是 parent 的命名子节点
    const namedChildren = parent.namedChildren
    return namedChildren.length > 0 && namedChildren[0]?.id === node.id
  },
}
