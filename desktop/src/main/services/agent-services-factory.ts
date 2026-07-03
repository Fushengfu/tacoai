/**
 * Agent 服务工厂
 *
 * 将现有基础设施模块（infrastructure/browser、infrastructure/mcp、
 * infrastructure/desktop-service、services/terminal/ 等）适配为
 * AgentServices 接口，注入到 Agent SDK。
 *
 * 桌面端主进程入口：chat-handlers.ts 调用 buildAgentServices()，
 * 创建包含所有桌面端能力的服务容器。
 */

import { app, desktopCapturer, screen } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { log as infraLog } from '../infrastructure/logger'
import { executeBrowserAction, getBrowserConsoleSnapshot, listBrowserInstances, closeExternalBrowser } from '../infrastructure/browser'
import { getActiveMcpTools, callMcpTool, saveScreenshot } from '../infrastructure/mcp'
import { callDesktopService } from '../infrastructure/desktop-service'
import {
  createAITerminal,
  runInAITerminal,
  listAITerminals,
  closeAITerminal,
} from './terminal/ai-terminal-manager'
import {
  loadUploadConfigFromDb,
  saveUploadConfigToDb,
  loadAppProvidersStateFromDb,
  getMemoryDbInfo,
  countMemoryMaintainRuns,
  getDb,
  hasAnyTaskMemories,
  listTaskMemoriesByTier,
  replaceTaskMemoriesByTier,
  importTaskMemoriesByTier,
  resolveChatStoreMessageSeqRange,
  initMemoryDb,
  isMemoryDbEmpty,
  importProjectNotes,
  importMemorySnapshots,
  listMemorySnapshotsForScope,
  replaceMemorySnapshots,
} from '../data/memory-db'
import { listNotes } from './notes/notes-crud'
import { getGatewayModelListCache } from '../ipc/handlers/gateway-handlers'
import type { AgentServices, BrowserService, McpService, DesktopAutomationService, TerminalService, DatabaseService, MemorySnapshotStore, NotesService, FsProvider, GatewayModelCache } from '../sdk/agent/services'

/* ------------------------------------------------------------------ */
/*  Logger                                                            */
/* ------------------------------------------------------------------ */

function createLogger(): AgentServices['logger'] {
  return (tag: string, meta?: Record<string, unknown>, scope?: string) => {
    infraLog(tag, meta, scope)
  }
}

/* ------------------------------------------------------------------ */
/*  Browser Service                                                    */
/* ------------------------------------------------------------------ */

function createBrowserService(): BrowserService {
  return {
    async executeAction(params, appId) {
      const result = await executeBrowserAction(
        { action: params.action, params: params.params } as any,
        appId,
      )
      return {
        success: result.success,
        data: result.data,
        error: result.error,
      }
    },
    getConsoleSnapshot(options) {
      const snapshot = getBrowserConsoleSnapshot({
        appId: options.appId,
        limit: options.limit,
        levels: options.levels,
        onlyErrors: options.onlyErrors,
        devOnly: options.devOnly,
        includeCandidates: options.includeCandidates,
        clearAfterRead: options.clearAfterRead,
      })
      return {
        entries: (snapshot as any).entries ?? [],
        count: (snapshot as any).count ?? 0,
      }
    },
    listInstances() {
      return listBrowserInstances().map((inst: any) => ({
        appId: inst.appId,
        windowLabel: inst.windowLabel,
        title: inst.title,
        url: inst.url,
        createdAt: inst.createdAt,
      }))
    },
    closeInstance(appId) {
      closeExternalBrowser(appId)
    },
  }
}

/* ------------------------------------------------------------------ */
/*  MCP Service                                                        */
/* ------------------------------------------------------------------ */

function createMcpService(): McpService {
  return {
    async saveScreenshot(dataUrl, appId, workspacePath) {
      return saveScreenshot(dataUrl, appId, workspacePath)
    },
    getActiveTools() {
      return getActiveMcpTools()
    },
    async callTool(serverId, toolName, args) {
      return callMcpTool(serverId, toolName, args)
    },
  }
}

/* ------------------------------------------------------------------ */
/*  Desktop Automation Service                                         */
/* ------------------------------------------------------------------ */

// 缓存屏幕录制权限状态，避免频繁调用 systemPreferences
let _screenPermissionCache: 'granted' | 'denied' | 'unknown' | null = null

function createDesktopAutomationService(): DesktopAutomationService {
  return {
    async call(payload, signal) {
      const result = await callDesktopService(
        { action: payload.action as any, ...payload },
        signal,
      )
      return {
        ok: result.ok,
        error: result.error,
        message: result.message,
        cursorBefore: result.cursorBefore ?? null,
        cursorAfter: result.cursorAfter ?? null,
      }
    },
    async captureScreen(options) {
      const displayId = options.displayId ? Number(options.displayId) : undefined
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: {
          width: options.width ?? 0,
          height: options.height ?? 0,
        },
      })

      if (sources.length === 0) {
        throw new Error('No screen sources found')
      }

      _screenPermissionCache = 'granted'

      // 按 displayId 或默认取第一个
      const source = displayId !== undefined
        ? sources.find(s => s.display_id === String(displayId)) ?? sources[0]
        : sources[0]

      const img = source.thumbnail
      if (img.isEmpty()) {
        throw new Error('Screenshot image is empty')
      }

      const display = screen.getPrimaryDisplay()
      const bounds = display.bounds
      const dataUrl = img.toDataURL()

      // 保存截图到项目空间隐藏目录
      const ssDir = options.workspacePath
        ? path.join(options.workspacePath, '.taco', 'screenshots', 'desktop')
        : path.join(app.getPath('temp'), 'taco-screenshots')
      if (!fs.existsSync(ssDir)) {
        fs.mkdirSync(ssDir, { recursive: true })
      }
      const screenshotPath = path.join(ssDir, `desktop-${Date.now()}.png`)
      fs.writeFileSync(screenshotPath, img.toPNG())

      return {
        dataUrl,
        screenshotPath,
        cloudUrl: undefined,
        displayId: source.display_id,
        width: img.getSize().width,
        height: img.getSize().height,
        displayWidth: bounds.width,
        displayHeight: bounds.height,
        displayBoundsX: bounds.x,
        displayBoundsY: bounds.y,
        displayScaleFactor: display.scaleFactor,
      }
    },
    checkScreenRecordingPermission() {
      // 使用缓存结果避免重复查询
      if (_screenPermissionCache !== null) return _screenPermissionCache

      // macOS 需要屏幕录制权限。通过尝试调用 desktopCapturer 来检测。
      // systemPreferences.getMediaAccessStatus 在 Electron 40+ 不支持 'screen'。
      if (process.platform !== 'darwin') return 'granted'
      return 'unknown' // 首次调用时返回 unknown，让 captureScreen 实际尝试后更新
    },
    openScreenRecordingSettings() {
      // macOS 用户需要手动到系统设置开启权限
      // Electron 40+ 的 askForMediaAccess 不支持 'screen'
    },
  }
}

/* ------------------------------------------------------------------ */
/*  Terminal Service                                                   */
/* ------------------------------------------------------------------ */

function createTerminalService(): TerminalService {
  return {
    create(options) {
      const info = createAITerminal({ name: options?.name, cwd: options?.cwd })
      return {
        id: info.terminalId,
        name: info.name,
        cwd: info.cwd,
        createdAt: new Date(info.createdAt).toISOString(),
      }
    },
    async run(terminalId, command, timeout, stream, streamMs) {
      const result = await runInAITerminal(terminalId, command, timeout, stream, streamMs)
      return { output: result.output }
    },
    list() {
      return listAITerminals().map(t => ({
        id: t.terminalId,
        name: t.name,
        cwd: t.cwd,
        createdAt: new Date(t.createdAt).toISOString(),
      }))
    },
    close(terminalId) {
      return closeAITerminal(terminalId)
    },
  }
}

/* ------------------------------------------------------------------ */
/*  Database Service — 适配 repositories/memory-db/ 到 AgentServices     */
/* ------------------------------------------------------------------ */

function createDatabaseService(): DatabaseService {
  return {
    getUploadConfig() {
      const cfg = loadUploadConfigFromDb()
      if (!cfg || cfg.provider === 'none') return null
      return { provider: cfg.provider, config: cfg as Record<string, unknown> }
    },
    saveUploadConfig(provider, config) {
      saveUploadConfigToDb(provider, config)
    },
    getAppProviders() {
      return loadAppProvidersStateFromDb() as any
    },
    getMemoryDbInfo() {
      return getMemoryDbInfo()
    },
    countMaintainRuns(scope) {
      return countMemoryMaintainRuns({ workspace: scope })
    },
    getRawDb() {
      return getDb()
    },
    hasAnyTaskMemories(workspace, projectId) {
      return hasAnyTaskMemories({ workspace, projectId })
    },
    listTaskMemoriesByTier(workspace, tier, projectId) {
      return listTaskMemoriesByTier({ workspace, projectId }, tier as any)
    },
    replaceTaskMemoriesByTier(workspace, tier, entries, projectId) {
      replaceTaskMemoriesByTier({ workspace, projectId }, entries as any[], tier as any)
    },
    importTaskMemoriesByTier(workspace, tier, entries, projectId) {
      importTaskMemoriesByTier({ workspace, projectId }, entries as any[], tier as any)
    },
    resolveChatStoreMessageSeqRange(scopeKey, messageIds) {
      return resolveChatStoreMessageSeqRange(scopeKey, messageIds as any[])
    },
    initMemoryDb() {
      initMemoryDb()
    },
    isMemoryDbEmpty() {
      return isMemoryDbEmpty()
    },
    importProjectNotes(workspace, notes, projectId) {
      importProjectNotes({ workspace, projectId }, notes as any[])
    },
    importMemorySnapshots(workspace, snapshots, projectId) {
      importMemorySnapshots({ workspace, projectId }, snapshots as any[])
    },
  }
}

/* ------------------------------------------------------------------ */
/*  Snapshot Store                                                     */
/* ------------------------------------------------------------------ */

function createSnapshotStore(): MemorySnapshotStore {
  return {
    listForScope(scope) {
      return listMemorySnapshotsForScope(scope) as any[]
    },
    replaceForScope(scope, items) {
      replaceMemorySnapshots(scope, items as any[])
    },
    importForScope(scope, items) {
      importMemorySnapshots(scope, items as any[])
    },
  }
}

/* ------------------------------------------------------------------ */
/*  Notes Service                                                      */
/* ------------------------------------------------------------------ */

function createNotesService(): NotesService {
  return {
    async list(workspace, projectId) {
      return listNotes(workspace, projectId)
    },
    normalize(entry) {
      return entry
    },
  }
}

/* ------------------------------------------------------------------ */
/*  File System Provider                                               */
/* ------------------------------------------------------------------ */

function createFsProvider(): FsProvider {
  return {
    getUserDataPath() {
      return app.getPath('userData')
    },
    getHomeDir() {
      return app.getPath('home')
    },
    async trashFile(absPath) {
      const { shell } = await import('electron')
      await shell.trashItem(absPath)
    },
  }
}

/* ------------------------------------------------------------------ */
/*  Gateway Model Cache                                                */
/* ------------------------------------------------------------------ */

function createGatewayModelCache(): GatewayModelCache {
  return {
    get() {
      return (getGatewayModelListCache() ?? []) as Array<Record<string, unknown>>
    },
  }
}

/* ------------------------------------------------------------------ */
/*  工厂主函数                                                          */
/* ------------------------------------------------------------------ */

let cachedServices: AgentServices | null = null

/**
 * 构建 Agent 服务容器（单例）。
 * 包含所有桌面端基础设施服务。
 */
export function buildAgentServices(): AgentServices {
  if (cachedServices) return cachedServices

  cachedServices = {
    logger: createLogger(),
    browser: createBrowserService(),
    mcp: createMcpService(),
    desktop: createDesktopAutomationService(),
    terminal: createTerminalService(),
    database: createDatabaseService(),
    snapshotStore: createSnapshotStore(),
    notes: createNotesService(),
    fsProvider: createFsProvider(),
    gatewayModelCache: createGatewayModelCache(),
  }

  return cachedServices
}

/**
 * 获取缓存的 Agent 服务容器。
 * 必须在 buildAgentServices() 之后调用。
 */
export function getAgentServices(): AgentServices | null {
  return cachedServices
}
