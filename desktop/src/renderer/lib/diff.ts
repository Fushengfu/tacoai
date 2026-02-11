/**
 * 轻量级行级别 diff 算法
 *
 * 基于 Myers 差异算法的简化实现，生成 unified diff 格式的行列表。
 */

export type DiffLineType = 'same' | 'add' | 'remove'

export type DiffLine = {
  type: DiffLineType
  content: string
  /** 旧文件行号（remove/same 有值） */
  oldLineNo?: number
  /** 新文件行号（add/same 有值） */
  newLineNo?: number
}

/**
 * 计算两段文本的行级别 diff
 */
export function computeDiff(oldText: string | null, newText: string | null): DiffLine[] {
  const oldLines = oldText ? oldText.split('\n') : []
  const newLines = newText ? newText.split('\n') : []

  // 删除文件：全部是 remove
  if (newLines.length === 0 && oldLines.length > 0) {
    return oldLines.map((line, i) => ({
      type: 'remove' as const,
      content: line,
      oldLineNo: i + 1,
    }))
  }

  // 新建文件：全部是 add
  if (oldLines.length === 0) {
    return newLines.map((line, i) => ({
      type: 'add' as const,
      content: line,
      newLineNo: i + 1,
    }))
  }

  // 使用简单 LCS 实现 diff（适用于中小文件）
  const lcs = computeLCS(oldLines, newLines)
  const result: DiffLine[] = []

  let oi = 0
  let ni = 0
  let li = 0
  let oldNo = 1
  let newNo = 1

  while (oi < oldLines.length || ni < newLines.length) {
    if (li < lcs.length && oi < oldLines.length && ni < newLines.length && oldLines[oi] === lcs[li] && newLines[ni] === lcs[li]) {
      // 共同行
      result.push({ type: 'same', content: oldLines[oi], oldLineNo: oldNo, newLineNo: newNo })
      oi++; ni++; li++; oldNo++; newNo++
    } else if (li < lcs.length && oi < oldLines.length && oldLines[oi] !== lcs[li]) {
      // 旧文件中多出的行（删除）
      result.push({ type: 'remove', content: oldLines[oi], oldLineNo: oldNo })
      oi++; oldNo++
    } else if (ni < newLines.length && (li >= lcs.length || newLines[ni] !== lcs[li])) {
      // 新文件中多出的行（添加）
      result.push({ type: 'add', content: newLines[ni], newLineNo: newNo })
      ni++; newNo++
    } else if (oi < oldLines.length) {
      result.push({ type: 'remove', content: oldLines[oi], oldLineNo: oldNo })
      oi++; oldNo++
    } else if (ni < newLines.length) {
      result.push({ type: 'add', content: newLines[ni], newLineNo: newNo })
      ni++; newNo++
    } else {
      break
    }
  }

  return result
}

/** 计算两个字符串数组的最长公共子序列 */
function computeLCS(a: string[], b: string[]): string[] {
  const m = a.length
  const n = b.length

  // 对大文件使用简化策略避免内存爆炸
  if (m * n > 2_000_000) {
    return simpleLCS(a, b)
  }

  // 标准 DP
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      }
    }
  }

  // 回溯
  const result: string[] = []
  let i = m, j = n
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.unshift(a[i - 1])
      i--; j--
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--
    } else {
      j--
    }
  }

  return result
}

/** 大文件的简化 LCS：逐行匹配，复杂度 O(n) */
function simpleLCS(a: string[], b: string[]): string[] {
  const bSet = new Map<string, number[]>()
  b.forEach((line, idx) => {
    if (!bSet.has(line)) bSet.set(line, [])
    bSet.get(line)!.push(idx)
  })

  const result: string[] = []
  let lastJ = -1
  for (const line of a) {
    const positions = bSet.get(line)
    if (!positions) continue
    // 找第一个 > lastJ 的位置
    const next = positions.find((p) => p > lastJ)
    if (next !== undefined) {
      result.push(line)
      lastJ = next
    }
  }
  return result
}

/** 统计变更摘要 */
export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of lines) {
    if (line.type === 'add') added++
    else if (line.type === 'remove') removed++
  }
  return { added, removed }
}
