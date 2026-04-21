import { createRequire } from 'node:module'

type DesktopAction = 'move' | 'click' | 'mouse_down' | 'drag' | 'scroll' | 'type' | 'key'
type DesktopCursor = { x: number; y: number } | null

type NutPoint = unknown

type NutModule = {
  mouse: {
    setPosition: (point: NutPoint) => Promise<void>
    getPosition?: () => Promise<unknown>
    click: (button?: unknown) => Promise<void>
    pressButton?: (button?: unknown) => Promise<void>
    releaseButton?: (button?: unknown) => Promise<void>
    press?: (button?: unknown) => Promise<void>
    release?: (button?: unknown) => Promise<void>
    buttonDown?: (button?: unknown) => Promise<void>
    buttonUp?: (button?: unknown) => Promise<void>
    scrollDown: (amount?: number) => Promise<void>
    scrollUp: (amount?: number) => Promise<void>
    scrollLeft: (amount?: number) => Promise<void>
    scrollRight: (amount?: number) => Promise<void>
  }
  keyboard: {
    type: (text: string) => Promise<void>
    pressKey: (...keys: unknown[]) => Promise<void>
    releaseKey: (...keys: unknown[]) => Promise<void>
  }
  Point: new (x: number, y: number) => NutPoint
  Button: Record<string, unknown>
  Key: Record<string, unknown>
}

export type DesktopActionRequest = {
  action: DesktopAction
  x?: number
  y?: number
  toX?: number
  toY?: number
  button?: 'left' | 'right' | 'middle'
  clicks?: number
  steps?: number
  duration_ms?: number
  release?: boolean
  dx?: number
  dy?: number
  text?: string
  key?: string
  modifiers?: Array<'cmd' | 'ctrl' | 'alt' | 'shift'>
  delay_ms?: number
}

type DesktopActionResponse = {
  ok: boolean
  message?: string
  error?: string
  cursorBefore?: DesktopCursor
  cursorAfter?: DesktopCursor
}

let nutModule: NutModule | null = null
let loadingNut: Promise<NutModule> | null = null
let lastMousePos: { x: number; y: number } | null = null
let lastDesktopClickAt = 0
let activeMouseButton: DesktopActionRequest['button'] | null = null
const runtimeRequire = createRequire(__filename)

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    const err = new Error('Aborted')
    err.name = 'AbortError'
    throw err
  }
}

async function loadNutJs(): Promise<NutModule> {
  if (nutModule) return nutModule
  if (loadingNut) return loadingNut

  loadingNut = (async () => {
    const preferred = process.env.TACO_DESKTOP_LIB?.trim()
    const candidates = [
      preferred,
      '@nut-tree-fork/nut-js',
    ].filter((x): x is string => Boolean(x))

    let lastErr: unknown
    for (const name of candidates) {
      try {
        const loaded = runtimeRequire(name) as NutModule | { default?: NutModule }
        const mod = (loaded as { default?: NutModule }).default ?? (loaded as NutModule)
        nutModule = mod
        return mod
      } catch (err) {
        lastErr = err
      }
    }

    const reason = lastErr instanceof Error ? lastErr.message : String(lastErr)
    throw new Error(
      `desktop library not available. Install: @nut-tree-fork/nut-js. (${reason})`
    )
  })().finally(() => {
    loadingNut = null
  })

  return loadingNut
}

function mapButton(btn: DesktopActionRequest['button'], Button: Record<string, unknown>): unknown {
  const key = (btn ?? 'left').toLowerCase()
  if (key === 'right') return Button.RIGHT ?? Button.Right ?? Button.right
  if (key === 'middle') return Button.MIDDLE ?? Button.Middle ?? Button.middle
  return Button.LEFT ?? Button.Left ?? Button.left
}

function mapModifierKeys(modifiers: DesktopActionRequest['modifiers'], Key: Record<string, unknown>): unknown[] {
  const modSet = new Set((modifiers ?? []).map((m) => m.toLowerCase()))
  const result: unknown[] = []
  if (modSet.has('cmd')) result.push(Key.LeftCmd ?? Key.Cmd ?? Key.Command)
  if (modSet.has('ctrl')) result.push(Key.LeftControl ?? Key.Control ?? Key.Ctrl)
  if (modSet.has('alt')) result.push(Key.LeftAlt ?? Key.Alt ?? Key.Option)
  if (modSet.has('shift')) result.push(Key.LeftShift ?? Key.Shift)
  return result.filter(Boolean)
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[\s_-]+/g, '')
}

function mapKey(key: string, Key: Record<string, unknown>): unknown {
  const k = normalizeKey(key)
  const directMap: Record<string, string[]> = {
    enter: ['Return', 'Enter'],
    return: ['Return', 'Enter'],
    tab: ['Tab'],
    esc: ['Escape', 'Esc'],
    escape: ['Escape', 'Esc'],
    backspace: ['Backspace'],
    delete: ['Delete', 'Backspace'],
    forwarddelete: ['Delete'],
    space: ['Space'],
    left: ['Left'],
    right: ['Right'],
    up: ['Up'],
    down: ['Down'],
    home: ['Home'],
    end: ['End'],
    pageup: ['PageUp'],
    pagedown: ['PageDown'],
  }

  const fKeyMatch = /^f(\d{1,2})$/.exec(k)
  if (fKeyMatch) {
    const n = Number(fKeyMatch[1])
    if (Number.isFinite(n) && n >= 1 && n <= 24) {
      const fName = `F${n}`
      if (Key[fName] !== undefined) return Key[fName]
      if (Key[`Function${n}`] !== undefined) return Key[`Function${n}`]
    }
  }

  const aliases = directMap[k]
  if (aliases) {
    for (const name of aliases) {
      if (Key[name] !== undefined) return Key[name]
    }
  }

  if (k.length === 1) {
    const upper = k.toUpperCase()
    if (Key[upper] !== undefined) return Key[upper]
  }

  return undefined
}

function wheelAmount(value: number | undefined): number {
  const raw = Number(value ?? 0)
  if (!Number.isFinite(raw)) return 0
  const px = Math.abs(raw)
  if (px === 0) return 0
  return Math.max(1, Math.round(px / 120))
}

function parseMousePos(value: unknown): { x: number; y: number } | null {
  if (!value || typeof value !== 'object') return null
  const obj = value as Record<string, unknown>
  const x = Number(obj.x)
  const y = Number(obj.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x: Math.round(x), y: Math.round(y) }
}

async function getCurrentMousePos(mouse: NutModule['mouse']): Promise<{ x: number; y: number } | null> {
  if (typeof mouse.getPosition === 'function') {
    try {
      const current = await mouse.getPosition()
      const parsed = parseMousePos(current)
      if (parsed) return parsed
    } catch {
      // ignore and fallback
    }
  }
  return lastMousePos
}

async function smoothSetPosition(
  mouse: NutModule['mouse'],
  Point: NutModule['Point'],
  targetX: number,
  targetY: number,
  options?: { steps?: number; durationMs?: number },
  signal?: AbortSignal,
): Promise<void> {
  const x2 = Math.round(targetX)
  const y2 = Math.round(targetY)
  const start = await getCurrentMousePos(mouse)

  if (!start) {
    await mouse.setPosition(new Point(x2, y2))
    lastMousePos = { x: x2, y: y2 }
    return
  }

  const distance = Math.hypot(x2 - start.x, y2 - start.y)
  if (distance < 2) {
    await mouse.setPosition(new Point(x2, y2))
    lastMousePos = { x: x2, y: y2 }
    return
  }

  const autoSteps = Math.max(4, Math.min(30, Math.round(distance / 60)))
  const autoTotalMs = Math.max(80, Math.min(260, Math.round(distance * 0.7)))
  const steps = Math.max(2, Math.min(120, Math.round(options?.steps ?? autoSteps)))
  const totalMs = Math.max(20, Math.min(5000, Math.round(options?.durationMs ?? autoTotalMs)))
  const delayMs = Math.max(4, Math.floor(totalMs / steps))

  for (let i = 1; i <= steps; i++) {
    throwIfAborted(signal)
    const t = i / steps
    const eased = 1 - Math.pow(1 - t, 3)
    const x = Math.round(start.x + (x2 - start.x) * eased)
    const y = Math.round(start.y + (y2 - start.y) * eased)
    await mouse.setPosition(new Point(x, y))
    if (i < steps) await sleep(delayMs)
  }

  lastMousePos = { x: x2, y: y2 }
}

function resolveMouseDownApi(mouse: NutModule['mouse']): ((button?: unknown) => Promise<void>) | null {
  if (typeof mouse.pressButton === 'function') return mouse.pressButton.bind(mouse)
  if (typeof mouse.press === 'function') return mouse.press.bind(mouse)
  if (typeof mouse.buttonDown === 'function') return mouse.buttonDown.bind(mouse)
  return null
}

function resolveMouseUpApi(mouse: NutModule['mouse']): ((button?: unknown) => Promise<void>) | null {
  if (typeof mouse.releaseButton === 'function') return mouse.releaseButton.bind(mouse)
  if (typeof mouse.release === 'function') return mouse.release.bind(mouse)
  if (typeof mouse.buttonUp === 'function') return mouse.buttonUp.bind(mouse)
  return null
}

export async function callDesktopService(payload: DesktopActionRequest, signal?: AbortSignal): Promise<DesktopActionResponse> {
  let cursorBefore: DesktopCursor = null
  try {
    throwIfAborted(signal)

    const nut = await loadNutJs()
    const { mouse, keyboard, Point, Button, Key } = nut

    if (payload.delay_ms && payload.delay_ms > 0) {
      await sleep(payload.delay_ms)
      throwIfAborted(signal)
    }
    cursorBefore = await getCurrentMousePos(mouse)

    switch (payload.action) {
      case 'move': {
        if (!Number.isFinite(payload.x) || !Number.isFinite(payload.y)) {
          return { ok: false, error: 'x and y are required for move action', cursorBefore }
        }
        await smoothSetPosition(mouse, Point, Number(payload.x), Number(payload.y), undefined, signal)
        const cursorAfter = await getCurrentMousePos(mouse)
        return { ok: true, message: 'mouse moved', cursorBefore, cursorAfter }
      }

      case 'click': {
        if (Number.isFinite(payload.x) && Number.isFinite(payload.y)) {
          await smoothSetPosition(mouse, Point, Number(payload.x), Number(payload.y), undefined, signal)
        }
        const button = mapButton(payload.button, Button)
        const clicks = Math.max(1, Number(payload.clicks ?? 1))
        for (let i = 0; i < clicks; i++) {
          throwIfAborted(signal)
          await mouse.click(button)
          // 双击/多击时保留短间隔，提升系统识别率
          if (i < clicks - 1) await sleep(40)
        }
        lastDesktopClickAt = Date.now()
        const cursorAfter = await getCurrentMousePos(mouse)
        return { ok: true, message: 'mouse clicked', cursorBefore, cursorAfter }
      }

      case 'mouse_down': {
        if (Number.isFinite(payload.x) && Number.isFinite(payload.y)) {
          await smoothSetPosition(mouse, Point, Number(payload.x), Number(payload.y), undefined, signal)
        }
        const mouseDown = resolveMouseDownApi(mouse)
        if (!mouseDown) {
          return { ok: false, error: 'desktop library does not support mouse down API', cursorBefore }
        }
        const button = mapButton(payload.button, Button)
        await mouseDown(button)
        activeMouseButton = payload.button ?? 'left'
        const cursorAfter = await getCurrentMousePos(mouse)
        return { ok: true, message: 'mouse down', cursorBefore, cursorAfter }
      }

      case 'drag': {
        const releaseAfter = payload.release !== false
        const buttonName = payload.button ?? activeMouseButton ?? 'left'
        const button = mapButton(buttonName, Button)
        const mouseDown = resolveMouseDownApi(mouse)
        const mouseUp = resolveMouseUpApi(mouse)
        if (!mouseDown || !mouseUp) {
          return { ok: false, error: 'desktop library does not support drag (mouse down/up API missing)', cursorBefore }
        }
        if (!Number.isFinite(payload.toX) || !Number.isFinite(payload.toY)) {
          return { ok: false, error: 'toX and toY are required for drag action', cursorBefore }
        }

        const hasStart = Number.isFinite(payload.x) && Number.isFinite(payload.y)
        if (hasStart) {
          await smoothSetPosition(mouse, Point, Number(payload.x), Number(payload.y), undefined, signal)
        }

        if (!activeMouseButton) {
          await mouseDown(button)
          activeMouseButton = buttonName
        }

        await smoothSetPosition(
          mouse,
          Point,
          Number(payload.toX),
          Number(payload.toY),
          { steps: payload.steps, durationMs: payload.duration_ms },
          signal,
        )

        if (releaseAfter) {
          await mouseUp(button)
          activeMouseButton = null
        } else {
          activeMouseButton = buttonName
        }
        const cursorAfter = await getCurrentMousePos(mouse)
        return { ok: true, message: releaseAfter ? 'mouse dragged and released' : 'mouse dragged (holding)', cursorBefore, cursorAfter }
      }

      case 'scroll': {
        const dx = Number(payload.dx ?? 0)
        const dy = Number(payload.dy ?? 0)
        if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) {
          return { ok: false, error: 'dx or dy is required for scroll action', cursorBefore }
        }

        const xAmount = wheelAmount(dx)
        const yAmount = wheelAmount(dy)

        if (dy > 0) await mouse.scrollDown(yAmount)
        if (dy < 0) await mouse.scrollUp(yAmount)
        if (dx > 0) await mouse.scrollRight(xAmount)
        if (dx < 0) await mouse.scrollLeft(xAmount)

        const cursorAfter = await getCurrentMousePos(mouse)
        return { ok: true, message: 'mouse scrolled', cursorBefore, cursorAfter }
      }

      case 'type': {
        const text = String(payload.text ?? '')
        if (!text) return { ok: false, error: 'text is required for type action', cursorBefore }
        // 点击后给系统留出焦点切换时间，避免输入丢失
        const elapsed = Date.now() - lastDesktopClickAt
        if (elapsed >= 0 && elapsed < 1000) await sleep(1000 - elapsed)
        await keyboard.type(text)
        const cursorAfter = await getCurrentMousePos(mouse)
        return { ok: true, message: 'text typed', cursorBefore, cursorAfter }
      }

      case 'key': {
        const rawKey = String(payload.key ?? '').trim()
        if (!rawKey) return { ok: false, error: 'key is required for key action', cursorBefore }

        const mapped = mapKey(rawKey, Key)
        if (!mapped) return { ok: false, error: `unsupported key: ${rawKey}`, cursorBefore }

        const modKeys = mapModifierKeys(payload.modifiers, Key)
        await keyboard.pressKey(...modKeys, mapped)
        await keyboard.releaseKey(mapped, ...modKeys.reverse())
        const cursorAfter = await getCurrentMousePos(mouse)
        return { ok: true, message: 'key pressed', cursorBefore, cursorAfter }
      }

      default:
        return { ok: false, error: `unsupported action: ${String(payload.action)}`, cursorBefore }
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, error: 'aborted', cursorBefore }
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err), cursorBefore }
  }
}
