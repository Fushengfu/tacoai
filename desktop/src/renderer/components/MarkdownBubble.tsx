import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { highlightByLang } from '../lib/highlight'

/** 提取代码块纯文本（去掉末尾换行） */
function extractText(children: React.ReactNode): string {
  // 处理 ReactNode 数组的情况
  const flatten = (node: React.ReactNode): string => {
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(flatten).join('')
    if (node && typeof node === 'object' && 'props' in node) {
      return flatten((node as React.ReactElement).props?.children)
    }
    return ''
  }
  return flatten(children).replace(/\n$/, '')
}

function normalizeSlashPath(input: string): string {
  return String(input ?? '').trim().replace(/[\\/]+/g, '/').replace(/\/+/g, '/')
}

function isWindowsAbsolutePath(input: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(input) || input.startsWith('\\\\')
}

function isHttpLikeUrl(input: string): boolean {
  return /^(https?|ftp|mailto|tel):/i.test(input)
}

function decodeFileHrefPath(href: string): string | null {
  const raw = String(href ?? '').trim()
  if (!raw || raw.startsWith('#')) return null
  if (isHttpLikeUrl(raw)) return null

  if (raw.startsWith('file://')) {
    try {
      const u = new URL(raw)
      let pathname = decodeURIComponent(u.pathname || '')
      if (u.hostname) {
        // file://server/share/path
        const uncPath = pathname.replace(/\//g, '\\')
        return `\\\\${u.hostname}${uncPath}`
      }
      if (/^\/[a-zA-Z]:\//.test(pathname)) {
        pathname = pathname.slice(1)
      }
      return pathname
    } catch {
      return null
    }
  }

  if (raw.startsWith('/') || isWindowsAbsolutePath(raw)) {
    try { return decodeURIComponent(raw) } catch { return raw }
  }

  // 相对路径（非 URL 协议）视作项目内候选路径
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
    try { return decodeURIComponent(raw) } catch { return raw }
  }
  return null
}

function toWorkspaceRelativePath(filePath: string, workspace?: string): string | null {
  const normalizedPath = normalizeSlashPath(filePath).replace(/^\.\//, '')
  if (!normalizedPath) return null
  if (normalizedPath.startsWith('../') || normalizedPath === '..') return null

  if (!workspace) {
    return normalizedPath.startsWith('/') || isWindowsAbsolutePath(normalizedPath) ? null : normalizedPath
  }

  const normalizedWorkspace = normalizeSlashPath(workspace).replace(/\/+$/, '')
  const lowerPath = normalizedPath.toLowerCase()
  const lowerWorkspace = normalizedWorkspace.toLowerCase()

  if (normalizedPath.startsWith('/') || isWindowsAbsolutePath(normalizedPath)) {
    if (lowerPath === lowerWorkspace) return ''
    if (lowerPath.startsWith(`${lowerWorkspace}/`)) {
      return normalizedPath.slice(normalizedWorkspace.length + 1)
    }
    return null
  }

  return normalizedPath
}

/* ------------------------------------------------------------------ */
/*  解析 <think> 标签                                                    */
/* ------------------------------------------------------------------ */

type ParsedContent = {
  /** 思考过程内容（已去除 <think> 标签） */
  thinking: string
  /** 正文内容（去除 <think> 块后的文本） */
  body: string
  /** 思考是否已完成（有闭合 </think>，或根本没有 <think>） */
  thinkingDone: boolean
}

/**
 * 从内容中解析出 <think>...</think> 块。
 * 支持流式场景（<think> 还未闭合时 thinkingDone=false）。
 */
function parseThinkTag(raw: string): ParsedContent {
  const openIdx = raw.indexOf('<think>')
  if (openIdx === -1) {
    return { thinking: '', body: raw, thinkingDone: true }
  }

  const closeIdx = raw.indexOf('</think>', openIdx)
  if (closeIdx === -1) {
    // <think> 还未闭合 → 流式中
    const thinking = raw.slice(openIdx + 7) // 7 = '<think>'.length
    const body = raw.slice(0, openIdx).trim()
    return { thinking, body, thinkingDone: false }
  }

  // 有完整的 <think>...</think>
  const thinking = raw.slice(openIdx + 7, closeIdx)
  const body = (raw.slice(0, openIdx) + raw.slice(closeIdx + 8)).trim() // 8 = '</think>'.length
  return { thinking, body, thinkingDone: true }
}

/* ------------------------------------------------------------------ */
/*  思考过程折叠组件                                                      */
/* ------------------------------------------------------------------ */

function ThinkingBlock({ content, done }: Readonly<{ content: string; done: boolean }>) {
  const [expanded, setExpanded] = useState(!done)
  const wasStreamingRef = useRef(!done)

  // 思考完成后自动折叠
  useEffect(() => {
    if (done && wasStreamingRef.current) {
      wasStreamingRef.current = false
      // 稍作延迟再折叠，让用户有感知
      const timer = setTimeout(() => setExpanded(false), 400)
      return () => clearTimeout(timer)
    }
  }, [done])

  if (!content.trim()) return null

  return (
    <div className={`thinking-block ${done ? 'done' : 'streaming'}`}>
      <button
        type="button"
        className="thinking-block-header"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className={`thinking-block-chevron ${expanded ? 'open' : ''}`}>›</span>
        <span className="thinking-block-label">
          {done ? '思考过程' : '思考中...'}
        </span>
        {!done && <span className="dot-pulse inline" />}
      </button>
      {expanded && (
        <div className="thinking-block-body">
          {content}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  复制按钮 & MarkdownBubble                                           */
/* ------------------------------------------------------------------ */

function CopyButton({ text }: Readonly<{ text: string }>) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout>>()

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setCopied(false), 2000)
    })
  }, [text])

  return (
    <button
      type="button"
      className={`code-copy-btn${copied ? ' copied' : ''}`}
      onClick={handleCopy}
      title="复制代码"
    >
      {copied ? '✓ 已复制' : '复制'}
    </button>
  )
}

type MarkdownBubbleProps = {
  content: string
  streaming?: boolean
  workspace?: string
  onOpenProjectFile?: (filePath: string) => void
}

export function MarkdownBubble({ content, streaming, workspace, onOpenProjectFile }: Readonly<MarkdownBubbleProps>) {
  const parsed = useMemo(() => parseThinkTag(content), [content])

  // 思考完成状态：如果没有思考内容则忽略；流式中跟随 thinkingDone
  const thinkingDone = parsed.thinkingDone || (!streaming && parsed.thinkingDone)

  return (
    <>
      {parsed.thinking && (
        <ThinkingBlock content={parsed.thinking} done={thinkingDone} />
      )}
      {parsed.body && (
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a({ href, children, ...rest }) {
              return (
                <a
                  href={href}
                  rel="noopener noreferrer"
                  onClick={(e) => {
                    e.preventDefault()
                    const resolvedPath = href
                      ? toWorkspaceRelativePath(decodeFileHrefPath(href) ?? '', workspace)
                      : null
                    if (resolvedPath && onOpenProjectFile) {
                      onOpenProjectFile(resolvedPath)
                      return
                    }
                    if (href) {
                      window.taco.browser.openExternal(href)
                    }
                  }}
                  {...rest}
                >
                  {children}
                </a>
              )
            },
            // 覆盖 pre 元素：避免 react-markdown v10 自动包裹 <pre> 导致嵌套
            pre({ children }) {
              return <>{children}</>
            },
            code({ className, children, node, ...rest }) {
              const rawCode = extractText(children)
              // 判断是否为代码块：
              // 1. 有 language- 前缀 → 代码块
              // 2. 无 className 但内容包含换行 → 代码块（无语言标识的多行代码块）
              // 3. 其他情况 → 行内代码（如表格中的 `code`）
              const isBlock = (className && /language-/.test(className)) || (!className && rawCode.includes('\n'))
              if (isBlock) {
                const lang = className ? className.replace('language-', '') : ''
                const rawCode = extractText(children)
                const highlighted = highlightByLang(rawCode, lang)
                return (
                  <div className="code-block-wrapper">
                    <div className="code-block-header">
                      {lang && <span className="code-block-lang">{lang}</span>}
                      <CopyButton text={rawCode} />
                    </div>
                    <pre className="code-block">
                      <code
                        className={className}
                        dangerouslySetInnerHTML={{ __html: highlighted }}
                      />
                    </pre>
                  </div>
                )
              }
              return (
                <code className="inline-code" {...rest}>
                  {children}
                </code>
              )
            }
          }}
        >
          {parsed.body}
        </ReactMarkdown>
      )}
    </>
  )
}
