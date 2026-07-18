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

export function scopedBrowserAppId(projectId?: string): string | undefined {
  const raw = String(projectId ?? '').trim()
  if (!raw) return undefined
  const safe = raw.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 64)
  return safe ? `project-${safe}` : undefined
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

  const appId = args.appId ? String(args.appId) : scopedBrowserAppId(projectId)
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

  const appId = args.appId ? String(args.appId) : (scopedBrowserAppId(projectId) ?? 'default')
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
