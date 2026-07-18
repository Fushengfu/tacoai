/**
 * 代码智能工具执行器
 *
 * 处理 find_definition / find_references / list_symbols 三个工具。
 * 基于 tree-sitter AST 解析实现多语言语义级代码搜索。
 * 支持 22 种语言（TypeScript / JavaScript / Python / Go / Rust
 * / C / C++ / Java / Ruby / PHP / Bash / Kotlin / Scala
 * / Haskell / Elixir / C# / Perl / CSS / HTML / JSON / OCaml / F#）。
 *
 * find_references 跨目录引用：
 *   - 先在定义文件中确认符号存在
 *   - 扫描 workspace 下所有同扩展名的源文件
 *   - 逐个文件用 tree-sitter 解析并查找引用
 *   - 聚合结果，排除定义自身
 *   - 自动跳过 node_modules、.git、dist 等无关目录
 */

import fs from 'node:fs/promises'
import { Dirent } from 'node:fs'
import path from 'node:path'
import { resolveSafe } from './exec-utils'
import type { ExecResult } from './exec-utils'
import {
  parseFile,
  getLanguageInfo,
  findDefinition,
  findReferences,
  findAllSymbols,
} from '../../../services/code-intelligence'
import { supportedExtensions, preloadEsmLanguages } from '../../../services/code-intelligence/languages/registry'

// 预加载 ESM-only 语言包（C#、Perl）。异步，不阻塞模块加载。
const esmPreloadPromise = preloadEsmLanguages().catch(() => {})

/* ------------------------------------------------------------------ */
/*  Path helper                                                         */
/* ------------------------------------------------------------------ */

function resolveFile(filePath: string, workspace: string): string | null {
  const result = resolveSafe(workspace, filePath)
  if ('error' in result) return null
  return result.resolved
}

/* ------------------------------------------------------------------ */
/*  Cross-file helpers                                                  */
/* ------------------------------------------------------------------ */

/** 需要跳过的目录名 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg',
  'dist', 'build', '.next', '.turbo', '.cache',
  '__pycache__', '.venv', 'venv', 'vendor',
  'target', '.gradle', '.idea', '.vscode',
  'coverage', '.nyc_output', 'release', 'out',
  '.taco', 'bin', 'obj',
])

/** 最大扫描文件数 */
const MAX_SCAN_FILES = 200
/** 单文件最大字节 */
const MAX_FILE_SIZE = 500 * 1024

/**
 * 递归扫描目录，找到所有指定扩展名的源文件。
 */
async function findSourceFiles(
  dir: string,
  exts: ReadonlySet<string>,
  results: string[],
): Promise<void> {
  if (results.length >= MAX_SCAN_FILES) return
  let entries: Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (results.length >= MAX_SCAN_FILES) return
    if (entry.name.startsWith('.') && entry.name !== '.env') continue
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      await findSourceFiles(path.join(dir, entry.name), exts, results)
    } else if (entry.isFile()) {
      for (const ext of exts) {
        if (entry.name.endsWith(ext)) {
          results.push(path.join(dir, entry.name))
          break
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/*  find_definition                                                    */
/* ------------------------------------------------------------------ */

export async function execFindDefinition(
  args: Record<string, unknown>,
  workspace: string,
): Promise<ExecResult> {
  await esmPreloadPromise
  
  const symbol = String(args.symbol ?? '').trim()
  const rawPath = String(args.filePath ?? '').trim()

  if (!symbol) return { content: 'Error: symbol is required', success: false }
  if (!rawPath) return { content: 'Error: filePath is required', success: false }

  const resolved = resolveFile(rawPath, workspace)
  if (!resolved) return { content: `Error: cannot resolve path "${rawPath}"`, success: false }

  try {
    const code = await fs.readFile(resolved, 'utf-8')
    const tree = parseFile(resolved, code)
    const langInfo = getLanguageInfo(resolved)
    if (!langInfo) {
      const allExts = supportedExtensions().join(' ')
      return { content: `Error: unsupported language for "${resolved}". Supported: ${allExts}`, success: false }
    }

    const result = findDefinition(tree.rootNode, symbol, resolved, langInfo)

    if (!result) {
      return {
        content: `Symbol "${symbol}" not found in ${resolved}. Run list_symbols first to see available symbols.`,
        success: false,
      }
    }

    return {
      content: JSON.stringify({
        name: result.name,
        kind: result.kind,
        file: result.filePath,
        line: result.line,
        column: result.column,
      }, null, 2),
      success: true,
    }
  } catch (err) {
    return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, success: false }
  }
}

/* ------------------------------------------------------------------ */
/*  find_references  (cross-file)                                     */
/* ------------------------------------------------------------------ */

export async function execFindReferences(
  args: Record<string, unknown>,
  workspace: string,
): Promise<ExecResult> {
  await esmPreloadPromise
  
  const symbol = String(args.symbol ?? '').trim()
  const rawPath = String(args.filePath ?? '').trim()

  if (!symbol) return { content: 'Error: symbol is required', success: false }
  if (!rawPath) return { content: 'Error: filePath is required', success: false }

  const resolved = resolveFile(rawPath, workspace)
  if (!resolved) return { content: `Error: cannot resolve path "${rawPath}"`, success: false }

  try {
    const code = await fs.readFile(resolved, 'utf-8')
    const tree = parseFile(resolved, code)
    const langInfo = getLanguageInfo(resolved)
    if (!langInfo) {
      const allExts = supportedExtensions().join(' ')
      return { content: `Error: unsupported language for "${resolved}". Supported: ${allExts}`, success: false }
    }

    // 先确定符号类型，用于跳过定义位置
    const def = findDefinition(tree.rootNode, symbol, resolved, langInfo)
    const kind = def?.kind ?? 'variable'

    // Step 1: 在当前文件中查找引用
    const refs = findReferences(tree.rootNode, symbol, kind, langInfo)
    const allRefs: Array<{ file: string; line: number; column: number; context: string }> = refs.map(
      (r: { filePath: string; line: number; column: number; context: string }) => ({
        file: resolved,
        line: r.line,
        column: r.column,
        context: r.context,
      }),
    )

    // Step 2: 跨文件扫描。找到定义文件扩展名对应的所有扩展名，如 .go 文件也搜 .go
    const defExt = path.extname(resolved)
    if (!defExt) {
      // 无扩展名，只返回当前文件结果
      return {
        content: JSON.stringify(allRefs.length > 0 ? allRefs : [], null, 2),
        success: true,
      }
    }

    const targetExts = new Set([defExt])
    // 同语言可能有多个扩展名：.ts/.tsx、.js/.jsx/.mjs/.cjs、.py/.pyw 等
    const allExts = supportedExtensions()
    const defLang = langInfo.id
    for (const ext of allExts) {
      // 获取该扩展名对应的语言，如果是同一语言则加入扫描
      const { detectLanguage } = require('../../../services/code-intelligence/languages/registry')
      const li = detectLanguage(`x${ext}`)
      if (li && li.id === defLang) targetExts.add(ext)
    }

    // 扫描 workspace 下所有同扩展名文件
    const candidateFiles: string[] = []
    await findSourceFiles(workspace, targetExts, candidateFiles)

    // 逐个文件查找引用（跳过已处理过的定义文件）
    const wsNorm = path.normalize(workspace)
    for (const candidate of candidateFiles) {
      if (candidate === resolved) continue // 已经处理过
      if (allRefs.length >= 200) break      // 结果上限

      try {
        const stat = await fs.stat(candidate)
        if (stat.size > MAX_FILE_SIZE) continue
      } catch { continue }

      try {
        const fileCode = await fs.readFile(candidate, 'utf-8')
        const fileTree = parseFile(candidate, fileCode)
        const fileLangInfo = getLanguageInfo(candidate)
        if (!fileLangInfo) continue

        const fileRefs = findReferences(fileTree.rootNode, symbol, kind, fileLangInfo)
        for (const r of fileRefs) {
          if (allRefs.length >= 200) break
          if (r.filePath) continue // queries 里 filePath 是空的，但安全起见

          // 转相对路径输出，更清晰
          const relPath = candidate.startsWith(wsNorm)
            ? candidate.slice(wsNorm.length).replace(/^[/\\]/, '')
            : candidate

          allRefs.push({
            file: relPath,
            line: r.line,
            column: r.column,
            context: r.context,
          })
        }
      } catch {
        // 跳过无法解析的文件
      }
    }

    if (allRefs.length === 0) {
      return {
        content: `No references found for "${symbol}" across any source files in workspace.`,
        success: true,
      }
    }

    return {
      content: JSON.stringify({ total: allRefs.length, refs: allRefs }, null, 2),
      success: true,
    }
  } catch (err) {
    return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, success: false }
  }
}

/* ------------------------------------------------------------------ */
/*  list_symbols                                                       */
/* ------------------------------------------------------------------ */

export async function execListSymbols(
  args: Record<string, unknown>,
  workspace: string,
): Promise<ExecResult> {
  await esmPreloadPromise
  
  const rawPath = String(args.filePath ?? '').trim()

  if (!rawPath) return { content: 'Error: filePath is required', success: false }

  const resolved = resolveFile(rawPath, workspace)
  if (!resolved) return { content: `Error: cannot resolve path "${rawPath}"`, success: false }

  try {
    const code = await fs.readFile(resolved, 'utf-8')
    const tree = parseFile(resolved, code)
    const langInfo = getLanguageInfo(resolved)
    if (!langInfo) {
      const allExts = supportedExtensions().join(' ')
      return { content: `Error: unsupported language for "${resolved}". Supported: ${allExts}`, success: false }
    }

    const symbols = findAllSymbols(tree.rootNode, resolved, langInfo)

    const output = symbols.map((s: { name: string; kind: string; line: number; column: number }, i: number) => ({
      index: i + 1,
      name: s.name,
      kind: s.kind,
      line: s.line,
      column: s.column,
    }))

    return {
      content: JSON.stringify({
        file: resolved,
        total: output.length,
        symbols: output,
      }, null, 2),
      success: true,
    }
  } catch (err) {
    return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, success: false }
  }
}
