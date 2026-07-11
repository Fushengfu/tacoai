/**
 * 意图类型推断（向后兼容 barrel）
 *
 * 实际实现已迁移到 sdk/agent/shared/intent.ts。
 * 此文件保留以兼容所有现有消费者（renderer / main / shared 内部）。
 */

export { inferIntentTypeFromQuery } from '../main/sdk/agent/shared/intent'
