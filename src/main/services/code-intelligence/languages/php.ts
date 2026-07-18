/**
 * PHP 查询模式
 *
 * tree-sitter-php 导出 { php, php_only }，使用 php 语言。
 */

import type { LanguageQueries, SymbolKind } from './registry'

export const queries: LanguageQueries = {
  symbolQuery: `
    [
      (function_definition name: (name) @func.name)
      (method_declaration name: (name) @method.name)
      (class_declaration name: (name) @class.name)
      (interface_declaration name: (name) @interface.name)
      (trait_declaration name: (name) @class.name)
      (enum_declaration name: (name) @enum.name)
    ]
  `,

  captureToKind(name: string): SymbolKind | null {
    if (name.startsWith('func')) return 'function'
    if (name.startsWith('method')) return 'method'
    if (name.startsWith('class')) return 'class'
    if (name.startsWith('interface')) return 'interface'
    if (name.startsWith('enum')) return 'enum'
    return null
  },

  isDefinitionContext(parent, node, kind) {
    const defTypes = new Set([
      'function_definition',
      'method_declaration',
      'class_declaration',
      'interface_declaration',
      'trait_declaration',
      'enum_declaration',
    ])
    if (!defTypes.has(parent.type)) return false
    const nameField = parent.childForFieldName('name')
    return nameField?.id === node.id
  },
}
