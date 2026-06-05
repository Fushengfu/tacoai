/**
 * 工具系统 - Barrel file（向后兼容）
 *
 * 实际代码已迁移到 services/tools/。
 */

export type {
  ToolDefinition,
  ToolCall,
  FileChange,
  ToolResult,
} from '../services/tools/definitions'

export type {
  RiskLevel,
  RiskInfo,
  RiskCategory,
} from '../services/tools/risk-assessor'

export {
  toolDefinitions,
  normalizeToolName,
  buildToolDesignPromptBlock,
  getAllToolDefinitions,
  getFilteredToolDefinitions,
  getToolDesignPromptBlock,
} from '../services/tools/definitions'

export {
  buildAllowedToolNamesForRequest,
} from '../services/tools/registry'

export {
  executeToolCalls,
  getWorkspaceTree,
  setBrowserAutoApproved,
  setDesktopAutoApproved,
  setAutoApproveCategories,
  getAutoApproveCategories,
  isBrowserAutoApproved,
  isDesktopAutoApproved,
} from '../services/tools/executor'

export {
  assessToolCallsRisk,
  RISK_CATEGORY_INFO,
} from '../services/tools/risk-assessor'
