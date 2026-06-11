/**
 * 工具系统 - Barrel file (向后兼容)
 *
 * 所有导出已拆分到独立模块：
 * - definitions.ts: 工具定义、类型、Prompt 构建器
 * - registry.ts: 工具过滤、权限管理
 * - executor.ts: 工具执行引擎
 * - risk-assessor.ts: 风险评估
 * - workspace-tree.ts: 工作区目录树
 */

// Types
export type {
  ToolDefinition,
  ToolCall,
  FileChange,
  ToolResult,
} from './definitions'

export type {
  RiskLevel,
  RiskInfo,
  RiskCategory,
} from './risk-assessor'

// Definitions & Prompt builders
export {
  toolDefinitions,
  normalizeToolName,
  buildToolDesignPromptBlock,
  getAllToolDefinitions,
  getFilteredToolDefinitions,
  getToolDesignPromptBlock, // backward compat alias
} from './definitions'

// Registry
export {
  buildAllowedToolNamesForRequest,
} from './registry'

// Executor
export {
  executeToolCalls,
  getWorkspaceTree,
  setBrowserAutoApproved,
  setDesktopAutoApproved,
  setAutoApproveCategories,
  getAutoApproveCategories,
  isBrowserAutoApproved,
  isDesktopAutoApproved,
} from './executor'

// Risk assessor
export {
  assessToolCallsRisk,
  RISK_CATEGORY_INFO,
} from './risk-assessor'
