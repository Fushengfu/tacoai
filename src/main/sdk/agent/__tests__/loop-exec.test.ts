import { describe, it, expect } from 'vitest'
import {
  filterNoteTools,
  filterNonNoteTools,
  filterPlanProgressTools,
  filterNonPlanProgressTools,
} from '../loop/exec'
import type { ToolCall } from '../tools/definitions'

function tc(id: string, name: string, args = '{}'): ToolCall {
  return { id, type: 'function' as const, function: { name, arguments: args } }
}

describe('loop-exec 过滤函数', () => {
  /* ------------------------------------------------------------------ */
  /*  filterNoteTools                                                    */
  /* ------------------------------------------------------------------ */

  it('筛选出 save_note 工具', () => {
    const calls = [tc('1', 'save_note'), tc('2', 'read_file'), tc('3', 'delete_note')]
    const result = filterNoteTools(calls)
    expect(result).toHaveLength(2)
    expect(result[0].function.name).toBe('save_note')
    expect(result[1].function.name).toBe('delete_note')
  })

  it('无笔记工具时返回空数组', () => {
    const calls = [tc('1', 'read_file'), tc('2', 'write_file')]
    expect(filterNoteTools(calls)).toEqual([])
  })

  it('空数组返回空', () => {
    expect(filterNoteTools([])).toEqual([])
  })

  /* ------------------------------------------------------------------ */
  /*  filterNonNoteTools                                                 */
  /* ------------------------------------------------------------------ */

  it('筛选出非笔记工具', () => {
    const calls = [tc('1', 'save_note'), tc('2', 'read_file'), tc('3', 'delete_note')]
    const result = filterNonNoteTools(calls)
    expect(result).toHaveLength(1)
    expect(result[0].function.name).toBe('read_file')
  })

  it('全是笔记工具时返回空', () => {
    const calls = [tc('1', 'save_note'), tc('2', 'delete_note')]
    expect(filterNonNoteTools(calls)).toEqual([])
  })

  /* ------------------------------------------------------------------ */
  /*  filterPlanProgressTools                                            */
  /* ------------------------------------------------------------------ */

  it('筛选出 update_plan_progress 工具', () => {
    const calls = [tc('1', 'read_file'), tc('2', 'update_plan_progress', '{"stepIndex":1,"status":"done"}')]
    const result = filterPlanProgressTools(calls)
    expect(result).toHaveLength(1)
    expect(result[0].function.name).toBe('update_plan_progress')
  })

  it('无计划工具时返回空', () => {
    const calls = [tc('1', 'read_file'), tc('2', 'write_file')]
    expect(filterPlanProgressTools(calls)).toEqual([])
  })

  /* ------------------------------------------------------------------ */
  /*  filterNonPlanProgressTools                                         */
  /* ------------------------------------------------------------------ */

  it('筛选出非计划进度工具', () => {
    const calls = [
      tc('1', 'read_file'),
      tc('2', 'update_plan_progress'),
      tc('3', 'write_file'),
    ]
    const result = filterNonPlanProgressTools(calls)
    expect(result).toHaveLength(2)
    expect(result.map(r => r.function.name).sort()).toEqual(['read_file', 'write_file'])
  })

  it('全是计划工具时返回空', () => {
    const calls = [tc('1', 'update_plan_progress')]
    expect(filterNonPlanProgressTools(calls)).toEqual([])
  })
})
