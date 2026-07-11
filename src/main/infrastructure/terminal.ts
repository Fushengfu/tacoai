/**
 * Terminal — 基于 node-pty 的真实 PTY 终端管理
 * 
 * 每个终端实例通过 terminalId 隔离。同一渲染窗口可同时运行多个独立终端。
 */

import type { IpcMainEvent, WebContents } from 'electron'
import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import { IpcChannel } from '../../shared/ipc-channels'

/** 每个 terminalId 对应一个 PTY 进程 */
const terminalProcesses = new Map<string, IPty>()

/** 进程信息记录 */
type ProcessInfo = {
  pty: IPty
  terminalId: string
  senderId: number
  createdAt: number
  pid?: number
}

const processRegistry = new Map<string, ProcessInfo>()

function getShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC || 'powershell.exe'
  return process.env.SHELL || '/bin/zsh'
}

export function handleTerminalSpawn(event: IpcMainEvent, payload: { cwd?: string; terminalId: string }) {
  const { terminalId } = payload
  if (!terminalId) return

  // 如果已有同一 terminalId 的进程，先杀掉
  const existing = terminalProcesses.get(terminalId)
  if (existing) {
    try { existing.kill() } catch { /* ignore */ }
    terminalProcesses.delete(terminalId)
    processRegistry.delete(terminalId)
  }

  const shell = getShell()
  const cwd = payload.cwd || process.env.HOME || '/'

  try {
    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      } as Record<string, string>,
    })

    terminalProcesses.set(terminalId, ptyProcess)
    
    // 注册进程信息
    processRegistry.set(terminalId, {
      pty: ptyProcess,
      terminalId,
      senderId: event.sender.id,
      createdAt: Date.now(),
      pid: ptyProcess.pid,
    })

    // PTY 输出 → 推送给渲染进程（携带 terminalId 供过滤）
    ptyProcess.onData((data) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(IpcChannel.TERMINAL_OUTPUT, { terminalId, data })
      }
    })

    // PTY 退出（携带 terminalId 供过滤）
    ptyProcess.onExit(({ exitCode }) => {
      terminalProcesses.delete(terminalId)
      processRegistry.delete(terminalId)
      if (!event.sender.isDestroyed()) {
        event.sender.send(IpcChannel.TERMINAL_EXIT, { terminalId, code: exitCode })
      }
    })
  } catch (err) {
    console.error('Terminal spawn failed:', err)
    if (!event.sender.isDestroyed()) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      event.sender.send(IpcChannel.TERMINAL_OUTPUT, {
        terminalId,
        data: `\r\n\x1b[31m终端启动失败: ${msg}\x1b[0m\r\n` +
          `\x1b[33m请尝试: chmod +x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper\x1b[0m\r\n`
      })
      event.sender.send(IpcChannel.TERMINAL_EXIT, { terminalId, code: -1 })
    }
  }
}

export function handleTerminalInput(event: IpcMainEvent, payload: { terminalId: string; data: string }) {
  const ptyProcess = terminalProcesses.get(payload.terminalId)
  if (ptyProcess) {
    ptyProcess.write(payload.data)
  }
}

export function handleTerminalResize(event: IpcMainEvent, payload: { terminalId: string; cols: number; rows: number }) {
  const ptyProcess = terminalProcesses.get(payload.terminalId)
  if (ptyProcess && payload.cols > 0 && payload.rows > 0) {
    try { ptyProcess.resize(payload.cols, payload.rows) } catch { /* ignore */ }
  }
}

export function handleTerminalKill(event: IpcMainEvent, payload: { terminalId: string }) {
  const ptyProcess = terminalProcesses.get(payload.terminalId)
  if (ptyProcess) {
    try { ptyProcess.kill() } catch { /* ignore */ }
    terminalProcesses.delete(payload.terminalId)
    processRegistry.delete(payload.terminalId)
  }
}

/**
 * 清理所有终端进程
 * 在应用退出时调用
 */
export function cleanupAllTerminals(): void {
  const count = terminalProcesses.size
  if (count === 0) return

  console.log(`[Terminal] Cleaning up ${count} terminal process(es)...`)

  for (const [terminalId, ptyProcess] of terminalProcesses.entries()) {
    try {
      ptyProcess.kill()
      console.log(`[Terminal] Killed terminal ${terminalId}`)
    } catch (error) {
      console.error(`[Terminal] Failed to kill terminal ${terminalId}:`, error)
    }
  }

  terminalProcesses.clear()
  processRegistry.clear()
  console.log('[Terminal] All terminals cleaned up')
}

/**
 * 获取活跃的终端进程数
 */
export function getActiveTerminalCount(): number {
  return terminalProcesses.size
}

/**
 * 获取终端进程信息
 */
export function getTerminalInfo(terminalId: string): ProcessInfo | undefined {
  return processRegistry.get(terminalId)
}

/**
 * 获取所有终端进程信息
 */
export function getAllTerminalInfo(): ProcessInfo[] {
  return Array.from(processRegistry.values())
}
