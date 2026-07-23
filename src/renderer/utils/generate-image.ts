/**
 * Markdown 内容转图片工具
 *
 * 使用 html2canvas + react-markdown 将 AI 回复渲染为 PNG 图片，
 * 效果与聊天界面 MarkdownBubble 一致。
 */

import html2canvas from 'html2canvas'
import React from 'react'
import { createRoot } from 'react-dom/client'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/* ------------------------------------------------------------------ */
/*  主题颜色                                                             */
/* ------------------------------------------------------------------ */

const DARK_CSS = `
.markdown-img-root {
  background: #0b0c0e; color: #e8e9ee; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif;
  font-size: 14px; line-height: 1.65; padding: 20px 24px; width: 720px; box-sizing: border-box;
}
.markdown-img-root h1 { font-size: 1.3em; margin: 16px 0 8px; }
.markdown-img-root h2 { font-size: 1.15em; margin: 16px 0 8px; }
.markdown-img-root h3 { font-size: 1.05em; margin: 16px 0 8px; }
.markdown-img-root h4 { margin: 16px 0 8px; }
.markdown-img-root p { margin: 0 0 8px; }
.markdown-img-root p:last-child { margin-bottom: 0; }
.markdown-img-root ul, .markdown-img-root ol { padding-left: 1.4em; margin: 8px 0; }
.markdown-img-root li { margin-bottom: 4px; }
.markdown-img-root blockquote { border-left: 3px solid #56d9c5; padding-left: 12px; margin: 10px 0; color: #9aa3b2; }
.markdown-img-root table { border-collapse: separate; border-spacing: 0; width: 100%; margin: 10px 0; font-size: 13px; }
.markdown-img-root th, .markdown-img-root td { border: 1px solid #1f232b; padding: 6px 10px; text-align: left; }
.markdown-img-root th { background: rgba(255,255,255,0.04); font-weight: 600; }
.markdown-img-root a { color: #4c7bff; text-decoration: none; }
.markdown-img-root hr { border: none; border-top: 1px solid #1f232b; margin: 12px 0; }
.markdown-img-root .img-code-block { margin: 10px 0; border: 1px solid rgba(255,255,255,0.06); border-radius: 10px; overflow: hidden; background: rgba(0,0,0,0.4); }
.markdown-img-root .img-code-header { display: flex; align-items: center; padding: 6px 12px; background: rgba(255,255,255,0.04); border-bottom: 1px solid rgba(255,255,255,0.06); min-height: 28px; }
.markdown-img-root .img-code-lang { font-size: 11px; color: rgba(255,255,255,0.4); font-family: "SF Mono", Menlo, Monaco, Consolas, monospace; text-transform: uppercase; letter-spacing: 0.5px; }
.markdown-img-root .img-code-body { padding: 10px 14px; overflow-x: auto; }
.markdown-img-root .img-code-body pre { margin: 0; white-space: pre-wrap; word-break: break-all; }
.markdown-img-root .img-code-body code { font-family: "SF Mono", Menlo, Monaco, Consolas, monospace; font-size: 13px; color: #c9d1d9; }
.markdown-img-root .img-inline-code { background: rgba(255,255,255,0.08); padding: 2px 6px; border-radius: 5px; font-size: 0.9em; font-family: "SF Mono", Menlo, Monaco, Consolas, monospace; }
.markdown-img-root img { max-width: 100%; border-radius: 4px; }

/* ---- 亮色主题 ---- */
.markdown-img-root.light { background: #ffffff; color: #1c1c1e; }
.markdown-img-root.light blockquote { border-left-color: #2c9a8e; color: #6e6e73; }
.markdown-img-root.light table th, .markdown-img-root.light table td { border-color: #d0d7de; }
.markdown-img-root.light table th { background: rgba(0,0,0,0.03); }
.markdown-img-root.light a { color: #3b6eff; }
.markdown-img-root.light hr { border-top-color: #d0d7de; }
.markdown-img-root.light .img-code-block { border-color: rgba(0,0,0,0.08); background: rgba(0,0,0,0.03); }
.markdown-img-root.light .img-code-header { background: rgba(0,0,0,0.03); border-bottom-color: rgba(0,0,0,0.08); }
.markdown-img-root.light .img-code-lang { color: rgba(0,0,0,0.35); }
.markdown-img-root.light .img-code-body code { color: #1c1c1e; }
.markdown-img-root.light .img-inline-code { background: rgba(0,0,0,0.06); }
`

/* ------------------------------------------------------------------ */
/*  提取代码块纯文本                                                       */
/* ------------------------------------------------------------------ */

function extractText(children: React.ReactNode): string {
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

/* ------------------------------------------------------------------ */
/*  类型                                                                 */
/* ------------------------------------------------------------------ */

export interface RenderResult { dataUrl: string; width: number; height: number }

/* ------------------------------------------------------------------ */
/*  主渲染函数                                                            */
/* ------------------------------------------------------------------ */

export async function renderReplyToImage(content: string): Promise<RenderResult> {
  if (!content?.trim() || typeof document === 'undefined') {
    return { dataUrl: '', width: 0, height: 0 }
  }

  const isLight = document.documentElement.dataset.theme === 'light'
  const themeClass = isLight ? 'light' : ''

  // 1. 创建隐藏容器
  const wrapper = document.createElement('div')
  wrapper.style.cssText = 'position:fixed;left:-9999px;top:0;z-index:-1'
  document.body.appendChild(wrapper)

  // 注入样式
  const styleEl = document.createElement('style')
  styleEl.textContent = DARK_CSS
  wrapper.appendChild(styleEl)

  // Markdown 渲染容器
  const container = document.createElement('div')
  container.className = `markdown-img-root ${themeClass}`.trim()
  wrapper.appendChild(container)

  // 2. React 渲染 Markdown
  const root = createRoot(container)

  await new Promise<void>((resolve) => {
    root.render(
      React.createElement(ReactMarkdown, {
        remarkPlugins: [remarkGfm],
        children: content,
        components: {
          // 覆盖 img：只显示 alt 文本（图片 URL 无法在截图中有意义）
          img({ alt, src }: any) {
            return React.createElement('span', {
              style: { color: isLight ? '#6e6e73' : '#9aa3b2', fontStyle: 'italic' }
            }, alt ? `[图片: ${alt}]` : '[图片]')
          },
          // 代码块
          pre({ children }: any) {
            return React.createElement(React.Fragment, null, children)
          },
          code({ className, children }: any) {
            const rawCode = extractText(children)
            const isBlock =
              (className && /language-/.test(className)) ||
              (!className && rawCode.includes('\n'))

            if (isBlock) {
              const lang = className ? className.replace('language-', '') : ''
              return React.createElement('div', { className: 'img-code-block' },
                lang ? React.createElement('div', { className: 'img-code-header' },
                  React.createElement('span', { className: 'img-code-lang' }, lang)
                ) : null,
                React.createElement('div', { className: 'img-code-body' },
                  React.createElement('pre', null,
                    React.createElement('code', { className }, rawCode)
                  )
                )
              )
            }
            // 行内代码
            return React.createElement('code', { className: 'img-inline-code' }, children)
          }
        }
      })
    )

    // 等待渲染完成（给了足够的 layout/paint 时间）
    setTimeout(resolve, 150)
  })

  // 3. html2canvas 截图
  try {
    const canvas = await html2canvas(container, {
      backgroundColor: null,
      scale: 2, // 2x 高清
      useCORS: true,
      logging: false,
      allowTaint: false,
    })

    const dataUrl = canvas.toDataURL('image/png')

    // 4. 清理
    root.unmount()
    wrapper.remove()

    return { dataUrl, width: canvas.width, height: canvas.height }
  } catch {
    root.unmount()
    wrapper.remove()
    return { dataUrl: '', width: 0, height: 0 }
  }
}
