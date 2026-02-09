/**
 * 浏览器窗口管理 + CDP 自动化 + AppId 指纹持久化
 *
 * - 基于 appId 的多窗口管理（每个 appId 独立会话/指纹）
 * - Chrome DevTools Protocol (CDP) 自动化操作
 * - 反自动化检测 (Stealth) & 指纹唯一化
 */

import { BrowserWindow, app, ipcMain, session } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import * as nodePath from 'node:path'
import { IpcChannel } from '../shared/ipc'
import type { BrowserActionPayload, BrowserActionResult, ExternalBrowserStatus } from '../shared/ipc'

/** 浏览器调试模式（是否自动打开 DevTools） */
let browserDebugMode = false
/** 浏览器隐藏窗口模式（默认开启） */
let browserHiddenMode = true

/** 设置浏览器调试模式 */
export function setBrowserDebugMode(enabled: boolean) {
  browserDebugMode = enabled
  // 对已打开的窗口立即生效
  for (const inst of browserInstances.values()) {
    if (!inst.win.isDestroyed()) {
      if (enabled) {
        inst.win.webContents.openDevTools({ mode: 'bottom' })
      } else {
        inst.win.webContents.closeDevTools()
      }
    }
  }
}

/** 设置浏览器隐藏窗口模式 */
export function setBrowserHiddenMode(enabled: boolean) {
  browserHiddenMode = enabled
  for (const inst of browserInstances.values()) {
    if (inst.win.isDestroyed()) continue
    if (enabled) {
      if (inst.win.isVisible()) inst.win.hide()
    } else {
      if (!inst.win.isVisible()) inst.win.showInactive()
    }
  }
}

// 注册 IPC 监听
ipcMain.on(IpcChannel.BROWSER_DEBUG_MODE, (_e, enabled: boolean) => {
  setBrowserDebugMode(enabled)
})
ipcMain.on(IpcChannel.BROWSER_HIDDEN_MODE, (_e, enabled: boolean) => {
  setBrowserHiddenMode(enabled)
})

/* ------------------------------------------------------------------ */
/*  Browser Automation Bridge（统一使用外部 BrowserWindow）              */
/* ------------------------------------------------------------------ */

/**
 * 执行浏览器自动化操作。
 * 统一使用外部 BrowserWindow + CDP 实现。
 * @param payload 操作 payload
 * @param appId   浏览器实例标识（不指定则使用 'default'）
 */
export async function executeBrowserAction(payload: BrowserActionPayload, appId?: string): Promise<BrowserActionResult> {
  return executeExternalBrowserAction(payload, appId || DEFAULT_APP_ID)
}

/* ------------------------------------------------------------------ */
/*  External Browser — CDP + webContents 自动化                         */
/*                                                                      */
/*  使用 Electron 内置的 Chrome DevTools Protocol (debugger API) 和       */
/*  webContents 原生接口实现真正的浏览器级自动化：                          */
/*  - Input.dispatchMouseEvent / Input.dispatchKeyEvent  (CDP)          */
/*  - webContents.capturePage()                          (截图)         */
/*  - webContents.sendInputEvent()                       (键盘输入)     */
/*  - webContents.executeJavaScript()                    (JS 执行)      */
/*                                                                      */
/*  参考：                                                               */
/*  https://www.electronjs.org/zh/docs/latest/api/debugger              */
/*  https://www.electronjs.org/zh/docs/latest/api/web-contents          */
/* ------------------------------------------------------------------ */

/** 确保 CDP debugger 已附加到浏览器窗口，并执行反检测 CDP 命令 */
async function ensureCdpAttached(wc: Electron.WebContents, appId: string = DEFAULT_APP_ID): Promise<void> {
  if (!wc.debugger.isAttached()) {
    try {
      wc.debugger.attach('1.3')
    } catch (err) {
      if (!(err instanceof Error && err.message.includes('Already attached'))) {
        throw err
      }
    }
    // CDP 级别的反自动化检测
    try {
      // 使用该 appId 实例的 seed/UA 构建脚本（保证指纹一致）
      const inst = getBrowserInstance(appId)
      const seed = inst?.seed || generateFingerprintSeed()
      const ua = inst?.ua || generateChromeUA()
      const script = buildStealthJS(seed, ua)

      // 必须 await 确保命令完成
      await wc.debugger.sendCommand('Page.enable')

      await wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
        source: script,
      }).catch(() => {})

      await wc.debugger.sendCommand('Emulation.setUserAgentOverride', {
        userAgent: ua,
        platform: process.platform === 'darwin' ? 'MacIntel'
          : process.platform === 'win32' ? 'Win32' : 'Linux x86_64',
      }).catch(() => {})
    } catch { /* ignore */ }
  }
}

/**
 * 通过 CDP 定位元素并获取其在视口中的中心坐标。
 * 返回 { x, y } 用于精确的鼠标点击。
 */
async function getElementCenter(wc: Electron.WebContents, selector: string): Promise<{ x: number; y: number }> {
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
 * 在外部 BrowserWindow 上执行浏览器自动化操作。
 *
 * 使用 Electron 内置的 CDP (debugger API) 和 webContents 原生接口：
 * - click: CDP Input.dispatchMouseEvent 真实鼠标事件
 * - type:  CDP Input.dispatchKeyEvent  逐字符输入 + 可选回车
 * - screenshot: webContents.capturePage() 原生截图
 * - scroll: CDP Input.dispatchMouseEvent (wheel)
 * - navigate: webContents.loadURL()
 * - evaluate: webContents.executeJavaScript()
 */
async function executeExternalBrowserAction(payload: BrowserActionPayload, appId: string = DEFAULT_APP_ID): Promise<BrowserActionResult> {
  const { action, params } = payload

  // navigate → 打开/导航外部浏览器
  if (action === 'navigate') {
    const url = String(params.url ?? '')
    const finalUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`

    // 如果该 appId 的浏览器已打开且当前 URL 相同，直接聚焦
    const extWinExisting = getExternalBrowserWin(appId)
    if (extWinExisting) {
      const currentUrl = extWinExisting.webContents.getURL()
      if (isSameOriginUrl(currentUrl, finalUrl)) {
        focusExternalBrowser(appId)
        return { success: true, data: `浏览器[${appId}]已在 ${currentUrl}，已聚焦窗口（未重新加载）` }
      }
    }

    openExternalBrowser(finalUrl, appId)
    // 等待页面加载完成
    const extWin = getExternalBrowserWin(appId)
    if (extWin) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 10000)
        extWin.webContents.once('did-finish-load', () => { clearTimeout(timer); resolve() })
      })
    }
    return { success: true, data: `已在浏览器[${appId}]中打开 ${finalUrl}` }
  }

  const extWin = getExternalBrowserWin(appId)
  if (!extWin) return { success: false, error: `浏览器[${appId}]未打开，请先使用 browser_navigate 打开目标页面` }

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
        return { success: true, data: JSON.stringify({ url, title, viewport: JSON.parse(viewport) }) }
      }

      // ── 截图：按浏览器窗口整屏截图 ──
      case 'screenshot': {
        await ensureCdpAttached(wc, appId)

        // 截取整个浏览器窗口可视区域
        const { data: base64 } = await wc.debugger.sendCommand('Page.captureScreenshot', {
          format: 'png',
          fromSurface: true,
        }) as { data: string }

        const dataUrl = `data:image/png;base64,${base64}`

        // 采集页面结构信息，保持与内嵌浏览器返回结构一致
        let pageInfo: Record<string, unknown> = {
          title: wc.getTitle(),
          url: wc.getURL(),
          viewport: { w: 0, h: 0 },
          elements: [],
        }
        try {
          const raw = await wc.executeJavaScript(`
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
          `)
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
        const btn = (String(params.button ?? 'left')) as 'left' | 'right' | 'middle'
        const clicks = Number(params.clickCount ?? 1)
        let cx: number, cy: number

        if (selector) {
          // 通过选择器定位
          await wc.executeJavaScript(`
            document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'center', behavior: 'instant' })
          `)
          await new Promise(r => setTimeout(r, 100))
          const pos = await getElementCenter(wc, selector)
          cx = pos.x; cy = pos.y
        } else if (params.x != null && params.y != null) {
          // 直接坐标
          cx = Number(params.x); cy = Number(params.y)
        } else {
          return { success: false, error: '需要提供 selector 或 x/y 坐标' }
        }

        await ensureCdpAttached(wc, appId)
        // 先移动鼠标到目标位置
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: cx, y: cy,
        })
        // 按下 + 释放（支持 clickCount 双击等）
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mousePressed', x: cx, y: cy, button: btn, clickCount: clicks,
        })
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: cx, y: cy, button: btn, clickCount: clicks,
        })
        const label = selector || `(${Math.round(cx)},${Math.round(cy)})`
        return { success: true, data: `已${btn === 'right' ? '右键' : ''}${clicks > 1 ? '双' : ''}点击 ${label}` }
      }

      // ── 输入：CDP 鼠标点击聚焦 + 逐字符键盘模拟输入（模拟真人打字节奏） ──
      case 'type': {
        const selector = String(params.selector ?? '')
        const text = String(params.text ?? '')
        const submit = Boolean(params.submit)
        const clearFirst = params.clear !== false // 默认 true，先清空

        // 滚动到目标元素可见
        if (selector) {
          await wc.executeJavaScript(`
            document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'center', behavior: 'instant' })
          `)
          await new Promise(r => setTimeout(r, 150))
        }

        // 获取元素中心坐标
        const { x, y } = await getElementCenter(wc, selector)

        await ensureCdpAttached(wc, appId)

        // ① 鼠标移动到目标位置
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseMoved', x, y,
        })
        await new Promise(r => setTimeout(r, 30 + Math.random() * 50))

        // ② 鼠标点击聚焦
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mousePressed', x, y, button: 'left', clickCount: 1,
        })
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
        })
        await new Promise(r => setTimeout(r, 80 + Math.random() * 60))

        // ③ 清空已有内容 (Cmd+A / Ctrl+A, 然后 Backspace)
        if (clearFirst) {
          const selectAllMod = process.platform === 'darwin' ? 4 /* Meta/Cmd */ : 2 /* Ctrl */
          await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
            type: 'keyDown', key: 'a', code: 'KeyA',
            windowsVirtualKeyCode: 65, modifiers: selectAllMod,
          })
          await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
            type: 'keyUp', key: 'a', code: 'KeyA',
            windowsVirtualKeyCode: 65, modifiers: selectAllMod,
          })
          await new Promise(r => setTimeout(r, 30))
          await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
            type: 'keyDown', key: 'Backspace', code: 'Backspace',
            windowsVirtualKeyCode: 8,
          })
          await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
            type: 'keyUp', key: 'Backspace', code: 'Backspace',
            windowsVirtualKeyCode: 8,
          })
          await new Promise(r => setTimeout(r, 60 + Math.random() * 40))
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
          await new Promise(r => setTimeout(r, 30 + Math.random() * 90))
        }

        // ⑤ 可选：按回车提交
        if (submit) {
          await new Promise(r => setTimeout(r, 100 + Math.random() * 80))
          await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
            type: 'keyDown', key: 'Enter', code: 'Enter',
            windowsVirtualKeyCode: 13,
          })
          await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
            type: 'char', text: '\r', key: 'Enter',
            windowsVirtualKeyCode: 13,
          })
          await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
            type: 'keyUp', key: 'Enter', code: 'Enter',
            windowsVirtualKeyCode: 13,
          })
        }

        return { success: true, data: `已输入 "${text}" 到 ${selector}${submit ? ' 并提交' : ''}` }
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
          deltaX = 0; deltaY = 0
          switch (direction) {
            case 'down': deltaY = amount; break
            case 'up': deltaY = -amount; break
            case 'right': deltaX = amount; break
            case 'left': deltaX = -amount; break
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
          await new Promise(r => setTimeout(r, 100))
          const pos = await getElementCenter(wc, selector)
          scrollX = pos.x; scrollY = pos.y
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
          type: 'mouseMoved', x: scrollX, y: scrollY,
        })
        await new Promise(r => setTimeout(r, 30))

        // 多步平滑滚动（分 5 步，模拟真实滚轮手感）
        const scrollSteps = 5
        const stepDeltaX = Math.round(deltaX / scrollSteps)
        const stepDeltaY = Math.round(deltaY / scrollSteps)

        for (let i = 0; i < scrollSteps; i++) {
          // 最后一步补偿取整误差
          const dx = (i === scrollSteps - 1) ? deltaX - stepDeltaX * (scrollSteps - 1) : stepDeltaX
          const dy = (i === scrollSteps - 1) ? deltaY - stepDeltaY * (scrollSteps - 1) : stepDeltaY
          if (dx === 0 && dy === 0) continue

          await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: scrollX,
            y: scrollY,
            deltaX: dx,
            deltaY: dy,
          })
          await new Promise(r => setTimeout(r, 30 + Math.random() * 20))
        }

        const target = selector || '页面中心'
        return { success: true, data: `已在 ${target} 滚动 (${deltaX}, ${deltaY})` }
      }

      // ── 获取内容 ──
      case 'get_content': {
        const selector = String(params.selector ?? 'body')
        const result = await wc.executeJavaScript(`
          (function() {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return 'null';
            return el.innerText?.slice(0, 30000) || '';
          })()
        `)
        return { success: true, data: result }
      }

      // ── 等待 ──
      case 'wait': {
        const ms = Number(params.ms ?? 1000)
        await new Promise(r => setTimeout(r, ms))
        return { success: true, data: `等待了 ${ms}ms` }
      }

      // ── 执行 JS ──
      case 'evaluate': {
        const code = String(params.code ?? '')
        const result = await wc.executeJavaScript(code)
        return { success: true, data: typeof result === 'string' ? result : JSON.stringify(result) }
      }

      // ── 鼠标悬停：CDP mouseMoved ──
      case 'hover': {
        const selector = params.selector ? String(params.selector) : ''
        let hx: number, hy: number
        if (selector) {
          await wc.executeJavaScript(`
            document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'center', behavior: 'instant' })
          `)
          await new Promise(r => setTimeout(r, 100))
          const pos = await getElementCenter(wc, selector)
          hx = pos.x; hy = pos.y
        } else if (params.x != null && params.y != null) {
          hx = Number(params.x); hy = Number(params.y)
        } else {
          return { success: false, error: '需要提供 selector 或 x/y 坐标' }
        }
        await ensureCdpAttached(wc, appId)
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: hx, y: hy,
        })
        return { success: true, data: `已悬停在 ${selector || `(${Math.round(hx)},${Math.round(hy)})`}` }
      }

      // ── 键盘按键：CDP Input.dispatchKeyEvent ──
      case 'keypress': {
        const key = String(params.key ?? '')
        if (!key) return { success: false, error: 'key 参数缺失' }

        const mods = Array.isArray(params.modifiers) ? params.modifiers as string[] : []
        let modifierFlags = 0
        if (mods.includes('alt')) modifierFlags |= 1
        if (mods.includes('ctrl')) modifierFlags |= 2
        if (mods.includes('meta')) modifierFlags |= 4
        if (mods.includes('shift')) modifierFlags |= 8

        // 常见按键映射到 virtualKeyCode
        const keyMap: Record<string, { code: string; vk: number }> = {
          'Enter': { code: 'Enter', vk: 13 },
          'Tab': { code: 'Tab', vk: 9 },
          'Escape': { code: 'Escape', vk: 27 },
          'Backspace': { code: 'Backspace', vk: 8 },
          'Delete': { code: 'Delete', vk: 46 },
          'Space': { code: 'Space', vk: 32 },
          ' ': { code: 'Space', vk: 32 },
          'ArrowUp': { code: 'ArrowUp', vk: 38 },
          'ArrowDown': { code: 'ArrowDown', vk: 40 },
          'ArrowLeft': { code: 'ArrowLeft', vk: 37 },
          'ArrowRight': { code: 'ArrowRight', vk: 39 },
          'Home': { code: 'Home', vk: 36 },
          'End': { code: 'End', vk: 35 },
          'PageUp': { code: 'PageUp', vk: 33 },
          'PageDown': { code: 'PageDown', vk: 34 },
          'F1': { code: 'F1', vk: 112 },
          'F2': { code: 'F2', vk: 113 },
          'F3': { code: 'F3', vk: 114 },
          'F4': { code: 'F4', vk: 115 },
          'F5': { code: 'F5', vk: 116 },
          'F6': { code: 'F6', vk: 117 },
          'F7': { code: 'F7', vk: 118 },
          'F8': { code: 'F8', vk: 119 },
          'F9': { code: 'F9', vk: 120 },
          'F10': { code: 'F10', vk: 121 },
          'F11': { code: 'F11', vk: 122 },
          'F12': { code: 'F12', vk: 123 },
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
          const charCode = key.charCodeAt(0)
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
              windowsVirtualKeyCode: charCode,
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
          await wc.executeJavaScript(`
            document.querySelector(${JSON.stringify(String(params.fromSelector))})?.scrollIntoView({ block: 'center', behavior: 'instant' })
          `)
          await new Promise(r => setTimeout(r, 100))
          const from = await getElementCenter(wc, String(params.fromSelector))
          fx = from.x; fy = from.y
        } else if (params.fromX != null && params.fromY != null) {
          fx = Number(params.fromX); fy = Number(params.fromY)
        } else {
          return { success: false, error: '需要提供 fromSelector 或 fromX/fromY' }
        }

        // 终点
        if (params.toSelector) {
          const to = await getElementCenter(wc, String(params.toSelector))
          tx = to.x; ty = to.y
        } else if (params.toX != null && params.toY != null) {
          tx = Number(params.toX); ty = Number(params.toY)
        } else {
          return { success: false, error: '需要提供 toSelector 或 toX/toY' }
        }

        await ensureCdpAttached(wc, appId)
        // 移动到起点
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: fx, y: fy,
        })
        await new Promise(r => setTimeout(r, 50))
        // 按下
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mousePressed', x: fx, y: fy, button: 'left', clickCount: 1,
        })
        // 分步移动到终点（模拟真实拖拽轨迹）
        for (let i = 1; i <= dragSteps; i++) {
          const progress = i / dragSteps
          const mx = fx + (tx - fx) * progress
          const my = fy + (ty - fy) * progress
          await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
            type: 'mouseMoved', x: mx, y: my,
          })
          await new Promise(r => setTimeout(r, 16)) // ~60fps
        }
        // 释放
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: tx, y: ty, button: 'left', clickCount: 1,
        })
        return { success: true, data: `已拖拽从 (${Math.round(fx)},${Math.round(fy)}) 到 (${Math.round(tx)},${Math.round(ty)})` }
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
        await new Promise(r => setTimeout(r, 150))

        // 获取下拉框中心坐标
        const { x: sx, y: sy } = await getElementCenter(wc, selector)

        await ensureCdpAttached(wc, appId)

        // ① 鼠标移动到下拉框
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: sx, y: sy,
        })
        await new Promise(r => setTimeout(r, 40 + Math.random() * 30))

        // ② 鼠标点击打开下拉框
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mousePressed', x: sx, y: sy, button: 'left', clickCount: 1,
        })
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: sx, y: sy, button: 'left', clickCount: 1,
        })
        await new Promise(r => setTimeout(r, 200 + Math.random() * 100))

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
          return { success: false, error: `未找到匹配的选项 (value=${value}, label=${label})` }
        }

        // ④ 使用键盘上下箭头导航到目标选项
        const diff = optionInfo.targetIdx - optionInfo.currentIdx
        const arrowKey = diff > 0 ? 'ArrowDown' : 'ArrowUp'
        const arrowVk = diff > 0 ? 40 : 38
        const steps = Math.abs(diff)

        for (let i = 0; i < steps; i++) {
          await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
            type: 'keyDown', key: arrowKey, code: arrowKey,
            windowsVirtualKeyCode: arrowVk,
          })
          await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
            type: 'keyUp', key: arrowKey, code: arrowKey,
            windowsVirtualKeyCode: arrowVk,
          })
          await new Promise(r => setTimeout(r, 50 + Math.random() * 40))
        }

        // ⑤ 按回车确认选择
        await new Promise(r => setTimeout(r, 60 + Math.random() * 40))
        await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
          type: 'keyDown', key: 'Enter', code: 'Enter',
          windowsVirtualKeyCode: 13,
        })
        await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
          type: 'keyUp', key: 'Enter', code: 'Enter',
          windowsVirtualKeyCode: 13,
        })

        return { success: true, data: `已选择 "${optionInfo.label}"` }
      }

      default:
        return { success: false, error: `外部浏览器不支持操作: ${action}` }
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/* ------------------------------------------------------------------ */
/*  AppId-based 多窗口浏览器管理                                        */
/*                                                                      */
/*  每个 appId 绑定一个独立的浏览器窗口：                                  */
/*  - 指纹（seed/UA）持久化缓存到磁盘，同一 appId 始终使用相同指纹        */
/*  - 会话隔离：每个 appId 使用独立的 Electron partition                  */
/*  - 多窗口并行：可同时打开多个 appId 的浏览器窗口                       */
/* ------------------------------------------------------------------ */

/** 浏览器配置持久化目录 */
const BROWSER_PROFILES_DIR = nodePath.join(app.getPath('home'), '.taco', 'browser-profiles')

/** 单个 appId 的持久化指纹配置 */
interface BrowserProfile {
  appId: string
  seed: string
  ua: string
  createdAt: string
  lastUsedAt: string
}

/** 运行时浏览器窗口实例信息 */
interface BrowserInstance {
  win: BrowserWindow
  appId: string
  seed: string
  ua: string
}

/** appId → BrowserWindow 实例映射 */
const browserInstances = new Map<string, BrowserInstance>()

/** 默认 appId（当工具调用未指定 appId 时使用） */
const DEFAULT_APP_ID = 'default'

/** 确保配置目录存在 */
function ensureProfilesDir() {
  if (!existsSync(BROWSER_PROFILES_DIR)) {
    mkdirSync(BROWSER_PROFILES_DIR, { recursive: true })
  }
}

/** 加载或创建 appId 的浏览器指纹配置 */
function loadOrCreateProfile(appId: string): BrowserProfile {
  ensureProfilesDir()
  const profilePath = nodePath.join(BROWSER_PROFILES_DIR, `${appId}.json`)

  if (existsSync(profilePath)) {
    try {
      const data = JSON.parse(readFileSync(profilePath, 'utf-8')) as BrowserProfile
      // 更新最后使用时间
      data.lastUsedAt = new Date().toISOString()
      writeFileSync(profilePath, JSON.stringify(data, null, 2), 'utf-8')
      return data
    } catch { /* 配置损坏，重新生成 */ }
  }

  // 首次使用，生成并持久化
  const profile: BrowserProfile = {
    appId,
    seed: generateFingerprintSeed(),
    ua: generateChromeUA(),
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
  }
  writeFileSync(profilePath, JSON.stringify(profile, null, 2), 'utf-8')
  return profile
}

/** 向渲染进程发送外部浏览器状态 */
function sendExternalStatus(status: ExternalBrowserStatus) {
  const mainWin = BrowserWindow.getAllWindows().find(w => !browserInstances.has(getAppIdByWin(w)))
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send(IpcChannel.EXTERNAL_BROWSER_STATUS, status)
  }
}

/** 通过 BrowserWindow 反查 appId */
function getAppIdByWin(win: BrowserWindow): string {
  for (const [id, inst] of browserInstances) {
    if (inst.win === win) return id
  }
  return ''
}

/**
 * 比较两个 URL 是否指向同一个页面（忽略尾部斜杠、hash、多余空格）。
 * 同源同路径视为相同，不需要重新加载。
 */
function isSameOriginUrl(a: string, b: string): boolean {
  try {
    const ua = new URL(a)
    const ub = new URL(b)
    // 比较 origin + pathname（去掉尾部斜杠）+ search
    const normalize = (u: URL) =>
      `${u.origin}${u.pathname.replace(/\/+$/, '')}${u.search}`
    return normalize(ua) === normalize(ub)
  } catch {
    return a === b
  }
}

/* ------------------------------------------------------------------ */
/*  外部浏览器反自动化检测（Stealth）& 指纹唯一化                        */
/*                                                                      */
/*  1. 伪造真实 Chrome User-Agent                                        */
/*  2. 基于窗口 seed 生成唯一且一致的浏览器指纹                           */
/*     - Canvas 指纹 (toDataURL / getImageData)                          */
/*     - WebGL 参数（renderer / vendor / unmasked）                      */
/*     - AudioContext 指纹                                               */
/*     - ClientRects 微偏移                                              */
/*     - navigator.hardwareConcurrency / deviceMemory                    */
/*     - screen 分辨率                                                   */
/*  3. 反 webdriver / CDP 检测                                           */
/* ------------------------------------------------------------------ */

/** 生成一个伪造的真实 Chrome User-Agent */
function generateChromeUA(): string {
  // 主版本 120-132，随机 patch
  const major = 120 + Math.floor(Math.random() * 13)
  const build = 6000 + Math.floor(Math.random() * 400)
  const patch = Math.floor(Math.random() * 200)
  const chromeVer = `${major}.0.${build}.${patch}`
  const platform = process.platform === 'darwin'
    ? `Macintosh; Intel Mac OS X 10_15_${7 + Math.floor(Math.random() * 3)}`
    : process.platform === 'win32'
      ? `Windows NT 10.0; Win64; x64`
      : `X11; Linux x86_64`
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer} Safari/537.36`
}

/** 生成唯一的窗口指纹 seed（同一窗口生命周期内保持不变） */
function generateFingerprintSeed(): string {
  // 32 位十六进制字符串
  let s = ''
  for (let i = 0; i < 32; i++) {
    s += Math.floor(Math.random() * 16).toString(16)
  }
  return s
}

/**
 * 构造 stealth + 指纹注入脚本。
 * @param seed 窗口指纹 seed，保证同窗口内所有页面指纹一致
 * @param ua   伪造的 User-Agent
 */
function buildStealthJS(seed: string, ua: string): string {
  return `
(function(){
  if (window.__stealth_applied__) return;
  window.__stealth_applied__ = true;

  // ── 基于 seed 的确定性伪随机数生成器（同 seed 永远相同序列）──
  var SEED = ${JSON.stringify(seed)};
  var _idx = 0;
  function seedRand() {
    var h = 0;
    var s = SEED + ':' + (_idx++);
    for (var i = 0; i < s.length; i++) {
      h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    }
    return (((h >>> 0) % 10000) / 10000);
  }

  // ── 1. navigator.webdriver ──
  Object.defineProperty(navigator, 'webdriver', {
    get: function() { return undefined; },
    configurable: true,
  });

  // ── 2. User-Agent 一致性 ──
  var FAKE_UA = ${JSON.stringify(ua)};
  try {
    Object.defineProperty(navigator, 'userAgent', {
      get: function() { return FAKE_UA; }, configurable: true,
    });
    Object.defineProperty(navigator, 'appVersion', {
      get: function() { return FAKE_UA.slice(FAKE_UA.indexOf('/') + 1); }, configurable: true,
    });
  } catch(e){}

  // ── 3. window.chrome ──
  if (!window.chrome) {
    window.chrome = {};
  }
  if (!window.chrome.runtime) {
    window.chrome.runtime = {
      onMessage: { addListener: function(){}, removeListener: function(){} },
      sendMessage: function(){},
      connect: function(){ return { onMessage: { addListener: function(){} }, postMessage: function(){} }; },
    };
  }
  if (!window.chrome.loadTimes) window.chrome.loadTimes = function(){ return {}; };
  if (!window.chrome.csi) window.chrome.csi = function(){ return {}; };

  // ── 4. navigator.plugins ──
  Object.defineProperty(navigator, 'plugins', {
    get: function() {
      var a = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', length: 1 },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '', length: 1 },
      ];
      a.refresh = function(){};
      a.item = function(i){ return a[i] || null; };
      a.namedItem = function(n){ return a.find(function(p){ return p.name === n; }) || null; };
      return a;
    }, configurable: true,
  });

  // ── 5. navigator.mimeTypes ──
  Object.defineProperty(navigator, 'mimeTypes', {
    get: function() {
      return [
        { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
        { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format' },
      ];
    }, configurable: true,
  });

  // ── 6. navigator.languages ──
  Object.defineProperty(navigator, 'languages', {
    get: function() { return ['zh-CN', 'zh', 'en-US', 'en']; },
    configurable: true,
  });

  // ── 7. navigator.hardwareConcurrency（seed 决定，4-16）──
  var _cores = 4 + Math.floor(seedRand() * 13);
  _cores = _cores % 2 === 0 ? _cores : _cores + 1; // 保持偶数
  Object.defineProperty(navigator, 'hardwareConcurrency', {
    get: function() { return _cores; }, configurable: true,
  });

  // ── 8. navigator.deviceMemory（seed 决定，4/8/16）──
  var _memArr = [4, 8, 8, 16];
  var _mem = _memArr[Math.floor(seedRand() * _memArr.length)];
  try {
    Object.defineProperty(navigator, 'deviceMemory', {
      get: function() { return _mem; }, configurable: true,
    });
  } catch(e){}

  // ── 9. navigator.platform ──
  try {
    var _plat = ${JSON.stringify(
      process.platform === 'darwin' ? 'MacIntel'
        : process.platform === 'win32' ? 'Win32'
          : 'Linux x86_64'
    )};
    Object.defineProperty(navigator, 'platform', {
      get: function() { return _plat; }, configurable: true,
    });
  } catch(e){}

  // ── 10. screen 分辨率（固定 1920x1080）──
  var _scr = [1920, 1080];
  try {
    Object.defineProperty(screen, 'width', { get: function(){ return _scr[0]; } });
    Object.defineProperty(screen, 'height', { get: function(){ return _scr[1]; } });
    Object.defineProperty(screen, 'availWidth', { get: function(){ return _scr[0]; } });
    Object.defineProperty(screen, 'availHeight', { get: function(){ return _scr[1] - 40; } });
    Object.defineProperty(screen, 'colorDepth', { get: function(){ return 24; } });
    Object.defineProperty(screen, 'pixelDepth', { get: function(){ return 24; } });
  } catch(e){}

  // ── 11. Canvas 指纹（在像素数据中加入 seed 决定的微量噪声）──
  try {
    var _origToBlob = HTMLCanvasElement.prototype.toBlob;
    var _origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    var _origGetImageData = CanvasRenderingContext2D.prototype.getImageData;

    // 给 ImageData 的像素加微量噪声（seed 决定，同 seed 同结果）
    function _noiseImageData(imageData) {
      var d = imageData.data;
      for (var i = 0; i < d.length; i += 4) {
        // 每 100 个像素扰动一次，幅度 ±1
        if (i % 400 === 0) {
          var n = ((seedRand() * 3) | 0) - 1; // -1, 0, 1
          d[i] = Math.max(0, Math.min(255, d[i] + n));
        }
      }
      return imageData;
    }

    CanvasRenderingContext2D.prototype.getImageData = function() {
      var data = _origGetImageData.apply(this, arguments);
      return _noiseImageData(data);
    };
    HTMLCanvasElement.prototype.toDataURL = function() {
      // 在导出前注入噪声像素
      var ctx = this.getContext('2d');
      if (ctx) {
        try {
          var img = _origGetImageData.call(ctx, 0, 0, this.width, this.height);
          _noiseImageData(img);
          ctx.putImageData(img, 0, 0);
        } catch(e){} // 跨域 canvas 会报错，忽略
      }
      return _origToDataURL.apply(this, arguments);
    };
    HTMLCanvasElement.prototype.toBlob = function() {
      var ctx = this.getContext('2d');
      if (ctx) {
        try {
          var img = _origGetImageData.call(ctx, 0, 0, this.width, this.height);
          _noiseImageData(img);
          ctx.putImageData(img, 0, 0);
        } catch(e){}
      }
      return _origToBlob.apply(this, arguments);
    };
  } catch(e){}

  // ── 12. WebGL 指纹（伪造 renderer / vendor / unmasked 信息）──
  try {
    var _glRenderers = [
      'ANGLE (Intel, Intel(R) UHD Graphics 630, OpenGL 4.1)',
      'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Ti, OpenGL 4.5)',
      'ANGLE (AMD, AMD Radeon Pro 5500M, OpenGL 4.1)',
      'ANGLE (Intel, Intel(R) Iris(TM) Plus Graphics 655, OpenGL 4.1)',
      'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060, OpenGL 4.5)',
      'ANGLE (Apple, Apple M1, OpenGL 4.1)',
      'ANGLE (Apple, Apple M2, OpenGL 4.1)',
      'ANGLE (Intel, Intel(R) UHD Graphics 770, OpenGL 4.5)',
    ];
    var _glVendors = ['Google Inc. (Intel)', 'Google Inc. (NVIDIA)', 'Google Inc. (AMD)', 'Google Inc. (Apple)'];
    var _myRenderer = _glRenderers[Math.floor(seedRand() * _glRenderers.length)];
    var _myVendor = _glVendors[Math.floor(seedRand() * _glVendors.length)];

    var _origGetParam = WebGLRenderingContext.prototype.getParameter;
    function _fakeGetParam(param) {
      // UNMASKED_VENDOR_WEBGL = 0x9245, UNMASKED_RENDERER_WEBGL = 0x9246
      if (param === 0x9245) return _myVendor;
      if (param === 0x9246) return _myRenderer;
      return _origGetParam.call(this, param);
    }
    WebGLRenderingContext.prototype.getParameter = _fakeGetParam;
    if (typeof WebGL2RenderingContext !== 'undefined') {
      var _origGetParam2 = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function(param) {
        if (param === 0x9245) return _myVendor;
        if (param === 0x9246) return _myRenderer;
        return _origGetParam2.call(this, param);
      };
    }
  } catch(e){}

  // ── 13. AudioContext 指纹噪声 ──
  try {
    var _origCreateOsc = (window.AudioContext || window.webkitAudioContext).prototype.createOscillator;
    var _origCreateDyn = (window.AudioContext || window.webkitAudioContext).prototype.createDynamicsCompressor;
    if (_origCreateDyn) {
      var _OrigAC = window.AudioContext || window.webkitAudioContext;
      var _origGetFloat = AnalyserNode.prototype.getFloatFrequencyData;
      AnalyserNode.prototype.getFloatFrequencyData = function(arr) {
        _origGetFloat.call(this, arr);
        // 加微量噪声
        for (var i = 0; i < arr.length; i += 10) {
          arr[i] = arr[i] + (seedRand() - 0.5) * 0.001;
        }
      };
    }
  } catch(e){}

  // ── 14. ClientRects 微偏移（seed 决定的亚像素偏移）──
  try {
    var _origGetBCR = Element.prototype.getBoundingClientRect;
    var _origGetCR = Element.prototype.getClientRects;
    var _rectNoise = (seedRand() - 0.5) * 0.5; // -0.25 ~ +0.25
    Element.prototype.getBoundingClientRect = function() {
      var r = _origGetBCR.call(this);
      return new DOMRect(r.x + _rectNoise, r.y + _rectNoise, r.width, r.height);
    };
    Element.prototype.getClientRects = function() {
      var rects = _origGetCR.call(this);
      var out = [];
      for (var i = 0; i < rects.length; i++) {
        out.push(new DOMRect(rects[i].x + _rectNoise, rects[i].y + _rectNoise, rects[i].width, rects[i].height));
      }
      return out;
    };
  } catch(e){}

  // ── 15. navigator.permissions.query ──
  try {
    if (navigator.permissions) {
      var _origPQ = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = function(p) {
        if (p.name === 'notifications') return Promise.resolve({ state: 'prompt', onchange: null });
        return _origPQ(p);
      };
    }
  } catch(e){}

  // ── 16. Function.prototype.toString ──
  var _ots = Function.prototype.toString;
  var _fts = function() {
    if (this === _fts) return 'function toString() { [native code] }';
    return _ots.call(this);
  };
  Function.prototype.toString = _fts;

  // ── 17. document.hidden / visibilityState ──
  try {
    Object.defineProperty(document, 'hidden', { get: function(){ return false; }, configurable: true });
    Object.defineProperty(document, 'visibilityState', { get: function(){ return 'visible'; }, configurable: true });
  } catch(e){}

  // ── 18. connection.rtt 一致性 ──
  try {
    if (navigator.connection) {
      var _rtt = [50, 100, 150][Math.floor(seedRand() * 3)];
      Object.defineProperty(navigator.connection, 'rtt', { get: function(){ return _rtt; } });
    }
  } catch(e){}

})();
`
}

/** 打开浏览器窗口（指定 appId），如已存在则复用 */
export function openExternalBrowser(url: string, appId: string = DEFAULT_APP_ID) {
  console.log(`[Browser] openExternalBrowser called: url="${url}", appId="${appId}"`)

  const existing = browserInstances.get(appId)
  if (existing && !existing.win.isDestroyed()) {
    const currentUrl = existing.win.webContents.getURL()
    console.log(`[Browser] 已有窗口, currentUrl="${currentUrl}"`)
    if (isSameOriginUrl(currentUrl, url)) {
      if (!browserHiddenMode) {
        if (existing.win.isMinimized()) existing.win.restore()
        existing.win.show()
        existing.win.focus()
      }
      return
    }
    console.log(`[Browser] 已有窗口导航到: ${url}`)
    existing.win.loadURL(url)
    if (!browserHiddenMode) existing.win.focus()
    return
  }

  const profile = loadOrCreateProfile(appId)

  const win = new BrowserWindow({
    width: 1920,
    height: 1080,
    show: !browserHiddenMode,
    title: `浏览器 [${appId}]`,
    backgroundColor: '#1e1e1e',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: `persist:browser-${appId}`,
    },
  })

  const instance: BrowserInstance = {
    win,
    appId,
    seed: profile.seed,
    ua: profile.ua,
  }
  browserInstances.set(appId, instance)

  const wc = win.webContents

  // 设置 UA
  wc.setUserAgent(profile.ua)

  // SSL 证书错误直接放行
  wc.on('certificate-error', (event, certUrl, error, _cert, callback) => {
    console.log(`[Browser] certificate-error: ${error} @ ${certUrl}`)
    event.preventDefault()
    callback(true)
  })

  // 页面加载失败 → 通知渲染进程 + 显示友好错误页
  wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    console.error(`[Browser] did-fail-load: code=${errorCode} desc="${errorDescription}" url="${validatedURL}"`)
    // 把错误信息发给渲染进程，自动反馈给 AI
    sendExternalStatus({
      type: 'console',
      appId,
      consoleLevel: 'error',
      consoleMessage: `[页面加载失败] ${validatedURL} — ${errorCode} ${errorDescription}`,
    })
    if (!isMainFrame || !validatedURL) return
    // 在窗口中显示友好的错误提示页面
    const errorHtml = `data:text/html;charset=utf-8,${encodeURIComponent(`
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>页面加载失败</title>
<style>
  body { background: #1e1e1e; color: #ccc; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  .container { text-align: center; max-width: 500px; }
  h1 { color: #e06c75; font-size: 24px; margin-bottom: 16px; }
  .url { color: #61afef; word-break: break-all; margin: 16px 0; font-size: 14px; background: #282c34; padding: 12px; border-radius: 6px; }
  .error { color: #e5c07b; font-size: 13px; margin: 8px 0; }
  .hint { color: #888; font-size: 13px; margin-top: 20px; line-height: 1.6; }
  button { margin-top: 20px; padding: 8px 24px; background: #61afef; color: #1e1e1e; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; }
  button:hover { background: #528bce; }
</style>
</head>
<body>
<div class="container">
  <h1>⚠ 页面加载失败</h1>
  <div class="url">${validatedURL}</div>
  <div class="error">错误码: ${errorCode} — ${errorDescription}</div>
  <div class="hint">
    ${errorCode === -102 ? '连接被拒绝 — 目标服务可能未启动，请确认服务已运行在该地址。' :
      errorCode === -105 ? '域名无法解析 — 请检查网址是否正确。' :
      errorCode === -106 ? '无网络连接 — 请检查网络设置。' :
      '请检查网址是否正确或稍后重试。'}
  </div>
  <button onclick="location.href='${validatedURL}'">重试</button>
</div>
</body>
</html>`)}`
    win.loadURL(errorHtml)
  })

  // stealth 脚本仅在 dom-ready 注入
  const stealthScript = buildStealthJS(profile.seed, profile.ua)
  wc.on('dom-ready', () => {
    wc.executeJavaScript(stealthScript).catch(() => {})
  })

  // 拦截新窗口请求（target="_blank"、window.open 等）→ 在当前窗口导航
  wc.setWindowOpenHandler(({ url: newUrl }) => {
    console.log(`[Browser] setWindowOpenHandler: newUrl="${newUrl}"`)
    if (newUrl && newUrl !== 'about:blank') {
      setTimeout(() => {
        if (!win.isDestroyed()) {
          console.log(`[Browser] 重定向到: ${newUrl}`)
          win.loadURL(newUrl)
        }
      }, 50)
    }
    return { action: 'deny' }
  })

  console.log(`[Browser] 开始加载: ${url}`)
  win.loadURL(url)

  // 如果调试模式开启，自动打开 DevTools
  if (browserDebugMode) {
    wc.openDevTools({ mode: 'bottom' })
  }

  // 监听浏览器控制台输出，转发到渲染进程（使用新 Event 对象属性）
  wc.on('console-message', (event) => {
    const levelMap: Record<string, 'log' | 'warn' | 'error' | 'info'> = {
      info: 'info', warning: 'warn', error: 'error', debug: 'log',
    }
    const consoleLevel = levelMap[event.level as string] ?? 'log'
    sendExternalStatus({
      type: 'console',
      appId,
      consoleLevel,
      consoleMessage: event.message,
      consoleSource: event.sourceId,
      consoleLine: event.lineNumber,
    })
  })

  // 追踪导航
  wc.on('did-navigate', (_e, navUrl) => {
    sendExternalStatus({ type: 'navigated', url: navUrl, appId })
  })
  wc.on('did-navigate-in-page', (_e, navUrl) => {
    sendExternalStatus({ type: 'navigated', url: navUrl, appId })
  })
  wc.on('page-title-updated', (_e, title) => {
    sendExternalStatus({ type: 'title-changed', title, appId })
  })

  // 窗口关闭 — 分离 CDP debugger，清理实例
  win.on('closed', () => {
    try {
      if (wc.debugger?.isAttached()) wc.debugger.detach()
    } catch { /* ignore */ }
    browserInstances.delete(appId)
    sendExternalStatus({ type: 'closed', appId })
  })

  sendExternalStatus({ type: 'opened', url, appId })
}

/** 关闭指定 appId 的浏览器窗口 */
export function closeExternalBrowser(appId: string = DEFAULT_APP_ID) {
  const inst = browserInstances.get(appId)
  if (inst && !inst.win.isDestroyed()) {
    try {
      if (inst.win.webContents.debugger.isAttached()) {
        inst.win.webContents.debugger.detach()
      }
    } catch { /* ignore */ }
    inst.win.close()
  }
  browserInstances.delete(appId)
}

/** 在指定 appId 的浏览器窗口中导航 */
export function navigateExternalBrowser(url: string, appId: string = DEFAULT_APP_ID) {
  const inst = browserInstances.get(appId)
  if (inst && !inst.win.isDestroyed()) {
    inst.win.loadURL(url)
    if (!browserHiddenMode) inst.win.focus()
  }
}

/** 聚焦/显示指定 appId 的浏览器窗口（不重新加载） */
export function focusExternalBrowser(appId: string = DEFAULT_APP_ID) {
  const inst = browserInstances.get(appId)
  if (inst && !inst.win.isDestroyed()) {
    if (inst.win.isMinimized()) inst.win.restore()
    inst.win.show()
    inst.win.focus()
  }
}

/** 获取指定 appId 的浏览器窗口引用 */
export function getExternalBrowserWin(appId: string = DEFAULT_APP_ID): BrowserWindow | null {
  const inst = browserInstances.get(appId)
  if (inst && !inst.win.isDestroyed()) return inst.win
  return null
}

/** 获取指定 appId 窗口实例的指纹信息 */
function getBrowserInstance(appId: string = DEFAULT_APP_ID): BrowserInstance | null {
  const inst = browserInstances.get(appId)
  if (inst && !inst.win.isDestroyed()) return inst
  return null
}

/** 列出所有活跃的浏览器窗口 appId */
export function listBrowserAppIds(): string[] {
  const ids: string[] = []
  for (const [appId, inst] of browserInstances) {
    if (!inst.win.isDestroyed()) ids.push(appId)
  }
  return ids
}
