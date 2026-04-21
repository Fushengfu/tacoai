/**
 * MCP (Model Context Protocol) 客户端管理器
 *
 * 实现 MCP JSON-RPC 2.0 over stdio 协议（LSP 风格 Content-Length 帧格式），
 * 管理 MCP 服务器的生命周期。
 * 支持内置 MCP（如 MiniMax）和第三方 MCP 安装。
 *
 * 持久化：MCP 服务器配置保存在 ~/.taco/mcp.json
 */

import { spawn, execSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { app } from 'electron'
import { log } from '../system/logger'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** MCP 服务器配置 */
export type McpServerConfig = {
  /** 唯一标识 */
  id: string
  /** 显示名称 */
  name: string
  /** 启动命令 */
  command: string
  /** 命令参数 */
  args: string[]
  /** 环境变量 */
  env: Record<string, string>
  /** 是否启用 */
  enabled: boolean
  /** 是否为内置 */
  builtin: boolean
  /** 描述 */
  description?: string
}

/** MCP 工具定义（来自服务器） */
export type McpTool = {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

/** MCP 工具调用结果 */
export type McpToolResult = {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>
  isError?: boolean
}

/**
 * 传输模式：
 * - 'newline': 换行分隔 JSON（Python SDK 使用）
 * - 'content-length': Content-Length 帧格式（TypeScript SDK 使用）
 * - 'unknown': 尚未检测
 */
type TransportMode = 'unknown' | 'newline' | 'content-length'

/** 服务器运行时状态 */
type McpServerState = {
  config: McpServerConfig
  process: ChildProcess | null
  tools: McpTool[]
  status: 'stopped' | 'starting' | 'running' | 'error'
  error?: string
  /** JSON-RPC 请求 ID 计数器 */
  nextId: number
  /** 等待响应的请求 */
  pendingRequests: Map<number, {
    resolve: (result: unknown) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>
  /** 接收缓冲区（原始字节） */
  rawBuffer: Buffer
  /** 自动检测的传输模式 */
  transportMode: TransportMode
}

/* ------------------------------------------------------------------ */
/*  路径常量                                                            */
/* ------------------------------------------------------------------ */

const TACO_DIR = path.join(app.getPath('home'), '.taco')
const MCP_JSON = path.join(TACO_DIR, 'mcp.json')
const SCREENSHOTS_DIR = path.join(TACO_DIR, 'screenshots')

/* ------------------------------------------------------------------ */
/*  内置 MCP 服务器                                                     */
/* ------------------------------------------------------------------ */

const BUILTIN_SERVERS: McpServerConfig[] = [
  {
    id: 'minimax',
    name: 'MiniMax',
    description: '图片理解 & 网络搜索（需要配置 API Key）',
    command: 'uvx',
    args: ['minimax-coding-plan-mcp'],
    env: {
      MINIMAX_API_KEY: '',
      MINIMAX_API_HOST: 'https://api.minimaxi.com',
    },
    enabled: false,
    builtin: true,
  },
]

/* ------------------------------------------------------------------ */
/*  状态管理                                                            */
/* ------------------------------------------------------------------ */

const servers: Map<string, McpServerState> = new Map()

/* ------------------------------------------------------------------ */
/*  PATH 解析 — 确保 Electron 能找到 uvx/npx 等命令                      */
/* ------------------------------------------------------------------ */

/** 缓存扩展后的 PATH */
let expandedPath: string | null = null

/**
 * 获取完整的 shell PATH。
 * Electron 从 Dock 启动时 PATH 很短，需要从用户 shell 中获取完整 PATH。
 */
function getFullPath(): string {
  if (expandedPath) return expandedPath

  const currentPath = process.env.PATH ?? ''

  // 常见的额外 PATH 目录
  const extraPaths = [
    path.join(app.getPath('home'), '.local', 'bin'),     // uv/uvx
    path.join(app.getPath('home'), '.cargo', 'bin'),     // cargo
    '/usr/local/bin',
    '/opt/homebrew/bin',                                  // macOS ARM Homebrew
    '/opt/homebrew/sbin',
  ]

  // 尝试从 shell 获取完整 PATH
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    const fullPath = execSync(`${shell} -ilc 'echo $PATH'`, {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim()
    if (fullPath) {
      expandedPath = fullPath
      log('MCP_PATH_RESOLVED', { method: 'shell', pathLength: fullPath.split(':').length })
      return fullPath
    }
  } catch (err) {
    log('MCP_PATH_SHELL_FAIL', { error: err instanceof Error ? err.message : String(err) })
  }

  // 回退：合并当前 PATH + 常见目录
  const allPaths = [...new Set([...currentPath.split(':'), ...extraPaths])]
  expandedPath = allPaths.join(':')
  log('MCP_PATH_RESOLVED', { method: 'fallback', pathLength: allPaths.length })
  return expandedPath
}

/* ------------------------------------------------------------------ */
/*  持久化                                                              */
/* ------------------------------------------------------------------ */

async function ensureDirs() {
  await fs.mkdir(TACO_DIR, { recursive: true })
  await fs.mkdir(SCREENSHOTS_DIR, { recursive: true })
}

/** 从 JSON 文件读取 MCP 配置 */
async function loadConfig(): Promise<McpServerConfig[]> {
  try {
    const data = await fs.readFile(MCP_JSON, 'utf-8')
    return JSON.parse(data)
  } catch {
    return []
  }
}

/** 保存 MCP 配置到 JSON */
async function saveConfig(configs: McpServerConfig[]) {
  await ensureDirs()
  await fs.writeFile(MCP_JSON, JSON.stringify(configs, null, 2), 'utf-8')
}

/** 获取所有服务器配置（内置 + 已安装） */
async function getAllConfigs(): Promise<McpServerConfig[]> {
  const saved = await loadConfig()
  const result: McpServerConfig[] = []

  // 内置服务器：以持久化的为准，但始终同步 command/args（修复旧版本遗留问题）
  for (const builtin of BUILTIN_SERVERS) {
    const persisted = saved.find((s) => s.id === builtin.id)
    if (persisted) {
      // 保留用户修改的 env/enabled，但强制同步 command/args/description
      persisted.command = builtin.command
      persisted.args = builtin.args
      persisted.description = builtin.description
      result.push(persisted)
    } else {
      result.push({ ...builtin })
    }
  }

  // 第三方服务器
  for (const s of saved) {
    if (!s.builtin) result.push(s)
  }

  return result
}

/* ------------------------------------------------------------------ */
/*  JSON-RPC 双模传输                                                    */
/*                                                                      */
/*  MCP 有两种 stdio 传输格式：                                           */
/*  1. 换行分隔 JSON: {"jsonrpc":"2.0",...}\n      (Python SDK)         */
/*  2. Content-Length: Content-Length: N\r\n\r\n{}  (TypeScript SDK)     */
/*                                                                      */
/*  自动检测：根据服务器首条响应数据判断格式并适配。                          */
/* ------------------------------------------------------------------ */

const HEADER_SEPARATOR = Buffer.from('\r\n\r\n')
const CONTENT_LENGTH_RE = /Content-Length:\s*(\d+)/i

/** 以指定格式写入一条 JSON-RPC 消息 */
function writeMessage(state: McpServerState, json: string) {
  const stdin = state.process?.stdin
  if (!stdin?.writable) return

  if (state.transportMode === 'content-length') {
    // Content-Length 帧格式
    const bodyBytes = Buffer.from(json, 'utf-8')
    stdin.write(`Content-Length: ${bodyBytes.length}\r\n\r\n`)
    stdin.write(bodyBytes)
  } else {
    // 换行分隔 JSON（默认 / unknown 时也用此格式）
    stdin.write(json + '\n')
  }
}

function sendJsonRpc(state: McpServerState, method: string, params?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!state.process?.stdin?.writable) {
      reject(new Error('MCP 服务器进程不可用'))
      return
    }
    console.log(`Sending JSON-RPC message: ${method}`, params)

    const id = state.nextId++
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    })

    // 超时 30 秒
    const timer = setTimeout(() => {
      state.pendingRequests.delete(id)
      reject(new Error(`MCP 请求超时: ${method}`))
    }, 30000)

    state.pendingRequests.set(id, { resolve, reject, timer })

    writeMessage(state, body)
  })
}

function sendNotification(state: McpServerState, method: string, params?: unknown) {
  if (!state.process?.stdin?.writable) return

  const body = JSON.stringify({
    jsonrpc: '2.0',
    method,
    ...(params !== undefined ? { params } : {}),
  })

  writeMessage(state, body)
}

/**
 * 处理接收缓冲区 — 自动检测传输格式。
 *
 * 检测逻辑：
 * - 如果缓冲区以 "Content-Length:" 开头 → Content-Length 模式
 * - 如果缓冲区以 "{" 开头 → 换行分隔 JSON 模式
 * - 一旦检测到格式，后续消息都用同一格式解析
 */
function processBuffer(state: McpServerState) {
  // 自动检测传输模式（只在首次收到数据时检测）
  if (state.transportMode === 'unknown' && state.rawBuffer.length > 0) {
    const firstByte = String.fromCharCode(state.rawBuffer[0])
    if (firstByte === 'C' || firstByte === 'c') {
      // 可能是 Content-Length 头部
      state.transportMode = 'content-length'
      log('MCP_TRANSPORT_DETECTED', { serverId: state.config.id, mode: 'content-length' })
    } else {
      // 假定换行分隔 JSON
      state.transportMode = 'newline'
      log('MCP_TRANSPORT_DETECTED', { serverId: state.config.id, mode: 'newline' })
    }
  }

  if (state.transportMode === 'content-length') {
    processContentLengthBuffer(state)
  } else {
    processNewlineBuffer(state)
  }
}

/** 解析换行分隔 JSON 消息 */
function processNewlineBuffer(state: McpServerState) {
  while (true) {
    const newlineIdx = state.rawBuffer.indexOf(0x0A) // \n
    if (newlineIdx < 0) break

    const line = state.rawBuffer.subarray(0, newlineIdx).toString('utf-8').trim()
    state.rawBuffer = state.rawBuffer.subarray(newlineIdx + 1)

    if (!line) continue
    try {
      const msg = JSON.parse(line)
      handleMessage(state, msg)
    } catch {
      log('MCP_PARSE_ERROR', { serverId: state.config.id, line: line.slice(0, 300) })
    }
  }
}

/** 解析 Content-Length 帧格式消息 */
function processContentLengthBuffer(state: McpServerState) {
  while (true) {
    const sepIdx = state.rawBuffer.indexOf(HEADER_SEPARATOR)
    if (sepIdx < 0) break

    const headerStr = state.rawBuffer.subarray(0, sepIdx).toString('utf-8')
    const match = CONTENT_LENGTH_RE.exec(headerStr)
    if (!match) {
      log('MCP_HEADER_ERROR', { serverId: state.config.id, header: headerStr.slice(0, 200) })
      state.rawBuffer = state.rawBuffer.subarray(sepIdx + HEADER_SEPARATOR.length)
      continue
    }

    const contentLength = parseInt(match[1], 10)
    const bodyStart = sepIdx + HEADER_SEPARATOR.length

    if (state.rawBuffer.length < bodyStart + contentLength) {
      break // body 不完整，等待更多数据
    }

    const bodyBuf = state.rawBuffer.subarray(bodyStart, bodyStart + contentLength)
    state.rawBuffer = state.rawBuffer.subarray(bodyStart + contentLength)

    const bodyStr = bodyBuf.toString('utf-8')
    try {
      const msg = JSON.parse(bodyStr)
      handleMessage(state, msg)
    } catch {
      log('MCP_PARSE_ERROR', { serverId: state.config.id, body: bodyStr.slice(0, 300) })
    }
  }
}

function handleMessage(state: McpServerState, msg: unknown) {
  if (!msg || typeof msg !== 'object') return
  const obj = msg as Record<string, unknown>

  // 响应消息（有 id）
  if ('id' in obj && obj.id !== null && obj.id !== undefined) {
    const id = Number(obj.id)
    const pending = state.pendingRequests.get(id)
    if (!pending) return

    clearTimeout(pending.timer)
    state.pendingRequests.delete(id)

    if ('error' in obj) {
      const err = obj.error as { message?: string; code?: number }
      pending.reject(new Error(err.message ?? `MCP error ${err.code ?? 'unknown'}`))
    } else {
      pending.resolve(obj.result)
    }
  }
  // 通知消息（无 id）— 记录日志但不处理
  else if ('method' in obj) {
    log('MCP_NOTIFICATION', { serverId: state.config.id, method: obj.method })
  }
}

/* ------------------------------------------------------------------ */
/*  服务器生命周期                                                      */
/* ------------------------------------------------------------------ */

/** 启动单个 MCP 服务器 */
async function startServer(config: McpServerConfig): Promise<McpServerState> {
  const existing = servers.get(config.id)
  if (existing?.status === 'running') return existing

  const state: McpServerState = {
    config,
    process: null,
    tools: [],
    status: 'starting',
    nextId: 1,
    pendingRequests: new Map(),
    rawBuffer: Buffer.alloc(0),
    transportMode: 'unknown',
  }
  servers.set(config.id, state)

  try {
    // 前置校验：检查关键环境变量是否已配置
    const emptyKeys = Object.entries(config.env)
      .filter(([key, val]) => key.toLowerCase().includes('api_key') && !val.trim())
      .map(([key]) => key)
    if (emptyKeys.length > 0) {
      throw new Error(`请先在设置中配置 ${emptyKeys.join(', ')}，再启用此 MCP 服务器`)
    }

    // 合并环境变量 + 确保 PATH 完整
    const fullPath = getFullPath()
    const env = {
      ...process.env,
      PATH: fullPath,
      ...config.env,
    }

    log('MCP_SPAWNING', {
      serverId: config.id,
      command: config.command,
      args: config.args,
    })

    const child = spawn(config.command, config.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      // 在所有平台使用 shell 模式，确保命令能被正确解析
      shell: true,
    })

    state.process = child

    // 处理 stdout — Content-Length 帧格式
    child.stdout?.on('data', (chunk: Buffer) => {
      state.rawBuffer = Buffer.concat([state.rawBuffer, chunk])
      processBuffer(state)
    })

    // stderr 日志（MCP 服务器可能通过 stderr 输出调试信息）
    child.stderr?.on('data', (chunk: Buffer) => {
      const msg = chunk.toString('utf-8').trim()
      if (msg) log('MCP_STDERR', { serverId: config.id, msg: msg.slice(0, 1000) })
    })

    child.on('error', (err) => {
      log('MCP_PROCESS_ERROR', { serverId: config.id, error: err.message })
      state.status = 'error'
      state.error = err.message

      // 常见错误提示
      if (err.message.includes('ENOENT')) {
        state.error = `找不到命令 "${config.command}"。请确保已安装（如 uvx 需先安装 uv: curl -LsSf https://astral.sh/uv/install.sh | sh）`
      }
    })

    child.on('exit', (code, signal) => {
      log('MCP_PROCESS_EXIT', { serverId: config.id, code, signal })
      if (state.status !== 'error') {
        state.status = 'stopped'
        if (code !== 0) {
          state.error = `进程退出，code=${code}${signal ? `, signal=${signal}` : ''}`
        }
      }
      // 清理所有 pending requests
      for (const [, pending] of state.pendingRequests) {
        clearTimeout(pending.timer)
        pending.reject(new Error(`MCP 服务器进程已退出 (code=${code})`))
      }
      state.pendingRequests.clear()
    })

    // 等待进程准备就绪（检测 stdout 是否有数据活动或进程是否存活）
    await waitForProcessReady(state, 10000)

    if (state.status === 'error') {
      throw new Error(state.error ?? '启动失败')
    }

    // MCP 初始化握手
    log('MCP_HANDSHAKE_START', { serverId: config.id })

    const initResult = await sendJsonRpc(state, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'taco', version: '1.0.0' },
    }) as Record<string, unknown>

    log('MCP_INIT', { serverId: config.id, result: initResult })

    // 发送 initialized 通知
    sendNotification(state, 'notifications/initialized')

    // 获取工具列表
    const toolsResult = await sendJsonRpc(state, 'tools/list') as { tools?: McpTool[] }
    state.tools = toolsResult.tools ?? []

    log('MCP_TOOLS', { serverId: config.id, tools: state.tools.map((t) => t.name) })

    state.status = 'running'
    return state
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log('MCP_START_FAIL', { serverId: config.id, error: msg })
    state.status = 'error'
    state.error = msg
    // 清理进程
    try { state.process?.kill() } catch { /* ignore */ }
    state.process = null
    return state
  }
}

/**
 * 等待进程准备就绪：
 * - 进程存活且 stdin 可写
 * - 如果进程立即退出或报错，提前返回
 */
function waitForProcessReady(state: McpServerState, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const startTime = Date.now()

    const check = () => {
      // 如果已出错，立即返回
      if (state.status === 'error') {
        resolve()
        return
      }
      // 如果进程已退出，立即返回
      if (state.process?.exitCode !== null && state.process?.exitCode !== undefined) {
        state.status = 'error'
        state.error = state.error ?? `进程立即退出 (code=${state.process.exitCode})`
        resolve()
        return
      }
      // 如果 stdin 可写，认为进程就绪
      if (state.process?.stdin?.writable) {
        resolve()
        return
      }
      // 超时
      if (Date.now() - startTime > timeoutMs) {
        state.status = 'error'
        state.error = `进程启动超时 (${timeoutMs}ms)`
        resolve()
        return
      }
      // 继续等待
      setTimeout(check, 200)
    }

    // 给进程一小段初始化时间
    setTimeout(check, 500)
  })
}

/** 停止单个 MCP 服务器 */
function stopServer(serverId: string) {
  const state = servers.get(serverId)
  if (!state) return

  try { state.process?.kill() } catch { /* ignore */ }
  state.process = null
  state.status = 'stopped'
  state.tools = []

  // 清理 pending
  for (const [, pending] of state.pendingRequests) {
    clearTimeout(pending.timer)
    pending.reject(new Error('服务器已停止'))
  }
  state.pendingRequests.clear()
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/** 初始化：加载配置，启动所有已启用的服务器 */
export async function initMcp() {
  await ensureDirs()
  const configs = await getAllConfigs()
  await saveConfig(configs) // 确保内置服务器写入配置

  for (const config of configs) {
    if (config.enabled) {
      // 异步启动，不阻塞
      startServer(config).catch((err) =>
        log('MCP_INIT_START_FAIL', { id: config.id, error: String(err) })
      )
    }
  }
}

/** 列出所有 MCP 服务器及其状态 */
export async function listMcpServers(): Promise<Array<McpServerConfig & { status: string; toolCount: number; error?: string }>> {
  const configs = await getAllConfigs()
  return configs.map((config) => {
    const state = servers.get(config.id)
    return {
      ...config,
      status: state?.status ?? 'stopped',
      toolCount: state?.tools.length ?? 0,
      error: state?.error,
    }
  })
}

/** 添加/更新 MCP 服务器 */
export async function saveMcpServer(config: McpServerConfig): Promise<void> {
  const configs = await getAllConfigs()
  const idx = configs.findIndex((c) => c.id === config.id)
  if (idx >= 0) {
    configs[idx] = config
  } else {
    configs.push(config)
  }
  await saveConfig(configs)

  // 如果正在运行，先停止
  stopServer(config.id)

  // 如果启用，启动
  if (config.enabled) {
    await startServer(config)
  }
}

/** 删除 MCP 服务器 */
export async function removeMcpServer(serverId: string): Promise<void> {
  stopServer(serverId)
  servers.delete(serverId)

  const configs = await getAllConfigs()
  const filtered = configs.filter((c) => c.id !== serverId || c.builtin)
  await saveConfig(filtered)
}

/** 启用/禁用 MCP 服务器 */
export async function toggleMcpServer(serverId: string, enabled: boolean): Promise<void> {
  const configs = await getAllConfigs()
  const config = configs.find((c) => c.id === serverId)
  if (!config) throw new Error(`MCP 服务器 ${serverId} 不存在`)

  config.enabled = enabled
  await saveConfig(configs)

  if (enabled) {
    await startServer(config)
  } else {
    stopServer(serverId)
  }
}

/** 获取所有已启用服务器的工具列表（供 Agent 使用） */
export function getActiveMcpTools(): Array<McpTool & { serverId: string }> {
  const tools: Array<McpTool & { serverId: string }> = []
  for (const [serverId, state] of servers) {
    if (state.status === 'running') {
      for (const tool of state.tools) {
        tools.push({ ...tool, serverId })
      }
    }
  }
  return tools
}

/** 调用 MCP 工具 */
export async function callMcpTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<McpToolResult> {
  const state = servers.get(serverId)
  if (!state || state.status !== 'running') {
    throw new Error(`MCP 服务器 ${serverId} 未运行`)
  }

  const result = await sendJsonRpc(state, 'tools/call', {
    name: toolName,
    arguments: args,
  }) as McpToolResult

  return result
}

/** 保存截图文件，返回文件路径 */
export async function saveScreenshot(dataUrl: string, appId?: string): Promise<string> {
  await ensureDirs()

  // 从 data URL 中提取 base64 数据
  const base64Match = dataUrl.match(/^data:image\/\w+;base64,(.+)$/)
  if (!base64Match) throw new Error('Invalid screenshot data URL')

  const normalizedAppId = (appId ?? 'shared')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 64) || 'shared'
  const targetDir = path.join(SCREENSHOTS_DIR, normalizedAppId)
  await fs.mkdir(targetDir, { recursive: true })

  const buffer = Buffer.from(base64Match[1], 'base64')
  const filename = `screenshot-${Date.now()}.png`
  const filePath = path.join(targetDir, filename)

  await fs.writeFile(filePath, buffer)

  // 清理旧截图（每个 appId 目录保留最近 20 张）
  try {
    const files = await fs.readdir(targetDir)
    const screenshots = files
      .filter((f) => f.startsWith('screenshot-') && f.endsWith('.png'))
      .sort()

    if (screenshots.length > 20) {
      const toDelete = screenshots.slice(0, screenshots.length - 20)
      for (const f of toDelete) {
        await fs.unlink(path.join(targetDir, f)).catch(() => {})
      }
    }
  } catch { /* ignore cleanup errors */ }

  return filePath
}

/** 关闭所有 MCP 服务器（app 退出时调用） */
export function shutdownAllMcp() {
  for (const [id] of servers) {
    stopServer(id)
  }
  servers.clear()
}
