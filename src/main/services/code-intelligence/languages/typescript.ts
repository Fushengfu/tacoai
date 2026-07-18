/**
 * TypeScript / TSX 查询模式
 */

import type { LanguageQueries, SymbolKind } from './registry'

export const queries: LanguageQueries = {
  symbolQuery: `
    [
      (function_declaration name: (identifier) @func.name)
      (method_definition name: (property_identifier) @method.name)
      (class_declaration name: (type_identifier) @class.name)
      (interface_declaration name: (type_identifier) @interface.name)
      (type_alias_declaration name: (type_identifier) @type.name)
      (enum_declaration name: (identifier) @enum.name)
      (variable_declarator
        name: (identifier) @var.name
        value: [(arrow_function) (function_expression)]
      )
    ]
  `,

  captureToKind(name: string): SymbolKind | null {
    if (name.startsWith('func')) return 'function'
    if (name.startsWith('method')) return 'method'
    if (name.startsWith('class')) return 'class'
    if (name.startsWith('interface')) return 'interface'
    if (name.startsWith('type')) return 'type'
    if (name.startsWith('enum')) return 'enum'
    if (name.startsWith('var')) return 'variable'
    return null
  },

  isDefinitionContext(parent, node, kind) {
    const defTypes = new Set([
      'function_declaration',
      'method_definition',
      'class_declaration',
      'interface_declaration',
      'type_alias_declaration',
      'enum_declaration',
      'variable_declarator',
      'property_signature',
      'public_field_definition',
    ])
    if (!defTypes.has(parent.type)) return false
    const nameField = parent.childForFieldName('name')
    return nameField?.id === node.id
  },
}
