/**
 * Monaco Editor 配置
 *
 * 使用 @monaco-editor/react 的默认 CDN 加载方式（jsDelivr）。
 * 首次加载后由 Chromium 缓存，后续几乎零延迟。
 * 导出主题配置函数、语言映射和编辑器通用配置。
 */

import type { Monaco } from '@monaco-editor/react'

let dartFallbackRegistered = false

function ensureDartLanguage(monaco: Monaco) {
  if (dartFallbackRegistered) return
  const hasDart = monaco.languages.getLanguages().some((lang) => lang.id === 'dart')
  if (hasDart) {
    dartFallbackRegistered = true
    return
  }

  monaco.languages.register({
    id: 'dart',
    aliases: ['Dart', 'dart'],
    extensions: ['.dart'],
  })

  monaco.languages.setMonarchTokensProvider('dart', {
    keywords: [
      'abstract', 'as', 'assert', 'async', 'await', 'break', 'case', 'catch', 'class', 'const',
      'continue', 'default', 'deferred', 'do', 'dynamic', 'else', 'enum', 'export', 'extends',
      'extension', 'external', 'factory', 'false', 'final', 'finally', 'for', 'Function', 'get',
      'hide', 'if', 'implements', 'import', 'in', 'interface', 'is', 'late', 'library', 'mixin',
      'new', 'null', 'on', 'operator', 'part', 'required', 'rethrow', 'return', 'set', 'show',
      'static', 'super', 'switch', 'sync', 'this', 'throw', 'true', 'try', 'typedef', 'var',
      'void', 'while', 'with', 'yield',
    ],
    typeKeywords: [
      'bool', 'double', 'int', 'num', 'String', 'Object', 'Never', 'Map', 'List', 'Set',
      'Future', 'Stream', 'Iterable', 'Record',
    ],
    tokenizer: {
      root: [
        [/\/\/.*$/, 'comment'],
        [/\/\*/, 'comment', '@comment'],
        [/\b[A-Z]\w*\b/, 'type.identifier'],
        [/\b(?:@keywords)\b/, 'keyword'],
        [/\b(?:@typeKeywords)\b/, 'type'],
        [/\d+(\.\d+)?([eE][\-+]?\d+)?/, 'number'],
        [/'/, { token: 'string.quote', bracket: '@open', next: '@sstring' }],
        [/"/, { token: 'string.quote', bracket: '@open', next: '@dstring' }],
        [/[{}()[\]]/, '@brackets'],
        [/[;,.]/, 'delimiter'],
        [/[+\-*/%=&|<>!?:^~]+/, 'operator'],
        [/[a-zA-Z_$]\w*/, 'identifier'],
      ],
      comment: [
        [/[^/*]+/, 'comment'],
        [/\/\*/, 'comment', '@push'],
        [/\*\//, 'comment', '@pop'],
        [/[/*]/, 'comment'],
      ],
      sstring: [
        [/[^\\']+/, 'string'],
        [/\\./, 'string.escape'],
        [/'/, { token: 'string.quote', bracket: '@close', next: '@pop' }],
      ],
      dstring: [
        [/[^\\"]+/, 'string'],
        [/\\./, 'string.escape'],
        [/"/, { token: 'string.quote', bracket: '@close', next: '@pop' }],
      ],
    },
  })

  monaco.languages.setLanguageConfiguration('dart', {
    comments: { lineComment: '//', blockComment: ['/*', '*/'] },
    brackets: [['{', '}'], ['[', ']'], ['(', ')']],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
  })

  dartFallbackRegistered = true
}

/** 在 Editor 创建前调用，注册自定义主题等 */
export function configureMonaco(monaco: Monaco) {
  ensureDartLanguage(monaco)
  monaco.editor.defineTheme('taco-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '6a9955', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'c586c0' },
      { token: 'keyword.control', foreground: 'c586c0' },
      { token: 'storage', foreground: '569cd6' },
      { token: 'storage.type', foreground: '569cd6' },
      { token: 'string', foreground: 'ce9178' },
      { token: 'string.escape', foreground: 'd7ba7d' },
      { token: 'number', foreground: 'b5cea8' },
      { token: 'constant', foreground: '569cd6' },
      { token: 'type', foreground: '4ec9b0' },
      { token: 'type.identifier', foreground: '4ec9b0' },
      { token: 'identifier', foreground: '9cdcfe' },
      { token: 'variable', foreground: '9cdcfe' },
      { token: 'function', foreground: 'dcdcaa' },
      { token: 'tag', foreground: '569cd6' },
      { token: 'attribute.name', foreground: '9cdcfe' },
      { token: 'attribute.value', foreground: 'ce9178' },
      { token: 'delimiter', foreground: 'd4d4d4' },
      { token: 'operator', foreground: 'd4d4d4' },
      { token: 'regexp', foreground: 'd16969' },
      { token: 'selector', foreground: 'd7ba7d' },
      { token: 'property', foreground: '9cdcfe' },
      { token: 'markup.heading', foreground: '569cd6', fontStyle: 'bold' },
      { token: 'markup.bold', fontStyle: 'bold' },
      { token: 'markup.italic', fontStyle: 'italic' },
    ],
    colors: {
      'editor.background': '#121316',
      'editor.foreground': '#d4d4d4',
      'editor.lineHighlightBackground': '#ffffff08',
      'editor.selectionBackground': '#264f78',
      'editorCursor.foreground': '#aeafad',
      'editor.inactiveSelectionBackground': '#3a3d41',
      'editorLineNumber.foreground': '#858585',
      'editorLineNumber.activeForeground': '#c6c6c6',
      'editorGutter.background': '#121316',
      'editorWidget.background': '#1e1e1e',
      'editorWidget.border': '#454545',
      'input.background': '#1e1e1e',
      'input.foreground': '#cccccc',
      'input.border': '#454545',
      'scrollbar.shadow': '#00000033',
      'scrollbarSlider.activeBackground': '#bfbfbf66',
      'scrollbarSlider.background': '#79797966',
      'scrollbarSlider.hoverBackground': '#646464b3',
      'diffEditor.insertedTextBackground': '#23d18b20',
      'diffEditor.removedTextBackground': '#f4424220',
      'diffEditor.insertedLineBackground': '#23d18b15',
      'diffEditor.removedLineBackground': '#f4424215',
    },
  })
}

/** 文件扩展名 → Monaco language ID */
export function getMonacoLanguage(filePath: string): string {
  const name = filePath.split('/').pop()?.toLowerCase() ?? ''

  const nameMap: Record<string, string> = {
    makefile: 'makefile',
    dockerfile: 'dockerfile',
    'docker-compose.yml': 'yaml',
    'docker-compose.yaml': 'yaml',
    '.gitignore': 'plaintext',
    '.env': 'ini',
    '.env.local': 'ini',
    '.env.example': 'ini',
  }
  if (nameMap[name]) return nameMap[name]

  const ext = name.includes('.') ? name.split('.').pop() ?? '' : ''
  const extMap: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    json: 'json', jsonc: 'json',
    html: 'html', htm: 'html',
    css: 'css', scss: 'scss', less: 'less',
    md: 'markdown', mdx: 'markdown',
    xml: 'xml', svg: 'xml', xsl: 'xml',
    yaml: 'yaml', yml: 'yaml',
    py: 'python', pyw: 'python',
    rs: 'rust',
    dart: 'dart',
    go: 'go',
    java: 'java',
    c: 'c', h: 'c',
    cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
    cs: 'csharp',
    rb: 'ruby',
    php: 'php',
    swift: 'swift',
    kt: 'kotlin', kts: 'kotlin',
    sh: 'shell', bash: 'shell', zsh: 'shell',
    sql: 'sql',
    graphql: 'graphql', gql: 'graphql',
    toml: 'ini', ini: 'ini', env: 'ini',
    r: 'r',
    lua: 'lua',
    perl: 'perl', pl: 'perl',
    vue: 'html',
    svelte: 'html',
    txt: 'plaintext',
    log: 'plaintext',
    diff: 'plaintext',
    patch: 'plaintext',
  }
  return extMap[ext] ?? 'plaintext'
}

/** Monaco 通用编辑器配置（不包含 theme，由 beforeMount 设置） */
export const MONACO_COMMON_OPTIONS = {
  fontSize: 13,
  lineHeight: 20,
  fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', 'JetBrains Mono', Menlo, Monaco, 'Courier New', monospace",
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  automaticLayout: true,
  tabSize: 2,
  renderLineHighlight: 'all' as const,
  cursorBlinking: 'smooth' as const,
  smoothScrolling: true,
  padding: { top: 8, bottom: 8 },
  scrollbar: {
    verticalScrollbarSize: 8,
    horizontalScrollbarSize: 8,
    verticalSliderSize: 6,
    horizontalSliderSize: 6,
  },
  hover: { enabled: true, delay: 300 },
  suggestOnTriggerCharacters: true,
  quickSuggestions: true,
  wordBasedSuggestions: 'currentDocument' as const,
  bracketPairColorization: { enabled: true },
  guides: { bracketPairs: true, indentation: true },
  renderWhitespace: 'selection' as const,
  folding: true,
  foldingHighlight: true,
  links: true,
  colorDecorators: true,
  contextmenu: true,
  mouseWheelZoom: true,
}
