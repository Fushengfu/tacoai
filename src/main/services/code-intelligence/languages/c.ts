/**
 * C 语言查询模式
 */

import type { LanguageQueries, SymbolKind } from './registry'

export const queries: LanguageQueries = {
  symbolQuery: `
    [
      (function_definition
        declarator: (function_declarator
          declarator: (identifier) @func.name))
      (struct_specifier name: (type_identifier) @struct.name)
      (enum_specifier name: (type_identifier) @enum.name)
      (type_definition
        declarator: (type_identifier) @type.name)
    ]
  `,

  captureToKind(name: string): SymbolKind | null {
    if (name.startsWith('func')) return 'function'
    if (name.startsWith('struct')) return 'struct'
    if (name.startsWith('enum')) return 'enum'
    if (name.startsWith('type')) return 'type'
    return null
  },

  isDefinitionContext(parent, node, kind) {
    const defTypes = new Set([
      'function_declarator',
      'struct_specifier',
      'enum_specifier',
      'type_definition',
    ])
    if (!defTypes.has(parent.type)) return false
    // 对于 function_declarator，检查是否是 declarator 字段
    if (parent.type === 'function_declarator') {
      const decl = parent.childForFieldName('declarator')
      return decl?.id === node.id
    }
    // 其他情况检查 name 字段
    const nameField = parent.childForFieldName('name')
    return nameField?.id === node.id
  },
}
