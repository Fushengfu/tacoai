/**
 * 记忆系统 - Barrel file
 *
 * 所有导出已拆分到独立模块：
 * - memory-crud.ts: 任务记忆 CRUD
 * - memory-maintain.ts: AI 记忆整理
 * - memory-migration.ts: 记忆迁移
 * - memory-normalize.ts: 记忆标准化
 * - memory-recall.ts: 记忆召回
 * - memory-replay.ts: 对话回放
 * - memory-snapshot.ts: 记忆快照
 * - memory-stats.ts: 记忆统计
 * - memory-utils.ts: 记忆工具函数
 */

// CRUD
export { listTaskMemories, deleteTaskMemory, recordTaskLog } from './store'
export type { TaskLogInput } from './store'

// 标准化
export type { TaskMemoryEntry } from './memory-normalize'

// AI 记忆整理
export { maintainTaskMemoriesByAI } from './memory-maintain'
export type { MemoryMaintainOptions } from './memory-maintain'

// 召回
export { recallBackgroundContext } from './memory-recall'
export type { RecalledItem, RecallMeta, RecallDebugCandidate, BuildBackgroundContextOptions } from './memory-recall'

// 对话回放
export { buildBackgroundContextConversationMessages, inferIntentFromBackground, wrapUserQueryText } from './replay'
export type { BuildBackgroundContextConversationOptions } from './replay'

// 统计 & 导出
export { getMemoryScopeStats, exportMemoryScope } from './memory-stats'

// 迁移
export { ensureLegacyMemoryDbBootstrap, ensureNoteScopeReady, ensureTaskMemoryScopeReady } from './memory-migration'
