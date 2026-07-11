/**
 * 路径工具函数（向后兼容 barrel）
 *
 * 实际实现已迁移到 sdk/agent/paths.ts。
 * 此文件保留以兼容所有现有消费者（renderer / main / shared 内部）。
 * 
 * 注意：此模块依赖 electron.app，仅限主进程使用。
 */

export { resolveHomeDir, TACO_HOME, workspaceHash, projectScope } from '../main/sdk/agent/paths'
