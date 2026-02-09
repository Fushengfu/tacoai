/**
 * 工具执行结果的富显示组件
 *
 * 根据工具类型渲染不同的内容：
 * - run_command → 终端风格输出
 * - write_file / delete_file → inline diff 显示文件变更
 * - read_file → 代码风格文件内容
 * - list_directory / find_file / search_files → 结构化树形展示
 * - 其他 → 原始文本
 */

import { useMemo, useState } from 'react'
import type { ToolResultInfo, FileChangeInfo } from '../types'
import { computeDiff } from '../lib/diff'
import type { DiffLine } from '../lib/diff'

type ToolResultContentProps = {
  toolName: string
  toolArgs: Record<string, unknown>
  result: ToolResultInfo
}

/** 将 diff 行按变更区域分组，保留上下文 */
function groupDiffHunks(lines: DiffLine[], context = 3): DiffLine[][] {
  if (lines.length <= 60) return [lines]
  const changed = lines.map((l) => l.type !== 'same')
  const hunks: DiffLine[][] = []
  let curr: DiffLine[] = []
  let lastIdx = -Infinity

  for (let i = 0; i < lines.length; i++) {
    if (changed[i]) {
      if (i - lastIdx > context * 2 + 1 && curr.length > 0) {
        hunks.push(curr)
        curr = []
        for (let j = Math.max(0, i - context); j < i; j++) curr.push(lines[j])
      } else if (curr.length === 0) {
        for (let j = Math.max(0, i - context); j < i; j++) curr.push(lines[j])
      }
      curr.push(lines[i])
      lastIdx = i
    } else if (i - lastIdx <= context) {
      curr.push(lines[i])
    }
  }
  if (curr.length > 0) hunks.push(curr)
  return hunks.length > 0 ? hunks : [lines.slice(0, 40)]
}

/** 命令执行结果 — 终端风格 */
function CommandOutput({ command, result }: { command: string; result: ToolResultInfo }) {
  const output = result.content
  // 限制过长输出
  const MAX_LINES = 100
  const lines = output.split('\n')
  const truncated = lines.length > MAX_LINES
  const displayText = truncated ? lines.slice(0, MAX_LINES).join('\n') : output

  return (
    <div className="tool-result-command">
      <div className="tool-result-command-header">
        <span className="tool-result-command-prompt">$</span>
        <code className="tool-result-command-text">{command}</code>
      </div>
      <pre className={`tool-result-command-output ${result.success ? '' : 'error'}`}>
        {displayText}
        {truncated && (
          <span className="tool-result-truncated">
            {'\n'}... 已截断（共 {lines.length} 行）
          </span>
        )}
      </pre>
    </div>
  )
}

/** 文件变更结果 — inline diff */
function FileChangeDiff({ change, result }: { change: FileChangeInfo; result: ToolResultInfo }) {
  const lines = useMemo(
    () => computeDiff(change.oldContent, change.newContent),
    [change.oldContent, change.newContent]
  )
  const hunks = useMemo(() => groupDiffHunks(lines), [lines])
  const added = lines.filter((l) => l.type === 'add').length
  const removed = lines.filter((l) => l.type === 'remove').length

  const isNew = change.oldContent === null
  const isDelete = change.newContent === null

  return (
    <div className="tool-result-diff">
      <div className="tool-result-diff-header">
        <span className="tool-result-diff-path">{change.filePath}</span>
        <span className="tool-result-diff-stats">
          {isNew ? (
            <span className="stat-add">新建文件</span>
          ) : isDelete ? (
            <span className="stat-remove">删除文件</span>
          ) : (
            <>
              {added > 0 && <span className="stat-add">+{added}</span>}
              {removed > 0 && <span className="stat-remove"> -{removed}</span>}
            </>
          )}
        </span>
      </div>
      <div className="tool-result-diff-body">
        {hunks.map((hunk, hi) => (
          <div key={hi} className="tool-result-diff-hunk">
            {hi > 0 && <div className="tool-result-diff-sep">···</div>}
            {hunk.map((line, li) => (
              <div key={`${hi}-${li}`} className={`tool-result-diff-line ${line.type}`}>
                <span className="tool-result-diff-no">{line.oldLineNo ?? line.newLineNo ?? ''}</span>
                <span className="tool-result-diff-prefix">
                  {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}
                </span>
                <span className="tool-result-diff-text">{line.content || '\u00A0'}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
      {!result.success && result.content && (
        <pre className="tool-result-error-note">{result.content}</pre>
      )}
    </div>
  )
}

/** 代码文件内容 — 带行号 */
function FileContent({ filePath, content }: { filePath: string; content: string }) {
  const [collapsed, setCollapsed] = useState(content.split('\n').length > 30)
  const lines = content.split('\n')
  const MAX_COLLAPSED = 20
  const displayLines = collapsed ? lines.slice(0, MAX_COLLAPSED) : lines

  return (
    <div className="tool-result-file">
      <div className="tool-result-file-header">
        <span className="tool-result-file-path">{filePath}</span>
        <span className="tool-result-file-lines">{lines.length} 行</span>
      </div>
      <div className="tool-result-file-body">
        {displayLines.map((line, i) => (
          <div key={i} className="tool-result-file-line">
            <span className="tool-result-file-no">{i + 1}</span>
            <span className="tool-result-file-text">{line || '\u00A0'}</span>
          </div>
        ))}
        {collapsed && lines.length > MAX_COLLAPSED && (
          <button
            type="button"
            className="tool-result-show-more"
            onClick={() => setCollapsed(false)}
          >
            显示全部 ({lines.length} 行)
          </button>
        )}
      </div>
    </div>
  )
}

/** 目录列表 — 树形展示 */
function DirectoryListing({ content }: { content: string }) {
  return (
    <pre className="tool-result-tree">{content}</pre>
  )
}

/* ================================================================== */
/*  主组件                                                              */
/* ================================================================== */

export function ToolResultContent({ toolName, toolArgs, result }: ToolResultContentProps) {
  // 1. 写入/删除文件 → 显示 diff
  if ((toolName === 'write_file' || toolName === 'delete_file') && result.fileChange) {
    return <FileChangeDiff change={result.fileChange} result={result} />
  }

  // 2. 执行命令 → 终端风格
  if (toolName === 'run_command') {
    const command = String(toolArgs.command ?? '')
    return <CommandOutput command={command} result={result} />
  }

  // 3. 读取文件 → 代码展示
  if (toolName === 'read_file' && result.success && result.content) {
    const filePath = String(toolArgs.path ?? '')
    return <FileContent filePath={filePath} content={result.content} />
  }

  // 4. 目录列表 / 搜索结果 → 树形
  if (
    (toolName === 'list_directory' || toolName === 'find_file' || toolName === 'search_files')
    && result.content
  ) {
    return <DirectoryListing content={result.content} />
  }

  // 5. Fallback → 原始文本
  return (
    <pre className={`agent-step-result-content ${result.success ? '' : 'error'}`}>
      {result.content}
    </pre>
  )
}
