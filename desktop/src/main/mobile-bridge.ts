import { app } from 'electron'
import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs/promises'
import { WebSocketServer, type WebSocket } from 'ws'
import type {
  MobileBridgeAbortData,
  MobileBridgeCommandData,
  MobileBridgeConfig,
  MobileBridgeContextSnapshot,
  MobileBridgeSelectData,
} from '../shared/ipc'
import { logError, logInfo } from './logger'

const DEFAULT_CONFIG: MobileBridgeConfig = {
  enabled: false,
  port: 18400,
  token: 'taco-mobile',
}
const SCREENSHOTS_ROOT = path.join(app.getPath('home'), '.taco', 'screenshots')

let currentConfig: MobileBridgeConfig = { ...DEFAULT_CONFIG }
let server: http.Server | null = null
let initialized = false
let commandHandler: ((data: MobileBridgeCommandData) => void) | null = null
let selectHandler: ((data: MobileBridgeSelectData) => void) | null = null
let abortHandler: ((data: MobileBridgeAbortData) => void) | null = null
let wsServer: WebSocketServer | null = null
const wsClients = new Set<WebSocket>()
let latestContextDigest = ''
let latestContext: MobileBridgeContextSnapshot = {
  updatedAt: 0,
  threads: [],
}

function getConfigFile(): string {
  return path.join(app.getPath('userData'), 'mobile-bridge.json')
}

function clampPort(raw: unknown): number {
  const num = Number(raw)
  if (!Number.isFinite(num)) return DEFAULT_CONFIG.port
  const rounded = Math.round(num)
  if (rounded < 1 || rounded > 65535) return DEFAULT_CONFIG.port
  return rounded
}

function sanitizeConfig(raw: Partial<MobileBridgeConfig> | null | undefined): MobileBridgeConfig {
  return {
    enabled: Boolean(raw?.enabled),
    port: clampPort(raw?.port),
    token: String(raw?.token ?? '').trim() || DEFAULT_CONFIG.token,
  }
}

async function loadConfigFile(): Promise<MobileBridgeConfig> {
  try {
    const raw = await fs.readFile(getConfigFile(), 'utf-8')
    return sanitizeConfig(JSON.parse(raw) as Partial<MobileBridgeConfig>)
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

async function saveConfigFile(config: MobileBridgeConfig): Promise<void> {
  try {
    await fs.writeFile(getConfigFile(), JSON.stringify(config, null, 2), 'utf-8')
  } catch (err) {
    logError('MOBILE_BRIDGE_SAVE', '保存移动桥接配置失败', err)
  }
}

function writeJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Taco-Token')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.end(JSON.stringify(data))
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > 1024 * 1024) throw new Error('body too large')
    chunks.push(buf)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'))
}

function authTokenFromRequest(req: http.IncomingMessage): string {
  const token = req.headers['x-taco-token']
  if (Array.isArray(token)) return token[0] ?? ''
  return token ?? ''
}

function isAuthorized(req: http.IncomingMessage, reqUrl?: URL): boolean {
  if (!currentConfig.token) return true
  if (reqUrl) {
    const queryToken = reqUrl.searchParams.get('token')
    if (queryToken && queryToken === currentConfig.token) return true
  }
  return authTokenFromRequest(req) === currentConfig.token
}

function isWsAuthorized(req: http.IncomingMessage, reqUrl: URL): boolean {
  if (!currentConfig.token) return true
  if (authTokenFromRequest(req) === currentConfig.token) return true
  const token = reqUrl.searchParams.get('token') ?? ''
  return token === currentConfig.token
}

function trimText(raw: unknown, maxLen: number): string {
  return String(raw ?? '').slice(0, maxLen)
}

function sanitizeAgentStepStatus(raw: unknown): 'calling' | 'running' | 'confirm' | 'done' {
  const text = String(raw ?? '')
  if (text === 'calling' || text === 'running' || text === 'confirm' || text === 'done') return text
  return 'done'
}

function sanitizePlanStepStatus(raw: unknown): 'pending' | 'in_progress' | 'done' | 'failed' {
  const text = String(raw ?? '')
  if (text === 'pending' || text === 'in_progress' || text === 'done' || text === 'failed') return text
  return 'pending'
}

function buildContextDigest(snapshot: MobileBridgeContextSnapshot): string {
  return JSON.stringify({
    ...snapshot,
    updatedAt: 0,
  })
}

function sendWsJson(client: WebSocket, payload: unknown): void {
  if (client.readyState !== client.OPEN) return
  try {
    client.send(JSON.stringify(payload))
  } catch {
    try { client.close() } catch { /* noop */ }
  }
}

function broadcastContext(): void {
  if (wsClients.size === 0) return
  const payload = { type: 'context', context: latestContext }
  for (const client of wsClients) sendWsJson(client, payload)
}

function sanitizeContext(raw: MobileBridgeContextSnapshot): MobileBridgeContextSnapshot {
  const providers = Array.isArray(raw?.providers)
    ? raw.providers.slice(0, 20).map((p) => ({
      id: trimText(p.id, 64),
      label: trimText(p.label, 128),
    }))
    : []
  const safeThreads = Array.isArray(raw?.threads) ? raw.threads : []
  const threads = safeThreads.slice(0, 20).map((thread) => {
    const sessions = Array.isArray(thread.sessions) ? thread.sessions : []
    const safeSessions = sessions.slice(0, 30).map((session) => {
      const messages = Array.isArray(session.messages) ? session.messages : []
      const safeMessages = messages.slice(0, 80).map((msg) => {
        const rawSteps = Array.isArray(msg.agentSteps) ? msg.agentSteps : []
        const safeSteps = rawSteps.slice(0, 30).map((step) => {
          const rawToolCalls = Array.isArray(step.toolCalls) ? step.toolCalls : []
          const rawToolResults = Array.isArray(step.toolResults) ? step.toolResults : []
          return {
            round: Number.isFinite(step.round) ? Math.max(0, Math.trunc(step.round)) : 0,
            thinking: trimText(step.thinking, 4000),
            status: sanitizeAgentStepStatus(step.status),
            toolCalls: rawToolCalls.slice(0, 30).map((tc) => ({
              id: trimText(tc.id, 128),
              name: trimText(tc.name, 128),
              arguments: trimText(tc.arguments, 2000),
            })),
            toolResults: rawToolResults.slice(0, 30).map((tr) => ({
              tool_call_id: trimText(tr.tool_call_id, 128),
              name: trimText(tr.name, 128),
              content: trimText(tr.content, 3000),
              success: Boolean(tr.success),
            })),
          }
        })
        const rawPlan = msg.activePlan && typeof msg.activePlan === 'object' ? msg.activePlan : null
        const rawPlanSteps = Array.isArray(rawPlan?.steps) ? rawPlan.steps : []
        const safePlan = rawPlan
          ? {
            summary: trimText(rawPlan.summary, 500),
            reasoning: trimText(rawPlan.reasoning, 1000),
            steps: rawPlanSteps.slice(0, 50).map((step) => ({
              text: trimText(step.text, 500),
              status: sanitizePlanStepStatus(step.status),
              note: trimText(step.note, 500),
            })),
          }
          : undefined
        return {
          id: trimText(msg.id, 128),
          role: msg.role === 'assistant' || msg.role === 'system' ? msg.role : 'user',
          content: trimText(msg.content, 4000),
          screenshotPaths: Array.isArray(msg.screenshotPaths)
            ? msg.screenshotPaths.slice(0, 20).map((p) => trimText(p, 1024)).filter(Boolean)
            : undefined,
          ...(safeSteps.length > 0 ? { agentSteps: safeSteps } : {}),
          ...(safePlan ? { activePlan: safePlan } : {}),
        }
      })
      const queue = Array.isArray(session.queue) ? session.queue : []
      return {
        sessionId: trimText(session.sessionId, 128),
        title: trimText(session.title, 256),
        messageCount: Number.isFinite(session.messageCount) ? Math.max(0, Math.trunc(session.messageCount)) : safeMessages.length,
        messages: safeMessages,
        sending: Boolean(session.sending),
        queue: queue.slice(0, 20).map((q) => trimText(q, 500)),
        streamingContent: trimText(session.streamingContent, 4000),
      }
    })
    return {
      threadId: trimText(thread.threadId, 128),
      title: trimText(thread.title, 256),
      updatedAt: Number.isFinite(thread.updatedAt) ? Math.max(0, Math.trunc(thread.updatedAt)) : Date.now(),
      provider: trimText(thread.provider, 64),
      mode: trimText(thread.mode, 32),
      workspace: trimText(thread.workspace, 1024),
      activeSessionId: trimText(thread.activeSessionId, 128),
      sessions: safeSessions,
    }
  })
  const updatedAt = Number.isFinite(raw?.updatedAt) ? Math.max(0, Math.trunc(raw.updatedAt)) : Date.now()
  return {
    updatedAt,
    activeThreadId: trimText(raw?.activeThreadId, 128),
    activeSessionId: trimText(raw?.activeSessionId, 128),
    activeProvider: trimText(raw?.activeProvider, 64),
    providers,
    threads,
  }
}

function handleCommandRequest(req: http.IncomingMessage, res: http.ServerResponse, body: unknown): void {
  const data = (body && typeof body === 'object' ? body : {}) as {
    text?: unknown
    threadId?: unknown
    sessionId?: unknown
    provider?: unknown
  }
  const text = typeof data.text === 'string' ? data.text.trim() : ''
  if (!text) {
    writeJson(res, 400, { ok: false, error: 'text is required' })
    return
  }

  const cmd: MobileBridgeCommandData = {
    id: `mobile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    text,
    receivedAt: Date.now(),
    remoteAddr: req.socket.remoteAddress,
    threadId: trimText(data.threadId, 128) || undefined,
    sessionId: trimText(data.sessionId, 128) || undefined,
    provider: trimText(data.provider, 64) || undefined,
  }
  commandHandler?.(cmd)
  logInfo('MOBILE_BRIDGE_COMMAND', '收到移动端指令', {
    id: cmd.id,
    text: cmd.text,
    remoteAddr: cmd.remoteAddr,
  })
  writeJson(res, 200, { ok: true, id: cmd.id })
}

function handleSelectRequest(req: http.IncomingMessage, res: http.ServerResponse, body: unknown): void {
  const data = (body && typeof body === 'object' ? body : {}) as {
    threadId?: unknown
    sessionId?: unknown
    provider?: unknown
  }
  const threadId = trimText(data.threadId, 128) || undefined
  const sessionId = trimText(data.sessionId, 128) || undefined
  const provider = trimText(data.provider, 64) || undefined
  if (!threadId && !sessionId && !provider) {
    writeJson(res, 400, { ok: false, error: 'threadId or sessionId or provider is required' })
    return
  }
  const select: MobileBridgeSelectData = {
    id: `mobile-select-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    receivedAt: Date.now(),
    remoteAddr: req.socket.remoteAddress,
    threadId,
    sessionId,
    provider,
  }
  selectHandler?.(select)
  logInfo('MOBILE_BRIDGE_SELECT', '收到移动端选择同步', {
    id: select.id,
    threadId: select.threadId,
    sessionId: select.sessionId,
    provider: select.provider,
    remoteAddr: select.remoteAddr,
  })
  writeJson(res, 200, { ok: true, id: select.id })
}

function handleAbortRequest(req: http.IncomingMessage, res: http.ServerResponse, body: unknown): void {
  const data = (body && typeof body === 'object' ? body : {}) as {
    threadId?: unknown
    sessionId?: unknown
  }
  const threadId = trimText(data.threadId, 128) || undefined
  const sessionId = trimText(data.sessionId, 128) || undefined
  if (!threadId && !sessionId) {
    writeJson(res, 400, { ok: false, error: 'threadId or sessionId is required' })
    return
  }
  const abort: MobileBridgeAbortData = {
    id: `mobile-abort-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    receivedAt: Date.now(),
    remoteAddr: req.socket.remoteAddress,
    threadId,
    sessionId,
  }
  abortHandler?.(abort)
  logInfo('MOBILE_BRIDGE_ABORT', '收到移动端停止请求', {
    id: abort.id,
    threadId: abort.threadId,
    sessionId: abort.sessionId,
    remoteAddr: abort.remoteAddr,
  })
  writeJson(res, 200, { ok: true, id: abort.id })
}

async function handleScreenshotRequest(req: http.IncomingMessage, res: http.ServerResponse, reqUrl: URL): Promise<void> {
  if (!isAuthorized(req, reqUrl)) {
    writeJson(res, 401, { ok: false, error: 'unauthorized' })
    return
  }
  const rawPath = reqUrl.searchParams.get('path') ?? ''
  if (!rawPath) {
    writeJson(res, 400, { ok: false, error: 'path is required' })
    return
  }
  const absolutePath = path.resolve(rawPath)
  const root = path.resolve(SCREENSHOTS_ROOT)
  if (!(absolutePath === root || absolutePath.startsWith(`${root}${path.sep}`))) {
    writeJson(res, 403, { ok: false, error: 'forbidden path' })
    return
  }

  try {
    const stat = await fs.stat(absolutePath)
    if (!stat.isFile()) {
      writeJson(res, 404, { ok: false, error: 'not found' })
      return
    }
    const ext = path.extname(absolutePath).toLowerCase()
    const contentType = ext === '.jpg' || ext === '.jpeg'
      ? 'image/jpeg'
      : ext === '.webp'
        ? 'image/webp'
        : 'image/png'
    const data = await fs.readFile(absolutePath)
    res.statusCode = 200
    res.setHeader('Content-Type', contentType)
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.end(data)
  } catch {
    writeJson(res, 404, { ok: false, error: 'not found' })
  }
}

function createServer(): http.Server {
  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        writeJson(res, 204, { ok: true })
        return
      }
      const reqUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
      if (reqUrl.pathname === '/health' && req.method === 'GET') {
        writeJson(res, 200, {
          ok: true,
          enabled: currentConfig.enabled,
          port: currentConfig.port,
          wsClients: wsClients.size,
          hasContext: latestContext.threads.length > 0,
          now: Date.now(),
        })
        return
      }

      if (reqUrl.pathname === '/ws' && req.method === 'GET') {
        writeJson(res, 426, { ok: false, error: 'websocket upgrade required' })
        return
      }

      if (reqUrl.pathname === '/context' && req.method === 'GET') {
        if (!isAuthorized(req, reqUrl)) {
          writeJson(res, 401, { ok: false, error: 'unauthorized' })
          return
        }
        writeJson(res, 200, { ok: true, context: latestContext })
        return
      }

      if (reqUrl.pathname === '/command' && req.method === 'POST') {
        if (!isAuthorized(req, reqUrl)) {
          writeJson(res, 401, { ok: false, error: 'unauthorized' })
          return
        }
        const body = await readJsonBody(req)
        handleCommandRequest(req, res, body)
        return
      }

      if (reqUrl.pathname === '/select' && req.method === 'POST') {
        if (!isAuthorized(req, reqUrl)) {
          writeJson(res, 401, { ok: false, error: 'unauthorized' })
          return
        }
        const body = await readJsonBody(req)
        handleSelectRequest(req, res, body)
        return
      }

      if (reqUrl.pathname === '/abort' && req.method === 'POST') {
        if (!isAuthorized(req, reqUrl)) {
          writeJson(res, 401, { ok: false, error: 'unauthorized' })
          return
        }
        const body = await readJsonBody(req)
        handleAbortRequest(req, res, body)
        return
      }

      if (reqUrl.pathname === '/screenshot' && req.method === 'GET') {
        await handleScreenshotRequest(req, res, reqUrl)
        return
      }

      writeJson(res, 404, { ok: false, error: 'not found' })
    } catch (err) {
      writeJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}

function initWebSocketForServer(httpServer: http.Server): void {
  wsServer = new WebSocketServer({ noServer: true })
  wsServer.on('connection', (client) => {
    wsClients.add(client)
    client.once('close', () => {
      wsClients.delete(client)
    })
    client.once('error', () => {
      wsClients.delete(client)
    })
    sendWsJson(client, { type: 'context', context: latestContext })
  })

  httpServer.on('upgrade', (req, socket, head) => {
    try {
      const reqUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
      if (reqUrl.pathname !== '/ws') {
        socket.destroy()
        return
      }
      if (!isWsAuthorized(req, reqUrl)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      const target = wsServer
      if (!target) {
        socket.destroy()
        return
      }
      target.handleUpgrade(req, socket, head, (client) => {
        target.emit('connection', client, req)
      })
    } catch {
      socket.destroy()
    }
  })
}

async function stopServer(): Promise<void> {
  for (const client of wsClients) {
    try { client.close() } catch { /* noop */ }
  }
  wsClients.clear()
  if (wsServer) {
    await new Promise<void>((resolve) => {
      const target = wsServer
      wsServer = null
      target.close(() => resolve())
    })
  }
  if (!server) return
  const target = server
  server = null
  await new Promise<void>((resolve) => target.close(() => resolve()))
}

async function startServer(): Promise<void> {
  await stopServer()
  if (!currentConfig.enabled) return
  const nextServer = createServer()
  initWebSocketForServer(nextServer)
  await new Promise<void>((resolve, reject) => {
    nextServer.once('error', reject)
    nextServer.listen(currentConfig.port, '0.0.0.0', () => {
      nextServer.removeListener('error', reject)
      resolve()
    })
  })
  server = nextServer
  logInfo('MOBILE_BRIDGE_START', '移动端桥接服务已启动', {
    port: currentConfig.port,
  })
}

export async function initMobileBridge(
  onCommand: (data: MobileBridgeCommandData) => void,
  onSelect: (data: MobileBridgeSelectData) => void,
  onAbort: (data: MobileBridgeAbortData) => void,
): Promise<MobileBridgeConfig> {
  commandHandler = onCommand
  selectHandler = onSelect
  abortHandler = onAbort
  if (!initialized) {
    currentConfig = await loadConfigFile()
    initialized = true
  }
  await startServer()
  return { ...currentConfig }
}

export async function getMobileBridgeConfig(): Promise<MobileBridgeConfig> {
  if (!initialized) {
    currentConfig = await loadConfigFile()
    initialized = true
  }
  return { ...currentConfig }
}

export async function setMobileBridgeConfig(config: MobileBridgeConfig): Promise<MobileBridgeConfig> {
  currentConfig = sanitizeConfig(config)
  initialized = true
  await saveConfigFile(currentConfig)
  await startServer()
  return { ...currentConfig }
}

export async function shutdownMobileBridge(): Promise<void> {
  await stopServer()
}

export function updateMobileBridgeContext(snapshot: MobileBridgeContextSnapshot): void {
  const next = sanitizeContext(snapshot)
  const digest = buildContextDigest(next)
  if (digest === latestContextDigest) return
  latestContextDigest = digest
  latestContext = next
  broadcastContext()
}
