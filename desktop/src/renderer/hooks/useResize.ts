import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 拖拽调整面板宽度 hook
 *
 * 用于实现面板分隔线拖拽调整大小。
 * 从右侧边缘向左拖拽 → 右侧面板变宽，反之变窄。
 *
 * @param defaultWidth  初始宽度（px）
 * @param minWidth      最小宽度（px）
 * @param maxWidth      最大宽度（px）
 * @param storageKey    localStorage 持久化 key（可选）
 */
export function useResize(
  defaultWidth: number,
  minWidth: number,
  maxWidth: number,
  storageKey?: string,
  edge: 'left' | 'right' = 'right',
) {
  const [width, setWidth] = useState<number>(() => {
    if (storageKey) {
      const saved = localStorage.getItem(storageKey)
      if (saved) {
        const n = Number(saved)
        if (!Number.isNaN(n) && n >= minWidth && n <= maxWidth) return n
      }
    }
    return defaultWidth
  })

  const isDragging = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)

  // 持久化
  useEffect(() => {
    if (storageKey) {
      localStorage.setItem(storageKey, String(width))
    }
  }, [width, storageKey])

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      isDragging.current = true
      startX.current = e.clientX
      startWidth.current = width
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      document.body.classList.add('is-resizing')
    },
    [width]
  )

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return
      const dx = e.clientX - startX.current
      const baseWidth = edge === 'right' ? startWidth.current - dx : startWidth.current + dx
      const newWidth = Math.min(maxWidth, Math.max(minWidth, baseWidth))
      setWidth(newWidth)
    }

    const handleMouseUp = () => {
      if (!isDragging.current) return
      isDragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      document.body.classList.remove('is-resizing')
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [edge, minWidth, maxWidth])

  return { width, setWidth, handleMouseDown }
}
