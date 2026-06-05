import { useEffect, useRef, useCallback, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

type TerminalPanelProps = {
  /** 终端工作目录 */
  cwd?: string
  /** 关闭终端回调 */
  onClose: () => void
}

export function TerminalPanel({ cwd, onClose }: Readonly<TerminalPanelProps>) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const [panelHeight, setPanelHeight] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem('taco.terminalPanelHeight') || '')
      if (Number.isFinite(saved) && saved >= 180 && saved <= 900) return saved
    } catch { /* ignore */ }
    return 280
  })
  const panelHeightRef = useRef(panelHeight)
  useEffect(() => {
    panelHeightRef.current = panelHeight
    try { localStorage.setItem('taco.terminalPanelHeight', String(panelHeight)) } catch { /* ignore */ }
  }, [panelHeight])

  // 初始化 xterm + 连接 IPC（合并为单个 effect，避免时序和 StrictMode 问题）
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // 创建 xterm 实例
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'SF Mono', 'Menlo', 'Consolas', 'Liberation Mono', monospace",
      lineHeight: 1.3,
      scrollback: 5000,
      theme: {
        background: '#0d0e11',
        foreground: '#e8e9ee',
        cursor: '#56d9c5',
        cursorAccent: '#0d0e11',
        selectionBackground: 'rgba(86, 217, 197, 0.25)',
        black: '#1b1e23',
        red: '#f56565',
        green: '#48bb78',
        yellow: '#ecc94b',
        blue: '#4c7bff',
        magenta: '#b794f4',
        cyan: '#56d9c5',
        white: '#e8e9ee',
        brightBlack: '#4a5568',
        brightRed: '#fc8181',
        brightGreen: '#68d391',
        brightYellow: '#fbd38d',
        brightBlue: '#63b3ed',
        brightMagenta: '#d6bcfa',
        brightCyan: '#76e4f7',
        brightWhite: '#ffffff',
      },
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(container)

    termRef.current = term
    fitAddonRef.current = fitAddon

    // 等 DOM 稳定后 fit，然后启动终端
    requestAnimationFrame(() => {
      try { fitAddon.fit() } catch { /* ignore */ }

      // 连接 IPC：终端输出 → xterm
      const cleanupOutput = window.taco.terminal.onOutput((data) => {
        term.write(data)
      })

      // 终端退出
      const cleanupExit = window.taco.terminal.onExit(({ code }) => {
        term.writeln(`\r\n\x1b[90m[进程已退出，代码: ${code ?? 'unknown'}]\x1b[0m`)
      })

      // xterm 键盘输入 → 终端进程
      const disposeData = term.onData((data) => {
        window.taco.terminal.input(data)
      })

      // 启动 PTY 终端进程
      window.taco.terminal.spawn(cwd)

      // 通知 PTY 初始大小
      window.taco.terminal.resize(term.cols, term.rows)

      // 存储清理函数供卸载使用
      ;(term as unknown as { _ipcCleanup: () => void })._ipcCleanup = () => {
        cleanupOutput()
        cleanupExit()
        disposeData.dispose()
      }
    })

    return () => {
      // 清理 IPC 监听
      const cleanup = (term as unknown as { _ipcCleanup?: () => void })._ipcCleanup
      if (cleanup) cleanup()

      // 杀掉终端进程
      window.taco.terminal.kill()

      // 销毁 xterm
      term.dispose()
      termRef.current = null
      fitAddonRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  // cwd 不放入依赖：终端只在挂载时创建一次

  // 监听容器大小变化，自动 fit + resize PTY
  const handleResize = useCallback(() => {
    const fitAddon = fitAddonRef.current
    const term = termRef.current
    if (!fitAddon || !term) return
    try {
      fitAddon.fit()
      window.taco.terminal.resize(term.cols, term.rows)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver(handleResize)
    observer.observe(el)
    return () => observer.disconnect()
  }, [handleResize])

  const handleResizeStart = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault()
    const startY = e.clientY
    const startHeight = panelHeightRef.current
    const minHeight = 180
    const maxHeight = Math.max(320, Math.floor(window.innerHeight * 0.75))

    document.body.style.cursor = 'ns-resize'
    document.body.classList.add('is-resizing')

    const onMove = (ev: MouseEvent) => {
      const delta = startY - ev.clientY
      const nextHeight = Math.max(minHeight, Math.min(maxHeight, startHeight + delta))
      panelHeightRef.current = nextHeight
      setPanelHeight(nextHeight)
    }

    const onUp = () => {
      document.body.style.cursor = ''
      document.body.classList.remove('is-resizing')
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  // 重启终端
  const handleRestart = useCallback(() => {
    window.taco.terminal.kill()
    const term = termRef.current
    if (term) {
      term.clear()
      term.reset()
      setTimeout(() => {
        window.taco.terminal.spawn(cwd)
        window.taco.terminal.resize(term.cols, term.rows)
      }, 150)
    }
  }, [cwd])

  return (
    <div className="terminal-panel" style={{ height: panelHeight }}>
      <div className="terminal-panel-resize-handle" onMouseDown={handleResizeStart}>
        <div className="terminal-panel-resize-line" />
      </div>
      <div className="terminal-panel-header">
        <span className="terminal-panel-title">终端</span>
        <div className="terminal-panel-actions">
          <button
            type="button"
            className="terminal-panel-btn"
            title="重启终端"
            onClick={handleRestart}
          >
            ↻
          </button>
          <button
            type="button"
            className="terminal-panel-btn"
            title="关闭终端"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
      </div>
      <div className="terminal-panel-body" ref={containerRef} />
    </div>
  )
}
