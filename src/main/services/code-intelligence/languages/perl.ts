/**
 * Perl 查询模式
 *
 * tree-sitter-perl 是 ESM-only，通过动态 import() 加载。
 * AST 节点类型：
 *   - subroutine_declaration_statement → name field: bareword
 *   - package_statement → name field: package
 * 引用节点：function (function_call_expression > function)
 */

import type { LanguageQueries, SymbolKind } from './registry'

export const queries: LanguageQueries = {
  symbolQuery: `
    [
      (subroutine_declaration_statement name: (bareword) @sub.name)
      (package_statement name: (package) @package.name)
    ]
  `,

  captureToKind(name: string): SymbolKind | null {
    if (name.startsWith('sub')) return 'function'
    if (name.startsWith('package')) return 'class'
    return null
  },

  isDefinitionContext(parent, node, kind) {
    if (kind === 'function' && parent.type === 'subroutine_declaration_statement') {
      const nameField = parent.childForFieldName('name')
      return nameField?.id === node.id
    }
    if (kind === 'class' && parent.type === 'package_statement') {
      const nameField = parent.childForFieldName('name')
      return nameField?.id === node.id
    }
    return false
  },
}
