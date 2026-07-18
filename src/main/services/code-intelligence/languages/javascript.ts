/**
 * JavaScript / JSX 查询模式
 *
 * 与 TypeScript 高度相似但无 interface / type alias / enum。
 * 使用 identifier（而非 type_identifier）作为类名。
 */

import type { LanguageQueries, SymbolKind } from './registry'

export const queries: LanguageQueries = {
  symbolQuery: `
    [
      (function_declaration name: (identifier) @func.name)
      (method_definition name: (property_identifier) @method.name)
      (class_declaration name: (identifier) @class.name)
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
    if (name.startsWith('var')) return 'variable'
    return null
  },

  isDefinitionContext(parent, node, _kind) {
    const defTypes = new Set([
      'function_declaration',
      'method_definition',
      'class_declaration',
      'variable_declarator',
      'property_signature',
      'public_field_definition',
    ])
    if (!defTypes.has(parent.type)) return false
    const nameField = parent.childForFieldName('name')
    return nameField?.id === node.id
  },
}
