import { app, BrowserWindow, dialog, shell } from 'electron'
import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { log, logError, logInfo } from '../system/logger'
import type { AppUpdateCheckResult } from '../../shared/ipc'

const API_BASE = 'https://ai.zhongnanke.cn/api'
const OWNER_ID = '35'
const LOGIN_URL = `${API_BASE}/v1/member/login/uid`
const VERSION_CHECK_URL = `${API_BASE}/v1/app/version/check`
const DEVICE_UID_FILE = 'device-uid.json'
const ZERO_WIDTH_SPLIT = '\u200B'
const ZERO_WIDTH_CHARS = /[\u200B\u200C\u200D\u200E\u200F\uFEFF\u2060]/g
const ZERO_WIDTH_GROUP_CHARS = /[\u200B\u200C\u200D\u200E\u200F\uFEFF\u2060]+/g

type UpdateType = 'Windows' | 'macOS'

type ApiEnvelope<T> = {
  errcode?: number
  msg?: string
  timestamp?: number
  data?: T
}

type LoginData = {
  token?: string
  uid?: string
}

type VersionCheckData = {
  version?: string
  version_code?: string | number
  download_url?: string
  hash?: string
  md5_sum?: string
  release_notes?: string
  forceUpdate?: boolean
}

type CheckUpdateOptions = {
  manual?: boolean
  parentWindow?: BrowserWindow | null
}

let lastUpdateCheckResult: AppUpdateCheckResult | null = null

function truncateText(text: string, maxLen = 1200): string {
  const raw = String(text ?? '')
  if (raw.length <= maxLen) return raw
  return `${raw.slice(0, maxLen)}...(truncated ${raw.length - maxLen} chars)`
}

function maskText(value: string, head = 10, tail = 6): string {
  const raw = String(value ?? '')
  if (!raw) return ''
  if (raw.length <= head + tail + 3) return '***'
  return `${raw.slice(0, head)}***${raw.slice(-tail)}`
}

function sanitizeToken(raw: unknown): string {
  const source = String(raw ?? '').trim()
  if (!source) return ''

  // 先尝试按“零宽分隔符”切段恢复 JWT 结构（避免把段间分隔误删）
  if (!source.includes('.')) {
    const parts = source
      .split(ZERO_WIDTH_GROUP_CHARS)
      .map((item) => item.trim())
      .filter(Boolean)
    if (parts.length >= 3) {
      const normalized = `${parts[0]}.${parts[1]}.${parts.slice(2).join('')}`
      return normalized.replace(/\s+/g, '')
    }
  }

  // 兜底：仅清理零宽字符和空白
  return source.replace(ZERO_WIDTH_CHARS, '').replace(/\s+/g, '').trim()
}

function fallbackDeviceUid(): string {
  const base = [
    app.getName(),
    process.platform,
    process.arch,
    process.env.HOSTNAME || process.env.COMPUTERNAME || '',
    app.getPath('home'),
  ].join('|')
  const hash = createHash('sha1').update(base).digest('hex').slice(0, 16)
  return `desktop_fp_${hash}`
}

function createDeviceUid(): string {
  return `desktop_${randomBytes(16).toString('hex')}`
}

function isValidDeviceUid(value: unknown): value is string {
  const text = String(value ?? '').trim()
  return Boolean(text) && text.length >= 12 && text.length <= 128
}

async function resolvePersistentDeviceUid(): Promise<string> {
  const fallback = fallbackDeviceUid()
  try {
    const dir = app.getPath('userData')
    const filePath = path.join(dir, DEVICE_UID_FILE)
    const raw = await fs.readFile(filePath, 'utf-8').catch(() => '')
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { uid?: string }
        if (isValidDeviceUid(parsed?.uid)) return parsed.uid
      } catch {
        // ignore parse error and regenerate
      }
    }

    const uid = createDeviceUid()
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      filePath,
      JSON.stringify(
        {
          uid,
          createdAt: Date.now(),
          schemaVersion: 1,
        },
        null,
        2,
      ),
      'utf-8',
    )
    return uid
  } catch (err) {
    console.warn('[app-update] [uid] persist failed, fallback deterministic uid:', err)
    return fallback
  }
}

function resolveUpdateType(): UpdateType {
  const envType = String(process.env.TACO_UPDATE_TYPE ?? '').trim()
  if (envType === 'Windows' || envType === 'macOS') return envType
  if (process.platform === 'darwin') return 'macOS'
  if (process.platform === 'win32') return 'Windows'
  throw new Error(`当前系统 ${process.platform} 暂不支持更新类型映射，仅支持 macOS / Windows`)
}

function randomNonce(length = 16): string {
  return randomBytes(Math.max(8, Math.ceil(length / 2))).toString('hex').slice(0, length)
}

function decodeBase64Url(input: string): string {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4)
  return Buffer.from(padded, 'base64').toString('utf-8')
}

function extractJwtSecret(token: string): string {
  const parts = String(token).split('.')
  if (parts.length < 2 || !parts[1]) return ''
  try {
    const payloadText = decodeBase64Url(parts[1])
    const payload = JSON.parse(payloadText) as Record<string, unknown>
    const candidates = ['secret', 'sign_secret', 'signSecret', 'sigSecret']
    for (const key of candidates) {
      const value = payload[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
  } catch {
    return ''
  }
  return ''
}

function sha1Hex(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

function versionParts(version: string): number[] {
  const parts = String(version)
    .split('.')
    .map((item) => Number.parseInt(item.replace(/[^\d]/g, ''), 10))
    .map((n) => (Number.isFinite(n) ? n : 0))
  while (parts.length < 4) parts.push(0)
  return parts.slice(0, 4)
}

function compareVersion(a: string, b: string): number {
  const pa = versionParts(a)
  const pb = versionParts(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] ?? 0
    const vb = pb[i] ?? 0
    if (va > vb) return 1
    if (va < vb) return -1
  }
  return 0
}

function versionToBuildCode(version: string): number {
  const [a, b, c, d] = versionParts(version)
  return a * 1_000_000_000 + b * 1_000_000 + c * 1_000 + d
}

function parseVersionCode(value: unknown): number {
  const numeric = Number.parseInt(String(value ?? '').replace(/[^\d]/g, ''), 10)
  return Number.isFinite(numeric) ? numeric : 0
}

async function parseJsonEnvelope<T>(resp: Response, actionLabel: string): Promise<ApiEnvelope<T>> {
  const text = await resp.text()
  console.log(`[app-update] [response-raw] ${actionLabel}:`, truncateText(text))

  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`${actionLabel}响应不是合法 JSON`)
  }
  if (!json || typeof json !== 'object') {
    throw new Error(`${actionLabel}响应格式错误`)
  }
  return json as ApiEnvelope<T>
}

async function loginAndGetToken(uid: string): Promise<{ token: string; uid: string }> {
  console.log('[app-update] [request] login:', {
    method: 'POST',
    url: LOGIN_URL,
    headers: {
      'Content-Type': 'application/json',
      'X-Owner-Id': OWNER_ID,
    },
    body: { uid },
  })

  const resp = await fetch(LOGIN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Owner-Id': OWNER_ID,
    },
    body: JSON.stringify({ uid }),
  })
  console.log('[app-update] [response] login status:', { status: resp.status, statusText: resp.statusText })
  if (!resp.ok) {
    throw new Error(`登录失败: ${resp.status} ${resp.statusText}`)
  }

  const envelope = await parseJsonEnvelope<LoginData>(resp, '登录接口')
  if (Number(envelope.errcode) !== 0) {
    throw new Error(`登录失败: ${String(envelope.msg || envelope.errcode || '未知错误')}`)
  }
  const token = sanitizeToken(envelope.data?.token)
  console.log('[app-update] [response] login parsed:', {
    errcode: envelope.errcode,
    msg: envelope.msg,
    uid: envelope.data?.uid,
    token: token ? maskText(token) : '',
  })
  if (!token) throw new Error('登录成功但未返回 token')
  const resolvedUid = String(envelope.data?.uid ?? uid).trim() || uid
  return { token, uid: resolvedUid }
}

async function requestVersionCheck(
  token: string,
  secret: string,
  currentVersion: string,
  updateType: UpdateType,
  uid: string,
): Promise<VersionCheckData> {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const nonce = randomNonce(16)
  const body = ''
  const sign = sha1Hex(`${nonce}${timestamp}${ZERO_WIDTH_SPLIT}${body}${ZERO_WIDTH_SPLIT}${secret}`)
  const query = new URLSearchParams({
    type: updateType,
    timestamp,
    nonce,
    sign,
  })
  const appId = String(process.env.TACO_APP_ID ?? 'com.taco.ai-agent').trim() || 'com.taco.ai-agent'
  const currentBuild = String(versionToBuildCode(currentVersion))
  const requestUrl = `${VERSION_CHECK_URL}?${query.toString()}`

  console.log('[app-update] [request] version-check:', {
    method: 'GET',
    url: requestUrl,
    query: {
      type: updateType,
      timestamp,
      nonce,
      sign: maskText(sign, 8, 4),
    },
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${maskText(token, 8, 4)}`,
      'X-App-Version': currentVersion,
      'X-App-Build': currentBuild,
      'X-App-ID': appId,
      'X-Device-Id': uid,
      'X-Owner-Id': OWNER_ID,
    },
  })

  const resp = await fetch(requestUrl, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'X-App-Version': currentVersion,
      'X-App-Build': currentBuild,
      'X-App-ID': appId,
      'X-Device-Id': uid,
      'X-Owner-Id': OWNER_ID,
    },
  })
  console.log('[app-update] [response] version-check status:', { status: resp.status, statusText: resp.statusText })
  if (!resp.ok) {
    throw new Error(`版本检查失败: ${resp.status} ${resp.statusText}`)
  }

  const envelope = await parseJsonEnvelope<VersionCheckData>(resp, '版本检查接口')
  if (Number(envelope.errcode) !== 0) {
    throw new Error(`版本检查失败: ${String(envelope.msg || envelope.errcode || '未知错误')}`)
  }

  console.log('[app-update] [response] version-check parsed:', {
    errcode: envelope.errcode,
    msg: envelope.msg,
    data: envelope.data
      ? {
        version: envelope.data.version,
        version_code: envelope.data.version_code,
        download_url: envelope.data.download_url,
        forceUpdate: envelope.data.forceUpdate,
      }
      : null,
  })

  return envelope.data ?? {}
}

function resolveDialogWindow(parentWindow?: BrowserWindow | null): BrowserWindow | undefined {
  if (parentWindow && !parentWindow.isDestroyed()) return parentWindow
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && !focused.isDestroyed()) return focused
  const firstAlive = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed())
  return firstAlive
}

async function showDialog(
  parentWindow: BrowserWindow | null | undefined,
  options: MessageBoxOptions,
): Promise<MessageBoxReturnValue> {
  const owner = resolveDialogWindow(parentWindow)
  if (owner) return dialog.showMessageBox(owner, options)
  return dialog.showMessageBox(options)
}

function safeFileNameFromUrl(downloadUrl: string): string {
  try {
    const u = new URL(downloadUrl)
    const raw = decodeURIComponent(path.basename(u.pathname || '').trim())
    if (raw) return raw
  } catch {
    // ignore
  }
  const ext = process.platform === 'win32' ? '.exe' : '.dmg'
  return `Taco-AI-update-${Date.now()}${ext}`
}

async function ensureUniquePath(targetPath: string): Promise<string> {
  const parsed = path.parse(targetPath)
  let candidate = targetPath
  let idx = 1
  while (true) {
    try {
      await fs.access(candidate)
      candidate = path.join(parsed.dir, `${parsed.name} (${idx})${parsed.ext}`)
      idx += 1
    } catch {
      return candidate
    }
  }
}

async function downloadUpdatePackage(
  downloadUrl: string,
  parentWindow?: BrowserWindow | null,
): Promise<string> {
  const owner = resolveDialogWindow(parentWindow)
  const win = owner ?? BrowserWindow.getAllWindows().find((item) => !item.isDestroyed())
  if (!win) throw new Error('未找到可用窗口，无法显示下载进度')

  const downloadsDir = app.getPath('downloads')
  await fs.mkdir(downloadsDir, { recursive: true })
  const fileName = safeFileNameFromUrl(downloadUrl)
  const savePath = await ensureUniquePath(path.join(downloadsDir, fileName))

  console.log('[app-update] [download] start:', { downloadUrl, savePath })

  return await new Promise<string>((resolve, reject) => {
    const session = win.webContents.session
    let started = false
    const startAt = Date.now()
    let lastLogAt = 0
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('下载超时：未收到下载启动事件'))
    }, 10_000)

    const cleanup = () => {
      clearTimeout(timeout)
      session.removeListener('will-download', onWillDownload)
      if (!win.isDestroyed()) win.setProgressBar(-1)
    }

    const onWillDownload = (_event: Electron.Event, item: Electron.DownloadItem) => {
      if (started) return
      if (item.getURL() !== downloadUrl) return
      started = true
      clearTimeout(timeout)
      item.setSavePath(savePath)
      if (!win.isDestroyed()) win.setProgressBar(0.01)

      item.on('updated', (_evt, state) => {
        const received = item.getReceivedBytes()
        const total = item.getTotalBytes()
        const progress = total > 0 ? received / total : -1
        if (!win.isDestroyed()) {
          if (progress >= 0) win.setProgressBar(Math.max(0.01, Math.min(progress, 0.99)))
          else win.setProgressBar(2)
        }
        const now = Date.now()
        if ((now - lastLogAt) >= 1_000) {
          lastLogAt = now
          console.log('[app-update] [download] progress:', {
            state,
            receivedBytes: received,
            totalBytes: total,
            progressPercent: progress >= 0 ? Number((progress * 100).toFixed(1)) : undefined,
            elapsedMs: now - startAt,
          })
        }
      })

      item.once('done', (_evt, state) => {
        cleanup()
        const finalPath = item.getSavePath() || savePath
        console.log('[app-update] [download] done:', {
          state,
          filePath: finalPath,
          elapsedMs: Date.now() - startAt,
        })
        if (state === 'completed') {
          resolve(finalPath)
          return
        }
        reject(new Error(`下载失败: ${state}`))
      })
    }

    session.on('will-download', onWillDownload)
    try {
      session.downloadURL(downloadUrl)
    } catch (err) {
      cleanup()
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

async function openInstallerPackage(filePath: string): Promise<void> {
  const target = String(filePath ?? '').trim()
  if (!target) throw new Error('安装包路径为空')

  await fs.access(target).catch(() => {
    throw new Error(`安装包不存在: ${target}`)
  })

  console.log('[app-update] [install] openPath:', { filePath: target })
  const openPathErr = await shell.openPath(target)
  if (!openPathErr) {
    console.log('[app-update] [install] openPath success')
    return
  }

  console.warn('[app-update] [install] openPath failed, fallback openExternal(file://):', openPathErr)
  const fileUrl = pathToFileURL(target).toString()
  try {
    await shell.openExternal(fileUrl)
    console.log('[app-update] [install] fallback openExternal success:', { fileUrl })
    return
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`打开安装包失败: ${openPathErr || detail}`)
  }
}

function shellQuote(text: string): string {
  return `'${String(text ?? '').replace(/'/g, `'\\''`)}'`
}

function scheduleInstallerLaunchAfterQuit(filePath: string): boolean {
  if (process.platform !== 'darwin') return false
  const target = String(filePath ?? '').trim()
  if (!target) return false
  try {
    const appName = shellQuote(app.getName())
    const cmd = `for i in $(seq 1 120); do if ! pgrep -x ${appName} >/dev/null 2>&1; then break; fi; sleep 0.2; done; open ${shellQuote(target)}`
    const child = spawn('/bin/sh', ['-c', cmd], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    console.log('[app-update] [install] scheduled launch after quit:', { filePath: target })
    return true
  } catch (err) {
    console.error('[app-update] [install] failed to schedule launch after quit:', err)
    return false
  }
}

export async function checkAndPromptForUpdate(options: CheckUpdateOptions = {}): Promise<AppUpdateCheckResult> {
  const manual = Boolean(options.manual)
  const currentVersion = app.getVersion()
  const checkedAt = Date.now()
  const uid = await resolvePersistentDeviceUid()
  const updateType = resolveUpdateType()

  log('APP_UPDATE_CHECK_START', {
    manual,
    currentVersion,
    updateType,
    uid,
  })
  console.log('[app-update] check start:', { manual, currentVersion, updateType, uid })

  try {
    const login = await loginAndGetToken(uid)
    const secret = extractJwtSecret(login.token)
    if (!secret) {
      throw new Error('token 中未解析到 secret，无法生成签名')
    }

    const latest = await requestVersionCheck(login.token, secret, currentVersion, updateType, login.uid)
    const latestVersion = String(latest.version ?? '').trim()
    const latestVersionCode = String(latest.version_code ?? '').trim()
    const currentBuildCode = versionToBuildCode(currentVersion)
    const remoteBuildCode = parseVersionCode(latest.version_code)
    const versionCmp = latestVersion ? compareVersion(latestVersion, currentVersion) : 0
    const hasUpdate = Boolean(
      latestVersion &&
      (versionCmp > 0 || (versionCmp === 0 && remoteBuildCode > currentBuildCode)),
    )
    const releaseNotes = String(latest.release_notes ?? '').trim()
    const downloadUrl = String(latest.download_url ?? '').trim()
    const forceUpdate = Boolean(latest.forceUpdate)

    let downloadTriggered = false
    if (hasUpdate && manual) {
      const detailLines = [
        `当前版本：v${currentVersion}`,
        `最新版本：v${latestVersion}${latestVersionCode ? ` (${latestVersionCode})` : ''}`,
        releaseNotes ? `更新内容：\n${releaseNotes}` : '',
        forceUpdate ? '该版本标记为强制更新。' : '',
      ].filter(Boolean)

      const result = await showDialog(options.parentWindow, {
        type: 'info',
        title: '发现新版本',
        message: `检测到新版本 v${latestVersion}`,
        detail: detailLines.join('\n\n'),
        buttons: ['稍后', '下载更新'],
        cancelId: 0,
        defaultId: 1,
        noLink: true,
      })

      if (result.response === 1 && downloadUrl) {
        downloadTriggered = true
        const downloadedFile = await downloadUpdatePackage(downloadUrl, options.parentWindow)
        if (process.platform === 'darwin') {
          const install = await showDialog(options.parentWindow, {
            type: 'question',
            title: '更新包下载完成',
            message: '安装更新需要先退出 Taco AI。是否现在退出并开始安装？',
            detail: downloadedFile,
            buttons: ['稍后安装', '立即安装（退出应用）'],
            cancelId: 0,
            defaultId: 1,
            noLink: true,
          })
          if (install.response === 1) {
            const scheduled = scheduleInstallerLaunchAfterQuit(downloadedFile)
            if (!scheduled) {
              throw new Error('安装启动失败：无法安排退出后自动打开安装包')
            }
            setTimeout(() => {
              app.quit()
            }, 120)
          }
        } else if (process.platform === 'win32') {
          const install = await showDialog(options.parentWindow, {
            type: 'question',
            title: '更新包下载完成',
            message: '安装更新需要先退出 Taco AI。是否现在退出并开始安装？',
            detail: downloadedFile,
            buttons: ['稍后安装', '立即安装（退出应用）'],
            cancelId: 0,
            defaultId: 1,
            noLink: true,
          })
          if (install.response === 1) {
            await openInstallerPackage(downloadedFile)
            setTimeout(() => {
              app.quit()
            }, 200)
          }
        } else {
          const install = await showDialog(options.parentWindow, {
            type: 'question',
            title: '更新包下载完成',
            message: '新版本已下载完成，是否立即安装？',
            detail: `文件位置：${downloadedFile}`,
            buttons: ['稍后安装', '立即安装'],
            cancelId: 0,
            defaultId: 1,
            noLink: true,
          })
          if (install.response === 1) {
            await openInstallerPackage(downloadedFile)
          }
        }
      }
    } else if (manual) {
      await showDialog(options.parentWindow, {
        type: 'info',
        title: '检查更新',
        message: '当前已是最新版本',
        detail: `当前版本：v${currentVersion}`,
        buttons: ['知道了'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
    }

    const output: AppUpdateCheckResult = {
      success: true,
      checkedAt,
      currentVersion,
      hasUpdate,
      latestVersion: latestVersion || undefined,
      latestVersionCode: latestVersionCode || undefined,
      releaseNotes: releaseNotes || undefined,
      downloadUrl: downloadUrl || undefined,
      forceUpdate,
      downloadTriggered,
      message: hasUpdate ? '发现新版本' : '当前已是最新版本',
    }
    lastUpdateCheckResult = output
    log('APP_UPDATE_CHECK_RESULT', output)
    console.log('[app-update] check result:', output)
    return output
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logError('app-update', '检查更新失败', err)
    console.error('[app-update] check failed:', message)

    const failed: AppUpdateCheckResult = {
      success: false,
      checkedAt,
      currentVersion,
      hasUpdate: false,
      message,
    }
    lastUpdateCheckResult = failed
    return failed
  }
}

export function getLastUpdateCheckResult(): AppUpdateCheckResult | null {
  return lastUpdateCheckResult
}

const AUTO_CHECK_INTERVAL_MS = 60_000 // 每分钟检查一次

export function scheduleStartupUpdateCheck(parentWindow?: BrowserWindow | null): void {
  const startupDelayMs = 1_000
  const runCheck = () => {
    void checkAndPromptForUpdate({ manual: false, parentWindow })
      .catch((err) => {
        logInfo('app-update', '自动检查更新失败（已忽略）', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
  }
  setTimeout(() => {
    runCheck()
    setInterval(runCheck, AUTO_CHECK_INTERVAL_MS)
  }, startupDelayMs)
}
