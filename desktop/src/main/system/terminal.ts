/**
 * Terminal — 基于 node-pty 的真实 PTY 终端管理
 */

import type { IpcMainEvent, WebContents } from 'electron'
import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import { IpcChannel } from '../../shared/ipc'

/** 每个 webContents 对应一个 PTY 进程 */
const terminalProcesses = new Map<number, IPty>()

/** 进程信息记录 */
type ProcessInfo = {
  pty: IPty
  senderId: number
  createdAt: number
  pid?: number
}

const processRegistry = new Map<number, ProcessInfo>()

function getShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC || 'powershell.exe'
  return process.env.SHELL || '/bin/zsh'
}

export function handleTerminalSpawn(event: IpcMainEvent, payload: { cwd?: string }) {
  const senderId = event.sender.id

  // 如果已有终端进程，先杀掉
  const existing = terminalProcesses.get(senderId)
  if (existing) {
    try { existing.kill() } catch { /* ignore */ }
    terminalProcesses.delete(senderId)
    processRegistry.delete(senderId)
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

    terminalProcesses.set(senderId, ptyProcess)
    
    // 注册进程信息
    processRegistry.set(senderId, {
      pty: ptyProcess,
      senderId,
      createdAt: Date.now(),
      pid: ptyProcess.pid,
    })

    // PTY 输出 → 推送给渲染进程
    ptyProcess.onData((data) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(IpcChannel.TERMINAL_OUTPUT, data)
      }
    })

    // PTY 退出
    ptyProcess.onExit(({ exitCode }) => {
      terminalProcesses.delete(senderId)
      processRegistry.delete(senderId)
      if (!event.sender.isDestroyed()) {
        event.sender.send(IpcChannel.TERMINAL_EXIT, { code: exitCode })
      }
    })
  } catch (err) {
    console.error('Terminal spawn failed:', err)
    if (!event.sender.isDestroyed()) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      event.sender.send(IpcChannel.TERMINAL_OUTPUT,
        `\r\n\x1b[31m终端启动失败: ${msg}\x1b[0m\r\n` +
        `\x1b[33m请尝试: chmod +x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper\x1b[0m\r\n`
      )
      event.sender.send(IpcChannel.TERMINAL_EXIT, { code: -1 })
    }
  }
}

export function handleTerminalInput(event: IpcMainEvent, data: string) {
  const ptyProcess = terminalProcesses.get(event.sender.id)
  if (ptyProcess) {
    ptyProcess.write(data)
  }
}

export function handleTerminalResize(event: IpcMainEvent, payload: { cols: number; rows: number }) {
  const ptyProcess = terminalProcesses.get(event.sender.id)
  if (ptyProcess && payload.cols > 0 && payload.rows > 0) {
    try { ptyProcess.resize(payload.cols, payload.rows) } catch { /* ignore */ }
  }
}

export function handleTerminalKill(event: IpcMainEvent) {
  const ptyProcess = terminalProcesses.get(event.sender.id)
  if (ptyProcess) {
    try { ptyProcess.kill() } catch { /* ignore */ }
    terminalProcesses.delete(event.sender.id)
    processRegistry.delete(event.sender.id)
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

  for (const [senderId, ptyProcess] of terminalProcesses.entries()) {
    try {
      ptyProcess.kill()
      console.log(`[Terminal] Killed terminal for sender ${senderId}`)
    } catch (error) {
      console.error(`[Terminal] Failed to kill terminal for sender ${senderId}:`, error)
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
export function getTerminalInfo(senderId: number): ProcessInfo | undefined {
  return processRegistry.get(senderId)
}

/**
 * 获取所有终端进程信息
 */
export function getAllTerminalInfo(): ProcessInfo[] {
  return Array.from(processRegistry.values())
}
