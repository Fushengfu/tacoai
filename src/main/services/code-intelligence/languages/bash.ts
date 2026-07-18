/**
 * Bash 查询模式
 */

import type { LanguageQueries, SymbolKind } from './registry'

export const queries: LanguageQueries = {
  symbolQuery: `
    [
      (function_definition name: (word) @func.name)
    ]
  `,

  captureToKind(name: string): SymbolKind | null {
    if (name.startsWith('func')) return 'function'
    return null
  },

  isDefinitionContext(parent, node, kind) {
    const defTypes = new Set(['function_definition'])
    if (!defTypes.has(parent.type)) return false
    const nameField = parent.childForFieldName('name')
    return nameField?.id === node.id
  },
}
