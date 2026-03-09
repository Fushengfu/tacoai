/**
 * 语法高亮工具
 *
 * 基于 highlight.js，提供按文件扩展名自动检测语言的高亮能力。
 * 使用 common 子集减小体积，涵盖主流语言。
 */

import hljs from 'highlight.js/lib/core'

// 按需注册常用语言（减少体积）
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'       // HTML/XML/SVG
import css from 'highlight.js/lib/languages/css'
import scss from 'highlight.js/lib/languages/scss'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import dart from 'highlight.js/lib/languages/dart'
import go from 'highlight.js/lib/languages/go'
import java from 'highlight.js/lib/languages/java'
import cpp from 'highlight.js/lib/languages/cpp'
import c from 'highlight.js/lib/languages/c'
import bash from 'highlight.js/lib/languages/bash'
import yaml from 'highlight.js/lib/languages/yaml'
import sql from 'highlight.js/lib/languages/sql'
import ruby from 'highlight.js/lib/languages/ruby'
import php from 'highlight.js/lib/languages/php'
import swift from 'highlight.js/lib/languages/swift'
import kotlin from 'highlight.js/lib/languages/kotlin'
import graphql from 'highlight.js/lib/languages/graphql'
import diff from 'highlight.js/lib/languages/diff'
import ini from 'highlight.js/lib/languages/ini'        // .env, .ini, .toml
import plaintext from 'highlight.js/lib/languages/plaintext'
import less from 'highlight.js/lib/languages/less'

hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('css', css)
hljs.registerLanguage('scss', scss)
hljs.registerLanguage('less', less)
hljs.registerLanguage('json', json)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('python', python)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('dart', dart)
hljs.registerLanguage('go', go)
hljs.registerLanguage('java', java)
hljs.registerLanguage('cpp', cpp)
hljs.registerLanguage('c', c)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('ruby', ruby)
hljs.registerLanguage('php', php)
hljs.registerLanguage('swift', swift)
hljs.registerLanguage('kotlin', kotlin)
hljs.registerLanguage('graphql', graphql)
hljs.registerLanguage('diff', diff)
hljs.registerLanguage('ini', ini)
hljs.registerLanguage('plaintext', plaintext)

/** 文件扩展名 → hljs 语言标识 */
const EXT_MAP: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  mjs: 'javascript', cjs: 'javascript',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', svelte: 'xml',
  css: 'css', scss: 'scss', less: 'less',
  json: 'json', jsonc: 'json',
  md: 'markdown', mdx: 'markdown',
  py: 'python', pyw: 'python',
  rs: 'rust',
  dart: 'dart',
  go: 'go',
  java: 'java',
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  yml: 'yaml', yaml: 'yaml',
  toml: 'ini', ini: 'ini', env: 'ini',
  sql: 'sql',
  rb: 'ruby',
  php: 'php',
  swift: 'swift',
  kt: 'kotlin', kts: 'kotlin',
  graphql: 'graphql', gql: 'graphql',
  diff: 'diff', patch: 'diff',
  txt: 'plaintext',
  gitignore: 'plaintext', dockerignore: 'plaintext',
  makefile: 'bash', dockerfile: 'bash',
}

/** 根据文件路径获取 hljs 语言标识 */
export function getLang(filePath: string): string {
  const name = filePath.split('/').pop()?.toLowerCase() ?? ''
  // 特殊文件名
  if (name === 'makefile' || name === 'dockerfile') return EXT_MAP[name] ?? 'plaintext'
  const ext = name.includes('.') ? name.split('.').pop() ?? '' : ''
  return EXT_MAP[ext] ?? 'plaintext'
}

/**
 * 对代码文本进行语法高亮，返回带 <span> 标签的 HTML 字符串。
 * 每一行独立返回（方便 diff 视图逐行渲染）。
 */
export function highlightCode(code: string, filePath: string): string {
  const lang = getLang(filePath)
  try {
    const result = hljs.highlight(code, { language: lang, ignoreIllegals: true })
    return result.value
  } catch {
    // fallback: 转义 HTML
    return escapeHtml(code)
  }
}

/**
 * 逐行高亮：返回每行的高亮 HTML 数组。
 * 保持跨行 token 的连续性（如多行字符串、注释等）。
 */
export function highlightLines(code: string, filePath: string): string[] {
  const html = highlightCode(code, filePath)
  // highlight.js 的输出中 \n 仍然是换行符
  // 但跨行的 <span> 可能没有在行末关闭
  // 需要手动处理：在每行末尾关闭所有打开的 span，在下一行开头重新打开
  return splitHtmlByLines(html)
}

/** 将高亮 HTML 按行拆分，处理跨行 span */
function splitHtmlByLines(html: string): string[] {
  const rawLines = html.split('\n')
  const result: string[] = []
  let openSpans: string[] = [] // 当前打开的 span 标签栈

  for (const raw of rawLines) {
    // 在行首补上前一行遗留的 open spans
    let line = openSpans.join('') + raw

    // 扫描这一行中的 span 标签
    const openRegex = /<span[^>]*>/g
    const closeRegex = /<\/span>/g

    let m: RegExpExecArray | null
    // 重新从 raw 开始计算（而非 line），因为 openSpans 已经计入
    const scanTarget = raw
    // 但我们需要重新扫描整行来确定行末的状态
    const allOpens: string[] = [...openSpans]

    m = openRegex.exec(scanTarget)
    while (m !== null) {
      allOpens.push(m[0])
      m = openRegex.exec(scanTarget)
    }

    let closeCount = 0
    m = closeRegex.exec(scanTarget)
    while (m !== null) {
      closeCount++
      m = closeRegex.exec(scanTarget)
    }

    // 从后往前移除已关闭的 span
    const remaining = [...allOpens]
    for (let i = 0; i < closeCount && remaining.length > 0; i++) {
      remaining.pop()
    }

    // 行末关闭所有未关闭的 span
    const closeTags = '</span>'.repeat(remaining.length)
    line += closeTags

    result.push(line)
    openSpans = remaining
  }

  return result
}

/** HTML 转义 */
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
