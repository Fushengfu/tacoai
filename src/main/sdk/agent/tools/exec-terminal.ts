/**
 * 工具执行器 - 终端管理（terminal_create/run/list/close）
 */

import type { AgentServices } from '../services'
import { resolveSafe, type ExecResult, type ToolRuntimeContext } from './exec-utils'

/* ------------------------------------------------------------------ */
/*  terminal_create                                                    */
/* ------------------------------------------------------------------ */

export async function execTerminalCreate(
  args: Record<string, unknown>,
  workspace: string,
  services?: AgentServices,
): Promise<ExecResult> {
  const name = typeof args.name === 'string' ? args.name.trim() : undefined
  const cwdRaw = typeof args.cwd === 'string' ? args.cwd.trim() : undefined

  let cwd: string | undefined
  if (cwdRaw) {
    const check = resolveSafe(workspace, cwdRaw)
    if ('error' in check) {
      return { content: `Error: cwd 路径超出工作空间: ${check.error}`, success: false }
    }
    cwd = check.resolved
  }

  if (!services?.terminal) {
    return { content: 'Error: terminal service not available', success: false }
  }

  try {
    const info = services.terminal.create({ name, cwd })
    return { content: JSON.stringify(info), success: true }
  } catch (err) {
    return { content: `Error: 创建终端失败: ${err instanceof Error ? err.message : String(err)}`, success: false }
  }
}

/* ------------------------------------------------------------------ */
/*  terminal_run                                                       */
/* ------------------------------------------------------------------ */

export async function execTerminalRun(
  args: Record<string, unknown>,
  services?: AgentServices,
): Promise<ExecResult> {
  const terminalId = String(args.terminalId ?? '').trim()
  if (!terminalId) return { content: 'Error: terminalId is required', success: false }

  const command = String(args.command ?? '')
  const timeoutMs = Number.isFinite(Number(args.timeout)) ? Number(args.timeout) : undefined
  const stream = args.stream === true
  const streamMs = Number.isFinite(Number(args.streamMs)) ? Number(args.streamMs) : undefined

  if (!services?.terminal) {
    return { content: 'Error: terminal service not available', success: false }
  }

  try {
    const result = await services.terminal.run(terminalId, command, timeoutMs || 120000, stream, streamMs)
    return { content: result.output, success: true }
  } catch (err) {
    return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, success: false }
  }
}

/* ------------------------------------------------------------------ */
/*  terminal_list                                                      */
/* ------------------------------------------------------------------ */

export async function execTerminalList(services?: AgentServices): Promise<ExecResult> {
  if (!services?.terminal) {
    return { content: '终端服务不可用', success: false }
  }

  try {
    const terminals = services.terminal.list()
    if (terminals.length === 0) {
      return { content: '当前没有活跃的 AI 终端会话。使用 terminal_create 创建新终端。', success: true }
    }
    return { content: JSON.stringify(terminals, null, 2), success: true }
  } catch (err) {
    return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, success: false }
  }
}

/* ------------------------------------------------------------------ */
/*  terminal_close                                                     */
/* ------------------------------------------------------------------ */

export async function execTerminalClose(
  args: Record<string, unknown>,
  services?: AgentServices,
): Promise<ExecResult> {
  const terminalId = String(args.terminalId ?? '').trim()
  if (!terminalId) return { content: 'Error: terminalId is required', success: false }

  if (!services?.terminal) {
    return { content: 'Error: terminal service not available', success: false }
  }

  try {
    const closed = services.terminal.close(terminalId)
    if (closed) {
      return { content: `终端 ${terminalId} 已关闭`, success: true }
    }
    return { content: `终端 ${terminalId} 不存在或已关闭`, success: false }
  } catch (err) {
    return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, success: false }
  }
}
