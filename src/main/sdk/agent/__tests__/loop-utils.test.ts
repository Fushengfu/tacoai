import { describe, it, expect } from 'vitest'
import {
  safeParseObject,
  extractThinkingFromAssistantRawText,
  buildAssistantContextContent,
  sleep,
  MAX_TOOL_ROUNDS,
  AGENT_LOOP_TIMEOUT_MS,
  AUTO_RETRY_BASE_DELAY_MS,
  AUTO_RETRY_MAX_DELAY_MS,
  STREAM_SANITIZE_HOLD_BACK,
} from '../loop/utils'

describe('loop-utils', () => {
  /* ------------------------------------------------------------------ */
  /*  常量                                                               */
  /* ------------------------------------------------------------------ */

  it('MAX_TOOL_ROUNDS 为 1000', () => {
    expect(MAX_TOOL_ROUNDS).toBe(1000)
  })

  it('AGENT_LOOP_TIMEOUT_MS 为 24 小时', () => {
    expect(AGENT_LOOP_TIMEOUT_MS).toBe(24 * 60 * 60 * 1000)
  })

  it('重试延迟在合理范围内', () => {
    expect(AUTO_RETRY_BASE_DELAY_MS).toBe(1000)
    expect(AUTO_RETRY_MAX_DELAY_MS).toBe(16000)
    expect(AUTO_RETRY_MAX_DELAY_MS).toBeGreaterThan(AUTO_RETRY_BASE_DELAY_MS)
  })

  it('STREAM_SANITIZE_HOLD_BACK 为正数', () => {
    expect(STREAM_SANITIZE_HOLD_BACK).toBe(24)
  })

  /* ------------------------------------------------------------------ */
  /*  safeParseObject                                                    */
  /* ------------------------------------------------------------------ */

  it('解析有效 JSON 对象', () => {
    const result = safeParseObject('{"key": "value"}')
    expect(result).toEqual({ key: 'value' })
  })

  it('解析嵌套 JSON', () => {
    const result = safeParseObject('{"a":{"b":1},"c":[1,2,3]}')
    expect(result).toEqual({ a: { b: 1 }, c: [1, 2, 3] })
  })

  it('数组返回 null', () => {
    expect(safeParseObject('[1, 2, 3]')).toBeNull()
  })

  it('原始值返回 null', () => {
    expect(safeParseObject('"hello"')).toBeNull()
    expect(safeParseObject('42')).toBeNull()
    expect(safeParseObject('true')).toBeNull()
  })

  it('无效 JSON 返回 null', () => {
    expect(safeParseObject('not json')).toBeNull()
  })

  it('空字符串返回 null', () => {
    expect(safeParseObject('')).toBeNull()
  })

  it('null 值返回 null', () => {
    expect(safeParseObject('null')).toBeNull()
  })

  /* ------------------------------------------------------------------ */
  /*  extractThinkingFromAssistantRawText                                */
  /* ------------------------------------------------------------------ */

  it('提取完整 <think> 标签内容', () => {
    const text = '<think>这是思考内容</think>\n\n这是回复'
    const result = extractThinkingFromAssistantRawText(text)
    expect(result).toBe('这是思考内容')
  })

  it('提取多段 <think> 标签并合并', () => {
    const text = '<think>第一段</think>\n<think>第二段</think>\n回复'
    const result = extractThinkingFromAssistantRawText(text)
    expect(result).toBe('第一段\n\n第二段')
  })

  it('无 think 标签返回空字符串', () => {
    const result = extractThinkingFromAssistantRawText('这是普通回复')
    expect(result).toBe('')
  })

  it('未闭合的 <think> 标签提取后续内容', () => {
    const result = extractThinkingFromAssistantRawText('<think>正在思考中...')
    expect(result).toBe('正在思考中...')
  })

  it('带属性的 <think> 标签', () => {
    const text = '<think duration="3s">快速思考</think>\n回复'
    const result = extractThinkingFromAssistantRawText(text)
    expect(result).toBe('快速思考')
  })

  it('空输入返回空字符串', () => {
    expect(extractThinkingFromAssistantRawText('')).toBe('')
  })

  it('纯空白输入返回空字符串', () => {
    expect(extractThinkingFromAssistantRawText('   \n  ')).toBe('')
  })

  /* ------------------------------------------------------------------ */
  /*  buildAssistantContextContent                                       */
  /* ------------------------------------------------------------------ */

  it('同时有思考内容和回复文本（无 think 标签）', () => {
    const result = buildAssistantContextContent(
      '这是原始回复',  // rawText
      '这是清洗后回复',  // sanitizedText
      '思考过程',       // rawReasoning
    )
    expect(result).toContain('<think>')
    expect(result).toContain('思考过程')
    expect(result).toContain('这是原始回复')
  })

  it('当 rawText 已包含 think 标签时不重复包裹', () => {
    const result = buildAssistantContextContent(
      '<think>已有思考</think>\n回复内容',
      '清洗后',
      '额外思考',
    )
    // 已有 think 标签，直接返回 rawText
    expect(result).toBe('<think>已有思考</think>\n回复内容')
  })

  it('仅有回复无思考', () => {
    const result = buildAssistantContextContent('回复', '回复清洗', '')
    expect(result).toBe('回复')
  })

  it('仅有思考无回复', () => {
    const result = buildAssistantContextContent('', '', '思考中')
    expect(result).toBe('思考：思考中')
  })

  it('全部为空返回空字符串', () => {
    const result = buildAssistantContextContent('', '', '')
    expect(result).toBe('')
  })
})
