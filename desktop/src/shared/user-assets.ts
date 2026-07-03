/**
 * USER_ASSETS / USER_QUERY 协议解析工具（向后兼容 barrel）
 *
 * 实际实现已迁移到 sdk/agent/shared/user-assets.ts。
 * 此文件保留以兼容所有现有消费者（renderer / main / shared 内部）。
 */

export {
  USER_ASSETS_BLOCK_REGEX,
  USER_ASSETS_BLOCK_CAPTURE_REGEX,
  USER_QUERY_BLOCK_CAPTURE_REGEX,
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  AUDIO_EXTENSIONS,
  isMediaFile,
  inferMediaSubtype,
  type UserAssetEntry,
  stripUserAssetsBlock,
  extractUserAssetsBlock,
  extractUserQueryText,
  parseUserAssetEntries,
  inferAssetKind,
  collectUserMediaRefsFromContent,
  collectUserMediaRefsFromMessages,
  appendMediaRefsToSummary,
  buildUserAssetsBlock,
  buildUserAssetsBlockFromAttachments,
  inferAttachmentType,
} from '../main/sdk/agent/shared/user-assets'
