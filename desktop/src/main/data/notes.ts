/**
 * 项目笔记/记忆系统 - Barrel File（转发到拆分后的 notes/ 子模块）
 *
 * 此文件仅做 re-export，不再包含任何业务逻辑。
 * 实际实现分布在 notes/ 子目录下的各模块中：
 *
 * - notes-crud.ts: 笔记 CRUD
 * - memory-crud.ts: 任务记忆 CRUD
 * - memory-normalize.ts: 记忆标准化
 * - memory-migration.ts: 遗留迁移
 * - memory-maintain.ts: AI 记忆整理
 * - memory-recall.ts: 召回
 * - memory-replay.ts: 对话回放
 * - memory-utils.ts: 工具函数
 */

export * from './notes/index'
