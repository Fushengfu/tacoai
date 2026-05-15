/**
 * GUI-Plus 坐标映射与桌面操作辅助工具
 *
 * 包含 GUI-Plus 坐标提取、映射、桌面操作规范化等。
 */

import { nativeImage } from 'electron'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type GuiPlusPoint = { x: number; y: number; source: 'xy' | 'x_array' | 'point' | 'xyxy_center' }

export type GuiPlusMappedPoint = {
  action: unknown
  x: number
  y: number
  coordinateSpace: 'screen-absolute' | 'image-local'
  localX: number
  localY: number
  originalWidth: number
  originalHeight: number
  scaledWidth: number
  scaledHeight: number
  minPixels: number
  maxPixels: number
  factor: number
  displayId?: string
  displayBoundsX?: number
  displayBoundsY?: number
  displayWidth?: number
  displayHeight?: number
  displayScaleFactor?: number
}

type GuiPlusClickCandidate = {
  imagePath: string
  x: number
  y: number
  timestamp: number
}

export type GuiPlusClickGuard = {
  x: number
  y: number
  unstable: boolean
  reason?: string
  imagePath?: string
  timestamp: number
}

export const lastGuiPlusClickByImagePath = new Map<string, GuiPlusClickCandidate>()
export const pendingGuiPlusClickGuardByScope = new Map<string, GuiPlusClickGuard>()

type DesktopScreenshotMeta = {
  screenshotPath: string
  screenshotWidth: number
  screenshotHeight: number
  displayId: string
  displayWidth: number
  displayHeight: number
  displayBoundsX: number
  displayBoundsY: number
  displayScaleFactor: number
}

export const desktopScreenshotMetaByPath = new Map<string, DesktopScreenshotMeta>()

/* ------------------------------------------------------------------ */
/*  GUI-Plus coordinate extraction                                     */
/* ------------------------------------------------------------------ */

function asNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => Number(item))
    .filter((num) => Number.isFinite(num))
}

export function extractGuiPlusPoint(parameters: Record<string, unknown>): GuiPlusPoint | null {
  const x = parameters.x
  const y = parameters.y
  if (typeof x === 'number' && typeof y === 'number') {
    return { x, y, source: 'xy' }
  }

  const xArray = asNumberArray(x)
  if (xArray.length >= 4) {
    return {
      x: (xArray[0] + xArray[2]) / 2,
      y: (xArray[1] + xArray[3]) / 2,
      source: 'xyxy_center',
    }
  }
  if (xArray.length >= 2) {
    return { x: xArray[0], y: xArray[1], source: 'x_array' }
  }

  const pointCandidate = (
    (parameters.point && typeof parameters.point === 'object' ? parameters.point : null) ??
    (parameters.position && typeof parameters.position === 'object' ? parameters.position : null) ??
    (parameters.coordinate && typeof parameters.coordinate === 'object' ? parameters.coordinate : null)
  ) as Record<string, unknown> | null

  if (pointCandidate) {
    const px = Number(pointCandidate.x)
    const py = Number(pointCandidate.y)
    if (Number.isFinite(px) && Number.isFinite(py)) {
      return { x: px, y: py, source: 'point' }
    }
  }

  return null
}

export function compactGuiPlusParsed(parsed: unknown): Record<string, unknown> | null {
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as { action?: unknown; thought?: unknown; parameters?: unknown }
  const out: Record<string, unknown> = {}

  if (typeof obj.action === 'string') out.action = obj.action.toUpperCase()
  if (typeof obj.thought === 'string' && obj.thought.trim()) {
    const thought = obj.thought.trim()
    out.thought = thought.length > 160 ? `${thought.slice(0, 160)}...` : thought
  }

  if (obj.parameters && typeof obj.parameters === 'object') {
    const p = obj.parameters as Record<string, unknown>
    const keepKeys = ['x', 'y', 'text', 'needs_enter', 'direction', 'amount', 'key', 'description', 'message', 'reason']
    const compactParams: Record<string, unknown> = {}
    for (const key of keepKeys) {
      if (p[key] !== undefined) compactParams[key] = p[key]
    }
    if (Object.keys(compactParams).length > 0) out.parameters = compactParams
  }

  return Object.keys(out).length > 0 ? out : null
}

export function compactGuiPlusMapped(mapped: GuiPlusMappedPoint | null): Record<string, unknown> | null {
  if (!mapped) return null
  return {
    action: mapped.action ?? null,
    x: mapped.x,
    y: mapped.y,
    coordinateSpace: mapped.coordinateSpace,
    localX: mapped.localX,
    localY: mapped.localY,
    ...(mapped.displayId ? { displayId: mapped.displayId } : {}),
    ...(mapped.displayBoundsX !== undefined ? { displayBoundsX: mapped.displayBoundsX } : {}),
    ...(mapped.displayBoundsY !== undefined ? { displayBoundsY: mapped.displayBoundsY } : {}),
  }
}

function getImageSize(dataUrl: string, imagePath?: string): { width: number; height: number } | null {
  if (dataUrl) {
    try {
      const img = nativeImage.createFromDataURL(dataUrl)
      const size = img.getSize()
      if (size.width > 0 && size.height > 0) return { width: size.width, height: size.height }
    } catch {
      // ignore
    }
  }
  if (imagePath) {
    try {
      const img = nativeImage.createFromPath(imagePath)
      const size = img.getSize()
      if (size.width > 0 && size.height > 0) return { width: size.width, height: size.height }
    } catch {
      // ignore
    }
  }
  return null
}

function computeScaledSize(
  width: number,
  height: number,
  minPixels?: number,
  maxPixels?: number,
  highResolution?: boolean,
  factor = 28,
) {
  const minPx = minPixels ?? (4 * 28 * 28)
  const maxPx = highResolution ? (16384 * 28 * 28) : (maxPixels ?? 1003520)

  let hBar = Math.round(height / factor) * factor
  let wBar = Math.round(width / factor) * factor

  if (hBar * wBar > maxPx) {
    const beta = Math.sqrt((height * width) / maxPx)
    hBar = Math.floor(height / beta / factor) * factor
    wBar = Math.floor(width / beta / factor) * factor
  } else if (hBar * wBar < minPx) {
    const beta = Math.sqrt(minPx / (height * width))
    hBar = Math.ceil(height * beta / factor) * factor
    wBar = Math.ceil(width * beta / factor) * factor
  }

  return { width: wBar, height: hBar, minPixels: minPx, maxPixels: maxPx, factor }
}

export function mapGuiPlusCoordinates(
  parsed: unknown,
  dataUrl: string,
  imagePath: string,
  options: { minPixels?: number; maxPixels?: number; highResolution?: boolean },
): GuiPlusMappedPoint | null {
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as { action?: string; parameters?: Record<string, unknown> }
  const params = obj.parameters ?? {}
  const point = extractGuiPlusPoint(params)
  if (!point) return null

  const size = getImageSize(dataUrl, imagePath)
  if (!size) return null

  const scaled = computeScaledSize(size.width, size.height, options.minPixels, options.maxPixels, options.highResolution)
  if (scaled.width <= 0 || scaled.height <= 0) return null

  const clampedX = Math.max(0, Math.min(point.x, Math.max(0, scaled.width - 1)))
  const clampedY = Math.max(0, Math.min(point.y, Math.max(0, scaled.height - 1)))
  const mappedX = Math.max(0, Math.min(size.width - 1, Math.floor((clampedX / Math.max(1, scaled.width)) * size.width)))
  const mappedY = Math.max(0, Math.min(size.height - 1, Math.floor((clampedY / Math.max(1, scaled.height)) * size.height)))

  const meta = imagePath ? desktopScreenshotMetaByPath.get(imagePath) : undefined
  let absoluteX = mappedX
  let absoluteY = mappedY
  if (meta && meta.screenshotWidth > 0 && meta.screenshotHeight > 0 && meta.displayWidth > 0 && meta.displayHeight > 0) {
    const screenshotXSpan = Math.max(1, meta.screenshotWidth - 1)
    const screenshotYSpan = Math.max(1, meta.screenshotHeight - 1)
    const displayXSpan = Math.max(0, meta.displayWidth - 1)
    const displayYSpan = Math.max(0, meta.displayHeight - 1)
    const rx = mappedX / screenshotXSpan
    const ry = mappedY / screenshotYSpan
    absoluteX = Math.round(meta.displayBoundsX + rx * displayXSpan)
    absoluteY = Math.round(meta.displayBoundsY + ry * displayYSpan)
    absoluteX = Math.max(meta.displayBoundsX, Math.min(meta.displayBoundsX + displayXSpan, absoluteX))
    absoluteY = Math.max(meta.displayBoundsY, Math.min(meta.displayBoundsY + displayYSpan, absoluteY))
  }

  return {
    action: obj.action ?? null,
    x: absoluteX,
    y: absoluteY,
    coordinateSpace: meta ? 'screen-absolute' : 'image-local',
    localX: mappedX,
    localY: mappedY,
    originalWidth: size.width,
    originalHeight: size.height,
    scaledWidth: scaled.width,
    scaledHeight: scaled.height,
    minPixels: scaled.minPixels,
    maxPixels: scaled.maxPixels,
    factor: scaled.factor,
    ...(meta ? {
      displayId: meta.displayId,
      displayBoundsX: meta.displayBoundsX,
      displayBoundsY: meta.displayBoundsY,
      displayWidth: meta.displayWidth,
      displayHeight: meta.displayHeight,
      displayScaleFactor: meta.displayScaleFactor,
    } : {}),
  }
}

/* ------------------------------------------------------------------ */
/*  Desktop action helpers                                             */
/* ------------------------------------------------------------------ */

export function normalizeDesktopAction(action: string): { action: 'move' | 'click' | 'mouse_down' | 'drag' | 'scroll' | 'type' | 'key'; impliedClicks?: number } | null {
  const normalized = action.trim().toUpperCase().replace(/[\s-]+/g, '_')
  const map: Record<string, { action: 'move' | 'click' | 'mouse_down' | 'drag' | 'scroll' | 'type' | 'key'; impliedClicks?: number }> = {
    MOVE: { action: 'move' },
    HOVER: { action: 'move' },
    CLICK: { action: 'click' },
    TAP: { action: 'click' },
    DOUBLE_CLICK: { action: 'click', impliedClicks: 2 },
    DOUBLECLICK: { action: 'click', impliedClicks: 2 },
    DBLCLICK: { action: 'click', impliedClicks: 2 },
    DOUBLE_TAP: { action: 'click', impliedClicks: 2 },
    MOUSE_DOWN: { action: 'mouse_down' },
    MOUSEDOWN: { action: 'mouse_down' },
    PRESS: { action: 'mouse_down' },
    PRESS_DOWN: { action: 'mouse_down' },
    DRAG: { action: 'drag' },
    DRAG_TO: { action: 'drag' },
    DRAG_SLIDER: { action: 'drag' },
    SCROLL: { action: 'scroll' },
    TYPE: { action: 'type' },
    INPUT: { action: 'type' },
    TEXT: { action: 'type' },
    TYPE_TEXT: { action: 'type' },
    INPUT_TEXT: { action: 'type' },
    KEY: { action: 'key' },
    KEY_PRESS: { action: 'key' },
    PRESS_KEY: { action: 'key' },
    HOTKEY: { action: 'key' },
    KEYBOARD_INPUT: { action: 'key' },
    KEYBOARD: { action: 'key' },
  }
  return map[normalized] ?? null
}

export function parseDesktopKeyCombo(raw: string): {
  key?: string
  modifiers?: Array<'cmd' | 'ctrl' | 'alt' | 'shift'>
} {
  const text = raw.trim()
  if (!text) return {}

  const tokens = text
    .replace(/[＋]/g, '+')
    .split(/[+\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)

  if (tokens.length === 0) return {}

  const mods: Array<'cmd' | 'ctrl' | 'alt' | 'shift'> = []
  const keys: string[] = []
  for (const token of tokens) {
    const mod = normalizeDesktopModifier(token)
    if (mod) mods.push(mod)
    else keys.push(token)
  }

  const key = keys.length > 0 ? keys[keys.length - 1] : (mods.length === tokens.length ? undefined : tokens[tokens.length - 1])
  return {
    ...(key ? { key } : {}),
    ...(mods.length > 0 ? { modifiers: [...new Set(mods)] } : {}),
  }
}

function normalizeDesktopModifier(mod: string): 'cmd' | 'ctrl' | 'alt' | 'shift' | null {
  const m = mod.trim().toLowerCase()
  if (m === 'cmd' || m === 'command' || m === 'meta' || m === 'win' || m === 'windows' || m === 'super') return 'cmd'
  if (m === 'ctrl' || m === 'control' || m === 'ctl') return 'ctrl'
  if (m === 'alt' || m === 'option' || m === 'opt') return 'alt'
  if (m === 'shift') return 'shift'
  return null
}

export function normalizeDesktopModifiers(raw: unknown): Array<'cmd' | 'ctrl' | 'alt' | 'shift'> | undefined {
  if (!Array.isArray(raw)) return undefined
  const set = new Set<'cmd' | 'ctrl' | 'alt' | 'shift'>()
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const normalized = normalizeDesktopModifier(item)
    if (normalized) set.add(normalized)
  }
  return set.size > 0 ? [...set] : undefined
}

export function resolveDesktopClicks(
  args: Record<string, unknown>,
  action: 'move' | 'click' | 'mouse_down' | 'drag' | 'scroll' | 'type' | 'key',
  impliedClicks?: number,
): number | undefined {
  if (action !== 'click') return undefined
  const clicksRaw = Number(args.clicks)
  const clickCountRaw = Number(args.clickCount)
  const clicks = Number.isFinite(clicksRaw) ? Math.max(1, Math.round(clicksRaw)) : undefined
  const clickCount = Number.isFinite(clickCountRaw) ? Math.max(1, Math.round(clickCountRaw)) : undefined
  const isDouble =
    parseBool(args.double) ||
    parseBool(args.double_click) ||
    parseBool(args.dblclick)
  if (isDouble) return 2
  return clicks ?? clickCount ?? impliedClicks
}

export function pickDesktopInputText(args: Record<string, unknown>): string | undefined {
  const candidates = [args.text, args.input, args.value, args.content, args.message]
  for (const item of candidates) {
    if (typeof item !== 'string') continue
    if (!item.trim()) continue
    return item
  }
  return undefined
}

function parseBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'y'
  }
  if (typeof value === 'number') return value !== 0
  return false
}

export function getGuiPlusScopeKey(logScope?: string): string {
  const key = (logScope ?? '').trim()
  return key || '__global__'
}
