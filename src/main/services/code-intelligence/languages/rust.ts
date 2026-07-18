/**
 * Rust 查询模式
 *
 * Rust 语法要点：
 * - function_item   name: (identifier)
 * - struct_item     name: (type_identifier)
 * - enum_item       name: (type_identifier)
 * - trait_item      name: (type_identifier) → 映射为 interface
 * - type_item       name: (type_identifier) → type alias
 * - impl_item       中的方法使用 identifier，但无 name 字段（self 相关）
 */

import type { LanguageQueries, SymbolKind } from './registry'

export const queries: LanguageQueries = {
  symbolQuery: `
    [
      (function_item name: (identifier) @func.name)
      (struct_item name: (type_identifier) @struct.name)
      (enum_item name: (type_identifier) @enum.name)
      (trait_item name: (type_identifier) @interface.name)
      (type_item name: (type_identifier) @type.name)
    ]
  `,

  captureToKind(name: string): SymbolKind | null {
    if (name.startsWith('func')) return 'function'
    if (name.startsWith('struct')) return 'struct'
    if (name.startsWith('enum')) return 'enum'
    if (name.startsWith('interface')) return 'interface'
    if (name.startsWith('type')) return 'type'
    return null
  },

  isDefinitionContext(parent, node, _kind) {
    const defTypes = new Set([
      'function_item',
      'struct_item',
      'enum_item',
      'trait_item',
      'type_item',
    ])
    if (!defTypes.has(parent.type)) return false
    const nameField = parent.childForFieldName('name')
    return nameField?.id === node.id
  },
}
