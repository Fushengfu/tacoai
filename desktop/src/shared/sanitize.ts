/**
 * 文本清理工具（向后兼容 barrel）
 *
 * 实际实现已迁移到 sdk/agent/shared/sanitize.ts。
 * 此文件保留以兼容所有现有消费者（renderer / main / shared 内部）。
 */

export {
  stripInternalContextTags,
  stripPseudoToolCallArtifacts,
  sanitizeUserFacingText,
  sanitizeContextArtifacts,
  stripReasoningArtifacts,
  sanitizeReasoningForContext,
  sanitizeReplayRawText,
  containsPseudoToolCallSyntax,
} from '../main/sdk/agent/shared/sanitize'
