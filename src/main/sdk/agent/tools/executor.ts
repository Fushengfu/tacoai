/**
 * 工具执行引擎 - 主入口
 *
 * 所有工具执行器已拆分到各子模块：
 * - exec-utils.ts: 路径解析、进程工具、类型定义
 * - exec-vision.ts: 视觉分析（analyze_image）
 * - exec-files.ts: 文件操作（read/write/edit/delete/list/find）
 * - exec-command.ts: 命令执行 + 文件上传
 * - exec-terminal.ts: 终端管理
 * - exec-mcp.ts: MCP 协议
 * - exec-recall.ts: 记忆回想
 * - exec-browser.ts: 浏览器使用
 * - exec-computer.ts: 电脑使用
 * - exec-skills.ts: 技能（搜索/安装/卸载/脚本执行）
 */

import type { AgentServices } from '../services'
import { normalizeToolName, type ToolCall, type ToolResult, type FileChange } from './definitions'
import { assessToolCallsRisk, type RiskInfo, type RiskCategory, type RiskLevel } from './risk'
import type { ExecResult, ToolRuntimeContext } from './exec-utils'
import { isAbortError, makeAbortError } from './exec-utils'
import { execAnalyzeImage } from './exec-vision'
import {
  execReadFile,
  execReadSkill,
  execReadSkillResource,
  execWriteFile,
  execEditFile,
  execDeleteFile,
  execListDirectory,
  execFindFile,
} from './exec-files'
import { execRunCommand, execUploadFile } from './exec-command'
import {
  execTerminalCreate,
  execTerminalRun,
  execTerminalList,
  execTerminalClose,
} from './exec-terminal'
import { execMcpCall, execMcpListTools } from './exec-mcp'
import { execRecallMemories } from './exec-recall'
import {
  execRunSkillScript,
  execSearchSkills,
  execInstallSkill,
  execUninstallSkill,
} from './exec-skills'

/* ------------------------------------------------------------------ */
/*  Tool dispatch                                                       */
/* ------------------------------------------------------------------ */

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  workspace: string,
  signal?: AbortSignal,
  projectId?: string,
  logScope?: string,
  runtimeContext?: ToolRuntimeContext,
): Promise<ExecResult & { fileChange?: FileChange }> {
  try {
    if (signal?.aborted) throw makeAbortError()
    const normalizedName = normalizeToolName(name)
    switch (normalizedName) {
      case 'read_file':
        return await execReadFile(args, workspace)
      case 'read_skill':
        return await execReadSkill(args, runtimeContext)
      case 'read_skill_resource':
        return await execReadSkillResource(args, runtimeContext)
      case 'write_file':
        return await execWriteFile(args, workspace)
      case 'edit_file':
        return await execEditFile(args, workspace)
      case 'delete_file':
        return await execDeleteFile(args, workspace)
      case 'list_dir':
        return await execListDirectory(args, workspace)
      case 'run_command':
        return await execRunCommand(args, workspace, signal)
      case 'find_file':
        return await execFindFile(args, workspace)
      case 'analyze_image':
        return await execAnalyzeImage(args, workspace, runtimeContext)
      case 'mcp_call':
        return await execMcpCall(args, signal, runtimeContext?.services, workspace)
      case 'mcp_list_tools':
        return await execMcpListTools(runtimeContext?.services)
      case 'upload_file':
        return await execUploadFile(args, workspace, runtimeContext?.services)
      case 'terminal_create':
        return await execTerminalCreate(args, workspace, runtimeContext?.services)
      case 'terminal_run':
        return await execTerminalRun(args, runtimeContext?.services)
      case 'terminal_list':
        return await execTerminalList(runtimeContext?.services)
      case 'terminal_close':
        return await execTerminalClose(args, runtimeContext?.services)
      case 'run_skill_script':
        return await execRunSkillScript(args, workspace, projectId, signal, logScope, runtimeContext)
      case 'recall_memories':
        return await execRecallMemories(args, workspace, projectId, runtimeContext)
      case 'search_skills':
        return await execSearchSkills(args, runtimeContext)
      case 'install_skill':
        return await execInstallSkill(args, workspace, runtimeContext)
      case 'uninstall_skill':
        return await execUninstallSkill(args, runtimeContext)
      default:
        return { content: `Unknown tool: ${name}`, success: false }
    }
  } catch (err) {
    if (isAbortError(err)) throw err
    const msg = err instanceof Error ? err.message : String(err)
    return { content: `Error: ${msg}`, success: false }
  }
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/** 异步执行一批 tool calls，返回结果 */
export async function executeToolCalls(
  toolCalls: ToolCall[],
  workspace: string,
  signal?: AbortSignal,
  logScope?: string,
  projectId?: string,
  runtimeContext?: ToolRuntimeContext,
): Promise<ToolResult[]> {
  const results: ToolResult[] = []
  const services = runtimeContext?.services

  for (const tc of toolCalls) {
    if (signal?.aborted) break
    const normalizedName = normalizeToolName(tc.function.name)
    if (runtimeContext?.allowedToolNames && !runtimeContext.allowedToolNames.has(normalizedName)) {
      results.push({
        tool_call_id: tc.id,
        name: tc.function.name,
        content: `Error: Tool is not enabled for current task: ${normalizedName}.`,
        success: false,
      })
      continue
    }
    let args: Record<string, unknown> = {}
    try {
      args = JSON.parse(tc.function.arguments)
    } catch {
      results.push({
        tool_call_id: tc.id,
        name: tc.function.name,
        content: `Error: Invalid JSON arguments: ${tc.function.arguments}`,
        success: false,
      })
      continue
    }

    services?.logger('TOOL_CALL', { id: tc.id, name: tc.function.name, arguments: args, workspace }, logScope)

    let result: ExecResult & { fileChange?: FileChange }
    try {
      result = await executeTool(tc.function.name, args, workspace, signal, projectId, logScope, runtimeContext)
    } catch (err) {
      if (isAbortError(err)) break
      const msg = err instanceof Error ? err.message : String(err)
      result = { content: `Error: ${msg}`, success: false }
    }

    services?.logger('TOOL_RESULT', { id: tc.id, name: tc.function.name, success: result.success, content: result.content }, logScope)

    results.push({
      tool_call_id: tc.id,
      name: tc.function.name,
      ...result,
    })
  }

  return results
}

// Re-exports
export { assessToolCallsRisk }
export type { RiskInfo, RiskCategory, RiskLevel }
export { setBrowserAutoApproved, setComputerAutoApproved, setAutoApproveCategories, getAutoApproveCategories, isBrowserAutoApproved, isComputerAutoApproved } from './risk'
export { getWorkspaceTree } from './workspace-tree'
export { buildAllowedToolNamesForRequest } from './registry'
