import { describe, it, expect } from 'vitest'
import {
  toWorkspaceRelativeFactPath,
  shortMemoryFactText,
  createTrackState,
  collectSearchMatchRefs,
  collectFindResultPaths,
  buildReadFileFact,
  buildFileChangeFact,
  isVerificationPlanStep,
} from '../loop-track'

describe('loop-track', () => {
  /* ------------------------------------------------------------------ */
  /*  toWorkspaceRelativeFactPath                                        */
  /* ------------------------------------------------------------------ */

  it('绝对路径在工作空间内返回相对路径', () => {
    const result = toWorkspaceRelativeFactPath('/home/user/project', '/home/user/project/src/main.ts')
    expect(result).toBe('src/main.ts')
  })

  it('工作空间本身返回 .', () => {
    const result = toWorkspaceRelativeFactPath('/home/user/project', '/home/user/project')
    expect(result).toBe('.')
  })

  it('路径不在工作空间内返回原路径', () => {
    const result = toWorkspaceRelativeFactPath('/home/user/project', '/etc/passwd')
    expect(result).toBe('/etc/passwd')
  })

  it('空工作空间返回原始路径', () => {
    const result = toWorkspaceRelativeFactPath('', '/some/path')
    expect(result).toBe('/some/path')
  })

  it('空值返回空字符串', () => {
    expect(toWorkspaceRelativeFactPath('/ws', '')).toBe('')
  })

  it('Windows 风格路径在 macOS 上保持原始格式', () => {
    // macOS 上 path.normalize 不会将反斜杠转为正斜杠，也不会将 C:\ 当作绝对路径
    // 所以 Windows 路径会被当作相对路径原样返回
    const result = toWorkspaceRelativeFactPath('/ws', 'C:\\project\\src\\file.ts')
    // 反斜杠被 replace 转成正斜杠，但路径不是 workspace 的绝对路径子路径，所以原样返回
    expect(result).toBe('C:/project/src/file.ts')
  })

  /* ------------------------------------------------------------------ */
  /*  shortMemoryFactText                                                */
  /* ------------------------------------------------------------------ */

  it('压缩空白字符', () => {
    const result = shortMemoryFactText('hello   world\r\ntest  ')
    expect(result).toBe('hello world test')
  })

  it('空字符串返回空', () => {
    expect(shortMemoryFactText('')).toBe('')
  })

  it('正常文本不变', () => {
    const result = shortMemoryFactText('修改 src/main.ts（涉及 token、user）')
    expect(result).toBe('修改 src/main.ts（涉及 token、user）')
  })

  /* ------------------------------------------------------------------ */
  /*  createTrackState                                                   */
  /* ------------------------------------------------------------------ */

  it('创建空的追踪状态', () => {
    const state = createTrackState()
    expect(state.changedFiles).toBeInstanceOf(Set)
    expect(state.changedFiles.size).toBe(0)
    expect(state.touchedFiles).toBeInstanceOf(Set)
    expect(state.failureLogs).toEqual([])
    expect(state.successfulRunCommandCount).toBe(0)
    expect(state.memoryEvidenceFacts).toEqual([])
    expect(state.hasFileChanges).toBe(false)
    expect(state.toolUsageCount).toBeInstanceOf(Map)
    expect(state.toolUsageCount.size).toBe(0)
  })

  it('每次调用创建独立的状态', () => {
    const a = createTrackState()
    const b = createTrackState()
    a.changedFiles.add('test.ts')
    expect(b.changedFiles.size).toBe(0)
  })

  /* ------------------------------------------------------------------ */
  /*  collectSearchMatchRefs                                              */
  /* ------------------------------------------------------------------ */

  it('从 grep 格式输出提取文件引用', () => {
    const content = [
      'src/main.ts:42: function hello() {',
      'src/utils.ts:10: export const x',
    ].join('\n')
    const refs = collectSearchMatchRefs('/home/project', content)
    expect(refs).toEqual(['src/main.ts:42', 'src/utils.ts:10'])
  })

  it('默认限制 3 条', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `file${i}.ts:${i}: code`).join('\n')
    const refs = collectSearchMatchRefs('/ws', lines)
    expect(refs.length).toBe(3)
  })

  it('自定义限制', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `file${i}.ts:${i}: code`).join('\n')
    const refs = collectSearchMatchRefs('/ws', lines, 5)
    expect(refs.length).toBe(5)
  })

  it('去重', () => {
    const content = 'src/main.ts:42: hello\nsrc/main.ts:42: world'
    const refs = collectSearchMatchRefs('/ws', content, 10)
    expect(refs).toEqual(['src/main.ts:42'])
  })

  it('空内容返回空数组', () => {
    expect(collectSearchMatchRefs('/ws', '')).toEqual([])
  })

  /* ------------------------------------------------------------------ */
  /*  collectFindResultPaths                                             */
  /* ------------------------------------------------------------------ */

  it('从 find_file 格式提取路径', () => {
    const content = '[F] src/main.ts\n[D] src/utils/\n[F] README.md'
    const refs = collectFindResultPaths('/home/project', content)
    expect(refs).toEqual(['src/main.ts', 'src/utils', 'README.md'])
  })

  it('默认限制 3 条', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `[F] file${i}.ts`).join('\n')
    const refs = collectFindResultPaths('/ws', lines)
    expect(refs.length).toBe(3)
  })

  /* ------------------------------------------------------------------ */
  /*  buildReadFileFact                                                  */
  /* ------------------------------------------------------------------ */

  it('从 content meta 提取路径', () => {
    const content = '[read_file] path: /home/project/src/main.ts\n文件内容...'
    const fact = buildReadFileFact('/home/project', content)
    expect(fact).toBe('查看 src/main.ts')
  })

  it('使用 requestedPath 作为备选', () => {
    const fact = buildReadFileFact('/home/project', '文件内容...', '/home/project/src/utils.ts')
    expect(fact).toBe('查看 src/utils.ts')
  })

  it('无路径返回空字符串', () => {
    const fact = buildReadFileFact('/ws', '只有内容没有路径')
    expect(fact).toBe('')
  })

  /* ------------------------------------------------------------------ */
  /*  buildFileChangeFact                                                */
  /* ------------------------------------------------------------------ */

  it('新增文件', () => {
    const change = { filePath: '/home/project/src/new.ts', oldContent: null, newContent: 'new code' }
    const fact = buildFileChangeFact('/home/project', change)
    expect(fact).toBe('新增 src/new.ts')
  })

  it('删除文件', () => {
    const change = { filePath: '/home/project/src/old.ts', oldContent: 'old', newContent: null }
    const fact = buildFileChangeFact('/home/project', change)
    expect(fact).toBe('删除 src/old.ts')
  })

  it('修改文件', () => {
    const change = { filePath: '/home/project/src/mod.ts', oldContent: 'old', newContent: 'new' }
    const fact = buildFileChangeFact('/home/project', change)
    expect(fact).toContain('修改 src/mod.ts')
  })

  it('空 fileChange 返回空字符串', () => {
    const fact = buildFileChangeFact('/ws', null as any)
    expect(fact).toBe('')
  })

  /* ------------------------------------------------------------------ */
  /*  isVerificationPlanStep                                             */
  /* ------------------------------------------------------------------ */

  it('识别验证步骤：编译通过', () => {
    expect(isVerificationPlanStep('编译通过')).toBe(true)
  })

  it('识别验证步骤：构建', () => {
    expect(isVerificationPlanStep('构建项目')).toBe(true)
  })

  it('识别验证步骤：测试', () => {
    expect(isVerificationPlanStep('运行测试')).toBe(true)
  })

  it('识别验证步骤：lint', () => {
    expect(isVerificationPlanStep('运行 lint 检查')).toBe(true)
  })

  it('识别验证步骤：typecheck', () => {
    expect(isVerificationPlanStep('TypeScript 类型检查: typecheck')).toBe(true)
  })

  it('识别英文验证步骤', () => {
    expect(isVerificationPlanStep('Run build and verify')).toBe(true)
    expect(isVerificationPlanStep('Execute tests')).toBe(true)
  })

  it('非验证步骤返回 false', () => {
    expect(isVerificationPlanStep('修改配置文件')).toBe(false)
    expect(isVerificationPlanStep('添加新功能')).toBe(false)
  })

  it('空字符串返回 false', () => {
    expect(isVerificationPlanStep('')).toBe(false)
  })
})
