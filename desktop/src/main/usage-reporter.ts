import { app } from 'electron'
import { log, logError } from './infrastructure/logger'

const API_BASE = 'https://aigateway.bjctykj.com'
const REPORT_URL = `${API_BASE}/api/v1/public/desktop/report`
const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000 // 30 分钟

let deviceId: string | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null

/**
 * 从 app-updater 模块动态加载 resolvePersistentDeviceUid
 * 避免循环依赖
 */
async function resolveDeviceId(): Promise<string> {
  if (deviceId) return deviceId

  try {
    // 动态导入以复用已有的设备 UID 生成逻辑
    const updater = await import('./infrastructure/app-updater')
    deviceId = await (updater as any).resolvePersistentDeviceUid?.()
    if (deviceId) return deviceId
  } catch (err) {
    console.warn('[usage-reporter] failed to import device uid from app-updater, using fallback:', err)
  }

  // 兜底：使用 crypto 生成
  const crypto = await import('node:crypto')
  deviceId = `desktop_${crypto.randomBytes(16).toString('hex')}`
  return deviceId
}

interface ReportPayload {
  device_id: string
  platform: string
  arch: string
  version: string
  event: 'startup' | 'heartbeat'
}

async function reportUsage(event: 'startup' | 'heartbeat'): Promise<void> {
  try {
    const uid = await resolveDeviceId()
    const payload: ReportPayload = {
      device_id: uid,
      platform: process.platform,
      arch: process.arch,
      version: app.getVersion(),
      event,
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000) // 10 秒超时

    const response = await fetch(REPORT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })

    clearTimeout(timeout)

    if (response.ok) {
      const data = await response.json().catch(() => ({})) as any
      if (data?.data?.registered) {
        log('USAGE_REPORT_REGISTERED', `Device registered: ${uid.slice(0, 12)}...`)
      } else {
        log('USAGE_REPORT_SENT', `${event} reported (${response.status})`)
      }
    } else {
      logError('USAGE_REPORT_FAIL', `${event} failed: HTTP ${response.status}`)
    }
  } catch (err) {
    // 上报失败不应影响桌面端正常运行，静默处理
    console.warn(`[usage-reporter] ${event} report error:`, err)
  }
}

/**
 * 启动使用统计上报器
 * - 启动时立即上报一次 startup
 * - 每 30 分钟上报一次 heartbeat
 */
export async function startUsageReporter(): Promise<void> {
  log('USAGE_REPORTER_START', 'Starting usage reporter')

  // 启动时上报
  await reportUsage('startup')

  // 定期心跳
  heartbeatTimer = setInterval(() => {
    reportUsage('heartbeat')
  }, HEARTBEAT_INTERVAL_MS)
}

/**
 * 停止使用统计上报器
 */
export function stopUsageReporter(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
  log('USAGE_REPORTER_STOP', 'Usage reporter stopped')
}
