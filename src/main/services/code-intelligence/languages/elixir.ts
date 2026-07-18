/**
 * Elixir 查询模式
 *
 * Elixir AST 将 defmodule/def/defp 都表示为 call 节点。
 * 函数定义有两种形式：
 * 1. def hello(name) → arguments 含 call 节点（带参数）
 * 2. defp secret → arguments 含 identifier 节点（无参数）
 * 模块：defmodule Foo → arguments 含 alias 节点
 */

import type { LanguageQueries, SymbolKind } from './registry'

export const queries: LanguageQueries = {
  symbolQuery: `
    [
      (call
        target: (identifier) @_t
        (arguments (call target: (identifier) @func.name))
        (#eq? @_t "def"))
      (call
        target: (identifier) @_t
        (arguments (call target: (identifier) @func.name))
        (#eq? @_t "defp"))
      (call
        target: (identifier) @_t
        (arguments (identifier) @func.name)
        (#eq? @_t "def"))
      (call
        target: (identifier) @_t
        (arguments (identifier) @func.name)
        (#eq? @_t "defp"))
      (call
        target: (identifier) @_t
        (arguments (alias) @module.name)
        (#eq? @_t "defmodule"))
    ]
  `,

  captureToKind(name: string): SymbolKind | null {
    if (name.startsWith('func')) return 'function'
    if (name.startsWith('module')) return 'class'
    return null
  },

  isDefinitionContext(parent, node, kind) {
    // Elixir 的 call 节点，def/defp 定义函数，defmodule 定义模块
    if (parent.type !== 'call') return false

    // 对于函数定义，node 是 arguments 中 call 或 identifier 的子节点
    if (kind === 'function') {
      // parent 是 arguments 中的 call 节点，node 是其 target
      if (parent.type === 'call') {
        const target = parent.childForFieldName('target')
        if (target?.id === node.id) return true
      }
      return false
    }

    // 对于模块：node 是 alias
    if (kind === 'class') {
      const args = parent.childForFieldName('arguments')
      if (!args) return false
      for (const child of args.namedChildren) {
        if (child.id === node.id) return true
      }
      return false
    }

    return false
  },
}
