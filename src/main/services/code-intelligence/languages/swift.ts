/**
 * Swift 查询模式
 *
 * Swift 中 struct/enum/protocol 都使用 class_declaration 节点，
 * 通过节点文本中的关键字来区分。
 */

import type { LanguageQueries, SymbolKind } from './registry'

export const queries: LanguageQueries = {
  symbolQuery: `
    [
      (function_declaration name: (simple_identifier) @func.name)
      (class_declaration name: (type_identifier) @class.name)
      (protocol_declaration name: (type_identifier) @interface.name)
    ]
  `,

  captureToKind(name: string): SymbolKind | null {
    if (name.startsWith('func')) return 'function'
    if (name.startsWith('class')) return 'class'
    if (name.startsWith('interface')) return 'interface'
    return null
  },

  isDefinitionContext(parent, node, kind) {
    const defTypes = new Set([
      'function_declaration',
      'class_declaration',
      'protocol_declaration',
    ])
    if (!defTypes.has(parent.type)) return false
    const nameField = parent.childForFieldName('name')
    return nameField?.id === node.id
  },
}
