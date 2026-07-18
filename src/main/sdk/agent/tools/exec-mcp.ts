/**
 * 工具执行器 - MCP 协议（mcp_call / mcp_list_tools）
 */

import type { AgentServices } from '../services'
import { makeAbortError, type ExecResult, type ToolRuntimeContext } from './exec-utils'

/* ------------------------------------------------------------------ */
/*  mcp_call                                                           */
/* ------------------------------------------------------------------ */

export async function execMcpCall(
  args: Record<string, unknown>,
  signal?: AbortSignal,
  services?: AgentServices,
  workspace?: string,
): Promise<ExecResult> {
  const serverId = String(args.server_id ?? '').trim()
  const toolName = String(args.tool_name ?? '').trim()
  const toolArgs = (args.arguments ?? {}) as Record<string, unknown>

  if (!serverId) return { content: 'Error: server_id is required', success: false }
  if (!toolName) return { content: 'Error: tool_name is required', success: false }
  if (signal?.aborted) throw makeAbortError()

  if (!services?.mcp) return { content: 'Error: MCP service not available', success: false }

  try {
    const result = await services.mcp.callTool(serverId, toolName, toolArgs)

    const texts: string[] = []
    for (const item of result.content ?? []) {
      if (item.type === 'text' && item.text) {
        texts.push(item.text)
      } else if (item.type === 'image' && item.data) {
        try {
          const imgPath = await services.mcp.saveScreenshot(`data:image/png;base64,${item.data}`, undefined, workspace)
          texts.push(`[图片已保存: ${imgPath}]`)
        } catch {
          texts.push('[图片数据接收成功但保存失败]')
        }
      } else if (item.type === 'resource') {
        texts.push(`[Resource: ${JSON.stringify(item)}]`)
      }
    }

    const content = texts.join('\n') || '(MCP 工具返回空结果)'
    return { content, success: !result.isError }
  } catch (err) {
    return { content: `MCP 调用失败: ${err instanceof Error ? err.message : String(err)}`, success: false }
  }
}

/* ------------------------------------------------------------------ */
/*  mcp_list_tools                                                     */
/* ------------------------------------------------------------------ */

export async function execMcpListTools(services?: AgentServices): Promise<ExecResult> {
  if (!services?.mcp) {
    return { content: '当前没有已启用的 MCP 服务器或没有可用工具。', success: true }
  }

  const mcpTools = services.mcp.getActiveTools()

  if (mcpTools.length === 0) {
    return {
      content: '当前没有已启用的 MCP 服务器或没有可用工具。请在设置中启用 MCP 服务器并配置 API Key。',
      success: true,
    }
  }

  const groups: Record<string, Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>> = {}
  for (const tool of mcpTools) {
    if (!groups[tool.serverId]) groups[tool.serverId] = []
    groups[tool.serverId].push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })
  }

  const lines: string[] = ['已启用的 MCP 工具列表：', '']
  for (const [serverId, tools] of Object.entries(groups)) {
    lines.push(`## 服务器: ${serverId}`)
    for (const tool of tools) {
      lines.push(`- **${tool.name}**: ${tool.description ?? '(无描述)'}`)
      if (tool.inputSchema?.properties) {
        const props = tool.inputSchema.properties as Record<string, { type?: string; description?: string }>
        const required = (tool.inputSchema.required ?? []) as string[]
        for (const [key, val] of Object.entries(props)) {
          const req = required.includes(key) ? ' (必需)' : ' (可选)'
          lines.push(`  - \`${key}\` (${val.type ?? 'any'}${req}): ${val.description ?? ''}`)
        }
      }
    }
    lines.push('')
  }

  lines.push('使用 mcp_call 工具来调用上述工具，传入 server_id、tool_name 和 arguments。')

  return { content: lines.join('\n'), success: true }
}
