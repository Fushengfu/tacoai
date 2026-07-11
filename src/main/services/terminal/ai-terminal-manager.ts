/**
 * AI 终端会话管理器
 *
 * 为 AI Agent 提供持久 PTY 终端会话，支持 cd / export / 后台进程等状态保持。
 * 通过 sentinel 机制判断命令结束，而非依赖 exit code。
 *
 * 与 run_command 的区别：
 * - run_command: 一次性命令，每次新建 shell，执行完即分离
 * - ai-terminal: 持久 PTY 进程，命令间状态保持（cd、env、后台进程）
 */

import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import { log } from '../../infrastructure/logger'

/* ------------------------------------------------------------------ */
/*  类型定义                                                           */
/* ------------------------------------------------------------------ */

export interface AITerminalInfo {
  terminalId: string
  name: string
  cwd: string
  createdAt: number
}

interface AITerminalSession {
  terminalId: string
  name: string
  ptyProcess: IPty
  cwd: string
  createdAt: number
  /** shell 类型，用于构建 sentinel 命令 */
  shellType: 'unix' | 'powershell' | 'cmd'
  /** 是否正在等待命令完成（sentinel 模式） */
  pending: {
    sentinel: string
    resolve: (output: string) => void
    reject: (err: Error) => void
    timeout: ReturnType<typeof setTimeout>
  } | null
  /** stream 模式输出收集器（不等待 sentinel，定时返回） */
  streamCollector: {
    chunks: string[]
    timer: ReturnType<typeof setTimeout>
  } | null
}

/* ------------------------------------------------------------------ */
/*  模块状态                                                           */
/* ------------------------------------------------------------------ */

const sessions = new Map<string, AITerminalSession>()
let terminalCounter = 0

/** 单次命令最大等待时间（毫秒） */
const DEFAULT_TIMEOUT_MS = 120_000

/** 输出截断上限（字符数） */
const MAX_OUTPUT_CHARS = 24_000

/* ------------------------------------------------------------------ */
/*  内部工具                                                           */
/* ------------------------------------------------------------------ */

function generateId(): string {
  terminalCounter++
  return `ai-term-${Date.now()}-${terminalCounter}`
}

function getShell(): string {
  if (process.platform === 'win32') {
    // 优先 PowerShell：`;` 语法与 Unix 一致，SSH 到远程 Linux 后 sentinel 无缝工作
    return 'powershell.exe'
  }
  return process.env.SHELL || '/bin/zsh'
}

function detectShellType(shell: string): 'unix' | 'powershell' | 'cmd' {
  const lower = shell.toLowerCase()
  if (lower.includes('cmd.exe') || lower === 'cmd') return 'cmd'
  if (lower.includes('powershell') || lower.includes('pwsh')) return 'powershell'
  return 'unix'
}

function buildFullCommand(command: string, sentinel: string, shellType: 'unix' | 'powershell' | 'cmd'): string {
  if (shellType === 'cmd') {
    // cmd.exe 用 & 分隔命令，echo 不带引号
    return `${command} & echo ${sentinel}\n`
  }
  // Unix / PowerShell 用 ; 分隔
  return `${command}; echo '${sentinel}'\n`
}

function stripAnsiCodes(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
}

function stripShellPrompt(text: string): string {
  // 去掉提示符行（以 $ / # / > 开头，行首无实质内容）
  return text
    .split('\n')
    .filter(line => {
      const trimmed = line.trimEnd()
      if (!trimmed) return true
      // 纯提示符行：只有提示符，无实质内容
      if (/^[$#>]\s*$/.test(trimmed)) return false
      return true
    })
    .join('\n')
}

/* ------------------------------------------------------------------ */
/*  公开 API                                                           */
/* ------------------------------------------------------------------ */

/**
 * 创建一个新的 AI 终端会话
 */
export function createAITerminal(options: {
  name?: string
  cwd?: string
}): AITerminalInfo {
  const terminalId = generateId()
  const name = options.name || `终端 ${terminalCounter}`
  const cwd = options.cwd || process.env.HOME || '/'
  const shell = getShell()

  const shellType = detectShellType(shell)

  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 200,
    rows: 30,
    cwd,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    } as Record<string, string>,
  })

  const session: AITerminalSession = {
    terminalId,
    name,
    ptyProcess,
    cwd,
    createdAt: Date.now(),
    shellType,
    pending: null,
    streamCollector: null,
  }

  sessions.set(terminalId, session)

  // 持续监听 PTY 输出，交由命令等待逻辑处理
  ptyProcess.onData((data: string) => {
    if (session.pending) {
      const buf = session.pending
      // 检查 sentinel 是否已出现
      if (data.includes(buf.sentinel)) {
        // sentinel 到了，完成
        const { resolve, timeout } = buf
        session.pending = null
        clearTimeout(timeout)
        resolve(data)
      }
    }
    // stream 模式：收集输出
    if (session.streamCollector) {
      session.streamCollector.chunks.push(data)
    }
    // 不在等待状态时忽略输出
  })

  // PTY 退出时自动清理
  ptyProcess.onExit(() => {
    // 如果有等待中的命令，通知超时
    if (session.pending) {
      const { reject, timeout } = session.pending
      session.pending = null
      clearTimeout(timeout)
      reject(new Error('终端进程已退出'))
    }
    sessions.delete(terminalId)
    log('AI_TERMINAL_EXITED', { terminalId, name })
  })

  log('AI_TERMINAL_CREATE', { terminalId, name, cwd, shell, pid: ptyProcess.pid })

  return { terminalId, name, cwd, createdAt: session.createdAt }
}

/**
 * 在指定终端中执行命令，返回输出
 *
 * 两种模式：
 *
 * 1. sentinel 模式（默认，stream 不传或 false）：
 *    写入 "{command}; echo 'SENTINEL'\n" → onData 收集直到 SENTINEL → 返回
 *    适用于一次性命令，如 ls、cat、grep、构建等
 *
 * 2. stream 模式（stream=true）：
 *    写入 command（不带 sentinel）→ 在 streamMs 毫秒内收集输出 → 返回已收集内容
 *    命令继续在后台运行。适用于：
 *    - 启动长时间运行的服务（npm run dev、top、tail -f）
 *    - 间歇性检查进度（command="" 只收集最近输出，反复调用直到完成）
 */
export function runInAITerminal(
  terminalId: string,
  command: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  stream?: boolean,
  streamMs?: number,
): Promise<{ output: string; terminalId: string }> {
  const session = sessions.get(terminalId)
  if (!session) {
    return Promise.reject(new Error(`终端会话不存在: ${terminalId}。可能已被关闭，请用 terminal_create 新建。`))
  }

  /* ---- stream 模式 ---- */
  if (stream) {
    if (session.pending) {
      return Promise.reject(new Error(`终端 ${terminalId} 正在执行命令，请等待完成后再操作。`))
    }
    if (session.streamCollector) {
      return Promise.reject(new Error(`终端 ${terminalId} 正在 stream 收集中，请等待返回后再操作。`))
    }

    const collectMs = (Number.isFinite(streamMs) && (streamMs as number) > 0)
      ? (streamMs as number)
      : 3000

    return new Promise((resolve) => {
      const collector = {
        chunks: [] as string[],
        timer: setTimeout(() => {
          // 时间到，返回已收集输出
          const sc = session.streamCollector
          if (!sc) return
          session.streamCollector = null

          let clean = stripAnsiCodes(sc.chunks.join(''))
          clean = stripShellPrompt(clean).trim()

          if (clean.length > MAX_OUTPUT_CHARS) {
            clean = clean.slice(0, MAX_OUTPUT_CHARS) +
              `\n\n[输出已截断，共 ${clean.length} 字符，仅显示前 ${MAX_OUTPUT_CHARS} 字符]`
          }

          resolve({ output: clean || '(无输出)', terminalId })
        }, collectMs),
      }

      session.streamCollector = collector

      // 写入命令（非空时才写，空命令 = 只观察当前输出）
      if (command) {
        session.ptyProcess.write(command + '\n')
      }
    })
  }

  /* ---- sentinel 模式 ---- */
  if (session.pending) {
    return Promise.reject(new Error(`终端 ${terminalId} 正在执行其他命令，请等待完成后再执行新命令。`))
  }

  if (session.streamCollector) {
    return Promise.reject(new Error(`终端 ${terminalId} 正在 stream 收集中，请等待返回后再执行命令。`))
  }

  return new Promise((resolve, reject) => {
    const sentinel = `__TAI_DONE_${Date.now()}_${Math.random().toString(36).slice(2, 10)}__`

    const timeout = setTimeout(() => {
      if (session.pending) {
        const { resolve: res } = session.pending
        session.pending = null
        res('') // 超时后返回空，让 finish 用超时逻辑处理
      }
      // 超时：返回已收集的输出并报错
      reject(new Error(`命令执行超时 (${timeoutMs / 1000} 秒)`))
    }, timeoutMs)

    session.pending = {
      sentinel,
      resolve: (rawOutput: string) => {
        // 清理 ANSI 转义码
        let clean = stripAnsiCodes(rawOutput)

        // 找到 sentinel 位置，去掉 sentinel 及之后的内容
        const sentinelIdx = clean.indexOf(sentinel)
        if (sentinelIdx >= 0) {
          clean = clean.substring(0, sentinelIdx)
        }

        // 去掉提示符空行
        clean = stripShellPrompt(clean).trim()

        // 输出截断
        if (clean.length > MAX_OUTPUT_CHARS) {
          clean = clean.slice(0, MAX_OUTPUT_CHARS) +
            `\n\n[输出已截断，共 ${clean.length} 字符，仅显示前 ${MAX_OUTPUT_CHARS} 字符]`
        }

        resolve({ output: clean || '(命令执行成功，无输出)', terminalId })
      },
      reject: (err: Error) => {
        reject(err)
      },
      timeout,
    }

    // 写入终端（带 sentinel）
    const fullCommand = buildFullCommand(command, sentinel, session.shellType)
    session.ptyProcess.write(fullCommand)
  })
}

/**
 * 列出所有 AI 终端会话
 */
export function listAITerminals(): AITerminalInfo[] {
  return Array.from(sessions.values()).map(s => ({
    terminalId: s.terminalId,
    name: s.name,
    cwd: s.cwd,
    createdAt: s.createdAt,
  }))
}

/**
 * 关闭并销毁指定终端
 */
export function closeAITerminal(terminalId: string): boolean {
  const session = sessions.get(terminalId)
  if (!session) return false

  // 如果有等待中的命令，先拒绝
  if (session.pending) {
    const { reject, timeout } = session.pending
    session.pending = null
    clearTimeout(timeout)
    reject(new Error('终端已被关闭'))
  }

  try {
    session.ptyProcess.kill()
  } catch {
    // 可能已退出
  }

  sessions.delete(terminalId)
  log('AI_TERMINAL_CLOSE', { terminalId, name: session.name })

  return true
}

/**
 * 清理所有 AI 终端（应用退出时调用）
 */
export function cleanupAllAITerminals(): void {
  const count = sessions.size
  if (count === 0) return

  log('AI_TERMINAL_CLEANUP_START', { count })

  for (const [terminalId, session] of sessions) {
    if (session.pending) {
      const { reject, timeout } = session.pending
      session.pending = null
      clearTimeout(timeout)
      reject(new Error('应用退出，终端被清理'))
    }
    try {
      session.ptyProcess.kill()
    } catch {
      // ignore
    }
  }

  sessions.clear()
  log('AI_TERMINAL_CLEANUP_DONE', {})
}
