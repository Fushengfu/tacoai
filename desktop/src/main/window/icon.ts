/**
 * 图标处理工具
 *
 * 托盘图标的透明边距裁剪算法。
 */

import type { NativeImage } from 'electron'

/**
 * 裁剪 NativeImage 的透明边距（上下左右各方向的完全透明像素）
 * 在 macOS 托盘上使用真实图标而非 template icon，避免产生白点
 */
export function trimTransparentPadding(image: NativeImage): NativeImage {
  try {
    const { width, height } = image.getSize()
    if (width <= 0 || height <= 0) return image

    const bitmap = image.toBitmap()
    let minX = width
    let minY = height
    let maxX = -1
    let maxY = -1

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // toBitmap: BGRA 顺序，alpha 在第 4 个字节
        const alpha = bitmap[(y * width + x) * 4 + 3]
        if (alpha > 8) {
          if (x < minX) minX = x
          if (y < minY) minY = y
          if (x > maxX) maxX = x
          if (y > maxY) maxY = y
        }
      }
    }

    if (maxX < minX || maxY < minY) return image
    if (minX === 0 && minY === 0 && maxX === width - 1 && maxY === height - 1) return image
    return image.crop({ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 })
  } catch {
    return image
  }
}
