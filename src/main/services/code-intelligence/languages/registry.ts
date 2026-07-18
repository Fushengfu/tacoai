/**
 * 语言注册表
 *
 * 扩展名 → 语言 ID 映射，以及语言查询模式加载。
 * 每个语言定义自己的 AST 查询模式，统一通过 LanguageQueries 接口暴露。
 *
 * 支持 23 种编程/标记语言，覆盖 60 个文件扩展名。
 */

import type Parser from 'tree-sitter'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'struct'
  | 'variable'
  | 'import'
  | 'export'

export interface LanguageQueries {
  /** tree-sitter 查询模式，用于查找所有命名符号 */
  symbolQuery: string
  /** 根据 capture 名称判断符号类型 */
  captureToKind(name: string): SymbolKind | null
  /** 判断节点是否处于定义上下文（而非引用位置） */
  isDefinitionContext(parent: Parser.SyntaxNode, node: Parser.SyntaxNode, kind: SymbolKind): boolean
}

/* ------------------------------------------------------------------ */
/*  Language registry                                                   */
/* ------------------------------------------------------------------ */

/** 扩展名 → 语言 ID */
const EXTENSION_MAP: Record<string, string> = {
  // TypeScript
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  // JavaScript
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  // Python
  '.py': 'python',
  '.pyw': 'python',
  '.pyi': 'python',
  // Go
  '.go': 'go',
  // Rust
  '.rs': 'rust',
  // C
  '.c': 'c',
  '.h': 'c',
  // C++
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hxx': 'cpp',
  // Java
  '.java': 'java',
  // Ruby
  '.rb': 'ruby',
  '.rbw': 'ruby',
  '.gemspec': 'ruby',
  '.rake': 'ruby',
  // PHP
  '.php': 'php',
  '.phtml': 'php',
  '.phps': 'php',
  '.phpt': 'php',
  // Swift
  '.swift': 'swift',
  // Bash
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  // Kotlin
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  // Scala
  '.scala': 'scala',
  '.sc': 'scala',
  // Haskell
  '.hs': 'haskell',
  '.lhs': 'haskell',
  // Elixir
  '.ex': 'elixir',
  '.exs': 'elixir',
  // C#
  '.cs': 'csharp',
  '.csx': 'csharp',
  // Perl
  '.pl': 'perl',
  '.pm': 'perl',
  // --- new: web & markup ---
  '.css': 'css',
  '.html': 'html',
  '.htm': 'html',
  '.json': 'json',
  // --- new: other languages ---
  '.ml': 'ocaml',
  '.mli': 'ocaml',
  '.fs': 'fsharp',
  '.fsx': 'fsharp',
}

/** 语言 ID → npm 包名 + 导出属性名 */
const LANGUAGE_LOADERS: Record<string, () => { lang: any; queries: LanguageQueries }> = {
  typescript: () => {
    const TS = require('tree-sitter-typescript')
    return { lang: TS.typescript, queries: tsQueries }
  },
  javascript: () => {
    const lang = require('tree-sitter-javascript')
    return { lang, queries: jsQueries }
  },
  python: () => {
    const lang = require('tree-sitter-python')
    return { lang, queries: pyQueries }
  },
  go: () => {
    const lang = require('tree-sitter-go')
    return { lang, queries: goQueries }
  },
  rust: () => {
    const lang = require('tree-sitter-rust')
    return { lang, queries: rsQueries }
  },
  c: () => {
    const lang = require('tree-sitter-c')
    return { lang, queries: cQueries }
  },
  cpp: () => {
    const lang = require('tree-sitter-cpp')
    return { lang, queries: cppQueries }
  },
  java: () => {
    const lang = require('tree-sitter-java')
    return { lang, queries: javaQueries }
  },
  ruby: () => {
    const lang = require('tree-sitter-ruby')
    return { lang, queries: rubyQueries }
  },
  php: () => {
    const PHP = require('tree-sitter-php')
    return { lang: PHP.php, queries: phpQueries }
  },
  swift: () => {
    const lang = require('tree-sitter-swift')
    return { lang, queries: swiftQueries }
  },
  bash: () => {
    const lang = require('tree-sitter-bash')
    return { lang, queries: bashQueries }
  },
  kotlin: () => {
    const lang = require('tree-sitter-kotlin')
    return { lang, queries: kotlinQueries }
  },
  scala: () => {
    const lang = require('tree-sitter-scala')
    return { lang, queries: scalaQueries }
  },
  haskell: () => {
    const lang = require('tree-sitter-haskell')
    return { lang, queries: haskellQueries }
  },
  elixir: () => {
    const lang = require('tree-sitter-elixir')
    return { lang, queries: elixirQueries }
  },
  csharp: () => {
    if (!_csharpLang) throw new Error('tree-sitter-c-sharp not loaded. Call preloadEsmLanguages() first.')
    return { lang: _csharpLang, queries: csharpQueries }
  },
  perl: () => {
    if (!_perlLang) throw new Error('tree-sitter-perl not loaded. Call preloadEsmLanguages() first.')
    return { lang: _perlLang, queries: perlQueries }
  },
  // --- new: web & markup ---
  css: () => {
    if (!_cssLang) throw new Error('tree-sitter-css not loaded. Call preloadEsmLanguages() first.')
    return { lang: _cssLang, queries: cssQueries }
  },
  html: () => { const lang = require('tree-sitter-html'); return { lang, queries: htmlQueries } },
  json: () => { const lang = require('tree-sitter-json'); return { lang, queries: jsonQueries } },
  // --- new: other languages ---
  ocaml: () => { const OCaml = require('tree-sitter-ocaml'); return { lang: OCaml.ocaml, queries: ocamlQueries } },
  fsharp: () => { const FS = require('tree-sitter-fsharp'); return { lang: FS.fsharp, queries: fsharpQueries } },
}

let _tsxLang: any = null

// 查询模式（按需导入，第一次访问时加载）
import { queries as tsQueries } from './typescript'
import { queries as jsQueries } from './javascript'
import { queries as pyQueries } from './python'
import { queries as goQueries } from './go'
import { queries as rsQueries } from './rust'
import { queries as cQueries } from './c'
import { queries as cppQueries } from './cpp'
import { queries as javaQueries } from './java'
import { queries as rubyQueries } from './ruby'
import { queries as phpQueries } from './php'
import { queries as swiftQueries } from './swift'
import { queries as bashQueries } from './bash'
import { queries as kotlinQueries } from './kotlin'
import { queries as scalaQueries } from './scala'
import { queries as haskellQueries } from './haskell'
import { queries as elixirQueries } from './elixir'
import { queries as csharpQueries } from './csharp'
import { queries as perlQueries } from './perl'
// --- new imports ---
import { queries as cssQueries } from './css'
import { queries as htmlQueries } from './html'
import { queries as jsonQueries } from './json'
import { queries as ocamlQueries } from './ocaml'
import { queries as fsharpQueries } from './fsharp'

// ESM-only 语言包需要提前通过动态 import 加载并缓存。
// 这些包无法通过 require() 加载（包含顶层 await），因此需要预加载。
let _csharpLang: any = null
let _perlLang: any = null
let _cssLang: any = null
let _esmModulesLoaded = false

/** 预加载 ESM-only 的 tree-sitter 语言包 */
export async function preloadEsmLanguages(): Promise<void> {
  if (_esmModulesLoaded) return
  try {
    const csMod = await import('tree-sitter-c-sharp')
    _csharpLang = (csMod as any).default ?? csMod
  } catch {
    // 忽略加载失败
  }
  try {
    const perlMod = await import('tree-sitter-perl')
    _perlLang = (perlMod as any).default ?? perlMod
  } catch {
    // 忽略加载失败
  }
  try {
    const cssMod = await import('tree-sitter-css')
    _cssLang = (cssMod as any).default ?? cssMod
  } catch {
    // 忽略加载失败
  }
  _esmModulesLoaded = true
}

/* ------------------------------------------------------------------ */
/*  Public API                                                          */
/* ------------------------------------------------------------------ */

export interface LanguageInfo {
  id: string
  lang: any          // tree-sitter Language 对象
  queries: LanguageQueries
}

/**
 * 根据文件扩展名检测语言。
 * @returns LanguageInfo 或 null（不支持的语言）
 */
export function detectLanguage(filePath: string): LanguageInfo | null {
  for (const [ext, langId] of Object.entries(EXTENSION_MAP)) {
    if (filePath.endsWith(ext)) {
      const loader = LANGUAGE_LOADERS[langId]
      if (!loader) return null
      const { lang, queries } = loader()

      // TSX 使用独立的 tree-sitter language
      if (ext === '.tsx') {
        if (!_tsxLang) {
          const TS = require('tree-sitter-typescript')
          _tsxLang = TS.tsx
        }
        return { id: 'typescript', lang: _tsxLang, queries }
      }

      return { id: langId, lang, queries }
    }
  }
  return null
}

/** 列出所有支持的语言 */
export function supportedLanguages(): string[] {
  return Object.keys(LANGUAGE_LOADERS)
}

/** 列出所有支持的文件扩展名 */
export function supportedExtensions(): string[] {
  return Object.keys(EXTENSION_MAP)
}
