/* ------------------------------------------------------------------ */
/*  Barrel file — 向后兼容导出所有公开 API                               */
/* ------------------------------------------------------------------ */

// Schema & types
export type {
  TaskMemoryEntry,
  ProjectNoteEntry,
  ChatStoreSessionEntry,
  ChatStoreSessionSummaryEntry,
  ChatStoreSessionPageEntry,
  ChatStoreSessionPatchEntry,
  MemorySnapshotEntry,
  AppStateStoreEntry,
  ChatStoreMessageSeqRange,
  BridgeSettingKey,
  BridgeSettingValue,
  UploadConfigDbEntry,
  MemoryTier,
  MemoryScope,
} from './schema'

export {
  APP_PROVIDER_IDS,
  APP_PROVIDER_LABELS,
  MEMORY_DB_PATH,
  buildScopeWhere,
  ensureColumn,
  runInTransaction,
  getMemoryDbInfo,
  isMemoryDbEmpty,
  initMemoryDb,
  getDb,
} from './schema'

// Utils
export {
  stringifyStringArray,
  parseStringArray,
  parseOptionalInteger,
  parseUnknownArray,
  parseUnknownObject,
  normalizeChatStoreSeq,
  parseOptionalTimestamp,
  asTrimmedString,
  asOptionalTrimmedString,
  asBooleanFlag,
  normalizeProviderId,
  normalizeMode,
  resolveLatestIsoTimestamp,
  rowToTaskMemoryEntry,
  rowToSnapshotEntry,
  rowToProjectNoteEntry,
  rowToChatStoreSessionEntry,
  rowToChatStoreSessionSummaryEntry,
  normalizeSessionForStorage,
  normalizeThreadForStorage,
  normalizeModelConfigForStorage,
  normalizeLegacyProviderFormsForStorage,
} from './utils'

// TaskMemory CRUD
export {
  hasAnyTaskMemories,
  listTaskMemoriesByTier,
  replaceTaskMemoriesByTier,
  importTaskMemoriesByTier,
} from './task-memory'

// ProjectNotes CRUD
export {
  hasAnyProjectNotes,
  listProjectNotesForScope,
  replaceProjectNotes,
  importProjectNotes,
} from './project-notes'

// Snapshots CRUD
export {
  hasAnyMemorySnapshots,
  listMemorySnapshotsForScope,
  replaceMemorySnapshots,
  importMemorySnapshots,
} from './snapshots'

// Maintain runs
export {
  insertMemoryMaintainRun,
  countMemoryMaintainRuns,
} from './maintain-runs'

// App state
export {
  loadAppThreadsStateFromDb,
  saveAppThreadsStateToDb,
  loadAppProvidersStateFromDb,
  saveAppProvidersStateToDb,
} from './app-state'

// Chat store
export {
  resolveChatStoreMessageSeqRange,
  listChatStoreSessions,
  loadChatStoreSessionPage,
  saveChatStoreSessionPatch,
  deleteChatStoreSession,
} from './chat-store'

// Bridge settings & upload config
export {
  getBridgeSetting,
  setBridgeSetting,
  loadUploadConfigFromDb,
  saveUploadConfigToDb,
} from './bridge-settings'
