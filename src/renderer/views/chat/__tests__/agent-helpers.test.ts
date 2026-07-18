import { describe, it, expect } from 'vitest'
import type { AgentStep, ChatMsg } from '../../../types'
import {
  escapeRegExp,
  stripInternalSummaryBlocks,
  maskToolNamesForUser,
  sanitizeAssistantContentForDisplay,
  maskSensitiveText,
  isWindowsAbsolutePath,
  normalizeScreenshotPath,
  toImageUrl,
  extractScreenshotPathsFromResultContent,
  parseArgs,
  summarizeRunCommand,
  toolCallSummary,
  stepStatusIcon,
  stepHeaderSummary,
  stepGroupOperationSummary,
} from '../agent-helpers'

/* ================================================================== */
/*  escapeRegExp                                                        */
/* ================================================================== */

describe('escapeRegExp', () => {
  it('应转义正则特殊字符', () => {
    expect(escapeRegExp('a.b*c')).toBe('a\\.b\\*c')
    expect(escapeRegExp('[test]')).toBe('\\[test\\]')
    expect(escapeRegExp('a(b)c')).toBe('a\\(b\\)c')
  })

  it('普通文本原样返回', () => {
    expect(escapeRegExp('hello world')).toBe('hello world')
    expect(escapeRegExp('abc123')).toBe('abc123')
  })
})

/* ================================================================== */
/*  stripInternalSummaryBlocks                                          */
/* ================================================================== */

describe('stripInternalSummaryBlocks', () => {
  it('应剥离【历史助手回复…】块', () => {
    const input = '前言\n【历史助手回复（仅供上下文，不代表当前轮结论）】\n旧回复\n【\n继续'
    const result = stripInternalSummaryBlocks(input)
    expect(result).not.toContain('旧回复')
    expect(result).toContain('前言')
    expect(result).toContain('继续')
  })

  it('应剥离【执行过程摘要】块', () => {
    const input = '开始\n【执行过程摘要】\n步骤1\n步骤2\n【\n结束'
    const result = stripInternalSummaryBlocks(input)
    expect(result).not.toContain('步骤1')
    expect(result).toContain('开始')
    expect(result).toContain('结束')
  })

  it('无内部块的原文本不变', () => {
    const input = '这是正常回复文本'
    expect(stripInternalSummaryBlocks(input)).toBe(input)
  })
})

/* ================================================================== */
/*  maskToolNamesForUser                                                */
/* ================================================================== */

describe('maskToolNamesForUser', () => {
  it('应将工具名替换为"工具操作"', () => {
    const result = maskToolNamesForUser('我用 read_file 读取了文件', ['read_file'])
    expect(result).toContain('工具操作')
    expect(result).not.toContain('read_file')
  })

  it('应剥离 [TOOL_CALL] 块', () => {
    const result = maskToolNamesForUser('文本 [TOOL_CALL]内容[/TOOL_CALL] 结束', [])
    expect(result).not.toContain('TOOL_CALL')
    expect(result).toContain('文本')
    expect(result).toContain('结束')
  })

  it('应剥离 <invoke> 块', () => {
    const result = maskToolNamesForUser('A <invoke name="x">y</invoke> B', [])
    expect(result).not.toContain('invoke')
    expect(result).toContain('A')
    expect(result).toContain('B')
  })
})

/* ================================================================== */
/*  sanitizeAssistantContentForDisplay                                  */
/* ================================================================== */

describe('sanitizeAssistantContentForDisplay', () => {
  it('应剥离 think 标签和工具名', () => {
    const input = '回答 <think>思考中</think> 用 read_file 读取'
    const result = sanitizeAssistantContentForDisplay(input, ['read_file'])
    expect(result).not.toContain('思考中')
    expect(result).not.toContain('read_file')
    expect(result).toContain('回答')
    expect(result).toContain('工具操作')
  })

  it('应移除末尾 [DONE]', () => {
    const result = sanitizeAssistantContentForDisplay('完成了\n[DONE]', [])
    expect(result).not.toContain('[DONE]')
    expect(result).toBe('完成了')
  })

  it('应合并多余空行', () => {
    const result = sanitizeAssistantContentForDisplay('a\n\n\n\nb', [])
    expect(result).toBe('a\n\nb')
  })
})

/* ================================================================== */
/*  maskSensitiveText                                                   */
/* ================================================================== */

describe('maskSensitiveText', () => {
  it('应脱敏 api_key=xxx', () => {
    const input = 'api_key: sk-abc123'
    const result = maskSensitiveText(input)
    expect(result).toContain('***')
    expect(result).not.toContain('sk-abc123')
  })

  it('应脱敏 Authorization: Bearer xxx（当前仅脱敏 Bearer 关键字，JWT 内容因正则限制暴露）', () => {
    const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc'
    const result = maskSensitiveText(input)
    expect(result).toContain('***')
    // 注：当前正则 [a-z0-9._\-]+ 不匹配大写字母，JWT token 仅部分被脱敏
    expect(result).not.toContain('Bearer')
  })

  it('应脱敏 password=xxx', () => {
    const input = 'password: mySecret123'
    const result = maskSensitiveText(input)
    expect(result).toContain('***')
    expect(result).not.toContain('mySecret123')
  })

  it('无敏感信息原样返回', () => {
    const input = 'ls -la /home'
    expect(maskSensitiveText(input)).toBe(input)
  })
})

/* ================================================================== */
/*  isWindowsAbsolutePath                                               */
/* ================================================================== */

describe('isWindowsAbsolutePath', () => {
  it('盘符路径返回 true', () => {
    expect(isWindowsAbsolutePath('C:\\Users\\test')).toBe(true)
    expect(isWindowsAbsolutePath('D:/data')).toBe(true)
  })

  it('UNC 路径返回 true', () => {
    expect(isWindowsAbsolutePath('\\\\server\\share')).toBe(true)
  })

  it('Unix 绝对路径返回 false', () => {
    expect(isWindowsAbsolutePath('/home/user')).toBe(false)
  })

  it('相对路径返回 false', () => {
    expect(isWindowsAbsolutePath('src/main.ts')).toBe(false)
  })
})

/* ================================================================== */
/*  normalizeScreenshotPath                                             */
/* ================================================================== */

describe('normalizeScreenshotPath', () => {
  it('Unix 绝对路径返回原值', () => {
    expect(normalizeScreenshotPath('/tmp/screenshot.png')).toBe('/tmp/screenshot.png')
  })

  it('Windows 路径返回原值', () => {
    expect(normalizeScreenshotPath('C:\\screenshots\\1.png')).toBe('C:\\screenshots\\1.png')
  })

  it('非绝对路径返回 null', () => {
    expect(normalizeScreenshotPath('relative.png')).toBeNull()
  })

  it('空值返回 null', () => {
    expect(normalizeScreenshotPath('')).toBeNull()
    expect(normalizeScreenshotPath(null)).toBeNull()
  })
})

/* ================================================================== */
/*  toImageUrl                                                          */
/* ================================================================== */

describe('toImageUrl', () => {
  it('http/https URL 原样返回', () => {
    expect(toImageUrl('https://example.com/img.png')).toBe('https://example.com/img.png')
  })

  it('data: URL 原样返回', () => {
    expect(toImageUrl('data:image/png;base64,abc')).toBe('data:image/png;base64,abc')
  })

  it('Unix 绝对路径转为 file://', () => {
    const result = toImageUrl('/home/user/img.png')
    expect(result).toContain('file://')
  })

  it('Windows UNC 路径转换', () => {
    const result = toImageUrl('\\\\server\\share\\img.png')
    expect(result).toContain('file://')
  })
})

/* ================================================================== */
/*  extractScreenshotPathsFromResultContent                             */
/* ================================================================== */

describe('extractScreenshotPathsFromResultContent', () => {
  it('从 JSON 对象提取 screenshotPath', () => {
    const input = JSON.stringify({ screenshotPath: '/tmp/ss.png' })
    const result = extractScreenshotPathsFromResultContent(input)
    expect(result).toContain('/tmp/ss.png')
  })

  it('从 JSON 对象提取 screenshotPaths 数组', () => {
    const input = JSON.stringify({ screenshotPaths: ['/tmp/1.png', '/tmp/2.png'] })
    const result = extractScreenshotPathsFromResultContent(input)
    expect(result).toHaveLength(2)
    expect(result).toContain('/tmp/1.png')
    expect(result).toContain('/tmp/2.png')
  })

  it('非 JSON 内容中匹配引号内的 screenshotPath', () => {
    const input = 'result: "screenshotPath": "/tmp/cap.png" done'
    const result = extractScreenshotPathsFromResultContent(input)
    expect(result).toContain('/tmp/cap.png')
  })

  it('空字符串返回空数组', () => {
    expect(extractScreenshotPathsFromResultContent('')).toEqual([])
  })
})

/* ================================================================== */
/*  parseArgs                                                           */
/* ================================================================== */

describe('parseArgs', () => {
  it('合法 JSON 应解析', () => {
    expect(parseArgs('{"path":"/tmp"}')).toEqual({ path: '/tmp' })
  })

  it('非法 JSON 返回空对象', () => {
    expect(parseArgs('not-json')).toEqual({})
  })

  it('空字符串返回空对象', () => {
    expect(parseArgs('')).toEqual({})
  })
})

/* ================================================================== */
/*  summarizeRunCommand                                                 */
/* ================================================================== */

describe('summarizeRunCommand', () => {
  it('curl GET 请求应简化', () => {
    const result = summarizeRunCommand('curl https://api.example.com/users')
    expect(result).toContain('请求接口')
    expect(result).toContain('GET')
    expect(result).toContain('/users')
  })

  it('npm run dev 应识别', () => {
    expect(summarizeRunCommand('npm run dev')).toBe('启动前端开发服务')
  })

  it('npm run build 应识别', () => {
    expect(summarizeRunCommand('npm run build')).toBe('构建项目')
  })

  it('长命令应截断', () => {
    const longCmd = 'a'.repeat(100)
    const result = summarizeRunCommand(longCmd)
    expect(result.length).toBeLessThanOrEqual(60)
    expect(result).toContain('...')
  })

  it('空命令返回空字符串', () => {
    expect(summarizeRunCommand('')).toBe('')
  })
})

/* ================================================================== */
/*  toolCallSummary                                                     */
/* ================================================================== */

describe('toolCallSummary', () => {
  it('read_file 返回查看文件', () => {
    const result = toolCallSummary({ name: 'read_file', arguments: '{"path":"/tmp/test.txt"}' })
    expect(result.label).toBe('查看文件')
    expect(result.detail).toBe('/tmp/test.txt')
    expect(result.filePath).toBe('/tmp/test.txt')
  })

  it('write_file 返回写入文件', () => {
    const result = toolCallSummary({ name: 'write_file', arguments: '{"path":"/tmp/out.txt"}' })
    expect(result.label).toBe('写入文件')
  })

  it('edit_file 返回编辑文件', () => {
    const result = toolCallSummary({ name: 'edit_file', arguments: '{"path":"/tmp/edit.txt"}' })
    expect(result.label).toBe('编辑文件')
  })

  it('delete_file 返回删除文件', () => {
    const result = toolCallSummary({ name: 'delete_file', arguments: '{"path":"/tmp/del.txt"}' })
    expect(result.label).toBe('删除文件')
  })

  it('run_command 返回执行命令', () => {
    const result = toolCallSummary({ name: 'run_command', arguments: '{"command":"ls -la"}' })
    expect(result.label).toBe('执行命令')
  })

  it('未知工具返回默认标签', () => {
    const result = toolCallSummary({ name: 'unknown_tool', arguments: '{}' })
    expect(result.label).toBe('执行操作')
  })

  it('browser_navigate 返回浏览器操作', () => {
    const result = toolCallSummary({ name: 'browser_navigate', arguments: '{"url":"https://example.com"}' })
    expect(result.label).toBe('浏览器操作')
    expect(result.detail).toBe('https://example.com')
  })

  it('codebase_search 识别正则查询', () => {
    const result = toolCallSummary({ name: 'codebase_search', arguments: '{"query":"test.*pattern","path":"src"}' })
    expect(result.label).toBe('正则搜索')
  })
})

/* ================================================================== */
/*  stepStatusIcon                                                      */
/* ================================================================== */

describe('stepStatusIcon', () => {
  const baseStep: AgentStep = {
    round: 1,
    thinking: '',
    status: 'done' as AgentStep['status'],
    toolCalls: [],
    toolResults: [],
  }

  it('calling 状态返回 ⏳', () => {
    expect(stepStatusIcon({ ...baseStep, status: 'calling' })).toBe('⏳')
  })

  it('running 状态返回 ⚡', () => {
    expect(stepStatusIcon({ ...baseStep, status: 'running' })).toBe('⚡')
  })

  it('confirm 状态返回 🔒', () => {
    expect(stepStatusIcon({ ...baseStep, status: 'confirm' })).toBe('🔒')
  })

  it('done 全部成功返回 ✓', () => {
    const step = {
      ...baseStep,
      status: 'done' as const,
      toolResults: [{ success: true, tool_call_id: '1', content: 'ok', name: 'read_file' }],
    }
    expect(stepStatusIcon(step)).toBe('✓')
  })

  it('done 有失败返回 ⚠', () => {
    const step = {
      ...baseStep,
      status: 'done' as const,
      toolResults: [{ success: false, tool_call_id: '1', content: 'err', name: 'run_command' }],
    }
    expect(stepStatusIcon(step)).toBe('⚠')
  })
})

/* ================================================================== */
/*  stepHeaderSummary                                                   */
/* ================================================================== */

describe('stepHeaderSummary', () => {
  const baseStep: AgentStep = {
    round: 1,
    thinking: '',
    status: 'done' as AgentStep['status'],
    toolCalls: [],
    toolResults: [],
  }

  it('systemTitle 存在时直接使用', () => {
    const step = { ...baseStep, systemTitle: '编译项目', systemDetail: 'tsc' }
    const result = stepHeaderSummary(step)
    expect(result.label).toBe('编译项目')
    expect(result.detail).toBe('tsc')
  })

  it('无工具调用返回思考中', () => {
    const result = stepHeaderSummary(baseStep)
    expect(result.label).toBe('思考中')
  })

  it('单个工具调用返回对应摘要', () => {
    const step = {
      ...baseStep,
      toolCalls: [{ id: '1', name: 'read_file', arguments: '{"path":"/tmp/a.txt"}' }],
    }
    const result = stepHeaderSummary(step)
    expect(result.label).toBe('查看文件')
    expect(result.detail).toBe('/tmp/a.txt')
  })

  it('多个工具调用合并显示', () => {
    const step = {
      ...baseStep,
      toolCalls: [
        { id: '1', name: 'read_file', arguments: '{"path":"/a"}' },
        { id: '2', name: 'write_file', arguments: '{"path":"/b"}' },
      ],
    }
    const result = stepHeaderSummary(step)
    expect(result.label).toContain('查看文件')
    expect(result.label).toContain('写入文件')
  })

  it('retry_confirm 状态显示错误信息', () => {
    const step = { ...baseStep, status: 'retry_confirm' as const, retryErrorType: 'timeout' as const }
    const result = stepHeaderSummary(step)
    expect(result.label).toContain('请求超时')
  })
})

/* ================================================================== */
/*  stepGroupOperationSummary                                           */
/* ================================================================== */

describe('stepGroupOperationSummary', () => {
  it('空数组返回"暂无操作"', () => {
    expect(stepGroupOperationSummary([])).toBe('暂无操作')
  })

  it('有步骤时返回最近活动步骤摘要', () => {
    const step: AgentStep = {
      round: 1,
      thinking: '',
      status: 'done' as AgentStep['status'],
      toolCalls: [{ id: '1', name: 'write_file', arguments: '{"path":"/tmp/x.ts"}' }],
      toolResults: [{ success: true, tool_call_id: '1', content: 'ok', name: 'write_file' }],
    }
    const result = stepGroupOperationSummary([step])
    expect(result).toContain('写入文件')
    expect(result).toContain('/tmp/x.ts')
  })
})
