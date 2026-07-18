/**
 * Python 查询模式
 *
 * Python 语法：
 * - function_definition  name: (identifier)
 * - class_definition     name: (identifier)
 * - 不支持 interface / enum / type alias
 */

import type { LanguageQueries, SymbolKind } from './registry'

export const queries: LanguageQueries = {
  symbolQuery: `
    [
      (function_definition name: (identifier) @func.name)
      (class_definition name: (identifier) @class.name)
    ]
  `,

  captureToKind(name: string): SymbolKind | null {
    if (name.startsWith('func')) return 'function'
    if (name.startsWith('class')) return 'class'
    return null
  },

  isDefinitionContext(parent, node, _kind) {
    const defTypes = new Set([
      'function_definition',
      'class_definition',
    ])
    if (!defTypes.has(parent.type)) return false
    const nameField = parent.childForFieldName('name')
    return nameField?.id === node.id
  },
}
