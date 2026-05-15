/**
 * 项目笔记/记忆系统 - Barrel File
 *
 * 向后兼容导出所有原 notes.ts 的 export。
 * 消费方可以继续使用 `from '../data/notes'` 路径，无需修改。
 *
 * 模块拆分：
 * - notes-crud.ts: 笔记 CRUD
 * - memory-crud.ts: 任务记忆 CRUD
 * - memory-normalize.ts: 记忆标准化
 * - memory-migration.ts: 遗留迁移
 * - memory-maintain.ts: AI 记忆整理
 * - memory-recall.ts: 召回
 * - memory-replay.ts: 对话回放
 * - memory-snapshot.ts: 快照管理
 * - memory-utils.ts: 工具函数
 */

// 笔记 CRUD
export { listNotes, saveNote, deleteNote } from './notes-crud'

// 任务记忆 CRUD
export { listTaskMemories, deleteTaskMemory, recordTaskLog } from './memory-crud'
export type { TaskLogInput } from './memory-crud'

// 记忆标准化
export type { TaskMemoryEntry } from './memory-normalize'

// AI 记忆整理
export { maintainTaskMemoriesByAI } from './memory-maintain'
export type { MemoryMaintainOptions } from './memory-maintain'

// 快照管理
export { recordMemorySnapshot } from './memory-snapshot'
export type { MemorySnapshotEntry } from './memory-snapshot'

// 召回
export { recallBackgroundContext } from './memory-recall'
export type { RecalledItem, RecallMeta, RecallDebugCandidate, BuildBackgroundContextOptions } from './memory-recall'

// 对话回放
export { buildBackgroundContextConversationMessages, inferIntentFromBackground, wrapUserQueryText } from './memory-replay'
export type { BuildBackgroundContextConversationOptions } from './memory-replay'

// 统计 & 导出
export { getMemoryScopeStats, exportMemoryScope } from './memory-stats'

// 迁移（内部使用）
export { ensureLegacyMemoryDbBootstrap, ensureNoteScopeReady, ensureTaskMemoryScopeReady, ensureSnapshotScopeReady } from './memory-migration'
