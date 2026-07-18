/**
 * Ruby 查询模式
 */

import type { LanguageQueries, SymbolKind } from './registry'

export const queries: LanguageQueries = {
  symbolQuery: `
    [
      (method name: (identifier) @method.name)
      (class name: (constant) @class.name)
      (module name: (constant) @module.name)
      (singleton_method
        object: (self)
        name: (identifier) @method.name)
    ]
  `,

  captureToKind(name: string): SymbolKind | null {
    if (name.startsWith('method')) return 'method'
    if (name.startsWith('class')) return 'class'
    if (name.startsWith('module')) return 'class'  // Ruby module 映射为 class
    return null
  },

  isDefinitionContext(parent, node, kind) {
    const defTypes = new Set([
      'method',
      'class',
      'module',
      'singleton_method',
    ])
    if (!defTypes.has(parent.type)) return false
    const nameField = parent.childForFieldName('name')
    return nameField?.id === node.id
  },
}
