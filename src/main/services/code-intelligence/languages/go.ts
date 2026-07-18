/**
 * Go 查询模式
 *
 * Go 语法要点：
 * - function_declaration  name: (identifier)
 * - method_declaration    name: (field_identifier)
 * - type_declaration      → type_spec name: (type_identifier)，涵盖 struct / interface / type alias
 * - 没有 enum（Go 用 const iota）
 */

import type { LanguageQueries, SymbolKind } from './registry'

export const queries: LanguageQueries = {
  symbolQuery: `
    [
      (function_declaration name: (identifier) @func.name)
      (method_declaration name: (field_identifier) @method.name)
      (type_declaration (type_spec name: (type_identifier) @type.name))
    ]
  `,

  captureToKind(name: string): SymbolKind | null {
    if (name.startsWith('func')) return 'function'
    if (name.startsWith('method')) return 'method'
    if (name.startsWith('type')) return 'type'
    return null
  },

  isDefinitionContext(parent, node, _kind) {
    const defTypes = new Set([
      'function_declaration',
      'method_declaration',
      'type_spec',
    ])
    if (!defTypes.has(parent.type)) return false
    const nameField = parent.childForFieldName('name')
    return nameField?.id === node.id
  },
}
