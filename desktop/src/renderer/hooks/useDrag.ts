import { useCallback } from 'react'

/**
 * 手动窗口拖拽 hook
 *
 * 替代 -webkit-app-region: drag，使 CSS cursor 不再被系统覆盖。
 * mousedown → 通知 main 开始拖拽（记录偏移）
 * mousemove → 通知 main 更新窗口位置
 * mouseup   → 通知 main 结束拖拽
 *
 * 用法：
 *   const drag = useDrag()
 *   <div {...drag} className="drag-bar" />
 */
export function useDrag() {
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    // 不拖拽交互元素
    const target = e.target as HTMLElement
    if (target.closest('.no-drag')) return

    e.preventDefault()
    window.taco.window.dragStart(e.screenX, e.screenY)
    document.body.classList.add('is-dragging')

    const handleMouseMove = (ev: MouseEvent) => {
      window.taco.window.dragging(ev.screenX, ev.screenY)
    }

    const handleMouseUp = () => {
      window.taco.window.dragEnd()
      document.body.classList.remove('is-dragging')
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [])

  return { onMouseDown }
}
