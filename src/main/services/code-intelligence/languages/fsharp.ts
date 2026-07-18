/**
 * F# 查询模式
 *
 * tree-sitter-fsharp AST 节点类型：
 * - 因 tree-sitter 0.25 兼容性问题，使用启发式匹配
 * - module_definition / class_definition / type_definition
 * - 基本符号提取
 */

import type { LanguageQueries, SymbolKind } from './registry'

export const queries: LanguageQueries = {
  symbolQuery: `
    [
      (function_or_value_defn (function_name) @func.name)
      (class_defn (type_name) @class.name)
      (interface_defn (type_name) @interface.name)
      (module_defn (type_long_ident) @mod.name)
    ]
  `,

  captureToKind(name: string): SymbolKind | null {
    if (name.startsWith('func')) return 'function'
    if (name.startsWith('class')) return 'class'
    if (name.startsWith('interface')) return 'interface'
    if (name.startsWith('mod')) return 'class'
    return null
  },

  isDefinitionContext(parent, node, _kind) {
    const defTypes = new Set([
      'function_or_value_defn',
      'class_defn',
      'interface_defn',
      'module_defn',
    ])
    if (!defTypes.has(parent.type)) return false
    if (parent.type === 'function_or_value_defn') {
      return parent.childForFieldName('name')?.id === node.id
        || node.parent?.type === 'function_name'
    }
    const nameField = parent.childForFieldName('name')
    return nameField?.id === node.id
  },
}
