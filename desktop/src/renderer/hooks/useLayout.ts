/**
 * 布局管理 Hook
 * 
 * 管理侧边栏宽度、窗口尺寸、拖拽调整等布局相关逻辑
 */

import { useState, useEffect, useCallback, useRef } from 'react'

const SIDEBAR_MIN_WIDTH = 220
const SIDEBAR_DEFAULT_RATIO = 0.2
const CHAT_MIN_WIDTH = 640

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function useLayout() {
  const [sidebarVisible, setSidebarVisible] = useState<boolean>(true)
  const [sidebarWidthRatio, setSidebarWidthRatio] = useState<number>(() => {
    const savedRatio = Number(localStorage.getItem('taco.sidebarRatio') ?? '')
    if (Number.isFinite(savedRatio) && savedRatio > 0) {
      return savedRatio
    }
    // 兼容历史像素配置
    const savedWidth = Number(localStorage.getItem('taco.sidebarWidth') ?? '')
    if (Number.isFinite(savedWidth) && savedWidth > 0) {
      const viewport = typeof window === 'undefined' ? 1440 : window.innerWidth
      const fallbackAreaWidth = Math.max(1, viewport - 340)
      return savedWidth / fallbackAreaWidth
    }
    return SIDEBAR_DEFAULT_RATIO
  })
  const [appShellWidth, setAppShellWidth] = useState<number>(() =>
    typeof window === 'undefined' ? 1440 : window.innerWidth
  )
  const appShellRef = useRef<HTMLDivElement | null>(null)

  // 监听窗口尺寸变化
  useEffect(() => {
    const element = appShellRef.current
    if (!element) return

    const updateWidth = () => {
      const measured = element.clientWidth
      if (Number.isFinite(measured) && measured > 0) {
        setAppShellWidth(measured)
      } else {
        setAppShellWidth(window.innerWidth)
      }
    }

    updateWidth()
    const observer = new ResizeObserver(() => updateWidth())
    observer.observe(element)

    window.addEventListener('resize', updateWidth)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateWidth)
    }
  }, [])

  // 持久化侧边栏比例
  useEffect(() => {
    const normalized = Number.isFinite(sidebarWidthRatio) ? sidebarWidthRatio : SIDEBAR_DEFAULT_RATIO
    localStorage.setItem('taco.sidebarRatio', String(normalized))
  }, [sidebarWidthRatio])

  // 计算侧边栏最小/最大比例
  const sidebarAreaWidth = Math.max(0, appShellWidth)
  const sidebarAutoMinWidth = Math.min(SIDEBAR_MIN_WIDTH, sidebarAreaWidth)
  const sidebarAutoMaxWidth = Math.max(sidebarAutoMinWidth, sidebarAreaWidth - CHAT_MIN_WIDTH)
  const sidebarMinRatio = sidebarAreaWidth > 0 ? (sidebarAutoMinWidth / sidebarAreaWidth) : 0
  const sidebarMaxRatio = sidebarAreaWidth > 0
    ? clampNumber(sidebarAutoMaxWidth / sidebarAreaWidth, sidebarMinRatio, 1)
    : 0

  // 确保侧边栏比例在有效范围内
  useEffect(() => {
    setSidebarWidthRatio((prev) => {
      const safePrev = Number.isFinite(prev) ? prev : SIDEBAR_DEFAULT_RATIO
      const next = clampNumber(safePrev, sidebarMinRatio, sidebarMaxRatio)
      return Math.abs(next - safePrev) < 0.0001 ? safePrev : next
    })
  }, [sidebarMinRatio, sidebarMaxRatio])

  // 拖拽调整侧边栏宽度
  const handleSidebarResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const getAreaWidth = () => {
      const shellWidth = appShellRef.current?.clientWidth ?? appShellWidth
      return Math.max(1, shellWidth)
    }
    const startAreaWidth = getAreaWidth()
    const startMinWidth = Math.min(SIDEBAR_MIN_WIDTH, startAreaWidth)
    const startMaxWidth = Math.max(startMinWidth, startAreaWidth - CHAT_MIN_WIDTH)
    const startMinRatio = startAreaWidth > 0 ? (startMinWidth / startAreaWidth) : 0
    const startMaxRatio = startAreaWidth > 0
      ? clampNumber(startMaxWidth / startAreaWidth, startMinRatio, 1)
      : startMinRatio
    const startRatio = clampNumber(sidebarWidthRatio, startMinRatio, startMaxRatio)
    const startWidth = startRatio * startAreaWidth

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.body.classList.add('is-resizing')

    const handleMouseMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX
      const areaWidth = getAreaWidth()
      const dragMinWidth = Math.min(SIDEBAR_MIN_WIDTH, areaWidth)
      const dragMaxWidth = Math.max(dragMinWidth, areaWidth - CHAT_MIN_WIDTH)
      const dragMinRatio = areaWidth > 0 ? (dragMinWidth / areaWidth) : 0
      const dragMaxRatio = areaWidth > 0
        ? clampNumber(dragMaxWidth / areaWidth, dragMinRatio, 1)
        : dragMinRatio
      const nextWidth = clampNumber(startWidth + dx, dragMinWidth, dragMaxWidth)
      const nextRatio = areaWidth > 0 ? (nextWidth / areaWidth) : dragMinRatio
      setSidebarWidthRatio(clampNumber(nextRatio, dragMinRatio, dragMaxRatio))
    }

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      document.body.classList.remove('is-resizing')
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp, { once: true })
  }, [appShellWidth, sidebarWidthRatio])

  // 计算实际宽度
  const clampedSidebarRatio = clampNumber(sidebarWidthRatio, sidebarMinRatio, sidebarMaxRatio)
  const clampedSidebarWidth = sidebarAreaWidth > 0 ? clampedSidebarRatio * sidebarAreaWidth : 0
  const effectiveSidebarWidth = sidebarVisible ? clampedSidebarWidth : 0

  return {
    sidebarVisible,
    setSidebarVisible,
    sidebarWidthRatio,
    appShellRef,
    appShellWidth,
    sidebarMinRatio,
    sidebarMaxRatio,
    effectiveSidebarWidth,
    handleSidebarResizeMouseDown,
  }
}
