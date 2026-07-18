/**
 * C++ 查询模式
 */

import type { LanguageQueries, SymbolKind } from './registry'

export const queries: LanguageQueries = {
  symbolQuery: `
    [
      (function_definition
        declarator: (function_declarator
          declarator: [(identifier) (field_identifier)] @func.name))
      (class_specifier name: (type_identifier) @class.name)
      (struct_specifier name: (type_identifier) @struct.name)
      (enum_specifier name: (type_identifier) @enum.name)
      (template_declaration
        (function_definition
          declarator: (function_declarator
            declarator: (identifier) @func.name)))
      (template_declaration
        (class_specifier name: (type_identifier) @class.name))
    ]
  `,

  captureToKind(name: string): SymbolKind | null {
    if (name.startsWith('func')) return 'function'
    if (name.startsWith('class')) return 'class'
    if (name.startsWith('struct')) return 'struct'
    if (name.startsWith('enum')) return 'enum'
    return null
  },

  isDefinitionContext(parent, node, kind) {
    const defTypes = new Set([
      'function_declarator',
      'class_specifier',
      'struct_specifier',
      'enum_specifier',
    ])
    if (!defTypes.has(parent.type)) return false
    if (parent.type === 'function_declarator') {
      const decl = parent.childForFieldName('declarator')
      return decl?.id === node.id
    }
    const nameField = parent.childForFieldName('name')
    return nameField?.id === node.id
  },
}
