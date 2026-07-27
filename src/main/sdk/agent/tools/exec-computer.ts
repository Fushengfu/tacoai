/**
 * 工具执行器 - 电脑使用（computer-use 技能：桌面截图/操作）
 */

import type { AgentServices } from '../services'
import { uploadScreenshotToCloud } from './exec-vision'
import type { ExecResult, ToolRuntimeContext } from './exec-utils'

/* ------------------------------------------------------------------ */
/*  parseBool                                                          */
/* ------------------------------------------------------------------ */

function parseBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'y'
  }
  if (typeof value === 'number') return value !== 0
  return false
}

/* ------------------------------------------------------------------ */
/*  execComputerScreenshot                                              */
/* ------------------------------------------------------------------ */

export async function execComputerScreenshot(
  args: Record<string, unknown>,
  logScope?: string,
  services?: AgentServices,
  runtimeContext?: ToolRuntimeContext,
  workspace?: string,
): Promise<ExecResult> {
  const rawWidth = args.width
  const rawHeight = args.height
  const width = rawWidth === undefined ? undefined : Number(rawWidth)
  const height = rawHeight === undefined ? undefined : Number(rawHeight)
  const displayId = typeof args.displayId === 'string' ? args.displayId : undefined
  const appId = typeof args.appId === 'string' && args.appId.trim() ? args.appId.trim() : 'computer'

  if ((width !== undefined && !Number.isFinite(width)) || (height !== undefined && !Number.isFinite(height))) {
    return { content: 'Error: width/height must be numbers', success: false }
  }
  if ((width !== undefined && width <= 0) || (height !== undefined && height <= 0)) {
    return { content: 'Error: width/height must be positive', success: false }
  }

  if (!services?.computer) return { content: 'Error: computer service not available', success: false }

  // macOS 屏幕录制权限检查
  if (await services.computer.checkScreenRecordingPermission() === 'denied') {
    services.computer.openScreenRecordingSettings()
    return {
      content: 'Error: Screen Recording permission is denied. Please allow Taco AI in System Settings > Privacy & Security > Screen Recording, then restart the app.',
      success: false,
    }
  }

  try {
    const result = await services.computer.captureScreen({
      width: width !== undefined && Number.isFinite(width) ? width : undefined,
      height: height !== undefined && Number.isFinite(height) ? height : undefined,
      displayId,
      appId,
      workspacePath: workspace,
    })

    services.logger('COMPUTER_SCREENSHOT_RESULT', {
      success: true,
      displayId: result.displayId,
      screenshotPath: result.screenshotPath,
      width: result.width,
      height: result.height,
      displayWidth: result.displayWidth,
      displayHeight: result.displayHeight,
      displayBoundsX: result.displayBoundsX,
      displayBoundsY: result.displayBoundsY,
      displayScaleFactor: result.displayScaleFactor,
      dataUrlLength: typeof result.dataUrl === 'string' ? result.dataUrl.length : 0,
    }, logScope)

    // 上传截图到云存储，以便手机端可以预览
    let cloudUrl: string | undefined
    if (services) {
      try {
        cloudUrl = await uploadScreenshotToCloud(result.dataUrl, services) || undefined
      } catch (err) {
        services.logger('COMPUTER_SCREENSHOT_UPLOAD_FAIL', { error: err instanceof Error ? err.message : String(err) })
        // 重试一次
        try {
          cloudUrl = await uploadScreenshotToCloud(result.dataUrl, services) || undefined
          services.logger('COMPUTER_SCREENSHOT_UPLOAD_RETRY_OK')
        } catch (retryErr) {
          services.logger('COMPUTER_SCREENSHOT_UPLOAD_RETRY_FAIL', { error: retryErr instanceof Error ? retryErr.message : String(retryErr) })
        }
      }
    }

    return {
      success: true,
      content: JSON.stringify({
        displayId: result.displayId,
        screenshotPath: result.screenshotPath,
        cloudUrl: cloudUrl || undefined,
        width: result.width,
        height: result.height,
        displayWidth: result.displayWidth,
        displayHeight: result.displayHeight,
        displayBoundsX: result.displayBoundsX,
        displayBoundsY: result.displayBoundsY,
        displayScaleFactor: result.displayScaleFactor,
        hint: cloudUrl
          ? '截图已上传到云存储。如需分析截图内容，请调用 analyze_image 工具，image 参数传 cloudUrl。'
          : '截图已保存到本地。如需分析截图内容，请调用 analyze_image 工具，image 参数传 data URL。',
      }),
    }
  } catch (err) {
    return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, success: false }
  }
}

/* ------------------------------------------------------------------ */
/*  execComputerAction                                                  */
/* ------------------------------------------------------------------ */

export async function execComputerAction(
  args: Record<string, unknown>,
  signal?: AbortSignal,
  logScope?: string,
  services?: AgentServices,
): Promise<ExecResult> {
  const rawAction = String(args.action ?? '').trim()
  if (!rawAction) return { content: 'Error: action is required', success: false }

  const ACTION_ALIASES: Record<string, { action: string; impliedClicks?: number }> = {
    INPUT: { action: 'type' },
    TYPE_TEXT: { action: 'type' },
    TYPE: { action: 'type' },
    KEY_PRESS: { action: 'key' },
    KEYPRESS: { action: 'key' },
    PRESS: { action: 'key' },
    DOUBLE_CLICK: { action: 'click', impliedClicks: 2 },
    RIGHT_CLICK: { action: 'click' },
    SCROLL_UP: { action: 'scroll' },
    SCROLL_DOWN: { action: 'scroll' },
    SCROLL_LEFT: { action: 'scroll' },
    SCROLL_RIGHT: { action: 'scroll' },
  }
  const normalizedAlias = ACTION_ALIASES[rawAction.toUpperCase()]
    ?? (['move', 'click', 'mouse_down', 'drag', 'scroll', 'type', 'key'].includes(rawAction.toLowerCase())
      ? { action: rawAction.toLowerCase() }
      : null)
  if (!normalizedAlias) {
    return {
      content: `Error: unsupported action "${rawAction}". Supported actions: move/click/mouse_down/drag/scroll/type/key`,
      success: false,
    }
  }
  const action = normalizedAlias.action

  let dx = Number.isFinite(Number(args.dx)) ? Number(args.dx) : undefined
  let dy = Number.isFinite(Number(args.dy)) ? Number(args.dy) : undefined
  const direction = typeof args.direction === 'string' ? args.direction.toLowerCase() : ''
  if (action === 'scroll' && (dx === undefined || dy === undefined) && direction) {
    const rawAmount = args.amount
    let amount = 240
    if (typeof rawAmount === 'number' && Number.isFinite(rawAmount)) amount = rawAmount
    if (typeof rawAmount === 'string') {
      const lower = rawAmount.toLowerCase()
      if (lower === 'small') amount = 160
      else if (lower === 'medium') amount = 320
      else if (lower === 'large') amount = 520
      else if (Number.isFinite(Number(lower))) amount = Number(lower)
    }
    switch (direction) {
      case 'up': dy = -amount; dx = 0; break
      case 'down': dy = amount; dx = 0; break
      case 'left': dx = -amount; dy = 0; break
      case 'right': dx = amount; dy = 0; break
    }
  }

  const rawKey = typeof args.key === 'string' ? args.key.trim() : ''
  let parsedKey: { key?: string; modifiers?: Array<'cmd' | 'ctrl' | 'alt' | 'shift'> } = { key: rawKey || undefined }
  if (rawKey && rawKey.includes('+')) {
    const parts = rawKey.split('+').map(p => p.trim().toLowerCase())
    const keyPart = parts.pop()
    const mods: Array<'cmd' | 'ctrl' | 'alt' | 'shift'> = []
    for (const p of parts) {
      if (p === 'cmd' || p === 'command' || p === 'meta' || p === 'super' || p === 'win') mods.push('cmd')
      else if (p === 'ctrl' || p === 'control') mods.push('ctrl')
      else if (p === 'alt' || p === 'option') mods.push('alt')
      else if (p === 'shift') mods.push('shift')
    }
    parsedKey = { key: keyPart, modifiers: mods.length > 0 ? mods : undefined }
  }

  const explicitModifiers = Array.isArray(args.modifiers)
    ? (args.modifiers as string[]).filter((m): m is 'cmd' | 'ctrl' | 'alt' | 'shift' =>
        ['cmd', 'command', 'meta', 'super', 'win', 'ctrl', 'control', 'alt', 'option', 'shift'].includes(String(m).toLowerCase()))
      .map((m) => {
        const lower = String(m).toLowerCase()
        if (['cmd', 'command', 'meta', 'super', 'win'].includes(lower)) return 'cmd' as const
        if (['ctrl', 'control'].includes(lower)) return 'ctrl' as const
        if (['alt', 'option'].includes(lower)) return 'alt' as const
        return 'shift' as const
      })
    : undefined

  const mergedModifiersSet = new Set<'cmd' | 'ctrl' | 'alt' | 'shift'>([
    ...(parsedKey.modifiers ?? []),
    ...(explicitModifiers ?? []),
  ])

  let clicks: number | undefined = undefined
  const double = Boolean(args.double)
  if (double) clicks = 2
  if (Number.isFinite(Number(args.clicks))) clicks = Number(args.clicks)
  if (Number.isFinite(Number(args.clickCount))) clicks = Number(args.clickCount)
  if (clicks === undefined && normalizedAlias.impliedClicks !== undefined) clicks = normalizedAlias.impliedClicks

  const textCandidates = [args.text, args.input, args.value, args.content, args.message]
  const text = textCandidates.find((t): t is string => typeof t === 'string' && t.trim().length > 0) ?? undefined

  const pickNumberArg = (keys: string[]): number | undefined => {
    for (const key of keys) {
      const n = Number(args[key])
      if (Number.isFinite(n)) return n
    }
    return undefined
  }

  const payload = {
    action: action as 'move' | 'click' | 'mouse_down' | 'drag' | 'scroll' | 'type' | 'key',
    x: pickNumberArg(['x', 'fromX', 'startX', 'from_x', 'start_x']),
    y: pickNumberArg(['y', 'fromY', 'startY', 'from_y', 'start_y']),
    toX: pickNumberArg(['toX', 'endX', 'targetX', 'to_x', 'end_x', 'target_x', 'x2']),
    toY: pickNumberArg(['toY', 'endY', 'targetY', 'to_y', 'end_y', 'target_y', 'y2']),
    steps: Number.isFinite(Number(args.steps)) ? Math.max(2, Math.round(Number(args.steps))) : undefined,
    duration_ms: Number.isFinite(Number(args.duration_ms))
      ? Math.max(40, Math.round(Number(args.duration_ms)))
      : (Number.isFinite(Number(args.durationMs)) ? Math.max(40, Math.round(Number(args.durationMs))) : undefined),
    release: (Object.prototype.hasOwnProperty.call(args, 'release') || Object.prototype.hasOwnProperty.call(args, 'keepDown'))
      ? !parseBool(args.keepDown) && parseBool(args.release ?? true)
      : undefined,
    button: typeof args.button === 'string' ? (args.button as 'left' | 'right' | 'middle') : undefined,
    clicks,
    dx,
    dy,
    text,
    key: parsedKey.key ?? (typeof args.key === 'string' ? args.key.trim() : undefined),
    modifiers: mergedModifiersSet.size > 0 ? [...mergedModifiersSet] : undefined,
    delay_ms: Number.isFinite(Number(args.delay_ms)) ? Number(args.delay_ms) : undefined,
  }

  if (!services?.computer) return { content: 'Error: computer service not available', success: false }

  services.logger('COMPUTER_ACTION_REQUEST', {
    action: payload.action,
    x: payload.x,
    y: payload.y,
    toX: payload.toX,
    toY: payload.toY,
    steps: payload.steps,
    duration_ms: payload.duration_ms,
    release: payload.release,
    button: payload.button,
    clicks: payload.clicks,
    dx: payload.dx,
    dy: payload.dy,
    key: payload.key,
    textLength: payload.text ? payload.text.length : 0,
  }, logScope)

  const result = await services.computer.call(payload, signal)
  services.logger('COMPUTER_ACTION_RESULT', {
    ok: result.ok,
    error: result.error,
    message: result.message,
    cursorBefore: result.cursorBefore ?? null,
    cursorAfter: result.cursorAfter ?? null,
    target: (Number.isFinite(payload.x) && Number.isFinite(payload.y))
      ? { x: Number(payload.x), y: Number(payload.y) }
      : null,
    targetOffsetAfter: (
      Number.isFinite(payload.x) &&
      Number.isFinite(payload.y) &&
      result.cursorAfter &&
      Number.isFinite(result.cursorAfter.x) &&
      Number.isFinite(result.cursorAfter.y)
    ) ? {
      dx: Number(result.cursorAfter.x) - Number(payload.x),
      dy: Number(result.cursorAfter.y) - Number(payload.y),
    } : null,
  }, logScope)

  if (!result.ok) {
    return { content: `Error: ${result.error ?? 'computer action failed'}`, success: false }
  }

  const needsEnter = Boolean(args.needs_enter)
  if (action === 'type' && needsEnter && services.computer) {
    const enterResult = await services.computer.call({ action: 'key', key: 'enter' }, signal)
    if (!enterResult.ok) {
      return { content: `Error: ${enterResult.error ?? 'enter key failed'}`, success: false }
    }
    return { content: JSON.stringify({ ...result, followUp: enterResult }), success: true }
  }

  return { content: JSON.stringify(result), success: true }
}

/* ------------------------------------------------------------------ */
/*  execComputerOcr                                                    */
/* ------------------------------------------------------------------ */

export async function execComputerOcr(
  args: Record<string, unknown>,
  services?: AgentServices,
): Promise<ExecResult> {
  if (!services?.computer) return { content: 'Error: computer service not available', success: false }

  try {
    const image = typeof args.image === 'string' && args.image.trim() ? args.image.trim() : undefined
    const result = await services.computer.ocr(image)
    return {
      content: JSON.stringify(result, null, 2),
      success: true,
    }
  } catch (err) {
    return {
      content: `Error: OCR 识别失败: ${err instanceof Error ? err.message : String(err)}`,
      success: false,
    }
  }
}
