/**
 * 浏览器 CDP 网络监控 + Cookie 管理模块
 *
 * - CDP Network 域事件采集（requestWillBeSent / responseReceived / loadingFinished）
 * - 网络请求缓冲（按 appId 隔离，上限 200 条）
 * - CDP Network.getCookies / setCookie / clearBrowserCookies 封装
 */

import { ensureCdpAttached } from './state'

/* ------------------------------------------------------------------ */
/*  类型定义                                                           */
/* ------------------------------------------------------------------ */

export interface NetworkRequestHeader {
  name: string
  value: string
}

export interface NetworkRequestEntry {
  requestId: string
  url: string
  method: string
  requestHeaders?: Record<string, string>
  postData?: string
  status?: number
  statusText?: string
  responseHeaders?: Record<string, string>
  mimeType?: string
  responseBody?: string
  encodedDataLength?: number
  startTime: number
  endTime?: number
  /** 请求是否已完成（收到 loadingFinished） */
  completed: boolean
  /** 响应体是否已截断（超过 50KB） */
  bodyTruncated?: boolean
}

export interface NetworkRequestsResult {
  appId: string
  totalStored: number
  returned: number
  requests: NetworkRequestEntry[]
  monitoringActive: boolean
  hint: string
}

export interface CookieEntry {
  name: string
  value: string
  domain: string
  path: string
  expires?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
}

/* ------------------------------------------------------------------ */
/*  常量                                                               */
/* ------------------------------------------------------------------ */

const MAX_NETWORK_REQUESTS_PER_APP = 200
const MAX_RESPONSE_BODY_BYTES = 50 * 1024 // 50KB

/* ------------------------------------------------------------------ */
/*  模块级状态                                                         */
/* ------------------------------------------------------------------ */

const networkRequestsByAppId = new Map<string, NetworkRequestEntry[]>()
const networkMonitoringActive = new Set<string>()

/* ------------------------------------------------------------------ */
/*  CDP Network 事件监听                                               */
/* ------------------------------------------------------------------ */

function headersToRecord(headers?: Record<string, string> | NetworkRequestHeader[]): Record<string, string> | undefined {
  if (!headers) return undefined
  if (!Array.isArray(headers)) return headers
  const out: Record<string, string> = {}
  for (const h of headers) out[h.name] = h.value
  return out
}

async function enableCdpNetworkMonitoring(
  wc: Electron.WebContents,
  appId: string,
): Promise<void> {
  if (networkMonitoringActive.has(appId)) return
  await ensureCdpAttached(wc, appId)

  // 注册 CDP 事件监听
  wc.debugger.on('message', (_event, method, params: any) => {
    const buffer = networkRequestsByAppId.get(appId)
    if (!buffer) return

    if (method === 'Network.requestWillBeSent') {
      const req: NetworkRequestEntry = {
        requestId: params.requestId,
        url: params.request?.url ?? '',
        method: params.request?.method ?? 'GET',
        requestHeaders: headersToRecord(params.request?.headers),
        postData: params.request?.postData,
        startTime: params.timestamp * 1000,
        completed: false,
      }
      buffer.push(req)
      if (buffer.length > MAX_NETWORK_REQUESTS_PER_APP) {
        buffer.splice(0, buffer.length - MAX_NETWORK_REQUESTS_PER_APP)
      }
    }

    if (method === 'Network.responseReceived') {
      const entry = buffer.find((r) => r.requestId === params.requestId)
      if (entry) {
        entry.status = params.response?.status
        entry.statusText = params.response?.statusText
        entry.responseHeaders = headersToRecord(params.response?.headers)
        entry.mimeType = params.response?.mimeType
      }
    }

    if (method === 'Network.loadingFinished') {
      const entry = buffer.find((r) => r.requestId === params.requestId)
      if (entry) {
        entry.encodedDataLength = params.encodedDataLength
        entry.endTime = params.timestamp * 1000
        entry.completed = true
      }
    }
  })

  await wc.debugger.sendCommand('Network.enable')
  networkMonitoringActive.add(appId)
}

/* ------------------------------------------------------------------ */
/*  公共 API：网络请求                                                   */
/* ------------------------------------------------------------------ */

/**
 * 启用并返回指定 appId 的网络请求缓冲。
 * 首次调用自动启用 CDP Network 域监听。
 */
export async function getBrowserNetworkRequests(
  wc: Electron.WebContents,
  appId: string = 'default',
  limit?: number,
): Promise<NetworkRequestsResult> {
  await enableCdpNetworkMonitoring(wc, appId)

  const buffer = networkRequestsByAppId.get(appId) ?? []
  const effectiveLimit = Math.max(1, Math.min(200, limit ?? 50))
  const requests = buffer.slice(-effectiveLimit)

  return {
    appId,
    totalStored: buffer.length,
    returned: requests.length,
    requests,
    monitoringActive: networkMonitoringActive.has(appId),
    hint: requests.length > 0 && requests.some((r) => !r.completed)
      ? '部分请求仍在进行中（completed=false），稍后可再次查询获取完整响应。'
      : '每个请求的 responseBody 需要通过 get_network_request_body 单独获取（传入 requestId）。',
  }
}

/**
 * 获取单个请求的响应体（通过 CDP Network.getResponseBody）。
 */
export async function getBrowserNetworkRequestBody(
  wc: Electron.WebContents,
  appId: string,
  requestId: string,
): Promise<{ body: string; truncated: boolean; error?: string }> {
  await ensureCdpAttached(wc, appId)

  try {
    const result = (await wc.debugger.sendCommand('Network.getResponseBody', {
      requestId,
    })) as { body: string; base64Encoded: boolean }
    const body = result.base64Encoded
      ? Buffer.from(result.body, 'base64').toString('utf-8')
      : result.body
    const truncated = body.length > MAX_RESPONSE_BODY_BYTES
    return {
      body: truncated ? body.slice(0, MAX_RESPONSE_BODY_BYTES) : body,
      truncated,
    }
  } catch (err) {
    return {
      body: '',
      truncated: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * 清除指定 appId 的网络请求缓冲。
 */
export function clearBrowserNetworkRequests(appId: string = 'default'): void {
  networkRequestsByAppId.set(appId, [])
}

/**
 * 停用并清理指定 appId 的网络监控状态（浏览器关闭时调用）。
 */
export function destroyBrowserNetworkMonitoring(appId: string = 'default'): void {
  networkMonitoringActive.delete(appId)
  networkRequestsByAppId.delete(appId)
}

/* ------------------------------------------------------------------ */
/*  公共 API：Cookie                                                    */
/* ------------------------------------------------------------------ */

/**
 * 读取指定页面的所有 Cookie（含 HttpOnly）。
 */
export async function getBrowserCookies(
  wc: Electron.WebContents,
  appId: string,
  urls?: string[],
): Promise<{ cookies: CookieEntry[] }> {
  await ensureCdpAttached(wc, appId)

  const result = (await wc.debugger.sendCommand('Network.getCookies', {
    urls: urls && urls.length > 0 ? urls : undefined,
  })) as { cookies: Array<Record<string, any>> }

  return {
    cookies: (result.cookies ?? []).map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
    })),
  }
}

/**
 * 设置 Cookie。
 */
export async function setBrowserCookie(
  wc: Electron.WebContents,
  appId: string,
  cookie: {
    name: string
    value: string
    url?: string
    domain?: string
    path?: string
    secure?: boolean
    httpOnly?: boolean
    sameSite?: 'Strict' | 'Lax' | 'None'
    expires?: number
  },
): Promise<{ success: boolean }> {
  await ensureCdpAttached(wc, appId)

  await wc.debugger.sendCommand('Network.setCookie', {
    name: cookie.name,
    value: cookie.value,
    url: cookie.url,
    domain: cookie.domain,
    path: cookie.path ?? '/',
    secure: cookie.secure ?? false,
    httpOnly: cookie.httpOnly ?? false,
    sameSite: cookie.sameSite,
    expires: cookie.expires,
  })

  return { success: true }
}

/**
 * 清除浏览器所有 Cookie。
 */
export async function clearBrowserCookies(
  wc: Electron.WebContents,
  appId: string,
): Promise<{ success: boolean }> {
  await ensureCdpAttached(wc, appId)

  await wc.debugger.sendCommand('Network.clearBrowserCookies')

  return { success: true }
}
