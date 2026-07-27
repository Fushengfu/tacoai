/**
 * 工具执行器 - 浏览器使用（browser-use 技能）
 */

import type { AgentServices } from '../services'
import type { BrowserActionType } from '../types'
import { uploadScreenshotToCloud } from './exec-vision'
import type { ExecResult, ToolRuntimeContext } from './exec-utils'

/* ------------------------------------------------------------------ */
/*  scopedBrowserAppId                                                 */
/* ------------------------------------------------------------------ */

export function scopedBrowserAppId(projectId?: string, appId?: string): string | undefined {
  const raw = String(projectId ?? '').trim()
  if (!raw) return undefined
  const safe = raw.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 64)
  if (!safe) return undefined
  const base = `project-${safe}`
  if (!appId) return base
  const safeAppId = String(appId).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 32)
  if (!safeAppId) return base
  return `${base}::${safeAppId}`
}

/* ------------------------------------------------------------------ */
/*  execBrowserAction                                                  */
/* ------------------------------------------------------------------ */

export async function execBrowserAction(
  action: BrowserActionType,
  args: Record<string, unknown>,
  projectId?: string,
  services?: AgentServices,
  runtimeContext?: ToolRuntimeContext,
  workspace?: string,
): Promise<ExecResult> {
  if (!services?.browser) return { content: 'Error: browser service not available', success: false }

  const appId = scopedBrowserAppId(projectId, args.appId ? String(args.appId) : undefined)
  const mergedArgs = appId ? { ...args, appId } : args
  services.logger(`Browser action: ${action} [appId=${appId || 'default'}]`, mergedArgs)
  const result = await services.browser.executeAction({ action, params: mergedArgs }, appId)
  if (result.success) {
    if (action === 'screenshot' && result.data) {
      try {
        const parsed = JSON.parse(result.data)
        const pageInfo = parsed.page ?? {}
        const screenshotDataUrl = parsed.screenshot || parsed.dataUrl

        let screenshotPath = ''
        let cloudUrl: string | undefined
        if (screenshotDataUrl) {
          if (services.mcp) {
            try {
              screenshotPath = await services.mcp.saveScreenshot(screenshotDataUrl, appId || 'default', workspace)
            } catch (err) {
              services.logger('SCREENSHOT_SAVE_FAIL', { error: err instanceof Error ? err.message : String(err) })
            }
          }

          try {
            cloudUrl = await uploadScreenshotToCloud(screenshotDataUrl, services) || undefined
          } catch (err) {
            services.logger('BROWSER_SCREENSHOT_UPLOAD_FAIL', { error: err instanceof Error ? err.message : String(err) })
            // 重试一次
            try {
              cloudUrl = await uploadScreenshotToCloud(screenshotDataUrl, services) || undefined
              services.logger('BROWSER_SCREENSHOT_UPLOAD_RETRY_OK')
            } catch (retryErr) {
              services.logger('BROWSER_SCREENSHOT_UPLOAD_RETRY_FAIL', { error: retryErr instanceof Error ? retryErr.message : String(retryErr) })
            }
          }
        }

        return {
          content: JSON.stringify({
            screenshotPath: screenshotPath || undefined,
            cloudUrl: cloudUrl || undefined,
            title: pageInfo.title,
            url: pageInfo.url,
            viewport: pageInfo.viewport,
            visibleElements: pageInfo.elements ?? [],
            hint: cloudUrl
              ? '截图已上传到云存储。如需分析截图内容，请调用 analyze_image 工具，image 参数传 cloudUrl。'
              : screenshotPath
              ? '截图已保存到本地。如需分析截图内容，请调用 analyze_image 工具。'
              : undefined,
          }, null, 2),
          success: true,
        }
      } catch {
        return { content: result.data ?? '截图成功', success: true }
      }
    }
    return { content: result.data ?? '操作成功', success: true }
  }
  return { content: `浏览器操作失败: ${result.error}`, success: false }
}

/* ------------------------------------------------------------------ */
/*  execBrowserGetConsoleLogs                                          */
/* ------------------------------------------------------------------ */

export async function execBrowserGetConsoleLogs(
  args: Record<string, unknown>,
  projectId?: string,
  services?: AgentServices,
): Promise<ExecResult> {
  if (!services?.browser) return { content: 'Error: browser service not available', success: false }

  const appId = scopedBrowserAppId(projectId, args.appId ? String(args.appId) : undefined) ?? 'default'
  const limit = Number.isFinite(Number(args.limit)) ? Number(args.limit) : undefined
  const onlyErrors = args.onlyErrors === true
  const devOnly = args.devOnly !== false
  const includeCandidates = args.includeCandidates !== false
  const clearAfterRead = args.clearAfterRead !== false
  const levels = Array.isArray(args.levels)
    ? args.levels
      .map((v) => String(v))
      .filter((v): v is 'log' | 'info' | 'warn' | 'error' | 'debug' => ['log', 'info', 'warn', 'error', 'debug'].includes(v))
    : undefined

  const snapshot = services.browser.getConsoleSnapshot({
    appId,
    limit,
    levels,
    onlyErrors,
    devOnly,
    includeCandidates,
    clearAfterRead,
  })

  return { content: JSON.stringify(snapshot, null, 2), success: true }
}

/* ------------------------------------------------------------------ */
/*  execBrowserGetNetworkRequests                                      */
/* ------------------------------------------------------------------ */

export async function execBrowserGetNetworkRequests(
  args: Record<string, unknown>,
  projectId?: string,
  services?: AgentServices,
): Promise<ExecResult> {
  if (!services?.browser) return { content: 'Error: browser service not available', success: false }

  const appId = scopedBrowserAppId(projectId, args.appId ? String(args.appId) : undefined) ?? 'default'
  const limit = Number.isFinite(Number(args.limit)) ? Number(args.limit) : undefined

  const result = await services.browser.getNetworkRequests(appId, limit)
  return { content: JSON.stringify(result, null, 2), success: true }
}

/* ------------------------------------------------------------------ */
/*  execBrowserGetNetworkRequestBody                                   */
/* ------------------------------------------------------------------ */

export async function execBrowserGetNetworkRequestBody(
  args: Record<string, unknown>,
  projectId?: string,
  services?: AgentServices,
): Promise<ExecResult> {
  if (!services?.browser) return { content: 'Error: browser service not available', success: false }

  const appId = scopedBrowserAppId(projectId, args.appId ? String(args.appId) : undefined) ?? 'default'
  const requestId = String(args.requestId ?? '').trim()
  if (!requestId) return { content: 'Error: requestId is required', success: false }

  const result = await services.browser.getNetworkRequestBody(appId, requestId)
  return { content: JSON.stringify(result, null, 2), success: true }
}

/* ------------------------------------------------------------------ */
/*  execBrowserGetCookies                                              */
/* ------------------------------------------------------------------ */

export async function execBrowserGetCookies(
  args: Record<string, unknown>,
  projectId?: string,
  services?: AgentServices,
): Promise<ExecResult> {
  if (!services?.browser) return { content: 'Error: browser service not available', success: false }

  const appId = scopedBrowserAppId(projectId, args.appId ? String(args.appId) : undefined) ?? 'default'
  const urls = Array.isArray(args.urls) ? args.urls.map(String) : undefined

  const result = await services.browser.getCookies(appId, urls)
  return { content: JSON.stringify(result, null, 2), success: true }
}

/* ------------------------------------------------------------------ */
/*  execBrowserSetCookie                                               */
/* ------------------------------------------------------------------ */

export async function execBrowserSetCookie(
  args: Record<string, unknown>,
  projectId?: string,
  services?: AgentServices,
): Promise<ExecResult> {
  if (!services?.browser) return { content: 'Error: browser service not available', success: false }

  const appId = scopedBrowserAppId(projectId, args.appId ? String(args.appId) : undefined) ?? 'default'
  const cookie = {
    name: String(args.name ?? ''),
    value: String(args.value ?? ''),
    url: args.url ? String(args.url) : undefined,
    domain: args.domain ? String(args.domain) : undefined,
    path: args.path ? String(args.path) : undefined,
    secure: args.secure === true,
    httpOnly: args.httpOnly === true,
    sameSite: args.sameSite as any,
    expires: Number.isFinite(Number(args.expires)) ? Number(args.expires) : undefined,
  }

  if (!cookie.name) return { content: 'Error: name is required', success: false }

  const result = await services.browser.setCookie(appId, cookie)
  return { content: JSON.stringify(result, null, 2), success: result.success }
}

/* ------------------------------------------------------------------ */
/*  execBrowserClearCookies                                            */
/* ------------------------------------------------------------------ */

export async function execBrowserClearCookies(
  args: Record<string, unknown>,
  projectId?: string,
  services?: AgentServices,
): Promise<ExecResult> {
  if (!services?.browser) return { content: 'Error: browser service not available', success: false }

  const appId = scopedBrowserAppId(projectId, args.appId ? String(args.appId) : undefined) ?? 'default'

  const result = await services.browser.clearCookies(appId)
  return { content: JSON.stringify(result, null, 2), success: result.success }
}

/* ------------------------------------------------------------------ */
/*  execBrowserOcr                                                     */
/* ------------------------------------------------------------------ */

export async function execBrowserOcr(
  args: Record<string, unknown>,
  projectId?: string,
  services?: AgentServices,
  runtimeContext?: ToolRuntimeContext,
): Promise<ExecResult> {
  if (!services?.browser) return { content: 'Error: browser service not available', success: false }
  if (!services?.computer) return { content: 'Error: OCR service not available', success: false }

  const appId = scopedBrowserAppId(projectId, args.appId ? String(args.appId) : undefined) ?? 'default'

  // 1. 截取浏览器页面
  const screenshotResult = await services.browser.executeAction(
    { action: 'screenshot', params: {} },
    appId,
  )
  if (!screenshotResult.success || !screenshotResult.data) {
    return { content: `截图失败: ${screenshotResult.error ?? 'no data'}`, success: false }
  }

  // 2. 提取 dataUrl
  let dataUrl: string | undefined
  try {
    const parsed = JSON.parse(screenshotResult.data)
    dataUrl = parsed.screenshot || parsed.dataUrl
  } catch {
    dataUrl = screenshotResult.data
  }
  if (!dataUrl) {
    return { content: '截图结果中未找到图片数据', success: false }
  }

  // 3. OCR 识别
  try {
    const ocrResult = await services.computer.ocr(dataUrl)
    return { content: JSON.stringify(ocrResult, null, 2), success: true }
  } catch (err) {
    return {
      content: `OCR 识别失败: ${err instanceof Error ? err.message : String(err)}`,
      success: false,
    }
  }
}
