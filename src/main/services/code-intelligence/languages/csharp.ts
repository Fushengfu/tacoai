/**
 * C# 查询模式
 *
 * tree-sitter-c-sharp 是 ESM-only，通过动态 import() 加载。
 * AST 节点类型：class_declaration, method_declaration, interface_declaration,
 *   struct_declaration, enum_declaration
 * 引用节点：identifier (invocation_expression > identifier)
 */

import type { LanguageQueries, SymbolKind } from './registry'

export const queries: LanguageQueries = {
  symbolQuery: `
    [
      (method_declaration name: (identifier) @method.name)
      (class_declaration name: (identifier) @class.name)
      (interface_declaration name: (identifier) @interface.name)
      (struct_declaration name: (identifier) @struct.name)
      (enum_declaration name: (identifier) @enum.name)
    ]
  `,

  captureToKind(name: string): SymbolKind | null {
    if (name.startsWith('method')) return 'method'
    if (name.startsWith('class')) return 'class'
    if (name.startsWith('interface')) return 'interface'
    if (name.startsWith('struct')) return 'struct'
    if (name.startsWith('enum')) return 'enum'
    return null
  },

  isDefinitionContext(parent, node, kind) {
    const defTypes = new Set([
      'method_declaration',
      'class_declaration',
      'interface_declaration',
      'struct_declaration',
      'enum_declaration',
    ])
    if (!defTypes.has(parent.type)) return false
    const nameField = parent.childForFieldName('name')
    return nameField?.id === node.id
  },
}
