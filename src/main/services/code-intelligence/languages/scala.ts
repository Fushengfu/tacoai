/**
 * Scala 查询模式
 */

import type { LanguageQueries, SymbolKind } from './registry'

export const queries: LanguageQueries = {
  symbolQuery: `
    [
      (function_definition name: (identifier) @func.name)
      (class_definition name: (identifier) @class.name)
      (object_definition name: (identifier) @class.name)
      (trait_definition name: (identifier) @interface.name)
      (val_definition
        pattern: (identifier) @var.name)
      (var_definition
        pattern: (identifier) @var.name)
    ]
  `,

  captureToKind(name: string): SymbolKind | null {
    if (name.startsWith('func')) return 'function'
    if (name.startsWith('class')) return 'class'
    if (name.startsWith('interface')) return 'interface'
    if (name.startsWith('var')) return 'variable'
    return null
  },

  isDefinitionContext(parent, node, kind) {
    const defTypes = new Set([
      'function_definition',
      'class_definition',
      'object_definition',
      'trait_definition',
      'val_definition',
      'var_definition',
    ])
    if (!defTypes.has(parent.type)) return false
    // class/object/trait 用 name 字段
    if (['class_definition', 'object_definition', 'trait_definition'].includes(parent.type)) {
      const nameField = parent.childForFieldName('name')
      return nameField?.id === node.id
    }
    // function/val/var 检查 name 或 pattern 字段
    const nameField = parent.childForFieldName('name') ?? parent.childForFieldName('pattern')
    return nameField?.id === node.id
  },
}
