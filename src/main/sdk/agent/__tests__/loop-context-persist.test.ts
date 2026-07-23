import { describe, it, expect } from 'vitest'
import { buildRuntimeToolPrompt, buildUserId } from '../loop/context'
import { shouldPersistTaskCoreLog } from '../loop/persist'

describe('loop-context', () => {
  /* ------------------------------------------------------------------ */
  /*  buildRuntimeToolPrompt                                             */
  /* ------------------------------------------------------------------ */

  it('返回包含 sentinel 标记的 tool prompt', () => {
    const prompt = buildRuntimeToolPrompt(['run_command', 'read_file', 'write_file'])
    expect(prompt).toContain('<!--TACO_RUNTIME_TOOL_PROMPT_START-->')
    expect(prompt).toContain('<!--TACO_RUNTIME_TOOL_PROMPT_END-->')
    expect(prompt).toContain('[RUNTIME_TOOL_PROMPT]')
    expect(prompt).toContain('[/RUNTIME_TOOL_PROMPT]')
  })

  it('空工具列表不抛错', () => {
    const prompt = buildRuntimeToolPrompt([])
    expect(prompt).toContain('TACO_RUNTIME_TOOL_PROMPT_START')
  })

  /* ------------------------------------------------------------------ */
  /*  buildUserId                                                        */
  /* ------------------------------------------------------------------ */

  it('生成 32 位 hex 字符串', () => {
    const id = buildUserId('qwen', undefined, 'project-123', '/workspace')
    expect(id).toHaveLength(32)
    expect(/^[a-f0-9]{32}$/.test(id)).toBe(true)
  })

  it('不同 projectId 生成不同 userId', () => {
    const a = buildUserId('qwen', undefined, 'project-a', '/ws')
    const b = buildUserId('qwen', undefined, 'project-b', '/ws')
    expect(a).not.toBe(b)
  })

  it('相同输入生成相同 userId（确定性）', () => {
    const a = buildUserId('qwen', { qwen: { apiKey: 'key-123' } as any }, 'p1', '/ws')
    const b = buildUserId('qwen', { qwen: { apiKey: 'key-123' } as any }, 'p1', '/ws')
    expect(a).toBe(b)
  })

  it('不同 apiKey 生成不同 userId', () => {
    const a = buildUserId('qwen', { qwen: { apiKey: 'key-a' } as any }, 'p1', '/ws')
    const b = buildUserId('qwen', { qwen: { apiKey: 'key-b' } as any }, 'p1', '/ws')
    expect(a).not.toBe(b)
  })

  it('无 projectId 时使用 workspace', () => {
    const a = buildUserId('qwen', undefined, undefined, '/ws-a')
    const b = buildUserId('qwen', undefined, undefined, '/ws-b')
    expect(a).not.toBe(b)
  })
})

describe('loop-persist', () => {
  /* ------------------------------------------------------------------ */
  /*  shouldPersistTaskCoreLog                                            */
  /* ------------------------------------------------------------------ */

  it('始终返回 persist=true', () => {
    const result = shouldPersistTaskCoreLog()
    expect(result.persist).toBe(true)
    expect(result.reason).toBeDefined()
  })
})
