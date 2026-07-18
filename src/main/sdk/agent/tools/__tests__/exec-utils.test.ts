/**
 * tools/exec-utils.ts 单元测试
 *
 * 覆盖纯函数：toPosixPath、clampNumber、makeAbortError、isAbortError。
 */

import { describe, it, expect } from 'vitest'
import {
  toPosixPath,
  clampNumber,
  makeAbortError,
  isAbortError,
} from '../exec-utils'

/* ================================================================== */
/*  toPosixPath                                                        */
/* ================================================================== */

describe('toPosixPath', () => {
  it('Windows 反斜杠转为正斜杠', () => {
    expect(toPosixPath('src\\components\\App.tsx')).toBe('src/components/App.tsx')
  })

  it('多个连续斜杠归一化为单个', () => {
    expect(toPosixPath('src//components///App.tsx')).toBe('src/components/App.tsx')
  })

  it('去掉 ./ 前缀', () => {
    expect(toPosixPath('./src/main.ts')).toBe('src/main.ts')
  })

  it('去掉末尾 /', () => {
    expect(toPosixPath('src/dir/')).toBe('src/dir')
  })

  it('混合场景', () => {
    expect(toPosixPath('.\\src\\components//Button/')).toBe('src/components/Button')
  })

  it('空字符串', () => {
    expect(toPosixPath('')).toBe('')
  })

  it('已是 posix 路径不变', () => {
    expect(toPosixPath('src/main/index.ts')).toBe('src/main/index.ts')
  })
})

/* ================================================================== */
/*  clampNumber                                                        */
/* ================================================================== */

describe('clampNumber', () => {
  it('范围内值原样返回（向下取整）', () => {
    expect(clampNumber(5, 0, 10, 3)).toBe(5)
    expect(clampNumber(5.7, 0, 10, 3)).toBe(5)
  })

  it('小于 min 裁剪到 min', () => {
    expect(clampNumber(-1, 0, 10, 3)).toBe(0)
  })

  it('大于 max 裁剪到 max', () => {
    expect(clampNumber(20, 0, 10, 3)).toBe(10)
  })

  it('非数字值返回 fallback', () => {
    expect(clampNumber('abc', 0, 10, 3)).toBe(3)
    expect(clampNumber(NaN, 0, 10, 3)).toBe(3)
    expect(clampNumber(undefined, 0, 10, 3)).toBe(3)
    // Number(null) = 0，是有限值，不走 fallback
    expect(clampNumber(null, 0, 10, 3)).toBe(0)
  })

  it('边界值', () => {
    expect(clampNumber(0, 0, 10, 5)).toBe(0)
    expect(clampNumber(10, 0, 10, 5)).toBe(10)
  })

  it('Infinity 返回 fallback', () => {
    // Number.isFinite(Infinity) = false，走 fallback
    expect(clampNumber(Infinity, 0, 10, 3)).toBe(3)
  })
})

/* ================================================================== */
/*  makeAbortError / isAbortError                                      */
/* ================================================================== */

describe('makeAbortError', () => {
  it('创建 AbortError', () => {
    const err = makeAbortError()
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('Aborted')
    expect(err.name).toBe('AbortError')
  })
})

describe('isAbortError', () => {
  it('识别 AbortError', () => {
    expect(isAbortError(makeAbortError())).toBe(true)
  })

  it('拒绝普通 Error', () => {
    expect(isAbortError(new Error('something'))).toBe(false)
  })

  it('拒绝非 Error', () => {
    expect(isAbortError('string')).toBe(false)
    expect(isAbortError(null)).toBe(false)
  })

  it('消息为 Aborted 但不是 AbortError name', () => {
    const err = new Error('Aborted')
    expect(isAbortError(err)).toBe(true)
  })
})
