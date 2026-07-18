/**
 * Haskell 查询模式
 */

import type { LanguageQueries, SymbolKind } from './registry'

export const queries: LanguageQueries = {
  symbolQuery: `
    [
      (signature name: (variable) @func.name)
      (function
        name: (variable) @func.name
        patterns: (patterns))
      (data_type name: (name) @type.name)
      (newtype name: (name) @type.name)
      (class name: (name) @class.name)
    ]
  `,

  captureToKind(name: string): SymbolKind | null {
    if (name.startsWith('func')) return 'function'
    if (name.startsWith('type')) return 'type'
    if (name.startsWith('class')) return 'class'
    return null
  },

  isDefinitionContext(parent, node, kind) {
    const defTypes = new Set([
      'signature',
      'function',
      'data_type',
      'newtype',
      'class',
    ])
    if (!defTypes.has(parent.type)) return false
    const nameField = parent.childForFieldName('name')
    return nameField?.id === node.id
  },
}
