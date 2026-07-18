/**
 * CDP (Chrome DevTools Protocol) 自动化操作模块
 *
 * 使用 Electron 内置的 Chrome DevTools Protocol (debugger API) 和
 * webContents 原生接口实现真正的浏览器级自动化：
 * - Input.dispatchMouseEvent / Input.dispatchKeyEvent  (CDP)
 * - webContents.capturePage()                          (截图)
 * - webContents.sendInputEvent()                       (键盘输入)
 * - webContents.executeJavaScript()                    (JS 执行)
 *
 * 参考：
 * https://www.electronjs.org/zh/docs/latest/api/debugger
 * https://www.electronjs.org/zh/docs/latest/api/web-contents
 */

import type {
  BrowserActionPayload,
  BrowserActionResult,
} from '../../shared/ipc-types'
import {
  DEFAULT_APP_ID,
  browserHiddenMode,
  ensureCdpAttached,
  getExternalBrowserWin,
  getBrowserInstance,
  isSameOriginUrl,
} from './browser-state'
import { focusExternalBrowser, openExternalBrowser } from './browser-window'

/* ------------------------------------------------------------------ */
/*  工具函数                                                           */
/* ------------------------------------------------------------------ */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timeout (${timeoutMs}ms)`)),
        timeoutMs
      )
      promise.then(resolve).catch(reject)
    })
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 通过 CDP 定位元素并获取其在视口中的中心坐标。
 * 返回 { x, y } 用于精确的鼠标点击。
 */
async function getElementCenter(
  wc: Electron.WebContents,
  selector: string
): Promise<{ x: number; y: number }> {
  const rect = await wc.executeJavaScript(`
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()
  `)
  if (!rect) throw new Error(`元素不存在: ${selector}`)
  return rect
}

/**
 * Playwright 风格的自动等待：轮询等待元素在 DOM 中出现，超时后抛出错误。
 * 用于 click/type/hover/drag 等依赖选择器的操作前自动等待。
 */
export async function waitForElement(
  wc: Electron.WebContents,
  selector: string,
  timeoutMs: number = 5000
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const exists = await wc
      .executeJavaScript(
        `
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        const style = getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
      })()
    `
      )
      .catch(() => false)
    if (exists) return
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`等待元素超时 (${timeoutMs}ms): ${selector}`)
}

/* ------------------------------------------------------------------ */
/*  截图策略                                                           */
/* ------------------------------------------------------------------ */

async function captureScreenshotDataUrl(
  wc: Electron.WebContents
): Promise<string> {
  const errors: string[] = []
  const tryCdp = async (fromSurface: boolean): Promise<string> => {
    const result = await withTimeout(
      wc.debugger.sendCommand('Page.captureScreenshot', {
        format: 'png',
        fromSurface,
      }) as Promise<{ data: string }>,
      3000,
      `Page.captureScreenshot fromSurface=${fromSurface}`
    )
    if (!result?.data) throw new Error('empty screenshot data')
    return `data:image/png;base64,${result.data}`
  }
  const tryCapturePage = async (): Promise<string> => {
    const image = await withTimeout(
      wc.capturePage(),
      4000,
      'webContents.capturePage'
    )
    // 隐藏窗口下 capturePage() 可能返回 0×0 空图片，toDataURL() 返回 "data:image/png;base64," 是 truthy
    if (image.isEmpty()) throw new Error('capturePage returned empty image (0×0)')
    const dataUrl = image.toDataURL()
    if (!dataUrl || dataUrl === 'data:image/png;base64,')
      throw new Error('empty capturePage data')
    return dataUrl
  }
  // webContents.capturePage() 优先 —— Electron 原生 API，不依赖 CDP，paintWhenInitiallyHidden 保证始终有 buffer
  const strategies: Array<() => Promise<string>> = [
    () => tryCapturePage(),
    () => tryCdp(true),
    () => tryCdp(false),
  ]
  for (const strategy of strategies) {
    try {
      return await strategy()
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
    }
  }
  throw new Error(`截图失败: ${errors.join(' | ')}`)
}

/* ------------------------------------------------------------------ */
/*  主操作分发                                                         */
/* ------------------------------------------------------------------ */

/**
 * 在外部 BrowserWindow 上执行浏览器使用操作。
 *
 * 使用 Electron 内置的 CDP (debugger API) 和 webContents 原生接口：
 * - click: CDP Input.dispatchMouseEvent 真实鼠标事件
 * - type:  CDP Input.dispatchKeyEvent  逐字符输入 + 可选回车
 * - screenshot: webContents.capturePage() 原生截图
 * - scroll: CDP Input.dispatchMouseEvent (wheel)
 * - navigate: webContents.loadURL()
 * - evaluate: webContents.executeJavaScript()
 */
export async function executeExternalBrowserAction(
  payload: BrowserActionPayload,
  appId: string = DEFAULT_APP_ID
): Promise<BrowserActionResult> {
  const { action, params } = payload

  // navigate → 打开/导航外部浏览器
  if (action === 'navigate') {
    const url = String(params.url ?? '')
    const finalUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`

    // 如果该 appId 的浏览器已打开且当前 URL 相同，直接聚焦
    const extWinExisting = getExternalBrowserWin(appId)
    if (extWinExisting) {
      const currentUrl = extWinExisting.webContents.getURL()
      // 更新 windowLabel 备注（如果传了新的）
      const existingInst = getBrowserInstance(appId)
      if (existingInst && params.windowLabel) {
        existingInst.windowLabel = String(params.windowLabel)
      }
      if (isSameOriginUrl(currentUrl, finalUrl)) {
        focusExternalBrowser(appId)
        return {
          success: true,
          data: `浏览器[${appId}]已在 ${currentUrl}，已聚焦窗口（未重新加载）`,
        }
      }
    }

    openExternalBrowser(
      finalUrl,
      appId,
      params.windowLabel ? String(params.windowLabel) : undefined
    )
    // 等待页面加载完成 + CDP stealth 注入就绪（类 Playwright page.goto 行为）
    const extWin = getExternalBrowserWin(appId)
    if (extWin) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 10000)
        extWin.webContents.once('did-finish-load', () => {
          clearTimeout(timer)
          resolve()
        })
      })
      // 确保 CDP 附加 + stealth 注入完成，后续操作不再有竞态
      await ensureCdpAttached(extWin.webContents, appId).catch(() => {})
    }
    return { success: true, data: `已在浏览器[${appId}]中打开 ${finalUrl}` }
  }

  const extWin = getExternalBrowserWin(appId)
  if (!extWin)
    return {
      success: false,
      error: `浏览器[${appId}]未打开，请先导航到目标页面（使用 run_skill_script('browser-use', 'navigate', {url})）`,
    }

  const wc = extWin.webContents

  try {
    switch (action) {
      // ── 页面信息 ──
      case 'get_info': {
        const url = wc.getURL()
        const title = wc.getTitle()
        const viewport = await wc.executeJavaScript(
          `JSON.stringify({ width: window.innerWidth, height: window.innerHeight })`
        )
        return {
          success: true,
          data: JSON.stringify({ url, title, viewport: JSON.parse(viewport) }),
        }
      }

      // ── 截图：按浏览器窗口整屏截图 ──
      case 'screenshot': {
        await ensureCdpAttached(wc, appId)
        await wc.debugger.sendCommand('Page.bringToFront').catch(() => {})

        // Windows/macOS 隐藏窗口下截图经常卡住：失败时临时显示窗口后重试，再恢复隐藏
        let dataUrl: string
        try {
          dataUrl = await captureScreenshotDataUrl(wc)
        } catch (firstErr) {
          if (
            (process.platform !== 'win32' && process.platform !== 'darwin') ||
            !browserHiddenMode ||
            extWin.isDestroyed()
          )
            throw firstErr
          extWin.showInactive()
          await sleep(800)
          try {
            dataUrl = await captureScreenshotDataUrl(wc)
          } finally {
            if (!extWin.isDestroyed()) extWin.hide()
          }
        }

        // 采集页面结构信息，保持与内嵌浏览器返回结构一致
        let pageInfo: Record<string, unknown> = {
          title: wc.getTitle(),
          url: wc.getURL(),
          viewport: { w: 0, h: 0 },
          elements: [],
        }
        try {
          const raw = await withTimeout(
            wc.executeJavaScript(`
            (function() {
              var info = { title: document.title, url: location.href, viewport: { w: window.innerWidth, h: window.innerHeight } };
              var els = [];
              document.querySelectorAll('a, button, input, select, textarea, [role="button"], [onclick], h1, h2, h3, h4, img[alt], label').forEach(function(el, i) {
                if (i > 80) return;
                var rect = el.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) return;
                var tag = el.tagName.toLowerCase();
                var text = (el.textContent || '').trim().slice(0, 80);
                var obj = { tag: tag, text: text };
                if (el.id) obj.id = el.id;
                if (el.className && typeof el.className === 'string') obj.class = el.className.split(' ').slice(0, 3).join(' ');
                if (el.type) obj.type = el.type;
                if (el.name) obj.name = el.name;
                if (el.placeholder) obj.placeholder = el.placeholder;
                if (el.href) obj.href = el.href;
                if (el.alt) obj.alt = el.alt;
                if (el.value) obj.value = String(el.value).slice(0, 40);
                obj.pos = { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) };
                els.push(obj);
              });
              info.elements = els;
              return JSON.stringify(info);
            })()
          `),
            4000,
            'collect page info'
          )
          pageInfo = JSON.parse(String(raw))
        } catch {
          // 页面脚本失败时降级到基础信息
        }

        return {
          success: true,
          data: JSON.stringify({
            screenshot: dataUrl,
            page: pageInfo,
          }),
        }
      }

      // ── 点击：CDP Input.dispatchMouseEvent —— 支持选择器或坐标、左/右/中键、双击 ──
      case 'click': {
        const selector = params.selector ? String(params.selector) : ''
        const btn = (String(params.button ?? 'left')) as
          | 'left'
          | 'right'
          | 'middle'
        const clicks = Number(params.clickCount ?? 1)
        let cx: number, cy: number

        if (selector) {
          // Playwright 风格：操作前自动等待元素可见
          await waitForElement(wc, selector)
          // 通过选择器定位
          await wc.executeJavaScript(`
            document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'center', behavior: 'instant' })
          `)
          await new Promise((r) => setTimeout(r, 100))
          const pos = await getElementCenter(wc, selector)
          cx = pos.x
          cy = pos.y
        } else if (params.x != null && params.y != null) {
          // 直接坐标
          cx = Number(params.x)
          cy = Number(params.y)
        } else {
          return { success: false, error: '需要提供 selector 或 x/y 坐标' }
        }

        await ensureCdpAttached(wc, appId)
        // 先移动鼠标到目标位置
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: cx,
          y: cy,
        })
        // 按下 + 释放（支持 clickCount 双击等）
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: cx,
          y: cy,
          button: btn,
          clickCount: clicks,
        })
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: cx,
          y: cy,
          button: btn,
          clickCount: clicks,
        })
        const label = selector || `(${Math.round(cx)},${Math.round(cy)})`
        return {
          success: true,
          data: `已${btn === 'right' ? '右键' : ''}${clicks > 1 ? '双' : ''}点击 ${label}`,
        }
      }

      // ── 输入：CDP 鼠标点击聚焦 + 逐字符键盘模拟输入（模拟真人打字节奏） ──
      case 'type': {
        const selector = String(params.selector ?? '')
        const text = String(params.text ?? '')
        const submit = Boolean(params.submit)
        const clearFirst = params.clear !== false // 默认 true，先清空

        // Playwright 风格：操作前自动等待元素可见
        if (selector) {
          await waitForElement(wc, selector)
        }

        // 滚动到目标元素可见
        if (selector) {
          await waitForElement(wc, selector)
          await wc.executeJavaScript(`
            document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'center', behavior: 'instant' })
          `)
          await new Promise((r) => setTimeout(r, 150))
        }

        // 获取元素中心坐标
        const { x, y } = await getElementCenter(wc, selector)

        await ensureCdpAttached(wc, appId)

        // ① 鼠标移动到目标位置
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x,
          y,
        })
        await new Promise((r) => setTimeout(r, 30 + Math.random() * 50))

        // ② 鼠标点击聚焦
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x,
          y,
          button: 'left',
          clickCount: 1,
        })
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x,
          y,
          button: 'left',
          clickCount: 1,
        })
        await new Promise((r) => setTimeout(r, 80 + Math.random() * 60))

        // ③ 清空已有内容 (Cmd+A / Ctrl+A, 然后 Backspace)
        if (clearFirst) {
          const selectAllMod =
            process.platform === 'darwin' ? 4 : /* Meta/Cmd */ 2 /* Ctrl */
          await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
            type: 'keyDown',
            key: 'a',
            code: 'KeyA',
            windowsVirtualKeyCode: 65,
            modifiers: selectAllMod,
          })
          await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: 'a',
            code: 'KeyA',
            windowsVirtualKeyCode: 65,
            modifiers: selectAllMod,
          })
          await new Promise((r) => setTimeout(r, 30))
          await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
            type: 'keyDown',
            key: 'Backspace',
            code: 'Backspace',
            windowsVirtualKeyCode: 8,
          })
          await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: 'Backspace',
            code: 'Backspace',
            windowsVirtualKeyCode: 8,
          })
          await new Promise((r) => setTimeout(r, 60 + Math.random() * 40))
        }

        // ④ 逐字符模拟键盘输入
        for (const char of text) {
          const code = char.charCodeAt(0)
          // ASCII 可打印字符 —— 使用 keyDown + char + keyUp 完整序列
          if (code >= 32 && code < 127) {
            const isUpper = char >= 'A' && char <= 'Z'
            const isLetter = /^[a-zA-Z]$/.test(char)
            const vk = isLetter ? char.toUpperCase().charCodeAt(0) : code
            const keyCode = isLetter ? `Key${char.toUpperCase()}` : undefined

            await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
              type: 'keyDown',
              key: char,
              ...(keyCode ? { code: keyCode } : {}),
              windowsVirtualKeyCode: vk,
              ...(isUpper ? { modifiers: 8 /* Shift */ } : {}),
            })
            await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
              type: 'char',
              text: char,
              unmodifiedText: char,
              key: char,
              windowsVirtualKeyCode: code,
            })
            await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
              type: 'keyUp',
              key: char,
              ...(keyCode ? { code: keyCode } : {}),
              windowsVirtualKeyCode: vk,
              ...(isUpper ? { modifiers: 8 } : {}),
            })
          } else {
            // 非 ASCII 字符（中文、emoji 等）—— 用 Input.insertText 逐字输入
            await wc.debugger.sendCommand('Input.insertText', { text: char })
          }
          // 随机延迟模拟真人打字节奏（30-120ms）
          await new Promise((r) => setTimeout(r, 30 + Math.random() * 90))
        }

        // ⑤ 可选：按回车提交
        if (submit) {
          await new Promise((r) => setTimeout(r, 100 + Math.random() * 80))
          await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
            type: 'keyDown',
            key: 'Enter',
            code: 'Enter',
            windowsVirtualKeyCode: 13,
          })
          await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
            type: 'char',
            text: '\r',
            key: 'Enter',
            windowsVirtualKeyCode: 13,
          })
          await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: 'Enter',
            code: 'Enter',
            windowsVirtualKeyCode: 13,
          })
        }

        return {
          success: true,
          data: `已输入 "${text}" 到 ${selector}${submit ? ' 并提交' : ''}`,
        }
      }

      // ── 滚动：CDP 鼠标滚轮事件，支持选择器定位、多步平滑滚动 ──
      case 'scroll': {
        // 兼容两种参数格式：direction+amount 或 x+y
        const direction = String(params.direction ?? 'down')
        const amount = Number(params.amount ?? 300)
        let deltaX = Number(params.x ?? 0)
        let deltaY = Number(params.y ?? 0)

        // 如果传了 direction，优先用 direction + amount 计算
        if (params.direction) {
          deltaX = 0
          deltaY = 0
          switch (direction) {
            case 'down':
              deltaY = amount
              break
            case 'up':
              deltaY = -amount
              break
            case 'right':
              deltaX = amount
              break
            case 'left':
              deltaX = -amount
              break
          }
        }

        const selector = params.selector ? String(params.selector) : ''

        await ensureCdpAttached(wc, appId)

        let scrollX: number, scrollY: number

        if (selector) {
          // 如果指定选择器，先鼠标移动到该元素上方，然后在元素位置滚动
          await wc.executeJavaScript(`
            document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'center', behavior: 'instant' })
          `)
          await new Promise((r) => setTimeout(r, 100))
          const pos = await getElementCenter(wc, selector)
          scrollX = pos.x
          scrollY = pos.y
        } else {
          // 默认在页面中心发送滚轮
          const vpStr = await wc.executeJavaScript(
            `JSON.stringify({ w: window.innerWidth, h: window.innerHeight })`
          )
          const vp = JSON.parse(vpStr)
          scrollX = Math.round(vp.w / 2)
          scrollY = Math.round(vp.h / 2)
        }

        // 鼠标先移到滚动位置（模拟真实操作）
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: scrollX,
          y: scrollY,
        })
        await new Promise((r) => setTimeout(r, 30))

        // 多步平滑滚动（分 5 步，模拟真实滚轮手感）
        const scrollSteps = 5
        const stepDeltaX = Math.round(deltaX / scrollSteps)
        const stepDeltaY = Math.round(deltaY / scrollSteps)

        for (let i = 0; i < scrollSteps; i++) {
          // 最后一步补偿取整误差
          const dx =
            i === scrollSteps - 1
              ? deltaX - stepDeltaX * (scrollSteps - 1)
              : stepDeltaX
          const dy =
            i === scrollSteps - 1
              ? deltaY - stepDeltaY * (scrollSteps - 1)
              : stepDeltaY
          if (dx === 0 && dy === 0) continue

          await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: scrollX,
            y: scrollY,
            deltaX: dx,
            deltaY: dy,
          })
          await new Promise((r) => setTimeout(r, 30 + Math.random() * 20))
        }

        const target = selector || '页面中心'
        return {
          success: true,
          data: `已在 ${target} 滚动 (${deltaX}, ${deltaY})`,
        }
      }

      // ── 获取内容 ──
      case 'get_content': {
        const selector = String(params.selector ?? 'body')
        const type = String(params.type ?? 'text')
        const result = await wc.executeJavaScript(`
          (function() {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return 'null';
            switch (${JSON.stringify(type)}) {
              case 'html':
                return el.outerHTML?.slice(0, 30000) || '';
              case 'value':
                return el.value != null ? String(el.value).slice(0, 30000) : '';
              case 'text':
              default:
                return el.innerText?.slice(0, 30000) || '';
            }
          })()
        `)
        return { success: true, data: result }
      }

      // ── 等待 ──
      case 'wait': {
        const selector = String(params.selector ?? '')
        const timeout = Number(params.timeout ?? 5000)
        if (!selector) return { success: false, error: 'selector 参数缺失' }

        const appeared = await wc.executeJavaScript(`
          new Promise((resolve) => {
            const start = Date.now();
            const maxWait = ${timeout};
            const el = document.querySelector(${JSON.stringify(selector)});
            if (el) return resolve(true);
            const observer = new MutationObserver(() => {
              const el = document.querySelector(${JSON.stringify(selector)});
              if (el) { observer.disconnect(); resolve(true); }
              else if (Date.now() - start >= maxWait) { observer.disconnect(); resolve(false); }
            });
            observer.observe(document.body || document.documentElement, {
              childList: true, subtree: true, attributes: true,
            });
            setTimeout(() => { observer.disconnect(); resolve(false); }, maxWait);
          })
        `)
        if (!appeared) {
          return {
            success: false,
            error: `等待超时：选择器 "${selector}" 在 ${timeout}ms 内未出现`,
          }
        }
        return { success: true, data: `选择器 "${selector}" 已出现` }
      }

      // ── 执行 JS ──
      case 'evaluate': {
        const code = String(params.code ?? '')
        const result = await wc.executeJavaScript(code)
        return {
          success: true,
          data: typeof result === 'string' ? result : JSON.stringify(result),
        }
      }

      // ── 鼠标悬停：CDP mouseMoved ──
      case 'hover': {
        const selector = params.selector ? String(params.selector) : ''
        let hx: number, hy: number
        if (selector) {
          await wc.executeJavaScript(`
            document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'center', behavior: 'instant' })
          `)
          await new Promise((r) => setTimeout(r, 100))
          const pos = await getElementCenter(wc, selector)
          hx = pos.x
          hy = pos.y
        } else if (params.x != null && params.y != null) {
          hx = Number(params.x)
          hy = Number(params.y)
        } else {
          return { success: false, error: '需要提供 selector 或 x/y 坐标' }
        }
        await ensureCdpAttached(wc, appId)
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: hx,
          y: hy,
        })
        return {
          success: true,
          data: `已悬停在 ${selector || `(${Math.round(hx)},${Math.round(hy)})`}`,
        }
      }

      // ── 键盘按键：CDP Input.dispatchKeyEvent ──
      case 'keypress': {
        const key = String(params.key ?? '')
        if (!key) return { success: false, error: 'key 参数缺失' }

        const mods = Array.isArray(params.modifiers)
          ? (params.modifiers as string[])
          : []
        let modifierFlags = 0
        if (mods.includes('alt')) modifierFlags |= 1
        if (mods.includes('ctrl')) modifierFlags |= 2
        if (mods.includes('meta')) modifierFlags |= 4
        if (mods.includes('shift')) modifierFlags |= 8

        // 常见按键映射到 virtualKeyCode
        const keyMap: Record<string, { code: string; vk: number }> = {
          Enter: { code: 'Enter', vk: 13 },
          Tab: { code: 'Tab', vk: 9 },
          Escape: { code: 'Escape', vk: 27 },
          Backspace: { code: 'Backspace', vk: 8 },
          Delete: { code: 'Delete', vk: 46 },
          Space: { code: 'Space', vk: 32 },
          ' ': { code: 'Space', vk: 32 },
          ArrowUp: { code: 'ArrowUp', vk: 38 },
          ArrowDown: { code: 'ArrowDown', vk: 40 },
          ArrowLeft: { code: 'ArrowLeft', vk: 37 },
          ArrowRight: { code: 'ArrowRight', vk: 39 },
          Home: { code: 'Home', vk: 36 },
          End: { code: 'End', vk: 35 },
          PageUp: { code: 'PageUp', vk: 33 },
          PageDown: { code: 'PageDown', vk: 34 },
          F1: { code: 'F1', vk: 112 },
          F2: { code: 'F2', vk: 113 },
          F3: { code: 'F3', vk: 114 },
          F4: { code: 'F4', vk: 115 },
          F5: { code: 'F5', vk: 116 },
          F6: { code: 'F6', vk: 117 },
          F7: { code: 'F7', vk: 118 },
          F8: { code: 'F8', vk: 119 },
          F9: { code: 'F9', vk: 120 },
          F10: { code: 'F10', vk: 121 },
          F11: { code: 'F11', vk: 122 },
          F12: { code: 'F12', vk: 123 },
        }

        await ensureCdpAttached(wc, appId)
        const mapped = keyMap[key]

        if (mapped) {
          // 特殊键
          await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
            type: 'keyDown',
            key,
            code: mapped.code,
            windowsVirtualKeyCode: mapped.vk,
            modifiers: modifierFlags,
          })
          await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
            type: 'keyUp',
            key,
            code: mapped.code,
            windowsVirtualKeyCode: mapped.vk,
            modifiers: modifierFlags,
          })
        } else if (key.length === 1) {
          // 单个字符键
          const vk = key.toUpperCase().charCodeAt(0)
          await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
            type: 'keyDown',
            key,
            code: `Key${key.toUpperCase()}`,
            windowsVirtualKeyCode: vk,
            modifiers: modifierFlags,
          })
          if (!modifierFlags) {
            // 仅在无修饰键时发送 char 事件
            await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
              type: 'char',
              text: key,
              unmodifiedText: key,
              key,
              windowsVirtualKeyCode: key.charCodeAt(0),
            })
          }
          await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
            type: 'keyUp',
            key,
            code: `Key${key.toUpperCase()}`,
            windowsVirtualKeyCode: vk,
            modifiers: modifierFlags,
          })
        } else {
          return { success: false, error: `不支持的按键: ${key}` }
        }

        const modStr = mods.length > 0 ? mods.join('+') + '+' : ''
        return { success: true, data: `已按下 ${modStr}${key}` }
      }

      // ── 拖拽：CDP mouseMoved + mousePressed + 多步 mouseMoved + mouseReleased ──
      case 'drag': {
        let fx: number, fy: number, tx: number, ty: number
        const dragSteps = Number(params.steps ?? 10)

        // 起点
        if (params.fromSelector) {
          await waitForElement(wc, String(params.fromSelector))
          await wc.executeJavaScript(`
            document.querySelector(${JSON.stringify(String(params.fromSelector))})?.scrollIntoView({ block: 'center', behavior: 'instant' })
          `)
          await new Promise((r) => setTimeout(r, 100))
          const from = await getElementCenter(wc, String(params.fromSelector))
          fx = from.x
          fy = from.y
        } else if (params.fromX != null && params.fromY != null) {
          fx = Number(params.fromX)
          fy = Number(params.fromY)
        } else {
          return {
            success: false,
            error: '需要提供 fromSelector 或 fromX/fromY',
          }
        }

        // 终点
        if (params.toSelector) {
          const to = await getElementCenter(wc, String(params.toSelector))
          tx = to.x
          ty = to.y
        } else if (params.toX != null && params.toY != null) {
          tx = Number(params.toX)
          ty = Number(params.toY)
        } else {
          return { success: false, error: '需要提供 toSelector 或 toX/toY' }
        }

        await ensureCdpAttached(wc, appId)
        // 移动到起点
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: fx,
          y: fy,
        })
        await new Promise((r) => setTimeout(r, 50))
        // 按下
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: fx,
          y: fy,
          button: 'left',
          clickCount: 1,
        })
        // 分步移动到终点（模拟真实拖拽轨迹）
        for (let i = 1; i <= dragSteps; i++) {
          const progress = i / dragSteps
          const mx = fx + (tx - fx) * progress
          const my = fy + (ty - fy) * progress
          await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: mx,
            y: my,
          })
          await new Promise((r) => setTimeout(r, 16)) // ~60fps
        }
        // 释放
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: tx,
          y: ty,
          button: 'left',
          clickCount: 1,
        })
        return {
          success: true,
          data: `已拖拽从 (${Math.round(fx)},${Math.round(fy)}) 到 (${Math.round(tx)},${Math.round(ty)})`,
        }
      }

      // ── 选择下拉框选项：CDP 鼠标模拟点击 + 键盘导航 ──
      case 'select': {
        const selector = String(params.selector ?? '')
        const value = params.value != null ? String(params.value) : undefined
        const label = params.label != null ? String(params.label) : undefined
        if (!selector) return { success: false, error: 'selector 参数缺失' }

        // 滚动到下拉框可见
        await wc.executeJavaScript(`
          document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'center', behavior: 'instant' })
        `)
        await new Promise((r) => setTimeout(r, 150))

        // 获取下拉框中心坐标
        const { x: sx, y: sy } = await getElementCenter(wc, selector)

        await ensureCdpAttached(wc, appId)

        // ① 鼠标移动到下拉框
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: sx,
          y: sy,
        })
        await new Promise((r) => setTimeout(r, 40 + Math.random() * 30))

        // ② 鼠标点击打开下拉框
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: sx,
          y: sy,
          button: 'left',
          clickCount: 1,
        })
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: sx,
          y: sy,
          button: 'left',
          clickCount: 1,
        })
        await new Promise((r) => setTimeout(r, 200 + Math.random() * 100))

        // ③ 获取目标选项的索引
        const optionInfo = await wc.executeJavaScript(`
          (function() {
            const sel = document.querySelector(${JSON.stringify(selector)});
            if (!sel || sel.tagName !== 'SELECT') return null;
            const opts = Array.from(sel.options);
            const currentIdx = sel.selectedIndex;
            let targetIdx = -1;
            if (${JSON.stringify(value)} != null) {
              targetIdx = opts.findIndex(o => o.value === ${JSON.stringify(value)});
            }
            if (targetIdx < 0 && ${JSON.stringify(label)} != null) {
              targetIdx = opts.findIndex(o => o.textContent?.trim() === ${JSON.stringify(label)});
            }
            if (targetIdx < 0) return null;
            return { currentIdx, targetIdx, label: opts[targetIdx].textContent?.trim() || opts[targetIdx].value };
          })()
        `)

        if (!optionInfo) {
          return {
            success: false,
            error: `未找到匹配的选项 (value=${value}, label=${label})`,
          }
        }

        // ④ 使用键盘上下箭头导航到目标选项
        const diff = optionInfo.targetIdx - optionInfo.currentIdx
        const arrowKey = diff > 0 ? 'ArrowDown' : 'ArrowUp'
        const arrowVk = diff > 0 ? 40 : 38
        const steps = Math.abs(diff)

        for (let i = 0; i < steps; i++) {
          await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
            type: 'keyDown',
            key: arrowKey,
            code: arrowKey,
            windowsVirtualKeyCode: arrowVk,
          })
          await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: arrowKey,
            code: arrowKey,
            windowsVirtualKeyCode: arrowVk,
          })
          await new Promise((r) => setTimeout(r, 50 + Math.random() * 40))
        }

        // ⑤ 按回车确认选择
        await new Promise((r) => setTimeout(r, 60 + Math.random() * 40))
        await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
        })
        await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
        })

        return { success: true, data: `已选择 "${optionInfo.label}"` }
      }

      default:
        return { success: false, error: `外部浏览器不支持操作: ${action}` }
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
