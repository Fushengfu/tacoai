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

import { app, desktopCapturer, screen, shell, systemPreferences } from 'electron'
import { execSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { log as infraLog } from '../infrastructure/logger'
import { loadAuthFromFile } from '../infrastructure/auth-store'
import { getBridgeManager } from '../bridge/bridge-manager'
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
  loadAppProvidersStateFromDb,
  getMemoryDbInfo,
  countMemoryMaintainRuns,
  getDb,
  hasAnyTaskMemories,
  listTaskMemoriesByTier,
  searchTaskMemories,
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
      const ssDir = options.workspacePath
        ? path.join(options.workspacePath, '.taco', 'screenshots', 'desktop')
        : path.join(app.getPath('temp'), 'taco-screenshots')
      if (!fs.existsSync(ssDir)) {
        fs.mkdirSync(ssDir, { recursive: true })
      }
      const screenshotPath = path.join(ssDir, `desktop-${Date.now()}.png`)

      let dataUrl: string

      if (process.platform === 'darwin') {
        // macOS: 使用 screencapture 命令行，绕过 Electron 40 + macOS 26 的 desktopCapturer 兼容问题
        execSync(`screencapture -x "${screenshotPath}"`, { timeout: 10000 })
        const buf = fs.readFileSync(screenshotPath)
        dataUrl = 'data:image/png;base64,' + buf.toString('base64')
      } else {
        // Windows / Linux: 首选 desktopCapturer，失败后降级到系统命令行
        const displaySize = screen.getPrimaryDisplay().size
        try {
          const sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: displaySize,
          })
          const screenSource = sources.find(s => s.name === 'Entire Screen' || s.name === 'Screen 1')
          const img = screenSource?.thumbnail ?? sources[0]?.thumbnail
          if (!img || img.isEmpty()) {
            throw new Error('desktopCapturer 返回空截图')
          }
          const buf = img.toPNG()
          dataUrl = 'data:image/png;base64,' + buf.toString('base64')
        } catch (e1) {
          // desktopCapturer 失败 → 降级到系统命令行截屏
          try {
            if (process.platform === 'win32') {
              // PowerShell 全屏截图（System.Drawing 是 .NET 内置组件，无需安装）
              const safePath = screenshotPath.replace(/\\/g, '/')
              const psCmd = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $s=[System.Windows.Forms.Screen]::PrimaryScreen; $b=New-Object System.Drawing.Bitmap($s.Bounds.Width,$s.Bounds.Height); $g=[System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen($s.Bounds.X,$s.Bounds.Y,0,0,$b.Size); $b.Save('${safePath}',[System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $b.Dispose()`
              execSync(`powershell -NoProfile -Command "${psCmd}"`, { timeout: 15000 })
            } else {
              // Linux: 依次尝试 ImageMagick → gnome-screenshot → scrot
              try {
                execSync(`import -window root "${screenshotPath}"`, { timeout: 10000 })
              } catch {
                try {
                  execSync(`gnome-screenshot -f "${screenshotPath}"`, { timeout: 10000 })
                } catch {
                  execSync(`scrot "${screenshotPath}"`, { timeout: 10000 })
                }
              }
            }
            const buf = fs.readFileSync(screenshotPath)
            if (buf.length === 0) throw new Error('命令行截屏返回空文件')
            dataUrl = 'data:image/png;base64,' + buf.toString('base64')
          } catch (e2) {
            const err1 = e1 instanceof Error ? e1.message : String(e1)
            const err2 = e2 instanceof Error ? e2.message : String(e2)
            throw new Error(`截图失败：desktopCapturer(${err1})，命令行(${err2})`)
          }
        }
      }

      const display = screen.getPrimaryDisplay()
      const bounds = display.bounds
      const { width, height } = display.size

      return {
        dataUrl,
        screenshotPath,
        cloudUrl: undefined,
        displayId: String(display.id),
        width,
        height,
        displayWidth: bounds.width,
        displayHeight: bounds.height,
        displayBoundsX: bounds.x,
        displayBoundsY: bounds.y,
        displayScaleFactor: display.scaleFactor,
      }
    },
    async checkScreenRecordingPermission() {
      // 使用缓存结果避免重复查询
      if (_screenPermissionCache !== null) return _screenPermissionCache

      // macOS 需要屏幕录制权限
      if (process.platform !== 'darwin') return 'granted'

      // 尝试获取真实权限状态。systemPreferences.getMediaAccessStatus('screen')
      // 在 Electron 40+ 可能不支持，降级为 unknown 让 captureScreen 实际尝试。
      try {
        const raw = systemPreferences.getMediaAccessStatus('screen')
        const status = (raw === 'granted' || raw === 'denied' || raw === 'unknown') ? raw : 'unknown'
        _screenPermissionCache = status

        // 首次使用（unknown）：弹出系统权限弹窗，让用户选择
        if (status === 'unknown') {
          try {
            // askForMediaAccess('screen') 会弹出 macOS 系统权限弹窗
            // TS 类型定义不包含 'screen'，但运行时支持
            const allowed = await (systemPreferences as any).askForMediaAccess('screen')
            _screenPermissionCache = allowed ? 'granted' : 'denied'
            return _screenPermissionCache
          } catch {
            // Electron 40+ 可能不支持 askForMediaAccess('screen')，
            // 保留 unknown 让 captureScreen 实际尝试（会触发系统弹窗）
          }
        }

        return status
      } catch {
        return 'unknown'
      }
    },
    openScreenRecordingSettings() {
      // 直接打开 macOS 屏幕录制权限设置面板
      if (process.platform === 'darwin') {
        shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
      }
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
    searchTaskMemories(workspace, keywords, timeFrom, timeTo, limit, projectId) {
      return searchTaskMemories({ workspace, projectId }, keywords, timeFrom, timeTo, limit)
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
    getToken() {
      // 优先从 BridgeManager 取（手机端登录），降级到 auth-store（桌面端登录）
      const bridgeToken = getBridgeManager().getToken()
      if (bridgeToken) return bridgeToken
      // loadAuthFromFile 是异步的，但 getToken 必须同步返回
      // auth-store 的 token 已在 bridge.connect 时同步存入 BridgeManager
      // 所以这里只需要 BridgeManager 即可
      return null
    },
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
