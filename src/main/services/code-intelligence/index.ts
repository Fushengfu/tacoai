/**
 * 代码智能理解模块
 *
 * 基于 tree-sitter 解析代码为 AST，实现精确的语义搜索：
 * - find_definition: 跳转到函数/变量/类型/类的定义处
 * - find_references: 查找所有调用/引用位置
 * - list_symbols: 列出文件内所有命名符号
 *
 * 支持多语言：TypeScript / JavaScript / Python / Go / Rust
 * / C / C++ / Java / Ruby / PHP / Swift / Bash / Kotlin / Scala
 * / Haskell / Elixir / C# / Perl / CSS / HTML / JSON / OCaml / F#
 *
 * 与 grep 纯文本搜索的区别：
 *   grep "openFile" → 返回注释、字符串、变量名前缀的所有文本匹配（噪音）
 *   find_references("openFile") → 只返回真正的函数调用位置（语义精确）
 */

export { parseFile, invalidateCache, clearCache, getCacheSize, getLanguageInfo } from './parser'
export { findAllSymbols, findReferences, findDefinition } from './queries'
export type { SymbolInfo, SymbolKind } from './queries'
