/**
 * Java 查询模式
 */

import type { LanguageQueries, SymbolKind } from './registry'

export const queries: LanguageQueries = {
  symbolQuery: `
    [
      (method_declaration name: (identifier) @method.name)
      (class_declaration name: (identifier) @class.name)
      (interface_declaration name: (identifier) @interface.name)
      (enum_declaration name: (identifier) @enum.name)
      (constructor_declaration name: (identifier) @method.name)
    ]
  `,

  captureToKind(name: string): SymbolKind | null {
    if (name.startsWith('method')) return 'method'
    if (name.startsWith('class')) return 'class'
    if (name.startsWith('interface')) return 'interface'
    if (name.startsWith('enum')) return 'enum'
    return null
  },

  isDefinitionContext(parent, node, kind) {
    const defTypes = new Set([
      'method_declaration',
      'class_declaration',
      'interface_declaration',
      'enum_declaration',
      'constructor_declaration',
    ])
    if (!defTypes.has(parent.type)) return false
    const nameField = parent.childForFieldName('name')
    return nameField?.id === node.id
  },
}
