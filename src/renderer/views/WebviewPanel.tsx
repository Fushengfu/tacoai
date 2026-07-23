import { useCallback, useEffect, useRef, useState } from 'react'

type WebviewPanelProps = {
  url: string
  onClose: () => void
}

export function WebviewPanel({ url, onClose }: Readonly<WebviewPanelProps>) {
  const panelRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [currentUrl, setCurrentUrl] = useState(url)
  const [addressInput, setAddressInput] = useState(url)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [loading, setLoading] = useState(true)
  const [panelWidth, setPanelWidth] = useState(() => {
    const saved = localStorage.getItem('taco.webviewPanelWidth')
    return saved ? Number(saved) : Math.floor(window.innerWidth / 2)
  })
  const panelWidthRef = useRef(panelWidth)
  const urlRef = useRef(url)

  // 同步 state 到 ref
  useEffect(() => {
    panelWidthRef.current = panelWidth
  }, [panelWidth])

  // 计算 panel 内容区域在窗口中的位置
  const getBounds = useCallback(() => {
    const el = contentRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    }
  }, [])

  // 通知主进程更新 BrowserView 位置
  const syncBounds = useCallback(() => {
    const bounds = getBounds()
    if (bounds && bounds.width > 0 && bounds.height > 0) {
      window.taco.browserView.setBounds(bounds)
    }
  }, [getBounds])

  // 监听主进程导航事件
  useEffect(() => {
    return window.taco.browserView.onNavigate((data) => {
      if (data.url && data.url !== 'about:blank') {
        setCurrentUrl(data.url)
        setAddressInput(data.url)
      }
      setCanGoBack(data.canGoBack)
      setCanGoForward(data.canGoForward)
      setLoading(data.loading)
    })
  }, [])

  // URL 变化 → IPC 导航
  useEffect(() => {
    if (url === urlRef.current) return
    urlRef.current = url
    setCurrentUrl(url)
    setAddressInput(url)
    window.taco.browserView.loadURL(url)
  }, [url])

  // 挂载 → 创建 BrowserView
  useEffect(() => {
    const bounds = getBounds()
    if (bounds) {
      window.taco.browserView.create(url, bounds)
    }

    // 窗口 resize → 同步位置
    const onResize = () => syncBounds()
    window.addEventListener('resize', onResize)

    return () => {
      window.removeEventListener('resize', onResize)
      window.taco.browserView.destroy()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // panel 宽度变化 → 同步位置
  useEffect(() => {
    syncBounds()
  }, [panelWidth, syncBounds])

  const handleGoBack = () => window.taco.browserView.goBack()
  const handleGoForward = () => window.taco.browserView.goForward()
  const handleReload = () => window.taco.browserView.reload()
  const handleStop = () => window.taco.browserView.stop()

  const handleAddressSubmit = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return
    let targetUrl = addressInput.trim()
    if (!targetUrl) return
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(targetUrl)) {
      if (targetUrl.includes('.') && !targetUrl.includes(' ')) {
        targetUrl = 'https://' + targetUrl
      }
    }
    window.taco.browserView.loadURL(targetUrl)
  }

  const handleOpenExternal = () => {
    if (currentUrl) {
      window.taco.browser.openExternal(currentUrl)
    }
  }

  // 拖拽调整宽度 — 纯 ghost divider，BrowserView 完全不参与
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = panelWidthRef.current

    // ghost divider: fixed 定位的竖线
    const ghost = document.createElement('div')
    ghost.style.cssText = `
      position: fixed;
      top: 0;
      bottom: 0;
      width: 2px;
      background: var(--accent, #56d9c5);
      opacity: 0.6;
      z-index: 99999;
      pointer-events: none;
      left: ${e.clientX}px;
    `
    document.body.appendChild(ghost)

    const onMove = (ev: MouseEvent) => {
      ghost.style.left = `${ev.clientX}px`
    }

    const onUp = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      ghost.remove()

      const delta = startX - ev.clientX
      const newWidth = Math.max(300, Math.min(window.innerWidth * 0.85, startWidth + delta))
      setPanelWidth(newWidth)
      panelWidthRef.current = newWidth
      localStorage.setItem('taco.webviewPanelWidth', String(newWidth))

      // 拖拽结束后一次性同步 BrowserView 位置
      // 使用 setTimeout 等 React 渲染完成后再取 bounds
      setTimeout(() => {
        const el = contentRef.current
        if (!el) return
        const rect = el.getBoundingClientRect()
        window.taco.browserView.setBounds({
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        })
      }, 0)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])

  // ⌘W 关闭
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'w') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const faviconUrl = (() => {
    try {
      const u = new URL(currentUrl)
      return `${u.protocol}//${u.hostname}/favicon.ico`
    } catch {
      return undefined
    }
  })()

  return (
    <div className="webview-panel" ref={panelRef} style={{ width: panelWidth }}>
      <div className="webview-panel-resize-handle" onMouseDown={handleResizeStart}>
        <div className="webview-panel-resize-line" />
      </div>

      <div className="webview-panel-navbar">
        <button type="button" className="webview-nav-btn" onClick={handleGoBack} disabled={!canGoBack} title="后退">‹</button>
        <button type="button" className="webview-nav-btn" onClick={handleGoForward} disabled={!canGoForward} title="前进">›</button>
        <button type="button" className="webview-nav-btn" onClick={loading ? handleStop : handleReload} title={loading ? '停止' : '刷新'}>
          {loading ? '✕' : '↻'}
        </button>

        <div className="webview-address-bar">
          {faviconUrl && (
            <img src={faviconUrl} className="webview-address-favicon"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} alt="" />
          )}
          <input type="text" className="webview-address-input" value={addressInput}
            onChange={(e) => setAddressInput(e.target.value)} onKeyDown={handleAddressSubmit} spellCheck={false} />
          {loading && <span className="webview-loading-spinner" />}
        </div>

        <button type="button" className="webview-nav-btn" onClick={handleOpenExternal} title="在系统浏览器中打开">↗</button>
        <button type="button" className="webview-nav-btn webview-nav-close" onClick={onClose} title="关闭 (⌘W)">✕</button>
      </div>

      {/* 内容区域占位 — BrowserView 浮在其上方 */}
      <div ref={contentRef} className="webview-container" />
    </div>
  )
}
