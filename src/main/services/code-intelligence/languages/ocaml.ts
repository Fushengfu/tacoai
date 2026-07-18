/**
 * OCaml 查询模式
 *
 * tree-sitter-ocaml AST 节点类型：
 * - let_binding pattern: (value_name)
 * - type_binding (module_declaration | class_declaration)
 * - module_definition name: (module_name)
 * - external (外部函数声明)
 */

import type { LanguageQueries, SymbolKind } from './registry'

export const queries: LanguageQueries = {
  symbolQuery: `
    [
      (let_binding pattern: (value_name) @let.name)
      (module_definition name: (module_name) @mod.name)
      (module_type_definition name: (module_type_name) @modtype.name)
      (type_binding (type_variable) @type.name)
    ]
  `,

  captureToKind(name: string): SymbolKind | null {
    if (name.startsWith('let')) return 'function'
    if (name.startsWith('modtype') || name.startsWith('mod')) return 'class'
    if (name.startsWith('type')) return 'type'
    return null
  },

  isDefinitionContext(parent, node, kind) {
    const valueNameParent = node.parent
    if (valueNameParent?.type === 'value_name' && valueNameParent.parent?.type === 'let_binding') return true
    if (parent.type === 'module_definition' || parent.type === 'module_type_definition') {
      const nameField = parent.childForFieldName('name')
      return nameField?.id === node.id
    }
    return false
  },
}
