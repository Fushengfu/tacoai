import { app } from 'electron'
import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs/promises'
import { WebSocketServer, type WebSocket } from 'ws'
import type {
  MobileBridgeAbortData,
  MobileBridgeCommandData,
  MobileBridgeClearSessionData,
  MobileBridgeConfig,
  MobileBridgeConfirmData,
  MobileBridgeContextSnapshot,
  MobileBridgeNewSessionData,
  MobileBridgeSelectData,
  FileTreeEntry,
} from '../shared/ipc'
import { logError, logInfo } from './logger'

const DEFAULT_CONFIG: MobileBridgeConfig = {
  enabled: false,
  port: 18400,
  token: 'taco-mobile',
}
const SCREENSHOTS_ROOT = path.join(app.getPath('home'), '.taco', 'screenshots')
const WORKSPACE_TREE_MAX_DEPTH = 8
const WORKSPACE_TREE_MAX_ENTRIES = 4000
const WORKSPACE_EXCLUDED_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '.DS_Store',
  '__pycache__', '.cache', 'coverage', '.idea',
])

let currentConfig: MobileBridgeConfig = { ...DEFAULT_CONFIG }
let server: http.Server | null = null
let initialized = false
let commandHandler: ((data: MobileBridgeCommandData) => void) | null = null
let selectHandler: ((data: MobileBridgeSelectData) => void) | null = null
let abortHandler: ((data: MobileBridgeAbortData) => void) | null = null
let confirmHandler: ((data: MobileBridgeConfirmData) => void) | null = null
let newSessionHandler: ((data: MobileBridgeNewSessionData) => void) | null = null
let clearSessionHandler: ((data: MobileBridgeClearSessionData) => void) | null = null
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

function fullText(raw: unknown): string {
  return String(raw ?? '')
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
    ? raw.providers.map((p) => ({
      id: trimText(p.id, 64),
      label: trimText(p.label, 128),
    }))
    : []
  const safeThreads = Array.isArray(raw?.threads) ? raw.threads : []
  const threads = safeThreads.map((thread) => {
    const sessions = Array.isArray(thread.sessions) ? thread.sessions : []
    const safeSessions = sessions.map((session) => {
      const messages = Array.isArray(session.messages) ? session.messages : []
      const safeMessages = messages.map((msg) => {
        const rawSteps = Array.isArray(msg.agentSteps) ? msg.agentSteps : []
        const safeSteps = rawSteps.map((step) => {
          const rawToolCalls = Array.isArray(step.toolCalls) ? step.toolCalls : []
          const rawToolResults = Array.isArray(step.toolResults) ? step.toolResults : []
          const rawRisks = Array.isArray(step.risks) ? step.risks : []
          return {
            round: Number.isFinite(step.round) ? Math.max(0, Math.trunc(step.round)) : 0,
            thinking: fullText(step.thinking),
            status: sanitizeAgentStepStatus(step.status),
            confirmId: trimText(step.confirmId, 128) || undefined,
            risks: rawRisks.map((risk) => ({
              toolName: trimText(risk.toolName, 128),
              reason: fullText(risk.reason),
              detail: fullText(risk.detail),
              level: risk.level === 'safe' || risk.level === 'danger' ? risk.level : 'warning',
            })),
            toolCalls: rawToolCalls.map((tc) => ({
              id: trimText(tc.id, 128),
              name: trimText(tc.name, 128),
              arguments: fullText(tc.arguments),
            })),
            toolResults: rawToolResults.map((tr) => ({
              tool_call_id: trimText(tr.tool_call_id, 128),
              name: trimText(tr.name, 128),
              content: fullText(tr.content),
              success: Boolean(tr.success),
              fileChange: tr.fileChange && typeof tr.fileChange === 'object'
                ? {
                  filePath: trimText(tr.fileChange.filePath, 1024),
                  oldContent: tr.fileChange.oldContent == null ? null : fullText(tr.fileChange.oldContent),
                  newContent: tr.fileChange.newContent == null ? null : fullText(tr.fileChange.newContent),
                }
                : undefined,
            })),
          }
        })
        const rawPlan = msg.activePlan && typeof msg.activePlan === 'object' ? msg.activePlan : null
        const rawPlanSteps = Array.isArray(rawPlan?.steps) ? rawPlan.steps : []
        const safePlan = rawPlan
          ? {
            summary: fullText(rawPlan.summary),
            reasoning: fullText(rawPlan.reasoning),
            steps: rawPlanSteps.map((step) => ({
              text: fullText(step.text),
              status: sanitizePlanStepStatus(step.status),
              note: fullText(step.note),
            })),
          }
          : undefined
        return {
          id: trimText(msg.id, 128),
          role: msg.role === 'assistant' || msg.role === 'system' ? msg.role : 'user',
          content: fullText(msg.content),
          screenshotPaths: Array.isArray(msg.screenshotPaths)
            ? msg.screenshotPaths.map((p) => trimText(p, 1024)).filter(Boolean)
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
        queue: queue.map((q) => fullText(q)),
        streamingContent: fullText(session.streamingContent),
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
    mode?: unknown
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
    mode: data.mode === 'agent' ? 'agent' : data.mode === 'chat' ? 'chat' : undefined,
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
    mode?: unknown
  }
  const threadId = trimText(data.threadId, 128) || undefined
  const sessionId = trimText(data.sessionId, 128) || undefined
  const provider = trimText(data.provider, 64) || undefined
  const mode = data.mode === 'agent' ? 'agent' : data.mode === 'chat' ? 'chat' : undefined
  if (!threadId && !sessionId && !provider && !mode) {
    writeJson(res, 400, { ok: false, error: 'threadId or sessionId or provider or mode is required' })
    return
  }
  const select: MobileBridgeSelectData = {
    id: `mobile-select-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    receivedAt: Date.now(),
    remoteAddr: req.socket.remoteAddress,
    threadId,
    sessionId,
    provider,
    mode,
  }
  selectHandler?.(select)
  logInfo('MOBILE_BRIDGE_SELECT', '收到移动端选择同步', {
    id: select.id,
    threadId: select.threadId,
    sessionId: select.sessionId,
    provider: select.provider,
    mode: select.mode,
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

function handleConfirmRequest(req: http.IncomingMessage, res: http.ServerResponse, body: unknown): void {
  const data = (body && typeof body === 'object' ? body : {}) as {
    threadId?: unknown
    sessionId?: unknown
    confirmId?: unknown
    approved?: unknown
  }
  const threadId = trimText(data.threadId, 128) || undefined
  const sessionId = trimText(data.sessionId, 128) || undefined
  const confirmId = trimText(data.confirmId, 128)
  if (!confirmId) {
    writeJson(res, 400, { ok: false, error: 'confirmId is required' })
    return
  }
  const confirm: MobileBridgeConfirmData = {
    id: `mobile-confirm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    receivedAt: Date.now(),
    remoteAddr: req.socket.remoteAddress,
    threadId,
    sessionId,
    confirmId,
    approved: data.approved === true,
  }
  confirmHandler?.(confirm)
  logInfo('MOBILE_BRIDGE_CONFIRM', '收到移动端确认响应', {
    id: confirm.id,
    threadId: confirm.threadId,
    sessionId: confirm.sessionId,
    confirmId: confirm.confirmId,
    approved: confirm.approved,
    remoteAddr: confirm.remoteAddr,
  })
  writeJson(res, 200, { ok: true, id: confirm.id })
}

function handleSessionNewRequest(req: http.IncomingMessage, res: http.ServerResponse, body: unknown): void {
  const data = (body && typeof body === 'object' ? body : {}) as { threadId?: unknown }
  const threadId = trimText(data.threadId, 128) || trimText(latestContext.activeThreadId, 128) || trimText(latestContext.threads[0]?.threadId, 128)
  if (!threadId) {
    writeJson(res, 400, { ok: false, error: 'threadId is required' })
    return
  }
  const payload: MobileBridgeNewSessionData = {
    id: `mobile-session-new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    receivedAt: Date.now(),
    remoteAddr: req.socket.remoteAddress,
    threadId,
  }
  newSessionHandler?.(payload)
  logInfo('MOBILE_BRIDGE_SESSION_NEW', '收到移动端新建会话请求', {
    id: payload.id,
    threadId: payload.threadId,
    remoteAddr: payload.remoteAddr,
  })
  writeJson(res, 200, { ok: true, id: payload.id })
}

function handleSessionClearRequest(req: http.IncomingMessage, res: http.ServerResponse, body: unknown): void {
  const data = (body && typeof body === 'object' ? body : {}) as {
    threadId?: unknown
    sessionId?: unknown
  }
  const threadId = trimText(data.threadId, 128) || trimText(latestContext.activeThreadId, 128) || undefined
  const sessionId = trimText(data.sessionId, 128) || trimText(latestContext.activeSessionId, 128) || undefined
  if (!threadId && !sessionId) {
    writeJson(res, 400, { ok: false, error: 'threadId or sessionId is required' })
    return
  }
  const payload: MobileBridgeClearSessionData = {
    id: `mobile-session-clear-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    receivedAt: Date.now(),
    remoteAddr: req.socket.remoteAddress,
    threadId,
    sessionId,
  }
  clearSessionHandler?.(payload)
  logInfo('MOBILE_BRIDGE_SESSION_CLEAR', '收到移动端清空会话请求', {
    id: payload.id,
    threadId: payload.threadId,
    sessionId: payload.sessionId,
    remoteAddr: payload.remoteAddr,
  })
  writeJson(res, 200, { ok: true, id: payload.id })
}

function resolveContextThread(threadId?: string, sessionId?: string): MobileBridgeContextSnapshot['threads'][number] | null {
  const safeThreadId = trimText(threadId, 128)
  if (safeThreadId) {
    const byThread = latestContext.threads.find((thread) => thread.threadId === safeThreadId)
    if (byThread) return byThread
  }
  const safeSessionId = trimText(sessionId, 128)
  if (safeSessionId) {
    const bySession = latestContext.threads.find((thread) =>
      thread.sessions.some((session) => session.sessionId === safeSessionId)
    )
    if (bySession) return bySession
  }
  const activeThreadId = trimText(latestContext.activeThreadId, 128)
  if (activeThreadId) {
    const active = latestContext.threads.find((thread) => thread.threadId === activeThreadId)
    if (active) return active
  }
  return latestContext.threads[0] ?? null
}

function resolveWorkspaceRoot(threadId?: string, sessionId?: string): string | null {
  const thread = resolveContextThread(threadId, sessionId)
  const workspace = trimText(thread?.workspace, 2048)
  if (!workspace) return null
  return path.resolve(workspace)
}

function normalizeRelativeWorkspacePath(rawPath: unknown): string | null {
  const source = String(rawPath ?? '').trim()
  if (!source) return null
  const withSlash = source.replace(/\\/g, '/').replace(/^\/+/, '')
  const normalized = path.posix.normalize(withSlash)
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized === '..') return null
  return normalized
}

function resolveWorkspaceFilePath(workspaceRoot: string, rawPath: unknown): { relativePath: string; absolutePath: string } | null {
  const relativePath = normalizeRelativeWorkspacePath(rawPath)
  if (!relativePath) return null
  const absolutePath = path.resolve(workspaceRoot, relativePath)
  if (!(absolutePath === workspaceRoot || absolutePath.startsWith(`${workspaceRoot}${path.sep}`))) return null
  return { relativePath, absolutePath }
}

function isBinaryBuffer(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8192)
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

async function readWorkspaceTree(
  workspaceRoot: string,
  dir: string,
  basePath: string,
  depth: number,
  counter: { value: number },
): Promise<FileTreeEntry[]> {
  if (depth > WORKSPACE_TREE_MAX_DEPTH || counter.value >= WORKSPACE_TREE_MAX_ENTRIES) return []
  let entries: Awaited<ReturnType<typeof fs.readdir>>
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const sorted = entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  const result: FileTreeEntry[] = []
  for (const entry of sorted) {
    if (counter.value >= WORKSPACE_TREE_MAX_ENTRIES) break
    if (WORKSPACE_EXCLUDED_DIRS.has(entry.name)) continue
    const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name
    const absolutePath = path.join(dir, entry.name)
    if (!(absolutePath === workspaceRoot || absolutePath.startsWith(`${workspaceRoot}${path.sep}`))) continue
    counter.value += 1
    if (entry.isDirectory()) {
      const children = await readWorkspaceTree(workspaceRoot, absolutePath, relativePath, depth + 1, counter)
      result.push({ name: entry.name, path: relativePath, isDirectory: true, children })
    } else {
      result.push({ name: entry.name, path: relativePath, isDirectory: false })
    }
  }
  return result
}

async function handleWorkspaceTreeRequest(req: http.IncomingMessage, res: http.ServerResponse, reqUrl: URL): Promise<void> {
  const threadId = trimText(reqUrl.searchParams.get('threadId'), 128) || undefined
  const sessionId = trimText(reqUrl.searchParams.get('sessionId'), 128) || undefined
  const workspaceRoot = resolveWorkspaceRoot(threadId, sessionId)
  if (!workspaceRoot) {
    writeJson(res, 400, { ok: false, error: 'workspace not found' })
    return
  }
  try {
    const stat = await fs.stat(workspaceRoot)
    if (!stat.isDirectory()) {
      writeJson(res, 404, { ok: false, error: 'workspace not found' })
      return
    }
    const entries = await readWorkspaceTree(workspaceRoot, workspaceRoot, '', 0, { value: 0 })
    writeJson(res, 200, { ok: true, workspace: workspaceRoot, entries })
  } catch {
    writeJson(res, 404, { ok: false, error: 'workspace not found' })
  }
}

async function handleWorkspaceFileReadRequest(_req: http.IncomingMessage, res: http.ServerResponse, body: unknown): Promise<void> {
  const data = (body && typeof body === 'object' ? body : {}) as {
    threadId?: unknown
    sessionId?: unknown
    path?: unknown
  }
  const workspaceRoot = resolveWorkspaceRoot(trimText(data.threadId, 128), trimText(data.sessionId, 128))
  if (!workspaceRoot) {
    writeJson(res, 400, { ok: false, error: 'workspace not found' })
    return
  }
  const resolved = resolveWorkspaceFilePath(workspaceRoot, data.path)
  if (!resolved) {
    writeJson(res, 403, { ok: false, error: 'invalid path' })
    return
  }
  try {
    const stat = await fs.stat(resolved.absolutePath)
    if (!stat.isFile()) {
      writeJson(res, 404, { ok: false, error: 'file not found' })
      return
    }
    const size = stat.size
    const ext = path.extname(resolved.absolutePath).toLowerCase()
    const imageMime: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.bmp': 'image/bmp',
      '.ico': 'image/x-icon',
      '.svg': 'image/svg+xml',
    }
    const mime = imageMime[ext]
    if (size > 5 * 1024 * 1024) {
      writeJson(res, 200, {
        ok: true,
        path: resolved.relativePath,
        isBinary: true,
        size,
        content: null,
      })
      return
    }
    const buf = Buffer.from(await fs.readFile(resolved.absolutePath))
    if (isBinaryBuffer(buf)) {
      writeJson(res, 200, {
        ok: true,
        path: resolved.relativePath,
        isBinary: true,
        size,
        content: null,
        dataUrl: mime ? `data:${mime};base64,${buf.toString('base64')}` : undefined,
      })
      return
    }
    const text = buf.toString('utf-8')
    writeJson(res, 200, {
      ok: true,
      path: resolved.relativePath,
      isBinary: false,
      size,
      content: text,
      dataUrl: mime === 'image/svg+xml'
        ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`
        : undefined,
    })
  } catch {
    writeJson(res, 404, { ok: false, error: 'file not found' })
  }
}

async function handleWorkspaceFileWriteRequest(_req: http.IncomingMessage, res: http.ServerResponse, body: unknown): Promise<void> {
  const data = (body && typeof body === 'object' ? body : {}) as {
    threadId?: unknown
    sessionId?: unknown
    path?: unknown
    content?: unknown
  }
  const workspaceRoot = resolveWorkspaceRoot(trimText(data.threadId, 128), trimText(data.sessionId, 128))
  if (!workspaceRoot) {
    writeJson(res, 400, { ok: false, error: 'workspace not found' })
    return
  }
  const resolved = resolveWorkspaceFilePath(workspaceRoot, data.path)
  if (!resolved) {
    writeJson(res, 403, { ok: false, error: 'invalid path' })
    return
  }
  const content = typeof data.content === 'string' ? data.content : ''
  try {
    await fs.mkdir(path.dirname(resolved.absolutePath), { recursive: true })
    await fs.writeFile(resolved.absolutePath, content, 'utf-8')
    writeJson(res, 200, {
      ok: true,
      path: resolved.relativePath,
      size: Buffer.byteLength(content, 'utf-8'),
    })
  } catch (err) {
    writeJson(res, 500, { ok: false, error: err instanceof Error ? err.message : 'write failed' })
  }
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

      if (reqUrl.pathname === '/confirm' && req.method === 'POST') {
        if (!isAuthorized(req, reqUrl)) {
          writeJson(res, 401, { ok: false, error: 'unauthorized' })
          return
        }
        const body = await readJsonBody(req)
        handleConfirmRequest(req, res, body)
        return
      }

      if (reqUrl.pathname === '/session/new' && req.method === 'POST') {
        if (!isAuthorized(req, reqUrl)) {
          writeJson(res, 401, { ok: false, error: 'unauthorized' })
          return
        }
        const body = await readJsonBody(req)
        handleSessionNewRequest(req, res, body)
        return
      }

      if (reqUrl.pathname === '/session/clear' && req.method === 'POST') {
        if (!isAuthorized(req, reqUrl)) {
          writeJson(res, 401, { ok: false, error: 'unauthorized' })
          return
        }
        const body = await readJsonBody(req)
        handleSessionClearRequest(req, res, body)
        return
      }

      if (reqUrl.pathname === '/workspace/tree' && req.method === 'GET') {
        if (!isAuthorized(req, reqUrl)) {
          writeJson(res, 401, { ok: false, error: 'unauthorized' })
          return
        }
        await handleWorkspaceTreeRequest(req, res, reqUrl)
        return
      }

      if (reqUrl.pathname === '/workspace/file/read' && req.method === 'POST') {
        if (!isAuthorized(req, reqUrl)) {
          writeJson(res, 401, { ok: false, error: 'unauthorized' })
          return
        }
        const body = await readJsonBody(req)
        await handleWorkspaceFileReadRequest(req, res, body)
        return
      }

      if (reqUrl.pathname === '/workspace/file/write' && req.method === 'POST') {
        if (!isAuthorized(req, reqUrl)) {
          writeJson(res, 401, { ok: false, error: 'unauthorized' })
          return
        }
        const body = await readJsonBody(req)
        await handleWorkspaceFileWriteRequest(req, res, body)
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
  onConfirm: (data: MobileBridgeConfirmData) => void,
  onNewSession: (data: MobileBridgeNewSessionData) => void,
  onClearSession: (data: MobileBridgeClearSessionData) => void,
): Promise<MobileBridgeConfig> {
  commandHandler = onCommand
  selectHandler = onSelect
  abortHandler = onAbort
  confirmHandler = onConfirm
  newSessionHandler = onNewSession
  clearSessionHandler = onClearSession
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
