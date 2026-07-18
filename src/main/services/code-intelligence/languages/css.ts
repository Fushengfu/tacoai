/**
 * CSS 查询模式
 *
 * tree-sitter-css AST 节点类型：
 * - rule_set selectors: (selectors) → 获取第一个 class_selector/id_selector/tag_name
 * - 符号提取规则集
 */

import type { LanguageQueries, SymbolKind } from './registry'

export const queries: LanguageQueries = {
  symbolQuery: `
    [
      (rule_set (selectors (class_selector (class_name) @class.name)))
      (rule_set (selectors (id_selector (id_name) @id.name)))
      (rule_set (selectors (tag_name) @tag.name))
    ]
  `,

  captureToKind(name: string): SymbolKind | null {
    if (name.startsWith('class')) return 'class'
    if (name.startsWith('id')) return 'type'
    if (name.startsWith('tag')) return 'type'
    return null
  },

  isDefinitionContext(_parent, _node, _kind) {
    // CSS 选择器始终视为定义位置
    return true
  },
}
