/**
 * Agent SDK — 服务容器接口
 *
 * 定义 Agent SDK 所需的所有外部服务接口。
 * SDK 内部模块通过 AgentServices 容器获取服务，
 * 不再直接 import 基础设施模块（electron、infrastructure、repositories/memory-db 等）。
 *
 * 应用层（桌面端/CLI/其他项目）实现这些接口并注入到 SDK，
 * 使 SDK 可以在不同环境下独立复用。
 */

import type { ToolCall } from './tools'
import type { OcrResult } from '../../infrastructure/ocr'

/* ------------------------------------------------------------------ */
/*  Logger                                                             */
/* ------------------------------------------------------------------ */

export interface Logger {
  (tag: string, meta?: Record<string, unknown>, scope?: string): void
}

/* ------------------------------------------------------------------ */
/*  浏览器使用服务                                                     */
/* ------------------------------------------------------------------ */

export interface BrowserActionParams {
  action: string
  params: Record<string, unknown>
}

export interface BrowserActionResult {
  success: boolean
  data?: string
  error?: string
}

export interface BrowserConsoleOptions {
  appId: string
  limit?: number
  levels?: Array<'log' | 'info' | 'warn' | 'error' | 'debug'>
  onlyErrors?: boolean
  devOnly?: boolean
  includeCandidates?: boolean
  clearAfterRead?: boolean
}

export interface BrowserConsoleSnapshot {
  entries: Array<{
    level: string
    text: string
    timestamp: number
    source?: string
  }>
  count: number
}

export interface BrowserInstance {
  appId: string
  windowLabel?: string
  title?: string
  url?: string
  createdAt: number
}

export interface BrowserService {
  executeAction(params: BrowserActionParams, appId?: string): Promise<BrowserActionResult>
  getConsoleSnapshot(options: BrowserConsoleOptions): BrowserConsoleSnapshot
  getNetworkRequests(appId: string, limit?: number): Promise<any>
  getNetworkRequestBody(appId: string, requestId: string): Promise<any>
  getCookies(appId: string, urls?: string[]): Promise<any>
  setCookie(appId: string, cookie: Record<string, unknown>): Promise<any>
  clearCookies(appId: string): Promise<any>
  listInstances(): BrowserInstance[]
  closeInstance(appId: string): void
  clearNetworkRequests(appId: string): void
}

/* ------------------------------------------------------------------ */
/*  MCP 服务                                                           */
/* ------------------------------------------------------------------ */

export interface McpToolInfo {
  serverId: string
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

export interface McpCallResult {
  content: Array<{ type: string; text?: string; data?: string }>
  isError?: boolean
}

export interface McpService {
  saveScreenshot(dataUrl: string, appId?: string, workspacePath?: string): Promise<string>
  getActiveTools(): McpToolInfo[]
  callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<McpCallResult>
}

/* ------------------------------------------------------------------ */
/*  电脑使用服务                                                      */
/* ------------------------------------------------------------------ */

export interface DesktopActionResult {
  ok: boolean
  error?: string
  message?: string
  cursorBefore?: { x: number; y: number } | null
  cursorAfter?: { x: number; y: number } | null
}

export interface ScreenCaptureOptions {
  width?: number
  height?: number
  displayId?: string
  appId?: string
  workspacePath?: string
}

export interface ScreenCaptureResult {
  dataUrl: string
  screenshotPath: string
  cloudUrl?: string
  displayId: string
  width: number
  height: number
  displayWidth: number
  displayHeight: number
  displayBoundsX: number
  displayBoundsY: number
  displayScaleFactor: number
}

export interface DesktopAutomationService {
  call(payload: Record<string, unknown>, signal?: AbortSignal): Promise<DesktopActionResult>
  captureScreen(options: ScreenCaptureOptions): Promise<ScreenCaptureResult>
  checkScreenRecordingPermission(): Promise<'granted' | 'denied' | 'unknown'>
  openScreenRecordingSettings(): void
  /** OCR 文字识别：输入图片 dataUrl/cloudUrl/路径，返回文字块及坐标。不传 image 则自动截屏后识别 */
  ocr(image?: string): Promise<OcrResult>
}

/* ------------------------------------------------------------------ */
/*  终端服务                                                            */
/* ------------------------------------------------------------------ */

export interface TerminalCreateOptions {
  name?: string
  cwd?: string
}

export interface TerminalInfo {
  id: string
  name: string
  cwd: string
  createdAt: string
}

export interface TerminalService {
  create(options?: TerminalCreateOptions): TerminalInfo
  run(terminalId: string, command: string, timeout?: number, stream?: boolean, streamMs?: number): Promise<{ output: string }>
  list(): TerminalInfo[]
  close(terminalId: string): boolean
}

/* ------------------------------------------------------------------ */
/*  数据库服务（封装 repositories/memory-db）                               */
/* ------------------------------------------------------------------ */

export interface DatabaseService {
  // 应用提供商
  getAppProviders(): { data?: { modelConfigs: Array<Record<string, unknown>> } } | null

  // DB 信息
  getMemoryDbInfo(): any
  countMaintainRuns(scope: string): number

  // DB schema（直接暴露 better-sqlite3 Database 对象，用于 risk.ts 中 app_state_meta 读写）
  getRawDb(): any

  // 任务记忆 CRUD
  hasAnyTaskMemories(workspace: string, projectId?: string): boolean
  listTaskMemoriesByTier(workspace: string, tier: string, projectId?: string): any[]
  searchTaskMemories(workspace: string, keywords: string[], timeFrom?: string, timeTo?: string, limit?: number, projectId?: string): any[]
  replaceTaskMemoriesByTier(workspace: string, tier: string, entries: any[], projectId?: string): void
  importTaskMemoriesByTier(workspace: string, tier: string, entries: any[], projectId?: string): void
  resolveChatStoreMessageSeqRange(scopeKey: string, messageIds: any[], projectId?: string): any

  // 迁移
  initMemoryDb(workspace: string, projectId?: string): void
  isMemoryDbEmpty(workspace: string, projectId?: string): boolean
  importProjectNotes(workspace: string, notes: unknown[], projectId?: string): void
  importMemorySnapshots(workspace: string, snapshots: unknown[], projectId?: string): void
}

/* ------------------------------------------------------------------ */
/*  快照存储（封装 repositories/memory-db/snapshots）                     */
/* ------------------------------------------------------------------ */

export interface SnapshotScope {
  workspace: string
  projectId?: string
  scopeKey?: string
}

export interface MemorySnapshotStore {
  listForScope(scope: SnapshotScope): Array<Record<string, unknown>>
  replaceForScope(scope: SnapshotScope, items: Array<Record<string, unknown>>): void
  importForScope(scope: SnapshotScope, items: Array<Record<string, unknown>>): void
}

/* ------------------------------------------------------------------ */
/*  笔记服务                                                            */
/* ------------------------------------------------------------------ */

export interface NotesService {
  list(workspace: string, projectId?: string): Promise<unknown[]>
  normalize(entry: unknown): unknown
}

/* ------------------------------------------------------------------ */
/*  文件系统服务（替代 electron app.getPath）                             */
/* ------------------------------------------------------------------ */

export interface FsProvider {
  getUserDataPath(): string
  getHomeDir(): string
  /** 将文件移动到系统回收站 */
  trashFile(absPath: string): Promise<void>
}

/* ------------------------------------------------------------------ */
/*  网关模型缓存                                                        */
/* ------------------------------------------------------------------ */

export interface GatewayModelCache {
  get(): Array<Record<string, unknown>>
}

/* ------------------------------------------------------------------ */
/*  统一服务容器                                                        */
/* ------------------------------------------------------------------ */

export interface AgentServices {
  logger: Logger
  browser?: BrowserService
  mcp?: McpService
  desktop?: DesktopAutomationService
  terminal?: TerminalService
  database: DatabaseService
  snapshotStore?: MemorySnapshotStore
  notes?: NotesService
  fsProvider: FsProvider
  gatewayModelCache?: GatewayModelCache
  /** 获取 JWT token，用于网关 API 认证；null 表示未登录 */
  getToken(): string | null
}
