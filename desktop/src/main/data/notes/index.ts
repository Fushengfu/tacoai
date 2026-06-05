/**
 * 项目笔记/记忆系统 - Barrel File（向后兼容）
 *
 * 实际代码已迁移到 main/services/memory/ 和 main/services/notes/。
 * 消费方可以继续使用 `from '../data/notes'` 路径，无需修改。
 */

// 笔记 CRUD（→ services/notes/）
export { listNotes, saveNote, deleteNote } from '../../services/notes/notes-crud'

// 任务记忆 CRUD（→ services/memory/）
export { listTaskMemories, deleteTaskMemory, recordTaskLog } from '../../services/memory/memory-crud'
export type { TaskLogInput } from '../../services/memory/memory-crud'

// 记忆标准化（→ services/memory/）
export type { TaskMemoryEntry } from '../../services/memory/memory-normalize'

// AI 记忆整理（→ services/memory/）
export { maintainTaskMemoriesByAI } from '../../services/memory/memory-maintain'
export type { MemoryMaintainOptions } from '../../services/memory/memory-maintain'

// 召回（→ services/memory/）
export { recallBackgroundContext } from '../../services/memory/memory-recall'
export type { RecalledItem, RecallMeta, RecallDebugCandidate, BuildBackgroundContextOptions } from '../../services/memory/memory-recall'

// 对话回放（→ services/memory/）
export { buildBackgroundContextConversationMessages, inferIntentFromBackground, wrapUserQueryText } from '../../services/memory/memory-replay'
export type { BuildBackgroundContextConversationOptions } from '../../services/memory/memory-replay'

// 统计 & 导出（→ services/memory/）
export { getMemoryScopeStats, exportMemoryScope } from '../../services/memory/memory-stats'

// 迁移（→ services/memory/）
export { ensureLegacyMemoryDbBootstrap, ensureNoteScopeReady, ensureTaskMemoryScopeReady } from '../../services/memory/memory-migration'
