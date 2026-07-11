/**
 * 项目笔记/记忆系统 - Barrel File（向后兼容）
 *
 * 实际代码已迁移到 sdk/agent/memory/ 和 services/notes/。
 * 消费方可以继续使用 `from '../data/notes'` 路径，无需修改。
 */

// 笔记 CRUD（→ services/notes/）
export { listNotes, saveNote, deleteNote } from '../../services/notes/notes-crud'

// 任务记忆 CRUD（→ sdk/agent/memory/）
export { listTaskMemories, deleteTaskMemory, recordTaskLog } from '../../sdk/agent/memory/store'
export type { TaskLogInput } from '../../sdk/agent/memory/store'

// 记忆标准化（→ sdk/agent/memory/）
export type { TaskMemoryEntry } from '../../sdk/agent/memory/memory-normalize'

// AI 记忆整理（→ sdk/agent/memory/）
export { maintainTaskMemoriesByAI } from '../../sdk/agent/memory/memory-maintain'
export type { MemoryMaintainOptions } from '../../sdk/agent/memory/memory-maintain'

// 召回（→ sdk/agent/memory/）
export { recallBackgroundContext } from '../../sdk/agent/memory/memory-recall'
export type { RecalledItem, RecallMeta, RecallDebugCandidate, BuildBackgroundContextOptions } from '../../sdk/agent/memory/memory-recall'

// 对话回放（→ sdk/agent/memory/）
export { buildBackgroundContextConversationMessages, inferIntentFromBackground, wrapUserQueryText } from '../../sdk/agent/memory/replay'
export type { BuildBackgroundContextConversationOptions } from '../../sdk/agent/memory/replay'

// 统计 & 导出（→ sdk/agent/memory/）
export { getMemoryScopeStats, exportMemoryScope } from '../../sdk/agent/memory/memory-stats'

// 迁移（→ sdk/agent/memory/）
export { ensureLegacyMemoryDbBootstrap, ensureNoteScopeReady, ensureTaskMemoryScopeReady } from '../../sdk/agent/memory/memory-migration'
