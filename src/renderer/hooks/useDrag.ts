import { useCallback, useEffect, useRef } from 'react'

/**
 * 手动窗口拖拽 hook
 *
 * 替代 -webkit-app-region: drag，使 CSS cursor 不再被系统覆盖。
 * mousedown → 通知 main 开始拖拽（记录偏移）
 * mousemove → 通知 main 更新窗口位置
 * mouseup   → 通知 main 结束拖拽
 *
 * 防误触：跟踪实际拖拽行为，防止拖动时意外触发双击最大化。
 *
 * 用法：
 *   const drag = useDrag()
 *   <div {...drag} className="drag-bar" />
 */
export function useDrag() {
  /** 是否发生了实际的拖拽移动（≥3px），用于父组件判断是否应忽略双击 */
  const didMoveRef = useRef(false)
  /** 拖拽结束后保持 '已拖拽' 状态的冷却定时器 */
  const cooldownRef = useRef<ReturnType<typeof setTimeout>>()

  // 清理冷却定时器
  useEffect(() => {
    return () => clearTimeout(cooldownRef.current)
  }, [])

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    if (target.closest('.no-drag')) return

    // 双击时不启动拖拽，让 onDoubleClick 处理最大化
    if (e.detail >= 2) return

    e.preventDefault()
    const startX = e.screenX
    const startY = e.screenY
    window.taco.window.dragStart(startX, startY)
    document.body.classList.add('is-dragging')
    didMoveRef.current = false

    const DRAG_THRESHOLD = 3 // 移动超过 3px 才算真正在拖拽

    const handleMouseMove = (ev: MouseEvent) => {
      window.taco.window.dragging(ev.screenX, ev.screenY)
      if (!didMoveRef.current) {
        const dx = Math.abs(ev.screenX - startX)
        const dy = Math.abs(ev.screenY - startY)
        if (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD) {
          didMoveRef.current = true
        }
      }
    }

    const handleMouseUp = () => {
      window.taco.window.dragEnd()
      document.body.classList.remove('is-dragging')
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)

      // 如果发生了实际拖拽，保持冷却状态 300ms，防止后续双击误触
      if (didMoveRef.current) {
        clearTimeout(cooldownRef.current)
        cooldownRef.current = setTimeout(() => {
          didMoveRef.current = false
        }, 300)
      }
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [])

  return { onMouseDown, didMoveRef }
}
