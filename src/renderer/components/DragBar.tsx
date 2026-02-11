import { useDrag } from '../hooks/useDrag'

/**
 * 可复用的顶部拖拽条
 *
 * 放在 sidebar / detail-panel 顶部，鼠标 hover 时显示抓手光标，
 * 按住即可拖拽窗口。
 */
export function DragBar() {
  const drag = useDrag()
  return (
    <div
      className="drag-bar"
      {...drag}
      onDoubleClick={() => globalThis.window.taco.window.toggleMaximize()}
    />
  )
}
