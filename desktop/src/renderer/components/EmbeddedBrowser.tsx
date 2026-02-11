/**
 * 内嵌浏览器组件
 *
 * 使用 Electron <webview> 标签在主窗口中间区域显示外部网页。
 * 提供地址栏、前进/后退/刷新导航按钮、关闭按钮。
 * 底部开发者工具面板（可折叠、可拖拽调整大小），包含三个 Tab：
 *   - Console：页面控制台日志 & JS 错误
 *   - Network：捕获 fetch/XHR 请求（通过注入脚本）
 *   - Storage：查看 Cookie、LocalStorage、SessionStorage
 * 自动将错误信息回调给 AI Agent 进行分析和修复。
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { BrowserActionPayload, BrowserActionResult } from '../../shared/ipc'

/* ================================================================== */
/*  Types                                                              */
/* ================================================================== */

type EmbeddedBrowserProps = {
  url: string
  onClose: () => void
  onBrowserErrors?: (errors: BrowserErrorReport) => void
}

export type BrowserErrorReport = {
  url: string
  errors: Array<{
    level: 'error' | 'warn' | 'network'
    message: string
    source?: string
    line?: number
    timestamp: number
  }>
}

type ConsoleEntry = {
  id: number
  level: 'log' | 'warn' | 'error' | 'info' | 'network'
  message: string
  source?: string
  line?: number
  timestamp: number
}

type NetworkEntry = {
  id: number
  method: string
  url: string
  status: number
  statusText: string
  type: 'fetch' | 'xhr'
  duration: number
  size: string
  timestamp: number
  reqHeaders?: Record<string, string>
  resHeaders?: Record<string, string>
  responseBody?: string
}

type StorageItem = { key: string; value: string }

type DevToolsTab = 'console' | 'network' | 'storage'
type StorageSubTab = 'cookie' | 'localStorage' | 'sessionStorage'

/* ================================================================== */
/*  Constants                                                          */
/* ================================================================== */

let entryIdCounter = 0

const LEVEL_CONFIG: Record<ConsoleEntry['level'], { label: string; cls: string }> = {
  log: { label: 'LOG', cls: 'log' },
  info: { label: 'INFO', cls: 'info' },
  warn: { label: 'WARN', cls: 'warn' },
  error: { label: 'ERR', cls: 'error' },
  network: { label: 'NET', cls: 'error' },
}

const CONSOLE_DEFAULT_HEIGHT = 240
const CONSOLE_MIN_HEIGHT = 30
const CONSOLE_MAX_HEIGHT = 600

/**
 * 判断一条错误是否属于"系统性/开发级"错误（应自动反馈给 AI）。
 * 返回 true → 需要自动发送；false → 业务级错误，不自动发送。
 *
 * 系统性错误特征：
 * - JS 运行时异常：TypeError, ReferenceError, SyntaxError, RangeError, EvalError, URIError
 * - 未捕获异常：Uncaught, Unhandled
 * - 模块/资源加载失败：Failed to fetch, ChunkLoadError, Loading chunk, dynamically imported module
 * - CORS 错误
 * - 5xx 服务端错误（接口返回 500/502/503/504）
 * - 网络连接完全失败（status=0, ERR_CONNECTION_REFUSED 等）
 * - React/Vue 等框架错误边界
 *
 * 业务级错误（不自动发送）：
 * - 4xx 客户端错误（401 未授权, 403 禁止, 404 未找到, 422 参数错误）
 * - 表单验证失败、密码错误、权限不足等
 */
function isSystemError(entry: ConsoleEntry): boolean {
  const msg = entry.message.toLowerCase()

  // JS 运行时异常
  if (/\b(typeerror|referenceerror|syntaxerror|rangeerror|evalerror|urierror)\b/i.test(entry.message)) return true

  // 未捕获异常
  if (/\b(uncaught|unhandled)\b/i.test(entry.message)) return true

  // 模块/资源加载失败
  if (msg.includes('chunkloaderror') || msg.includes('loading chunk') || msg.includes('dynamically imported module')) return true
  if (msg.includes('failed to fetch') && !msg.includes('api')) return true // 纯网络断开，不是 API 调用失败

  // CORS
  if (msg.includes('cors') || msg.includes('cross-origin') || msg.includes('access-control-allow-origin')) return true

  // React/Vue 框架错误
  if (msg.includes('react error boundary') || msg.includes('maximum update depth') || msg.includes('cannot read properties of')) return true
  if (msg.includes('cannot read property') || msg.includes('is not a function') || msg.includes('is not defined')) return true

  // 网络连接完全失败（did-fail-load 产生的 network 级别）
  if (entry.level === 'network') {
    // 连接被拒、DNS 失败、SSL 错误等
    if (msg.includes('err_connection') || msg.includes('err_name') || msg.includes('err_ssl') || msg.includes('err_cert')) return true
    // 5xx 服务端错误
    if (/\b50[0-4]\b/.test(entry.message)) return true
  }

  // 堆栈溢出
  if (msg.includes('maximum call stack') || msg.includes('stack overflow')) return true

  // 内存不足
  if (msg.includes('out of memory') || msg.includes('allocation failed')) return true

  return false
}

/**
 * 判断一条 Network 请求是否属于系统性错误。
 * 5xx 和连接失败(status=0) → 系统错误；4xx → 业务错误。
 */
function isSystemNetworkError(entry: NetworkEntry): boolean {
  if (entry.status === 0) return true      // 连接完全失败
  if (entry.status >= 500) return true     // 5xx 服务端错误
  return false
}

/**
 * 注入到 webview 页面主世界（main world）中用于拦截 fetch/XHR 的脚本。
 *
 * 重要：由于 Electron webview 默认启用 contextIsolation，
 * 直接通过 executeJavaScript 运行的代码处于隔离上下文，无法拦截页面真正的 fetch/XHR。
 * 因此我们通过创建 <script> 标签注入到 DOM 中，使其在页面的主世界运行。
 */
const NETWORK_INJECT_SCRIPT_RAW = `
(function() {
  if (window.__TACO_NET_INJECTED__) return;
  window.__TACO_NET_INJECTED__ = true;

  function headersToObj(h) {
    var o = {};
    if (h && h.forEach) h.forEach(function(v,k){ o[k] = v; });
    return o;
  }
  function truncate(s, max) { return s && s.length > max ? s.slice(0, max) + '...(truncated)' : s; }

  // 拦截 fetch
  var origFetch = window.fetch;
  window.fetch = async function() {
    var req = new Request(arguments[0], arguments[1]);
    var method = req.method, url = req.url;
    var reqH = headersToObj(req.headers);
    var start = performance.now();
    try {
      var res = await origFetch.apply(this, arguments);
      var dur = Math.round(performance.now() - start);
      var size = res.headers.get('content-length') || '?';
      var resH = headersToObj(res.headers);
      var body = '';
      try {
        var ct = res.headers.get('content-type') || '';
        if (ct.includes('json') || ct.includes('text') || ct.includes('html') || ct.includes('xml')) {
          var clone = res.clone();
          body = truncate(await clone.text(), 2000);
        }
      } catch(e) {}
      console.log('__TACO_NET__:' + JSON.stringify({
        type:'fetch', method:method, url:url,
        status:res.status, statusText:res.statusText,
        duration:dur, size:size,
        reqHeaders:reqH, resHeaders:resH, responseBody:body
      }));
      return res;
    } catch(err) {
      var dur2 = Math.round(performance.now() - start);
      console.log('__TACO_NET__:' + JSON.stringify({
        type:'fetch', method:method, url:url,
        status:0, statusText:err.message||'Failed',
        duration:dur2, size:'0', reqHeaders:reqH
      }));
      throw err;
    }
  };

  // 拦截 XMLHttpRequest
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  var origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function(method, url) {
    var rawUrl = typeof url==='string'?url:String(url);
    var fullUrl;
    try { fullUrl = new URL(rawUrl, location.href).href; } catch(e) { fullUrl = rawUrl; }
    this.__taco = { method:method, url:fullUrl, start:0, reqHeaders:{} };
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function(k, v) {
    if (this.__taco) this.__taco.reqHeaders[k] = v;
    return origSetHeader.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function() {
    if (this.__taco) this.__taco.start = performance.now();
    var self = this;
    this.addEventListener('loadend', function() {
      var t = self.__taco || {};
      var dur = Math.round(performance.now() - (t.start||0));
      var size = self.getResponseHeader('content-length') || String(self.responseText?.length||'?');
      var resH = {};
      try {
        var all = self.getAllResponseHeaders().trim().split('\\r\\n');
        all.forEach(function(line){ var i=line.indexOf(':'); if(i>0) resH[line.slice(0,i).trim()]=line.slice(i+1).trim(); });
      } catch(e){}
      var body = '';
      try { body = truncate(self.responseText||'', 2000); } catch(e){}
      console.log('__TACO_NET__:' + JSON.stringify({
        type:'xhr', method:t.method||'GET', url:t.url||'',
        status:self.status, statusText:self.statusText||'',
        duration:dur, size:size,
        reqHeaders:t.reqHeaders||{}, resHeaders:resH, responseBody:body
      }));
    });
    return origSend.apply(this, arguments);
  };
})();
`

/**
 * 通过在 DOM 中创建 <script> 标签来注入拦截脚本。
 * 这样脚本会在页面主世界执行，可以真正拦截页面的 fetch/XHR 调用。
 */
const NETWORK_INJECT_SCRIPT = `
(function() {
  try {
    var s = document.createElement('script');
    s.textContent = ${JSON.stringify(NETWORK_INJECT_SCRIPT_RAW)};
    (document.head || document.documentElement).appendChild(s);
    s.remove();
  } catch(e) {
    console.error('[TACO] Network inject failed:', e);
  }
})();
`

/* ================================================================== */
/*  Component                                                          */
/* ================================================================== */

/** 浏览器组件对外暴露的操作接口 */
export type EmbeddedBrowserHandle = {
  executeAction: (payload: BrowserActionPayload) => Promise<BrowserActionResult>
}

export const EmbeddedBrowser = forwardRef<EmbeddedBrowserHandle, EmbeddedBrowserProps>(function EmbeddedBrowser({ url, onClose, onBrowserErrors }, ref) {
  const webviewRef = useRef<Electron.WebviewTag | null>(null)
  const consoleEndRef = useRef<HTMLDivElement | null>(null)
  const [currentUrl, setCurrentUrl] = useState(url)
  const [inputUrl, setInputUrl] = useState(url)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [loading, setLoading] = useState(true)
  const [, setPageTitle] = useState('')

  // DevTools 面板状态
  const [devToolsOpen, setDevToolsOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<DevToolsTab>('console')
  const [panelHeight, setPanelHeight] = useState(CONSOLE_DEFAULT_HEIGHT)
  const [isDragging, setIsDragging] = useState(false)
  const panelHeightRef = useRef(CONSOLE_DEFAULT_HEIGHT)

  // Console tab
  const [consoleEntries, setConsoleEntries] = useState<ConsoleEntry[]>([])
  const [consoleFilter, setConsoleFilter] = useState<'all' | 'error' | 'warn' | 'log'>('all')
  const [errorCount, setErrorCount] = useState(0)
  const [warnCount, setWarnCount] = useState(0)

  // Network tab
  const [networkEntries, setNetworkEntries] = useState<NetworkEntry[]>([])

  // Storage tab
  const [storageSubTab, setStorageSubTab] = useState<StorageSubTab>('cookie')
  const [cookies, setCookies] = useState<StorageItem[]>([])
  const [localStorageItems, setLocalStorageItems] = useState<StorageItem[]>([])
  const [sessionStorageItems, setSessionStorageItems] = useState<StorageItem[]>([])
  const [storageLoading, setStorageLoading] = useState(false)
  const [expandedStorageKey, setExpandedStorageKey] = useState<string | null>(null)
  const [editingStorage, setEditingStorage] = useState<{ key: string; value: string } | null>(null)
  const [addingStorage, setAddingStorage] = useState(false)
  const [newStorageKey, setNewStorageKey] = useState('')
  const [newStorageValue, setNewStorageValue] = useState('')

  // Network tab: expanded row
  const [expandedNetworkId, setExpandedNetworkId] = useState<number | null>(null)

  // Console: JS input
  const [jsInput, setJsInput] = useState('')
  const jsInputRef = useRef<HTMLInputElement>(null)

  // 发送错误给 AI（手动 + 自动）
  const onBrowserErrorsRef = useRef(onBrowserErrors)
  onBrowserErrorsRef.current = onBrowserErrors
  const currentUrlRef = useRef(currentUrl)
  currentUrlRef.current = currentUrl

  // 系统性错误自动上报：3 秒批量收集 + 10 秒冷却
  const autoBatchRef = useRef<ConsoleEntry[]>([])
  const autoBatchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastAutoReportRef = useRef(0)
  const AUTO_COOLDOWN = 10_000

  /** 将指定的错误条目发送给 AI 分析 */
  const sendErrorsToAI = useCallback((entries: ConsoleEntry[]) => {
    if (entries.length === 0 || !onBrowserErrorsRef.current) return
    onBrowserErrorsRef.current({
      url: currentUrlRef.current,
      errors: entries.map((e) => ({
        level: e.level as 'error' | 'warn' | 'network',
        message: e.message, source: e.source, line: e.line, timestamp: e.timestamp,
      })),
    })
  }, [])

  /** 自动上报系统性错误（批量） */
  const flushAutoBatch = useCallback(() => {
    const batch = autoBatchRef.current
    autoBatchRef.current = []
    autoBatchTimerRef.current = null
    if (batch.length === 0) return
    const now = Date.now()
    if (now - lastAutoReportRef.current < AUTO_COOLDOWN) return
    lastAutoReportRef.current = now
    // 去重
    const seen = new Set<string>()
    const deduped = batch.filter((e) => {
      if (seen.has(e.message)) return false
      seen.add(e.message)
      return true
    })
    sendErrorsToAI(deduped)
  }, [sendErrorsToAI])

  /** 将系统性错误加入自动上报队列 */
  const enqueueAutoReport = useCallback((entry: ConsoleEntry) => {
    autoBatchRef.current.push(entry)
    if (!autoBatchTimerRef.current) {
      autoBatchTimerRef.current = setTimeout(flushAutoBatch, 3_000)
    }
  }, [flushAutoBatch])

  // 清理定时器
  useEffect(() => {
    return () => { if (autoBatchTimerRef.current) clearTimeout(autoBatchTimerRef.current) }
  }, [])

  /** 手动发送单条错误给 AI */
  const sendSingleErrorToAI = useCallback((entry: ConsoleEntry) => {
    sendErrorsToAI([entry])
  }, [sendErrorsToAI])

  /** 手动发送当前所有错误给 AI */
  const sendAllErrorsToAI = useCallback(() => {
    const errors = consoleEntries.filter((e) => e.level === 'error' || e.level === 'network')
    sendErrorsToAI(errors)
  }, [consoleEntries, sendErrorsToAI])

  /* ---- URL sync ---- */
  useEffect(() => {
    setCurrentUrl(url)
    setInputUrl(url)
    const wv = webviewRef.current
    if (wv) wv.src = url
  }, [url])

  // 自动滚动 Console 到底部
  useEffect(() => {
    if (devToolsOpen && activeTab === 'console' && consoleEndRef.current) {
      consoleEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [consoleEntries, devToolsOpen, activeTab])

  

  /* ---- Webview events ---- */
  useEffect(() => {
    const wv = webviewRef.current
    if (!wv) return

    const onDidNavigate = () => {
      const newUrl = wv.getURL()
      setCurrentUrl(newUrl)
      setInputUrl(newUrl)
      setCanGoBack(wv.canGoBack())
      setCanGoForward(wv.canGoForward())
    }

    /** 在页面主世界注入 Network 拦截脚本（通过 DOM <script> 标签） */
    const injectNetworkScript = () => {
      wv.executeJavaScript(NETWORK_INJECT_SCRIPT).catch((err: unknown) => {
        console.warn('[TACO] Network inject failed:', err)
      })
    }

    const onStartLoading = () => setLoading(true)
    const onStopLoading = () => {
      setLoading(false)
      onDidNavigate()
      // 页面加载完成后注入 Network 拦截脚本
      injectNetworkScript()
    }

    // dom-ready 比 did-stop-loading 更早触发，在此也注入一次以尽早拦截网络请求
    const onDomReady = () => {
      injectNetworkScript()
    }

    const onTitleUpdate = (e: Electron.PageTitleUpdatedEvent) => setPageTitle(e.title)

    const onConsoleMessage = (e: Electron.ConsoleMessageEvent) => {
      // 检查是否为 Network 拦截数据
      if (e.message.startsWith('__TACO_NET__:')) {
        try {
          const data = JSON.parse(e.message.slice(13))
          const entry: NetworkEntry = {
            id: ++entryIdCounter,
            method: data.method || 'GET',
            url: data.url || '',
            status: data.status || 0,
            statusText: data.statusText || '',
            type: data.type || 'fetch',
            duration: data.duration || 0,
            size: String(data.size || '?'),
            timestamp: Date.now(),
            reqHeaders: data.reqHeaders,
            resHeaders: data.resHeaders,
            responseBody: data.responseBody,
          }
          setNetworkEntries((prev) => {
            const next = [...prev, entry]
            return next.length > 300 ? next.slice(-300) : next
          })
          // 5xx / 连接失败自动上报给 AI
          if (isSystemNetworkError(entry)) {
            enqueueAutoReport({
              id: entry.id, level: 'network', timestamp: entry.timestamp,
              message: `${entry.method} ${entry.url} → ${entry.status || 'ERR'} ${entry.statusText} (${entry.duration}ms)`,
            })
          }
        } catch { /* ignore parse error */ }
        return // 不加入 Console
      }

      const levelMap: Record<number, ConsoleEntry['level']> = { 0: 'log', 1: 'info', 2: 'warn', 3: 'error' }
      const level = levelMap[e.level] ?? 'log'
      const entry: ConsoleEntry = {
        id: ++entryIdCounter, level, message: e.message,
        source: e.sourceId, line: e.line, timestamp: Date.now(),
      }
      setConsoleEntries((prev) => {
        const next = [...prev, entry]
        return next.length > 500 ? next.slice(-500) : next
      })
      if (level === 'error') {
        setErrorCount((c) => c + 1)
        // 系统性致命错误自动上报给 AI
        if (isSystemError(entry)) enqueueAutoReport(entry)
      }
      if (level === 'warn') setWarnCount((c) => c + 1)
    }

    const onDidFailLoad = (e: Electron.DidFailLoadEvent) => {
      if (e.errorCode === -3) return
      const entry: ConsoleEntry = {
        id: ++entryIdCounter, level: 'network',
        message: `加载失败: ${e.errorDescription} (${e.errorCode}) — ${e.validatedURL}`,
        timestamp: Date.now(),
      }
      setConsoleEntries((prev) => [...prev, entry])
      setErrorCount((c) => c + 1)
      // 网络连接失败 / 5xx 等系统性错误自动上报
      if (isSystemError(entry)) enqueueAutoReport(entry)
    }

    wv.addEventListener('did-navigate', onDidNavigate)
    wv.addEventListener('did-navigate-in-page', onDidNavigate)
    wv.addEventListener('did-start-loading', onStartLoading)
    wv.addEventListener('did-stop-loading', onStopLoading)
    wv.addEventListener('dom-ready', onDomReady)
    wv.addEventListener('page-title-updated', onTitleUpdate)
    wv.addEventListener('console-message', onConsoleMessage)
    wv.addEventListener('did-fail-load', onDidFailLoad)

    return () => {
      wv.removeEventListener('did-navigate', onDidNavigate)
      wv.removeEventListener('did-navigate-in-page', onDidNavigate)
      wv.removeEventListener('did-start-loading', onStartLoading)
      wv.removeEventListener('did-stop-loading', onStopLoading)
      wv.removeEventListener('dom-ready', onDomReady)
      wv.removeEventListener('page-title-updated', onTitleUpdate)
      wv.removeEventListener('console-message', onConsoleMessage)
      wv.removeEventListener('did-fail-load', onDidFailLoad)
    }
  }, [enqueueAutoReport])

  /* ---- Resize ---- */
  useEffect(() => { panelHeightRef.current = panelHeight }, [panelHeight])

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const startY = e.clientY
    const startHeight = panelHeightRef.current
    setIsDragging(true)
    document.body.style.cursor = 'ns-resize'
    document.body.style.userSelect = 'none'
    const onMouseMove = (ev: MouseEvent) => {
      ev.preventDefault()
      const delta = startY - ev.clientY
      const newH = Math.max(CONSOLE_MIN_HEIGHT, Math.min(CONSOLE_MAX_HEIGHT, startHeight + delta))
      panelHeightRef.current = newH
      setPanelHeight(newH)
    }
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      setIsDragging(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [])

  /* ---- Navigation handlers ---- */
  const handleGoBack = useCallback(() => { webviewRef.current?.goBack() }, [])
  const handleGoForward = useCallback(() => { webviewRef.current?.goForward() }, [])
  const handleReload = useCallback(() => { webviewRef.current?.reload() }, [])

  const handleNavigate = useCallback(() => {
    const trimmed = inputUrl.trim()
    if (!trimmed) return
    const finalUrl = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    setCurrentUrl(finalUrl)
    const wv = webviewRef.current
    if (wv) wv.src = finalUrl
  }, [inputUrl])

  /* ---- Browser Automation (AI 浏览器操作) ---- */
  const executeAction = useCallback(async (payload: BrowserActionPayload): Promise<BrowserActionResult> => {
    const wv = webviewRef.current
    if (!wv) return { success: false, error: '浏览器未打开' }

    const { action, params } = payload
    try {
      switch (action) {
        case 'navigate': {
          const targetUrl = String(params.url ?? '')
          if (!targetUrl) return { success: false, error: 'url 参数缺失' }
          const finalUrl = /^https?:\/\//i.test(targetUrl) ? targetUrl : `https://${targetUrl}`
          // 如果当前 URL 与目标相同（忽略尾部斜杠和 hash），不重新加载
          const curSrc = (wv as unknown as { getURL?: () => string }).getURL?.() || wv.src || ''
          try {
            const cu = new URL(curSrc)
            const tu = new URL(finalUrl)
            const norm = (u: URL) => `${u.origin}${u.pathname.replace(/\/+$/, '')}${u.search}`
            if (norm(cu) === norm(tu)) {
              return { success: true, data: `浏览器已在 ${curSrc}，无需重新加载` }
            }
          } catch { /* URL 解析失败则继续导航 */ }
          setCurrentUrl(finalUrl)
          setInputUrl(finalUrl)
          wv.src = finalUrl
          // 等待页面加载完成
          await new Promise<void>((resolve) => {
            const onStop = () => { wv.removeEventListener('did-stop-loading', onStop); resolve() }
            wv.addEventListener('did-stop-loading', onStop)
            setTimeout(resolve, 15000) // 超时 15s
          })
          return { success: true, data: `已导航到 ${finalUrl}` }
        }

        case 'screenshot': {
          // 使用 webview.capturePage() 截取页面截图
          const image = await (wv as unknown as { capturePage: () => Promise<Electron.NativeImage> }).capturePage()
          const dataUrl = image.toDataURL()
          // 返回 DOM 文本摘要（AI 无法直接看图，提供可访问性信息）
          const accessibilityInfo = await wv.executeJavaScript(`
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
          return { success: true, data: JSON.stringify({ screenshot: dataUrl, page: JSON.parse(accessibilityInfo) }) }
        }

        case 'click': {
          const selector = params.selector ? String(params.selector) : ''
          const btn = String(params.button ?? 'left')
          const clicks = Number(params.clickCount ?? 1)

          if (selector) {
            const result = await wv.executeJavaScript(`
              (function() {
                var el = document.querySelector(${JSON.stringify(selector)});
                if (!el) return JSON.stringify({ ok: false, error: '未找到元素: ${selector.replace(/'/g, "\\'")}' });
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                var rect = el.getBoundingClientRect();
                var cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
                var evtInit = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: ${btn === 'right' ? 2 : btn === 'middle' ? 1 : 0} };
                for (var i = 0; i < ${clicks}; i++) {
                  el.dispatchEvent(new MouseEvent('mousedown', evtInit));
                  el.dispatchEvent(new MouseEvent('mouseup', evtInit));
                  el.dispatchEvent(new MouseEvent('click', { ...evtInit, detail: i + 1 }));
                }
                if (${clicks} >= 2) el.dispatchEvent(new MouseEvent('dblclick', evtInit));
                if (${btn === 'right' ? 'true' : 'false'}) el.dispatchEvent(new MouseEvent('contextmenu', evtInit));
                var text = (el.textContent || '').trim().slice(0, 50);
                return JSON.stringify({ ok: true, text: text, tag: el.tagName.toLowerCase() });
              })()
            `)
            const r = JSON.parse(result)
            return r.ok
              ? { success: true, data: `已${btn === 'right' ? '右键' : ''}${clicks > 1 ? '双' : ''}点击 <${r.tag}>${r.text ? ' "' + r.text + '"' : ''}` }
              : { success: false, error: r.error }
          } else if (params.x != null && params.y != null) {
            const cx = Number(params.x), cy = Number(params.y)
            await wv.executeJavaScript(`
              (function() {
                var el = document.elementFromPoint(${cx}, ${cy});
                if (!el) return;
                var evtInit = { bubbles: true, cancelable: true, clientX: ${cx}, clientY: ${cy}, button: ${btn === 'right' ? 2 : btn === 'middle' ? 1 : 0} };
                for (var i = 0; i < ${clicks}; i++) {
                  el.dispatchEvent(new MouseEvent('mousedown', evtInit));
                  el.dispatchEvent(new MouseEvent('mouseup', evtInit));
                  el.dispatchEvent(new MouseEvent('click', { ...evtInit, detail: i + 1 }));
                }
                if (${clicks} >= 2) el.dispatchEvent(new MouseEvent('dblclick', evtInit));
              })()
            `)
            return { success: true, data: `已点击坐标 (${cx}, ${cy})` }
          } else {
            return { success: false, error: '需要提供 selector 或 x/y 坐标' }
          }
        }

        case 'type': {
          const selector = String(params.selector ?? '')
          const text = String(params.text ?? '')
          const clear = params.clear === true
          const submit = params.submit === true
          if (!selector) return { success: false, error: 'selector 参数缺失' }
          const result = await wv.executeJavaScript(`
            (function() {
              var el = document.querySelector(${JSON.stringify(selector)});
              if (!el) return JSON.stringify({ ok: false, error: '未找到元素: ${selector.replace(/'/g, "\\'")}' });
              el.focus();
              if (${clear}) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
              var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
                || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
              if (nativeInputValueSetter) {
                nativeInputValueSetter.call(el, ${clear ? '' : 'el.value + '}${JSON.stringify(text)});
              } else {
                el.value = ${clear ? '' : 'el.value + '}${JSON.stringify(text)};
              }
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              if (${submit}) {
                // 模拟按下 Enter 键
                var enterOpts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
                el.dispatchEvent(new KeyboardEvent('keydown', enterOpts));
                el.dispatchEvent(new KeyboardEvent('keypress', enterOpts));
                el.dispatchEvent(new KeyboardEvent('keyup', enterOpts));
                // 如果在 form 内，也尝试提交表单
                var form = el.closest('form');
                if (form) {
                  var submitEvent = new Event('submit', { bubbles: true, cancelable: true });
                  if (form.dispatchEvent(submitEvent)) {
                    // 如果 submit 事件未被取消，手动调用 form.submit()
                    try { form.requestSubmit ? form.requestSubmit() : form.submit(); } catch(e) {}
                  }
                }
              }
              return JSON.stringify({ ok: true });
            })()
          `)
          const r = JSON.parse(result)
          return r.ok
            ? { success: true, data: `已在 ${selector} 中输入文字${submit ? '并提交' : ''}` }
            : { success: false, error: r.error }
        }

        case 'scroll': {
          const direction = String(params.direction ?? 'down')
          const amount = Number(params.amount ?? 300)
          const selector = params.selector ? String(params.selector) : null
          await wv.executeJavaScript(`
            (function() {
              var target = ${selector ? `document.querySelector(${JSON.stringify(selector)}) || window` : 'window'};
              var opts = { behavior: 'smooth' };
              if ('${direction}' === 'down') target.scrollBy({ top: ${amount}, ...opts });
              else if ('${direction}' === 'up') target.scrollBy({ top: -${amount}, ...opts });
              else if ('${direction}' === 'left') target.scrollBy({ left: -${amount}, ...opts });
              else if ('${direction}' === 'right') target.scrollBy({ left: ${amount}, ...opts });
            })()
          `)
          return { success: true, data: `已滚动 ${direction} ${amount}px` }
        }

        case 'get_content': {
          const selector = params.selector ? String(params.selector) : null
          const type = String(params.type ?? 'text')
          const result = await wv.executeJavaScript(`
            (function() {
              var el = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : 'document.body'};
              if (!el) return JSON.stringify({ ok: false, error: '未找到元素' });
              var content;
              if ('${type}' === 'html') content = el.innerHTML.slice(0, 5000);
              else if ('${type}' === 'value') content = el.value || '';
              else content = (el.innerText || el.textContent || '').slice(0, 5000);
              return JSON.stringify({ ok: true, content: content });
            })()
          `)
          const r = JSON.parse(result)
          return r.ok ? { success: true, data: r.content } : { success: false, error: r.error }
        }

        case 'wait': {
          const selector = String(params.selector ?? '')
          const timeout = Number(params.timeout ?? 5000)
          if (!selector) return { success: false, error: 'selector 参数缺失' }
          const result = await wv.executeJavaScript(`
            new Promise(function(resolve) {
              var el = document.querySelector(${JSON.stringify(selector)});
              if (el) return resolve(JSON.stringify({ ok: true }));
              var timer = setTimeout(function() { observer.disconnect(); resolve(JSON.stringify({ ok: false, error: '超时' })); }, ${timeout});
              var observer = new MutationObserver(function() {
                if (document.querySelector(${JSON.stringify(selector)})) {
                  clearTimeout(timer); observer.disconnect(); resolve(JSON.stringify({ ok: true }));
                }
              });
              observer.observe(document.body, { childList: true, subtree: true });
            })
          `)
          const r = JSON.parse(result)
          return r.ok
            ? { success: true, data: `元素 ${selector} 已出现` }
            : { success: false, error: `等待 ${selector} 超时 (${timeout}ms)` }
        }

        case 'evaluate': {
          const expression = String(params.expression ?? '')
          if (!expression) return { success: false, error: 'expression 参数缺失' }
          // 通过 DOM script 标签在主世界执行
          const wrappedScript = `
            (function() {
              try {
                var s = document.createElement('script');
                s.textContent = 'window.__TACO_EVAL_RESULT__ = (function(){ try { return JSON.stringify(eval(' + ${JSON.stringify(JSON.stringify(expression))} + ')); } catch(e) { return JSON.stringify({__error__: e.message}); } })()';
                document.documentElement.appendChild(s);
                s.remove();
                var result = window.__TACO_EVAL_RESULT__;
                delete window.__TACO_EVAL_RESULT__;
                return result || 'undefined';
              } catch(e) { return JSON.stringify({__error__: e.message}); }
            })()
          `
          const raw = await wv.executeJavaScript(wrappedScript)
          try {
            const parsed = JSON.parse(raw)
            if (parsed && parsed.__error__) return { success: false, error: parsed.__error__ }
            return { success: true, data: typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2) }
          } catch {
            return { success: true, data: String(raw) }
          }
        }

        case 'get_info': {
          const info = await wv.executeJavaScript(`
            JSON.stringify({
              url: location.href,
              title: document.title,
              viewport: { width: window.innerWidth, height: window.innerHeight },
              scrollPosition: { x: window.scrollX, y: window.scrollY },
              documentSize: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
              readyState: document.readyState,
              cookies: document.cookie.length,
              forms: document.forms.length,
              links: document.links.length,
              images: document.images.length,
            })
          `)
          return { success: true, data: info }
        }

        case 'hover': {
          const selector = params.selector ? String(params.selector) : ''
          if (selector) {
            await wv.executeJavaScript(`
              (function() {
                var el = document.querySelector(${JSON.stringify(selector)});
                if (!el) return;
                el.scrollIntoView({ block: 'center', behavior: 'instant' });
                var rect = el.getBoundingClientRect();
                var cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
                el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: cx, clientY: cy }));
                el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, clientX: cx, clientY: cy }));
                el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: cx, clientY: cy }));
              })()
            `)
            return { success: true, data: `已悬停在 ${selector}` }
          } else if (params.x != null && params.y != null) {
            const hx = Number(params.x), hy = Number(params.y)
            await wv.executeJavaScript(`
              (function() {
                var el = document.elementFromPoint(${hx}, ${hy});
                if (!el) return;
                el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: ${hx}, clientY: ${hy} }));
                el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, clientX: ${hx}, clientY: ${hy} }));
                el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: ${hx}, clientY: ${hy} }));
              })()
            `)
            return { success: true, data: `已悬停在 (${hx}, ${hy})` }
          }
          return { success: false, error: '需要提供 selector 或 x/y 坐标' }
        }

        case 'keypress': {
          const key = String(params.key ?? '')
          if (!key) return { success: false, error: 'key 参数缺失' }
          const mods = Array.isArray(params.modifiers) ? params.modifiers as string[] : []
          await wv.executeJavaScript(`
            (function() {
              var el = document.activeElement || document.body;
              var opts = {
                key: ${JSON.stringify(key)},
                code: ${JSON.stringify(key.length === 1 ? 'Key' + key.toUpperCase() : key)},
                bubbles: true, cancelable: true,
                ctrlKey: ${mods.includes('ctrl')},
                altKey: ${mods.includes('alt')},
                shiftKey: ${mods.includes('shift')},
                metaKey: ${mods.includes('meta')},
              };
              el.dispatchEvent(new KeyboardEvent('keydown', opts));
              if (${JSON.stringify(key)}.length === 1 && !${mods.includes('ctrl')} && !${mods.includes('meta')}) {
                el.dispatchEvent(new KeyboardEvent('keypress', opts));
              }
              el.dispatchEvent(new KeyboardEvent('keyup', opts));
            })()
          `)
          const modStr = mods.length > 0 ? mods.join('+') + '+' : ''
          return { success: true, data: `已按下 ${modStr}${key}` }
        }

        case 'drag': {
          const steps = Number(params.steps ?? 10)
          const result = await wv.executeJavaScript(`
            (function() {
              function getPos(sel, x, y) {
                if (sel) {
                  var el = document.querySelector(sel);
                  if (!el) return null;
                  el.scrollIntoView({ block: 'center', behavior: 'instant' });
                  var r = el.getBoundingClientRect();
                  return { x: r.x + r.width / 2, y: r.y + r.height / 2, el: el };
                }
                if (x != null && y != null) {
                  return { x: x, y: y, el: document.elementFromPoint(x, y) };
                }
                return null;
              }
              var from = getPos(${JSON.stringify(params.fromSelector ? String(params.fromSelector) : null)}, ${params.fromX ?? 'null'}, ${params.fromY ?? 'null'});
              var to = getPos(${JSON.stringify(params.toSelector ? String(params.toSelector) : null)}, ${params.toX ?? 'null'}, ${params.toY ?? 'null'});
              if (!from || !to) return JSON.stringify({ ok: false, error: '无法定位起点或终点' });
              var el = from.el || document.body;
              el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: from.x, clientY: from.y }));
              for (var i = 1; i <= ${steps}; i++) {
                var p = i / ${steps};
                var mx = from.x + (to.x - from.x) * p;
                var my = from.y + (to.y - from.y) * p;
                el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: mx, clientY: my }));
              }
              el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: to.x, clientY: to.y }));
              var dropEl = document.elementFromPoint(to.x, to.y) || el;
              dropEl.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: to.x, clientY: to.y }));
              return JSON.stringify({ ok: true, from: { x: Math.round(from.x), y: Math.round(from.y) }, to: { x: Math.round(to.x), y: Math.round(to.y) } });
            })()
          `)
          const r = JSON.parse(result)
          return r.ok
            ? { success: true, data: `已拖拽从 (${r.from.x},${r.from.y}) 到 (${r.to.x},${r.to.y})` }
            : { success: false, error: r.error }
        }

        case 'select': {
          const selector = String(params.selector ?? '')
          if (!selector) return { success: false, error: 'selector 参数缺失' }
          const result = await wv.executeJavaScript(`
            (function() {
              var sel = document.querySelector(${JSON.stringify(selector)});
              if (!sel || sel.tagName !== 'SELECT') return JSON.stringify({ ok: false, error: '未找到 <select> 元素' });
              var opts = Array.from(sel.options);
              var target = null;
              var val = ${JSON.stringify(params.value != null ? String(params.value) : null)};
              var lbl = ${JSON.stringify(params.label != null ? String(params.label) : null)};
              if (val != null) target = opts.find(function(o) { return o.value === val; });
              if (!target && lbl != null) target = opts.find(function(o) { return o.textContent.trim() === lbl; });
              if (!target) return JSON.stringify({ ok: false, error: '未找到匹配选项' });
              sel.value = target.value;
              sel.dispatchEvent(new Event('change', { bubbles: true }));
              return JSON.stringify({ ok: true, label: target.textContent.trim() });
            })()
          `)
          const r = JSON.parse(result)
          return r.ok
            ? { success: true, data: `已选择 "${r.label}"` }
            : { success: false, error: r.error }
        }

        default:
          return { success: false, error: `未知操作: ${action}` }
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }, [])

  // 暴露 executeAction 给父组件
  useImperativeHandle(ref, () => ({ executeAction }), [executeAction])

  /* ---- Console actions ---- */
  const handleClearConsole = useCallback(() => {
    setConsoleEntries([])
    setErrorCount(0)
    setWarnCount(0)
  }, [])

  const handleClearNetwork = useCallback(() => { setNetworkEntries([]) }, [])

  /* ---- Storage: 从 webview 读取数据 ---- */
  const refreshStorage = useCallback(async () => {
    const wv = webviewRef.current
    if (!wv) return
    setStorageLoading(true)
    try {
      // Cookie
      const cookieStr: string = await wv.executeJavaScript('document.cookie')
      const cookieItems: StorageItem[] = cookieStr
        ? cookieStr.split(';').map((s) => {
            const idx = s.indexOf('=')
            return idx > -1
              ? { key: s.slice(0, idx).trim(), value: s.slice(idx + 1).trim() }
              : { key: s.trim(), value: '' }
          })
        : []
      setCookies(cookieItems)

      // LocalStorage
      const lsStr: string = await wv.executeJavaScript(`
        JSON.stringify(
          Object.keys(localStorage).map(k => ({ key: k, value: localStorage.getItem(k) || '' }))
        )
      `)
      setLocalStorageItems(JSON.parse(lsStr || '[]'))

      // SessionStorage
      const ssStr: string = await wv.executeJavaScript(`
        JSON.stringify(
          Object.keys(sessionStorage).map(k => ({ key: k, value: sessionStorage.getItem(k) || '' }))
        )
      `)
      setSessionStorageItems(JSON.parse(ssStr || '[]'))
    } catch (err) {
      console.error('读取 Storage 失败:', err)
    } finally {
      setStorageLoading(false)
    }
  }, [])

  // 切换到 Storage tab 时自动刷新
  useEffect(() => {
    if (devToolsOpen && activeTab === 'storage') refreshStorage()
  }, [devToolsOpen, activeTab, refreshStorage])

  /* ---- Storage: 编辑、删除、新增 ---- */
  const handleStorageEdit = useCallback(async (key: string, newValue: string) => {
    const wv = webviewRef.current
    if (!wv) return
    const store = storageSubTab === 'cookie' ? 'cookie' : storageSubTab
    try {
      if (store === 'cookie') {
        await wv.executeJavaScript(`document.cookie = ${JSON.stringify(`${key}=${newValue}; path=/`)}`)
      } else {
        await wv.executeJavaScript(`${store}.setItem(${JSON.stringify(key)}, ${JSON.stringify(newValue)})`)
      }
      setEditingStorage(null)
      refreshStorage()
    } catch (err) { console.error('编辑 Storage 失败:', err) }
  }, [storageSubTab, refreshStorage])

  const handleStorageDelete = useCallback(async (key: string) => {
    const wv = webviewRef.current
    if (!wv) return
    const store = storageSubTab
    try {
      if (store === 'cookie') {
        await wv.executeJavaScript(`document.cookie = ${JSON.stringify(`${key}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`)}`)
      } else {
        await wv.executeJavaScript(`${store}.removeItem(${JSON.stringify(key)})`)
      }
      refreshStorage()
    } catch (err) { console.error('删除 Storage 失败:', err) }
  }, [storageSubTab, refreshStorage])

  const handleStorageAdd = useCallback(async () => {
    if (!newStorageKey.trim()) return
    const wv = webviewRef.current
    if (!wv) return
    const store = storageSubTab
    try {
      if (store === 'cookie') {
        await wv.executeJavaScript(`document.cookie = ${JSON.stringify(`${newStorageKey.trim()}=${newStorageValue}; path=/`)}`)
      } else {
        await wv.executeJavaScript(`${store}.setItem(${JSON.stringify(newStorageKey.trim())}, ${JSON.stringify(newStorageValue)})`)
      }
      setAddingStorage(false)
      setNewStorageKey('')
      setNewStorageValue('')
      refreshStorage()
    } catch (err) { console.error('新增 Storage 失败:', err) }
  }, [storageSubTab, newStorageKey, newStorageValue, refreshStorage])

  /* ---- Console: 执行 JS 表达式 ---- */
  const handleExecJs = useCallback(async () => {
    const code = jsInput.trim()
    if (!code) return
    const wv = webviewRef.current
    if (!wv) return

    // 添加一条用户输入记录
    setConsoleEntries((prev) => [...prev, {
      id: ++entryIdCounter, level: 'info', message: `> ${code}`, timestamp: Date.now(),
    }])

    try {
      const result = await wv.executeJavaScript(`
        (function() {
          try {
            var __r = eval(${JSON.stringify(code)});
            return typeof __r === 'object' ? JSON.stringify(__r, null, 2) : String(__r);
          } catch(e) { return 'Error: ' + e.message; }
        })()
      `)
      setConsoleEntries((prev) => [...prev, {
        id: ++entryIdCounter, level: 'log', message: String(result), timestamp: Date.now(),
      }])
    } catch (err) {
      setConsoleEntries((prev) => [...prev, {
        id: ++entryIdCounter, level: 'error',
        message: `执行失败: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
      }])
    }
    setJsInput('')
  }, [jsInput])

  /* ---- Filtered console entries ---- */
  const filteredEntries = consoleFilter === 'all'
    ? consoleEntries
    : consoleEntries.filter((e) =>
        consoleFilter === 'error' ? (e.level === 'error' || e.level === 'network')
          : consoleFilter === 'warn' ? e.level === 'warn'
          : e.level === 'log' || e.level === 'info'
      )

  /* ---- Helper: format bytes ---- */
  const fmtSize = (s: string) => {
    const n = parseInt(s, 10)
    if (isNaN(n)) return s
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    return `${(n / (1024 * 1024)).toFixed(1)} MB`
  }

  const fmtTime = (ts: number) =>
    new Date(ts).toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })

  /** 尝试格式化 JSON，失败则原样返回 */
  const tryFormatJson = (s: string): string => {
    try {
      return JSON.stringify(JSON.parse(s), null, 2)
    } catch { return s }
  }

  /* ---- Active storage items ---- */
  const activeStorageItems =
    storageSubTab === 'cookie' ? cookies
      : storageSubTab === 'localStorage' ? localStorageItems
      : sessionStorageItems

  /* ================================================================== */
  /*  Render                                                             */
  /* ================================================================== */

  return (
    <div className="embedded-browser">
      {/* 导航栏 */}
      <div className="browser-toolbar">
        <div className="browser-nav-buttons">
          <button type="button" className="browser-nav-btn" onClick={handleGoBack} disabled={!canGoBack} title="后退">‹</button>
          <button type="button" className="browser-nav-btn" onClick={handleGoForward} disabled={!canGoForward} title="前进">›</button>
          <button type="button" className="browser-nav-btn" onClick={handleReload} title="刷新">{loading ? '✕' : '↻'}</button>
        </div>
        <div className="browser-url-bar">
          <input
            className="browser-url-input"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleNavigate() }}
            placeholder="输入网址..."
            spellCheck={false}
          />
        </div>
        <button
          type="button"
          className={`browser-console-toggle ${errorCount > 0 ? 'has-errors' : ''}`}
          onClick={() => setDevToolsOpen((v) => !v)}
          title={devToolsOpen ? '关闭开发工具' : '打开开发工具'}
        >
          {errorCount > 0 ? (
            <span className="browser-console-badge error">{errorCount}</span>
          ) : warnCount > 0 ? (
            <span className="browser-console-badge warn">{warnCount}</span>
          ) : null}
          DevTools
        </button>
        <button type="button" className="browser-close-btn" onClick={onClose} title="关闭浏览器">✕</button>
      </div>

      {loading && <div className="browser-loading-bar" />}

      {/* Webview */}
      <div className="browser-webview-wrapper">
        {isDragging && <div className="browser-webview-overlay" />}
        <webview
          ref={webviewRef as React.RefObject<Electron.WebviewTag>}
          src={currentUrl}
          className="browser-webview"
          /* @ts-expect-error webview attributes */
          allowpopups="true"
        />
      </div>

      {/* 拖拽分隔条 */}
      {devToolsOpen && (
        <div className="browser-console-resize-handle" onMouseDown={handleResizeStart}>
          <div className="browser-console-resize-line" />
        </div>
      )}

      {/* 开发者工具面板 */}
      {devToolsOpen && (
        <div className="browser-devtools" style={{ height: panelHeight }}>
          {/* Tab 栏 */}
          <div className="devtools-tabs">
            <div className="devtools-tab-list">
              {(['console', 'network', 'storage'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  className={`devtools-tab ${activeTab === tab ? 'active' : ''}`}
                  onClick={() => setActiveTab(tab)}
                >
                  {tab === 'console' ? 'Console' : tab === 'network' ? 'Network' : 'Storage'}
                  {tab === 'console' && errorCount > 0 && (
                    <span className="devtools-tab-badge error">{errorCount}</span>
                  )}
                  {tab === 'network' && networkEntries.length > 0 && (
                    <span className="devtools-tab-badge">{networkEntries.length}</span>
                  )}
                </button>
              ))}
            </div>
            <div className="devtools-tab-actions">
              {activeTab === 'console' && errorCount > 0 && (
                <button type="button" className="browser-console-action send-ai" onClick={sendAllErrorsToAI} title="将所有错误发送给 AI 分析修复">
                  发送错误给 AI
                </button>
              )}
              {activeTab === 'console' && (
                <button type="button" className="browser-console-action" onClick={handleClearConsole} title="清空">清空</button>
              )}
              {activeTab === 'network' && (
                <button type="button" className="browser-console-action" onClick={handleClearNetwork} title="清空">清空</button>
              )}
              {activeTab === 'storage' && (
                <button type="button" className="browser-console-action" onClick={refreshStorage} title="刷新">刷新</button>
              )}
              <button type="button" className="browser-console-action" onClick={() => setDevToolsOpen(false)} title="关闭">✕</button>
            </div>
          </div>

          {/* ---- Console Tab ---- */}
          {activeTab === 'console' && (
            <>
              <div className="browser-console-header">
                <div className="browser-console-filters">
                  {(['all', 'error', 'warn', 'log'] as const).map((f) => (
                    <button
                      key={f}
                      type="button"
                      className={`browser-console-filter ${consoleFilter === f ? 'active' : ''}`}
                      onClick={() => setConsoleFilter(f)}
                    >
                      {f === 'all' ? '全部' : f === 'error' ? '错误' : f === 'warn' ? '警告' : '日志'}
                      {f === 'error' && errorCount > 0 && <span className="browser-console-count error">{errorCount}</span>}
                      {f === 'warn' && warnCount > 0 && <span className="browser-console-count warn">{warnCount}</span>}
                    </button>
                  ))}
                </div>
              </div>
              <div className="browser-console-body">
                {filteredEntries.length === 0 ? (
                  <div className="browser-console-empty">暂无日志</div>
                ) : (
                  filteredEntries.map((entry) => {
                    const cfg = LEVEL_CONFIG[entry.level]
                    const isErr = entry.level === 'error' || entry.level === 'network'
                    return (
                      <div key={entry.id} className={`browser-console-entry ${cfg.cls}`}>
                        <span className="browser-console-level">{cfg.label}</span>
                        <span className="browser-console-time">{fmtTime(entry.timestamp)}</span>
                        <span className="browser-console-msg">{entry.message}</span>
                        {entry.source && (
                          <span className="browser-console-source">
                            {entry.source.split('/').pop()}{entry.line ? `:${entry.line}` : ''}
                          </span>
                        )}
                        {isErr && (
                          <button
                            type="button"
                            className="console-send-ai-btn"
                            onClick={() => sendSingleErrorToAI(entry)}
                            title="发送给 AI 分析"
                          >
                            → AI
                          </button>
                        )}
                      </div>
                    )
                  })
                )}
                <div ref={consoleEndRef} />
              </div>
              {/* JS 输入框 */}
              <div className="devtools-console-input">
                <span className="devtools-console-prompt">&gt;</span>
                <input
                  ref={jsInputRef}
                  className="devtools-console-input-field"
                  value={jsInput}
                  onChange={(e) => setJsInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleExecJs() }}
                  placeholder="输入 JavaScript 表达式..."
                  spellCheck={false}
                />
              </div>
            </>
          )}

          {/* ---- Network Tab ---- */}
          {activeTab === 'network' && (
            <div className="devtools-network">
              <div className="devtools-network-header">
                <span className="nw-col nw-col-method">Method</span>
                <span className="nw-col nw-col-url">URL</span>
                <span className="nw-col nw-col-status">Status</span>
                <span className="nw-col nw-col-type">Type</span>
                <span className="nw-col nw-col-size">Size</span>
                <span className="nw-col nw-col-time">Time</span>
              </div>
              <div className="devtools-network-body">
                {networkEntries.length === 0 ? (
                  <div className="browser-console-empty">暂无请求，页面中的 fetch/XHR 请求将在此显示</div>
                ) : (
                  networkEntries.map((entry) => {
                    const isError = entry.status === 0 || entry.status >= 400
                    const isExpanded = expandedNetworkId === entry.id
                    return (
                      <div key={entry.id} className="devtools-network-item">
                        <div
                          className={`devtools-network-row ${isError ? 'error' : ''} ${isExpanded ? 'expanded' : ''}`}
                          onClick={() => setExpandedNetworkId(isExpanded ? null : entry.id)}
                          title={entry.url}
                        >
                          <span className="nw-col nw-col-method">{entry.method}</span>
                          <span className="nw-col nw-col-url">{entry.url}</span>
                          <span className={`nw-col nw-col-status ${isError ? 'error' : entry.status >= 300 ? 'warn' : 'ok'}`}>
                            {entry.status || 'ERR'}
                          </span>
                          <span className="nw-col nw-col-type">{entry.type}</span>
                          <span className="nw-col nw-col-size">{fmtSize(entry.size)}</span>
                          <span className="nw-col nw-col-time">{entry.duration}ms</span>
                          {isError && (
                            <button
                              type="button"
                              className="console-send-ai-btn"
                              onClick={(e) => { e.stopPropagation(); sendErrorsToAI([{
                                id: entry.id, level: 'network', timestamp: entry.timestamp,
                                message: `${entry.method} ${entry.url} → ${entry.status || 'ERR'} ${entry.statusText} (${entry.duration}ms)`,
                              }])}}
                              title="发送给 AI 分析"
                            >
                              → AI
                            </button>
                          )}
                        </div>
                        {isExpanded && (
                          <div className="devtools-network-detail">
                            <div className="nw-detail-section">
                              <div className="nw-detail-title">General</div>
                              <div className="nw-detail-kv"><span className="nw-k">URL:</span><span className="nw-v">{entry.url}</span></div>
                              <div className="nw-detail-kv"><span className="nw-k">Method:</span><span className="nw-v">{entry.method}</span></div>
                              <div className="nw-detail-kv"><span className="nw-k">Status:</span><span className="nw-v">{entry.status} {entry.statusText}</span></div>
                              <div className="nw-detail-kv"><span className="nw-k">Duration:</span><span className="nw-v">{entry.duration}ms</span></div>
                            </div>
                            {entry.reqHeaders && Object.keys(entry.reqHeaders).length > 0 && (
                              <div className="nw-detail-section">
                                <div className="nw-detail-title">Request Headers</div>
                                {Object.entries(entry.reqHeaders).map(([k, v]) => (
                                  <div key={k} className="nw-detail-kv"><span className="nw-k">{k}:</span><span className="nw-v">{v}</span></div>
                                ))}
                              </div>
                            )}
                            {entry.resHeaders && Object.keys(entry.resHeaders).length > 0 && (
                              <div className="nw-detail-section">
                                <div className="nw-detail-title">Response Headers</div>
                                {Object.entries(entry.resHeaders).map(([k, v]) => (
                                  <div key={k} className="nw-detail-kv"><span className="nw-k">{k}:</span><span className="nw-v">{v}</span></div>
                                ))}
                              </div>
                            )}
                            {entry.responseBody && (
                              <div className="nw-detail-section">
                                <div className="nw-detail-title">Response Body</div>
                                <pre className="nw-detail-body">{tryFormatJson(entry.responseBody)}</pre>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })
                )}
              </div>
            </div>
          )}

          {/* ---- Storage Tab ---- */}
          {activeTab === 'storage' && (
            <div className="devtools-storage">
              <div className="devtools-storage-subtabs">
                {(['cookie', 'localStorage', 'sessionStorage'] as const).map((st) => (
                  <button
                    key={st}
                    type="button"
                    className={`devtools-storage-subtab ${storageSubTab === st ? 'active' : ''}`}
                    onClick={() => { setStorageSubTab(st); setExpandedStorageKey(null); setEditingStorage(null); setAddingStorage(false) }}
                  >
                    {st === 'cookie' ? `Cookie (${cookies.length})` : st === 'localStorage' ? `Local (${localStorageItems.length})` : `Session (${sessionStorageItems.length})`}
                  </button>
                ))}
                <button type="button" className="devtools-storage-add-btn" onClick={() => { setAddingStorage(true); setEditingStorage(null) }} title="新增">+ 新增</button>
              </div>
              <div className="devtools-storage-body">
                {/* 新增表单 */}
                {addingStorage && (
                  <div className="devtools-storage-add-form">
                    <input
                      className="storage-edit-input"
                      value={newStorageKey}
                      onChange={(e) => setNewStorageKey(e.target.value)}
                      placeholder="Key"
                      spellCheck={false}
                    />
                    <input
                      className="storage-edit-input wide"
                      value={newStorageValue}
                      onChange={(e) => setNewStorageValue(e.target.value)}
                      placeholder="Value"
                      spellCheck={false}
                      onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleStorageAdd() }}
                    />
                    <button type="button" className="storage-btn save" onClick={handleStorageAdd}>保存</button>
                    <button type="button" className="storage-btn cancel" onClick={() => { setAddingStorage(false); setNewStorageKey(''); setNewStorageValue('') }}>取消</button>
                  </div>
                )}
                {storageLoading ? (
                  <div className="browser-console-empty">加载中...</div>
                ) : activeStorageItems.length === 0 && !addingStorage ? (
                  <div className="browser-console-empty">暂无数据</div>
                ) : (
                  <div className="devtools-storage-table">
                    <div className="devtools-storage-row header">
                      <span className="storage-key">Key</span>
                      <span className="storage-value">Value</span>
                      <span className="storage-actions">操作</span>
                    </div>
                    {activeStorageItems.map((item, i) => {
                      const isExpanded = expandedStorageKey === `${storageSubTab}-${item.key}-${i}`
                      const isEditing = editingStorage?.key === item.key
                      const expandKey = `${storageSubTab}-${item.key}-${i}`
                      return (
                        <div key={expandKey} className="devtools-storage-item">
                          <div
                            className={`devtools-storage-row ${isExpanded ? 'expanded' : ''}`}
                            onClick={() => { setExpandedStorageKey(isExpanded ? null : expandKey); setEditingStorage(null) }}
                          >
                            <span className="storage-key" title={item.key}>{item.key}</span>
                            <span className="storage-value" title={item.value}>
                              {item.value.length > 80 ? item.value.slice(0, 80) + '...' : item.value}
                            </span>
                            <span className="storage-actions" onClick={(e) => e.stopPropagation()}>
                              <button type="button" className="storage-btn edit" onClick={() => setEditingStorage({ key: item.key, value: item.value })} title="编辑">✎</button>
                              <button type="button" className="storage-btn delete" onClick={() => handleStorageDelete(item.key)} title="删除">✕</button>
                            </span>
                          </div>
                          {/* 展开查看完整值 */}
                          {isExpanded && !isEditing && (
                            <div className="devtools-storage-expanded">
                              <pre className="storage-expanded-value">{tryFormatJson(item.value)}</pre>
                            </div>
                          )}
                          {/* 编辑模式 */}
                          {isEditing && (
                            <div className="devtools-storage-edit">
                              <textarea
                                className="storage-edit-textarea"
                                defaultValue={editingStorage.value}
                                rows={4}
                                spellCheck={false}
                                ref={(el) => el?.focus()}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                                    handleStorageEdit(item.key, (e.target as HTMLTextAreaElement).value)
                                  }
                                  if (e.key === 'Escape') setEditingStorage(null)
                                }}
                              />
                              <div className="storage-edit-actions">
                                <span className="storage-edit-hint">Cmd+Enter 保存 · Esc 取消</span>
                                <button type="button" className="storage-btn save" onClick={(e) => {
                                  const textarea = (e.target as HTMLElement).closest('.devtools-storage-edit')?.querySelector('textarea')
                                  if (textarea) handleStorageEdit(item.key, textarea.value)
                                }}>保存</button>
                                <button type="button" className="storage-btn cancel" onClick={() => setEditingStorage(null)}>取消</button>
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
})
