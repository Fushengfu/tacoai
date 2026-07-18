/**
 * llm/utils.ts 单元测试
 *
 * 覆盖所有导出纯函数：温度解析、工具名归一化、delta 提取、消息处理、
 * 路径/URL 辅助、Token 用量解析、流式响应合并等。
 */

import { describe, it, expect } from 'vitest'
import {
  FIXED_MODEL_TEMPERATURE,
  resolveRequestTemperature,
  normalizeToolName,
  buildAllowedToolNameSet,
  extractDeltaString,
  extractReasoningDelta,
  extractTextDelta,
  extractContentText,
  normalizeMessages,
  resolveToolCallsFromMap,
  normalizeMediaUrl,
  dedupStrings,
  isLikelyLocalPath,
  isTokenPlanBaseUrl,
  asTrimmedText,
  normalizeObjectPrefix,
  ensureUrlWithScheme,
  normalizePublicBaseUrl,
  encodeObjectKeyPath,
  buildPublicUrl,
  toUrlSafeBase64,
  resolveQiniuRegionUploadUrl,
  toLocalPathIfFileUrl,
  normalizeModelName,
  parseTokenUsage,
  buildMergedResponse,
  fullHeadersForLog,
  parseJsonBodyForLog,
} from '../utils'

/* ================================================================== */
/*  常量                                                               */
/* ================================================================== */

describe('FIXED_MODEL_TEMPERATURE', () => {
  it('应该是 0.05', () => {
    expect(FIXED_MODEL_TEMPERATURE).toBe(0.05)
  })
})

/* ================================================================== */
/*  resolveRequestTemperature                                          */
/* ================================================================== */

describe('resolveRequestTemperature', () => {
  it('未配置或非数字时返回默认值', () => {
    expect(resolveRequestTemperature({ baseUrl: '', apiKey: '', model: '' })).toBe(0.05)
    expect(resolveRequestTemperature({ baseUrl: '', apiKey: '', model: '', temperature: NaN })).toBe(0.05)
  })

  it('超出 0~2 范围时返回默认值', () => {
    expect(resolveRequestTemperature({ baseUrl: '', apiKey: '', model: '', temperature: -1 })).toBe(0.05)
    expect(resolveRequestTemperature({ baseUrl: '', apiKey: '', model: '', temperature: 3 })).toBe(0.05)
    expect(resolveRequestTemperature({ baseUrl: '', apiKey: '', model: '', temperature: 2.5 })).toBe(0.05)
  })

  it('合法值原样返回', () => {
    expect(resolveRequestTemperature({ baseUrl: '', apiKey: '', model: '', temperature: 0 })).toBe(0)
    expect(resolveRequestTemperature({ baseUrl: '', apiKey: '', model: '', temperature: 0.7 })).toBe(0.7)
    expect(resolveRequestTemperature({ baseUrl: '', apiKey: '', model: '', temperature: 1 })).toBe(1)
    expect(resolveRequestTemperature({ baseUrl: '', apiKey: '', model: '', temperature: 2 })).toBe(2)
  })

  it('边界值 0 和 2 都合法', () => {
    expect(resolveRequestTemperature({ baseUrl: '', apiKey: '', model: '', temperature: 0 })).toBe(0)
    expect(resolveRequestTemperature({ baseUrl: '', apiKey: '', model: '', temperature: 2 })).toBe(2)
  })
})

/* ================================================================== */
/*  normalizeToolName                                                  */
/* ================================================================== */

describe('normalizeToolName', () => {
  it('转小写 + trim', () => {
    expect(normalizeToolName('  Read_File  ')).toBe('read_file')
    expect(normalizeToolName('WRITE_FILE')).toBe('write_file')
  })

  it('空值和 undefined', () => {
    expect(normalizeToolName('')).toBe('')
    expect(normalizeToolName(undefined as any)).toBe('')
  })
})

/* ================================================================== */
/*  buildAllowedToolNameSet                                            */
/* ================================================================== */

describe('buildAllowedToolNameSet', () => {
  it('无 tools 时返回空集合', () => {
    expect(buildAllowedToolNameSet({ tools: [] }).size).toBe(0)
    expect(buildAllowedToolNameSet(undefined).size).toBe(0)
  })

  it('返回归一化后的工具名集合', () => {
    const set = buildAllowedToolNameSet({
      tools: [
        { type: 'function', function: { name: '  Read_File ' } },
      ],
    } as any)
    expect(set.has('read_file')).toBe(true)
    expect(set.has('Read_File')).toBe(false)
  })

  it('跳过空名工具', () => {
    const set = buildAllowedToolNameSet({
      tools: [
        { type: 'function', function: { name: '' } },
        { type: 'function', function: { name: 'run_command' } },
      ],
    } as any)
    expect(set.size).toBe(1)
    expect(set.has('run_command')).toBe(true)
  })
})

/* ================================================================== */
/*  extractDeltaString                                                 */
/* ================================================================== */

describe('extractDeltaString', () => {
  it('字符串直接返回', () => {
    expect(extractDeltaString('hello')).toBe('hello')
  })

  it('数字和布尔转字符串', () => {
    expect(extractDeltaString(42)).toBe('42')
    expect(extractDeltaString(true)).toBe('true')
    expect(extractDeltaString(0)).toBe('0')
  })

  it('null/undefined/空值返回空字符串', () => {
    expect(extractDeltaString(null)).toBe('')
    expect(extractDeltaString(undefined)).toBe('')
    expect(extractDeltaString(false)).toBe('false')
  })

  it('数组拼接各元素提取结果', () => {
    expect(extractDeltaString(['a', 'b', 'c'])).toBe('abc')
  })

  it('对象按优先级提取 text > content > value > output_text > reasoning_content > reasoning > thinking > analysis', () => {
    expect(extractDeltaString({ text: 't' })).toBe('t')
    expect(extractDeltaString({ content: 'c', text: 't' })).toBe('t')
    expect(extractDeltaString({ value: 'v' })).toBe('v')
    expect(extractDeltaString({ output_text: 'o' })).toBe('o')
    expect(extractDeltaString({ reasoning_content: 'r' })).toBe('r')
    expect(extractDeltaString({ reasoning: 'r2' })).toBe('r2')
    expect(extractDeltaString({ thinking: 'th' })).toBe('th')
    expect(extractDeltaString({ analysis: 'a' })).toBe('a')
  })

  it('对象无匹配键时返回空', () => {
    expect(extractDeltaString({ foo: 'bar' })).toBe('')
  })
})

/* ================================================================== */
/*  extractReasoningDelta                                              */
/* ================================================================== */

describe('extractReasoningDelta', () => {
  it('非对象返回空', () => {
    expect(extractReasoningDelta('string')).toBe('')
    expect(extractReasoningDelta(null)).toBe('')
  })

  it('从 reasoning_content 提取', () => {
    expect(extractReasoningDelta({ reasoning_content: 'think hard' })).toBe('think hard')
  })

  it('从 reasoning 提取', () => {
    expect(extractReasoningDelta({ reasoning: 'reasoning text' })).toBe('reasoning text')
  })

  it('从 thinking 提取', () => {
    expect(extractReasoningDelta({ thinking: 'thinking...' })).toBe('thinking...')
  })

  it('从 analysis 提取', () => {
    expect(extractReasoningDelta({ analysis: 'analysis text' })).toBe('analysis text')
  })

  it('优先 reasoning_content', () => {
    expect(extractReasoningDelta({
      reasoning_content: 'first',
      reasoning: 'second',
      thinking: 'third',
    })).toBe('first')
  })
})

/* ================================================================== */
/*  extractTextDelta                                                   */
/* ================================================================== */

describe('extractTextDelta', () => {
  it('非对象返回空', () => {
    expect(extractTextDelta(null)).toBe('')
    expect(extractTextDelta('string')).toBe('')
  })

  it('从 content 提取', () => {
    expect(extractTextDelta({ content: 'hello world' })).toBe('hello world')
  })
})

/* ================================================================== */
/*  extractContentText                                                 */
/* ================================================================== */

describe('extractContentText', () => {
  it('字符串直接返回', () => {
    expect(extractContentText('hello')).toBe('hello')
  })

  it('数组提取 type=text 的部分', () => {
    const content = [
      { type: 'text', text: 'Hello' },
      { type: 'image_url', image_url: { url: 'x' } },
      { type: 'text', text: 'World' },
    ]
    expect(extractContentText(content)).toBe('Hello\nWorld')
  })

  it('非字符串非数组转字符串', () => {
    expect(extractContentText(42)).toBe('42')
    // null ?? '' → ''，所以 String('') → ''
    expect(extractContentText(null)).toBe('')
    // undefined ?? '' → ''，所以 String('') → ''
    expect(extractContentText(undefined)).toBe('')
  })
})

/* ================================================================== */
/*  normalizeMessages                                                  */
/* ================================================================== */

describe('normalizeMessages', () => {
  it('单条 system 消息保持原样', () => {
    const msgs = [
      { role: 'system' as const, content: 'You are helpful.' },
      { role: 'user' as const, content: 'hi' },
    ]
    const result = normalizeMessages(msgs)
    expect(result).toHaveLength(2)
    expect(result[0].content).toBe('You are helpful.')
  })

  it('多条 system 消息合并到第一条', () => {
    const msgs = [
      { role: 'system' as const, content: 'Rule 1' },
      { role: 'system' as const, content: 'Rule 2' },
      { role: 'user' as const, content: 'hi' },
    ]
    const result = normalizeMessages(msgs)
    expect(result).toHaveLength(2)
    expect((result[0].content as string)).toContain('Rule 1')
    expect((result[0].content as string)).toContain('Rule 2')
  })

  it('多余 system 消息空内容被跳过', () => {
    const msgs = [
      { role: 'system' as const, content: 'Only' },
      { role: 'system' as const, content: '   ' },
      { role: 'user' as const, content: 'hi' },
    ]
    const result = normalizeMessages(msgs)
    expect(result).toHaveLength(2)
    expect(result[0].content).toBe('Only')
  })

  it('单条 system 消息跟在 user 后面保持原位', () => {
    const msgs = [
      { role: 'user' as const, content: 'hi' },
      { role: 'system' as const, content: 'Late rule' },
    ]
    const result = normalizeMessages(msgs)
    expect(result).toHaveLength(2)
    // system 消息保持原位（不是第一条）
    expect(result[1].role).toBe('system')
    expect(result[1].content).toBe('Late rule')
  })

  it('system 消息内容是数组时正确提取文本', () => {
    const msgs = [
      { role: 'system' as const, content: [{ type: 'text' as const, text: 'Rule A' }] },
      { role: 'system' as const, content: 'Rule B' },
      { role: 'user' as const, content: 'hi' },
    ]
    const result = normalizeMessages(msgs)
    expect(result).toHaveLength(2)
    const sysContent = result[0].content as string
    expect(sysContent).toContain('Rule A')
    expect(sysContent).toContain('Rule B')
  })
})

/* ================================================================== */
/*  resolveToolCallsFromMap                                            */
/* ================================================================== */

describe('resolveToolCallsFromMap', () => {
  function makeEntry(name: string, args: string, id = '1') {
    return { id, type: 'function' as const, function: { name, arguments: args } }
  }

  it('空集合返回空', () => {
    const result = resolveToolCallsFromMap(new Map(), new Set())
    expect(result.toolCalls).toHaveLength(0)
    expect(result.invalidNames).toHaveLength(0)
  })

  it('合法工具名保留', () => {
    const map = new Map([[0, makeEntry('read_file', '{}')]])
    const allowed = new Set(['read_file'])
    const result = resolveToolCallsFromMap(map, allowed)
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].function.name).toBe('read_file')
  })

  it('未在白名单中的工具名标记为 invalid', () => {
    const map = new Map([[0, makeEntry('dangerous_tool', '{}')]])
    const allowed = new Set(['read_file'])
    const result = resolveToolCallsFromMap(map, allowed)
    expect(result.toolCalls).toHaveLength(0)
    expect(result.invalidNames).toEqual(['dangerous_tool'])
  })

  it('allowedToolNames 为空集合时不过滤', () => {
    const map = new Map([[0, makeEntry('any_tool', '{}')]])
    const result = resolveToolCallsFromMap(map, new Set())
    expect(result.toolCalls).toHaveLength(1)
  })

  it('空名工具被跳过', () => {
    const map = new Map([[0, makeEntry('', '{}')]])
    const result = resolveToolCallsFromMap(map, new Set())
    expect(result.toolCalls).toHaveLength(0)
  })

  it('invalid 去重', () => {
    const map = new Map([
      [0, makeEntry('bad', '{}', '1')],
      [1, makeEntry('bad', '{}', '2')],
    ])
    const allowed = new Set(['good'])
    const result = resolveToolCallsFromMap(map, allowed)
    expect(result.invalidNames).toEqual(['bad'])
  })
})

/* ================================================================== */
/*  normalizeMediaUrl                                                  */
/* ================================================================== */

describe('normalizeMediaUrl', () => {
  it('https/data/oss/file 协议原样返回', () => {
    expect(normalizeMediaUrl('https://example.com/a.png')).toBe('https://example.com/a.png')
    expect(normalizeMediaUrl('data:image/png;base64,xxx')).toBe('data:image/png;base64,xxx')
    expect(normalizeMediaUrl('oss://bucket/key')).toBe('oss://bucket/key')
    expect(normalizeMediaUrl('file:///tmp/x')).toBe('file:///tmp/x')
  })

  it('绝对路径转为 file:// URL', () => {
    const result = normalizeMediaUrl('/tmp/test.png')
    expect(result.startsWith('file://')).toBe(true)
    expect(result).toContain('test.png')
  })

  it('空值返回空', () => {
    expect(normalizeMediaUrl('')).toBe('')
    expect(normalizeMediaUrl('  ')).toBe('')
  })
})

/* ================================================================== */
/*  dedupStrings                                                       */
/* ================================================================== */

describe('dedupStrings', () => {
  it('去重 + trim + 去空', () => {
    expect(dedupStrings(['a', '  a  ', 'b', '', '  ', 'b'])).toEqual(['a', 'b'])
  })

  it('空数组返回空', () => {
    expect(dedupStrings([])).toEqual([])
  })

  it('全是空值的数组返回空', () => {
    expect(dedupStrings(['', ' ', '  '])).toEqual([])
  })
})

/* ================================================================== */
/*  isLikelyLocalPath                                                  */
/* ================================================================== */

describe('isLikelyLocalPath', () => {
  it('绝对路径返回 true', () => {
    expect(isLikelyLocalPath('/home/user')).toBe(true)
  })

  it('Windows 盘符路径返回 true', () => {
    expect(isLikelyLocalPath('C:\\Users')).toBe(true)
    expect(isLikelyLocalPath('D:/data')).toBe(true)
  })

  it('相对路径返回 false', () => {
    expect(isLikelyLocalPath('src/index.ts')).toBe(false)
  })

  it('URL 返回 false', () => {
    expect(isLikelyLocalPath('https://example.com')).toBe(false)
  })
})

/* ================================================================== */
/*  isTokenPlanBaseUrl                                                 */
/* ================================================================== */

describe('isTokenPlanBaseUrl', () => {
  it('百炼 Token Plan URL 返回 true', () => {
    expect(isTokenPlanBaseUrl('https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1')).toBe(true)
    expect(isTokenPlanBaseUrl('https://dashscope.maas.aliyuncs.com/compatible-mode/v1')).toBe(true)
  })

  it('普通 URL 返回 false', () => {
    expect(isTokenPlanBaseUrl('https://api.openai.com/v1')).toBe(false)
    expect(isTokenPlanBaseUrl('')).toBe(false)
  })

  it('字符串兜底匹配', () => {
    expect(isTokenPlanBaseUrl('token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1')).toBe(true)
  })
})

/* ================================================================== */
/*  asTrimmedText                                                      */
/* ================================================================== */

describe('asTrimmedText', () => {
  it('trim 字符串', () => {
    expect(asTrimmedText('  hello  ')).toBe('hello')
  })

  it('非字符串返回空', () => {
    expect(asTrimmedText(42)).toBe('')
    expect(asTrimmedText(null)).toBe('')
    expect(asTrimmedText(undefined)).toBe('')
  })
})

/* ================================================================== */
/*  normalizeObjectPrefix                                              */
/* ================================================================== */

describe('normalizeObjectPrefix', () => {
  it('去掉前后斜杠', () => {
    expect(normalizeObjectPrefix('/uploads/')).toBe('uploads')
    expect(normalizeObjectPrefix('//uploads//')).toBe('uploads')
  })

  it('空值返回空', () => {
    expect(normalizeObjectPrefix('')).toBe('')
    expect(normalizeObjectPrefix('  /  ')).toBe('')
  })
})

/* ================================================================== */
/*  ensureUrlWithScheme                                                */
/* ================================================================== */

describe('ensureUrlWithScheme', () => {
  it('已有 scheme 原样返回', () => {
    expect(ensureUrlWithScheme('https://example.com')).toBe('https://example.com')
    expect(ensureUrlWithScheme('http://example.com')).toBe('http://example.com')
  })

  it('无 scheme 补 https://', () => {
    expect(ensureUrlWithScheme('example.com')).toBe('https://example.com')
  })

  it('空值返回空', () => {
    expect(ensureUrlWithScheme('')).toBe('')
  })
})

/* ================================================================== */
/*  normalizePublicBaseUrl                                             */
/* ================================================================== */

describe('normalizePublicBaseUrl', () => {
  it('去掉末尾斜杠', () => {
    expect(normalizePublicBaseUrl('https://cdn.example.com/')).toBe('https://cdn.example.com')
  })

  it('补 scheme', () => {
    expect(normalizePublicBaseUrl('cdn.example.com/')).toBe('https://cdn.example.com')
  })
})

/* ================================================================== */
/*  encodeObjectKeyPath                                                */
/* ================================================================== */

describe('encodeObjectKeyPath', () => {
  it('路径各段 URL 编码', () => {
    expect(encodeObjectKeyPath('uploads/2024/test file.jpg')).toBe('uploads/2024/test%20file.jpg')
  })

  it('单段路径', () => {
    expect(encodeObjectKeyPath('hello world')).toBe('hello%20world')
  })

  it('空段被过滤', () => {
    expect(encodeObjectKeyPath('/a//b/')).toBe('a/b')
  })
})

/* ================================================================== */
/*  buildPublicUrl                                                     */
/* ================================================================== */

describe('buildPublicUrl', () => {
  it('拼接 baseUrl + encoded key', () => {
    const result = buildPublicUrl('https://cdn.example.com', 'path/to file.jpg')
    expect(result).toBe('https://cdn.example.com/path/to%20file.jpg')
  })

  it('baseUrl 末尾斜杠被归一化', () => {
    const result = buildPublicUrl('https://cdn.example.com///', 'key')
    expect(result).toBe('https://cdn.example.com/key')
  })
})

/* ================================================================== */
/*  toUrlSafeBase64                                                    */
/* ================================================================== */

describe('toUrlSafeBase64', () => {
  it('字符串 → URL 安全 base64', () => {
    // toUrlSafeBase64 只做 + → - 和 / → _
    const result = toUrlSafeBase64('test')
    expect(result).not.toContain('+')
    expect(result).not.toContain('/')
    // = 不会被剥离，这是设计行为
  })

  it('Buffer 输入同样处理', () => {
    const buf = Buffer.from('hello')
    const result = toUrlSafeBase64(buf)
    expect(result).toBe(toUrlSafeBase64('hello'))
  })
})

/* ================================================================== */
/*  resolveQiniuRegionUploadUrl                                        */
/* ================================================================== */

describe('resolveQiniuRegionUploadUrl', () => {
  it('从错误文本提取 host 并构建新 uploadUrl', () => {
    const result = resolveQiniuRegionUploadUrl(
      'error: please use up-z2.qiniup.com',
      'https://up.qiniup.com',
    )
    expect(result).toBe('https://up-z2.qiniup.com')
  })

  it('提取的 host 与当前相同时返回 null', () => {
    const result = resolveQiniuRegionUploadUrl(
      'please use up.qiniup.com',
      'https://up.qiniup.com',
    )
    expect(result).toBeNull()
  })

  it('不匹配时返回 null', () => {
    expect(resolveQiniuRegionUploadUrl('no match', '')).toBeNull()
  })

  it('当前为空时也能匹配', () => {
    const result = resolveQiniuRegionUploadUrl(
      'please use up-z2.qiniup.com',
      '',
    )
    expect(result).toBe('https://up-z2.qiniup.com')
  })
})

/* ================================================================== */
/*  toLocalPathIfFileUrl                                               */
/* ================================================================== */

describe('toLocalPathIfFileUrl', () => {
  it('file:// URL 转本地路径', () => {
    const result = toLocalPathIfFileUrl('file:///tmp/test.txt')
    expect(result).toBe('/tmp/test.txt')
  })

  it('非 file:// 返回 null', () => {
    expect(toLocalPathIfFileUrl('https://example.com')).toBeNull()
    expect(toLocalPathIfFileUrl('/local/path')).toBeNull()
  })

  it('无效 URL（非 file 协议）返回 null', () => {
    expect(toLocalPathIfFileUrl('http://example.com')).toBeNull()
    expect(toLocalPathIfFileUrl('/local/path')).toBeNull()
  })
})

/* ================================================================== */
/*  normalizeModelName                                                 */
/* ================================================================== */

describe('normalizeModelName', () => {
  it('转小写 + 下划线空格转连字符', () => {
    expect(normalizeModelName('DeepSeek V3')).toBe('deepseek-v3')
    expect(normalizeModelName('GPT_4_Turbo')).toBe('gpt-4-turbo')
  })

  it('空值返回空', () => {
    expect(normalizeModelName('')).toBe('')
  })
})

/* ================================================================== */
/*  parseTokenUsage                                                    */
/* ================================================================== */

describe('parseTokenUsage', () => {
  it('解析完整 usage', () => {
    const usage = parseTokenUsage({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
      },
    })
    expect(usage).toEqual({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    })
  })

  it('解析 cached_tokens（从 prompt_tokens_details）', () => {
    const usage = parseTokenUsage({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        prompt_tokens_details: { cached_tokens: 30 },
      },
    })
    expect(usage).toEqual({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      cachedTokens: 30,
    })
  })

  it('cached_tokens 从 input_tokens_details 获取', () => {
    const usage = parseTokenUsage({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        input_tokens_details: { cache_read_tokens: 25 },
      },
    })
    expect(usage?.cachedTokens).toBe(25)
  })

  it('无 usage 返回 null', () => {
    expect(parseTokenUsage({})).toBeNull()
    expect(parseTokenUsage(null)).toBeNull()
  })

  it('usage 为空对象返回 null', () => {
    expect(parseTokenUsage({ usage: {} })).toBeNull()
  })
})

/* ================================================================== */
/*  buildMergedResponse                                                */
/* ================================================================== */

describe('buildMergedResponse', () => {
  it('无 firstChunk 时使用 lastChunk 的 finish_reason', () => {
    const result = buildMergedResponse(
      undefined,
      { choices: [{ finish_reason: 'stop' }] },
      'hello',
    )
    expect(result.choices[0].message.content).toBe('hello')
    expect(result.choices[0].message.role).toBe('assistant')
    expect(result.choices[0].finish_reason).toBe('stop')
  })

  it('包含 tool_calls', () => {
    const result = buildMergedResponse(
      undefined,
      undefined,
      '',
      undefined,
      [{ id: '1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
    )
    expect(result.choices[0].message.tool_calls).toHaveLength(1)
  })

  it('包含 reasoning_content', () => {
    const result = buildMergedResponse(
      undefined,
      undefined,
      'text',
      undefined,
      undefined,
      'think step by step...',
    )
    expect(result.choices[0].message.reasoning_content).toBe('think step by step...')
  })

  it('传递 usage', () => {
    const result = buildMergedResponse(
      undefined,
      undefined,
      'text',
      { total_tokens: 50 },
    )
    expect(result.usage).toEqual({ total_tokens: 50 })
  })

  it('有 firstChunk 时使用其 id/model/created', () => {
    const result = buildMergedResponse(
      { id: 'chat-123', model: 'gpt-4', created: 1700000000 },
      { choices: [{ finish_reason: 'length' }] },
      'text',
    )
    expect(result.id).toBe('chat-123')
    expect(result.model).toBe('gpt-4')
    expect(result.created).toBe(1700000000)
    expect(result.choices[0].finish_reason).toBe('length')
  })
})

/* ================================================================== */
/*  fullHeadersForLog                                                  */
/* ================================================================== */

describe('fullHeadersForLog', () => {
  it('空 headers 返回空对象', () => {
    expect(fullHeadersForLog(undefined)).toEqual({})
  })

  it('HeadersInit 转 Record', () => {
    const result = fullHeadersForLog({ 'Content-Type': 'application/json' })
    expect(result['content-type']).toBe('application/json')
  })
})

/* ================================================================== */
/*  parseJsonBodyForLog                                                */
/* ================================================================== */

describe('parseJsonBodyForLog', () => {
  it('JSON 字符串解析为对象', () => {
    expect(parseJsonBodyForLog('{"key":"value"}')).toEqual({ key: 'value' })
  })

  it('非 JSON 字符串原样返回', () => {
    expect(parseJsonBodyForLog('not json')).toBe('not json')
  })

  it('null/undefined 返回 null', () => {
    expect(parseJsonBodyForLog(null)).toBeNull()
    expect(parseJsonBodyForLog(undefined)).toBeNull()
  })

  it('非字符串 body 原样返回', () => {
    const form = new FormData()
    expect(parseJsonBodyForLog(form)).toBe(form)
  })
})
