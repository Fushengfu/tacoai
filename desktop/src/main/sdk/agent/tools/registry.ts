/**
 * 工具注册与权限管理
 *
 * 包含工具过滤、技能工具映射、允许列表构建等。
 */

import { normalizeToolName, toolDefinitions, type ToolDefinition } from './definitions'

const ALWAYS_AVAILABLE_TOOL_NAMES = [
  'read_file',
  'write_file',
  'edit_file',
  'list_dir',
  'run_command',
  'delete_file',
  'propose_plan',
  'update_plan_progress',
  'find_file',
  'read_skill',
  'read_skill_resource',
  'mcp_list_tools',
  'mcp_call',
  'upload_file',
  'analyze_image',
  'terminal_create',
  'terminal_run',
  'terminal_list',
  'terminal_close',
  'run_skill_script',
  'recall_memories',
]

function filterToolDefinitions(allowedToolNames?: Iterable<string>): ToolDefinition[] {
  if (!allowedToolNames) return [...toolDefinitions]
  const allowed = new Set<string>()
  for (const name of allowedToolNames) {
    const normalized = normalizeToolName(String(name ?? '').trim())
    if (normalized) allowed.add(normalized)
  }
  return toolDefinitions.filter((definition) => allowed.has(normalizeToolName(definition.function.name)))
}

export function buildAllowedToolNamesForRequest(): Set<string> {
  return new Set(ALWAYS_AVAILABLE_TOOL_NAMES.map((name) => normalizeToolName(name)))
}

export { filterToolDefinitions }
