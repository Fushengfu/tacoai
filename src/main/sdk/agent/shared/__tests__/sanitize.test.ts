import { describe, it, expect } from 'vitest'
import {
  stripInternalContextTags,
  stripPseudoToolCallArtifacts,
  sanitizeUserFacingText,
  sanitizeContextArtifacts,
  stripReasoningArtifacts,
  sanitizeReasoningForContext,
  sanitizeReplayRawText,
  containsPseudoToolCallSyntax,
} from '../sanitize'

/* ================================================================== */
/*  stripInternalContextTags                                           */
/* ================================================================== */

describe('stripInternalContextTags', () => {
  it('应剥离 [USER_QUERY]...[/USER_QUERY] 块', () => {
    const input = '你好\n[USER_QUERY]\n用户问题\n[/USER_QUERY]\n回复'
    const result = stripInternalContextTags(input)
    expect(result).not.toContain('USER_QUERY')
    expect(result).not.toContain('用户问题')
    expect(result).toContain('你好')
    expect(result).toContain('回复')
  })

  it('应剥离 [SKILLS_CATALOG]...[/SKILLS_CATALOG] 块', () => {
    const input = '[SKILLS_CATALOG]\nskill1\nskill2\n[/SKILLS_CATALOG]剩余文本'
    const result = stripInternalContextTags(input)
    expect(result).not.toContain('skill1')
    expect(result).toContain('剩余文本')
  })

  it('应剥离带属性的 [SKILL_DETAIL id="xxx"]...[/SKILL_DETAIL] 块', () => {
    const input = '开头\n[SKILL_DETAIL id="test"]\n详情内容\n[/SKILL_DETAIL]\n结尾'
    const result = stripInternalContextTags(input)
    expect(result).not.toContain('详情内容')
    expect(result).toContain('开头')
    expect(result).toContain('结尾')
  })

  it('应剥离 TACO_RUNTIME_TOOL_PROMPT 注释块', () => {
    const input = '文本\n<!--TACO_RUNTIME_TOOL_PROMPT_START-->\n工具定义\n<!--TACO_RUNTIME_TOOL_PROMPT_END-->\n继续'
    const result = stripInternalContextTags(input)
    expect(result).not.toContain('工具定义')
    expect(result).toContain('文本')
    expect(result).toContain('继续')
  })

  it('应替换上下文标签名为中文', () => {
    const input = '这是 CURRENT_TASK_SUMMARY 的内容，参考 HISTORICAL_TASK_RESULT'
    const result = stripInternalContextTags(input)
    expect(result).toContain('当前任务续跑摘要')
    expect(result).toContain('历史任务总结')
    expect(result).not.toContain('CURRENT_TASK_SUMMARY')
  })

  it('空字符串应返回空', () => {
    expect(stripInternalContextTags('')).toBe('')
  })

  it('应合并多余空行', () => {
    const input = 'a\n\n\n\nb'
    const result = stripInternalContextTags(input)
    expect(result).toBe('a\n\nb')
  })
})

/* ================================================================== */
/*  stripPseudoToolCallArtifacts                                        */
/* ================================================================== */

describe('stripPseudoToolCallArtifacts', () => {
  it('应剥离 [TOOL_CALL]...[/TOOL_CALL] 块', () => {
    const input = '我来调用工具\n[TOOL_CALL]\nread_file\n[/TOOL_CALL]\n结束'
    const result = stripPseudoToolCallArtifacts(input)
    expect(result).not.toContain('TOOL_CALL')
    expect(result).toContain('我来调用工具')
    expect(result).toContain('结束')
  })

  it('应剥离 <invoke>...</invoke> 块', () => {
    const input = '文本 <invoke name="test">参数</invoke> 继续'
    const result = stripPseudoToolCallArtifacts(input)
    expect(result).not.toContain('invoke')
    expect(result).not.toContain('参数')
  })

  it('应剥离 <minimax:tool_call> 块', () => {
    const input = '开头 <minimax:tool_call>content</minimax:tool_call> 结尾'
    const result = stripPseudoToolCallArtifacts(input)
    expect(result).not.toContain('minimax')
    expect(result).not.toContain('content')
  })

  it('应剥离 <parameter> 块', () => {
    const input = '数据 <parameter name="x">123</parameter> 结束'
    const result = stripPseudoToolCallArtifacts(input)
    expect(result).not.toContain('parameter')
    expect(result).not.toContain('123')
  })

  it('无伪工具调用的文本原样保留', () => {
    const input = '这是一段正常的回复文本。'
    expect(stripPseudoToolCallArtifacts(input)).toBe(input)
  })
})

/* ================================================================== */
/*  stripReasoningArtifacts                                             */
/* ================================================================== */

describe('stripReasoningArtifacts', () => {
  it('应剥离 <think>...</think> 块', () => {
    const input = '回答 <think>我需要思考一下</think> 最终答案'
    const result = stripReasoningArtifacts(input)
    expect(result).not.toContain('我需要思考一下')
    expect(result).toContain('回答')
    expect(result).toContain('最终答案')
  })

  it('应剥离 <reflection>...</reflection> 块', () => {
    const input = '分析 <reflection>自我反思</reflection> 结论'
    const result = stripReasoningArtifacts(input)
    expect(result).not.toContain('自我反思')
    expect(result).toContain('结论')
  })

  it('应剥离 <tool_code>...</tool_code> 块', () => {
    const input = '代码 <tool_code>const x = 1;</tool_code> 解释'
    const result = stripReasoningArtifacts(input)
    expect(result).not.toContain('const x = 1')
    expect(result).toContain('解释')
  })
})

/* ================================================================== */
/*  sanitizeUserFacingText                                              */
/* ================================================================== */

describe('sanitizeUserFacingText', () => {
  it('应替换"从项目历史记录来看"为"结合当前上下文来看"', () => {
    const input = '从项目历史记录来看，这里需要修改。'
    const result = sanitizeUserFacingText(input)
    expect(result).toContain('结合当前上下文来看')
    expect(result).not.toContain('历史记录')
  })

  it('应替换"根据项目历史记忆"', () => {
    const input = '根据项目历史记忆，这个 bug 已经修复。'
    const result = sanitizeUserFacingText(input)
    expect(result).toContain('结合当前上下文')
    expect(result).not.toContain('历史记忆')
  })

  it('应替换英文背景措辞', () => {
    const input = 'based on the project history, this is solved.'
    const result = sanitizeUserFacingText(input)
    expect(result).toContain('based on current context')
    expect(result).not.toContain('history')
  })

  it('应同时剥离内部标签和伪工具调用', () => {
    const input = '[USER_QUERY]问题[/USER_QUERY] 从项目历史记录来看 [TOOL_CALL]read[/TOOL_CALL] 回复'
    const result = sanitizeUserFacingText(input)
    expect(result).not.toContain('USER_QUERY')
    expect(result).not.toContain('TOOL_CALL')
    expect(result).toContain('结合当前上下文')
  })
})

/* ================================================================== */
/*  sanitizeContextArtifacts                                            */
/* ================================================================== */

describe('sanitizeContextArtifacts', () => {
  it('应剥离推理标签和伪工具调用', () => {
    const input = '回答 <think>思考中</think> [TOOL_CALL]cmd[/TOOL_CALL] 最终'
    const result = sanitizeContextArtifacts(input)
    expect(result).not.toContain('思考中')
    expect(result).not.toContain('TOOL_CALL')
    expect(result).toContain('最终')
  })

  it('应合并多余空格', () => {
    const input = 'a    b'
    const result = sanitizeContextArtifacts(input)
    expect(result).toContain('a b')
  })
})

/* ================================================================== */
/*  sanitizeReasoningForContext                                         */
/* ================================================================== */

describe('sanitizeReasoningForContext', () => {
  it('应剥离推理标签但保留其内容（仅移除标签本身）', () => {
    const input = '分析 <think>想法</think> 然后 <reflection>反思</reflection> 结论'
    const result = sanitizeReasoningForContext(input)
    // sanitizeReasoningForContext 只剥离标签，保留标签内的文本内容
    expect(result).toContain('想法')
    expect(result).toContain('反思')
    expect(result).toContain('分析')
    expect(result).toContain('然后')
    expect(result).toContain('结论')
    expect(result).not.toContain('<think>')
    expect(result).not.toContain('</think>')
    expect(result).not.toContain('<reflection>')
    expect(result).not.toContain('</reflection>')
  })
})

/* ================================================================== */
/*  sanitizeReplayRawText                                               */
/* ================================================================== */

describe('sanitizeReplayRawText', () => {
  it('应剥离内部标签和伪工具调用，去除 \\r', () => {
    const input = 'hello\r\nworld [USER_QUERY]q[/USER_QUERY] <invoke>x</invoke> end'
    const result = sanitizeReplayRawText(input)
    expect(result).not.toContain('\r')
    expect(result).not.toContain('USER_QUERY')
    expect(result).not.toContain('invoke')
    expect(result).toContain('hello')
    expect(result).toContain('world')
    expect(result).toContain('end')
  })
})

/* ================================================================== */
/*  containsPseudoToolCallSyntax                                        */
/* ================================================================== */

describe('containsPseudoToolCallSyntax', () => {
  it('[TOOL_CALL] 语法返回 true', () => {
    expect(containsPseudoToolCallSyntax('[TOOL_CALL]')).toBe(true)
  })

  it('<invoke 语法返回 true', () => {
    expect(containsPseudoToolCallSyntax('<invoke name="test">')).toBe(true)
  })

  it('<minimax:tool_call 语法返回 true', () => {
    expect(containsPseudoToolCallSyntax('<minimax:tool_call>')).toBe(true)
  })

  it('<parameter 语法返回 true', () => {
    expect(containsPseudoToolCallSyntax('<parameter name="x">')).toBe(true)
  })

  it('正常文本返回 false', () => {
    expect(containsPseudoToolCallSyntax('这是一段正常文本')).toBe(false)
  })

  it('空字符串返回 false', () => {
    expect(containsPseudoToolCallSyntax('')).toBe(false)
  })
})
