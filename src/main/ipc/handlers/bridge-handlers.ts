/**
 * Bridge IPC Handlers（主编排器）
 *
 * 包含 Bridge 跨端桥接相关的所有 handler 注册与导出。
 * 子模块：
 *   bridge-utils   — 缓存、树结构、图片脱敏、文件 I/O
 *   bridge-state   — 状态处理器（项目切换、Token 更新、状态转发、快照响应）
 *   bridge-data    — 数据查询处理器（项目列表、目录树、文件读写、模型列表等）
 */

import type { IpcMainEvent } from 'electron'
import type { BridgeStatusPayload } from '../../../shared/ipc'
import { getBridgeManager } from '../../bridge/bridge-manager'

// 重导出所有子模块
export { tokenUsageCache, projectTokenStatsCache, buildNestedTree, stripDataUrlFromMessages, stripAgentStepsForBridge, handleFileRead, handleFileWrite } from './bridge-utils'
export { setupBridgeSwitchProjectLoadedHandler, setupBridgeTokenUsageUpdateHandler, setupBridgeStatusForwarding, setupBridgeClientConnectedHandler, setupBridgeStateSnapshotResponse } from './bridge-state'
export { setupBridgeDataHandler } from './bridge-data'

/* ------------------------------------------------------------------ */
/*  Bridge connection handlers                                         */
/* ------------------------------------------------------------------ */

/** 使用会员 token 连接 Relay */
export function handleBridgeConnect(_event: IpcMainEvent, token: string): void {
  const mgr = getBridgeManager()
  mgr.connect(token)
}

/** 断开桥接连接 */
export function handleBridgeDisconnect(): void {
  getBridgeManager().disconnect()
}

/** 获取当前桥接状态 */
export async function handleBridgeGetStatus(): Promise<BridgeStatusPayload> {
  return getBridgeManager().getStatus()
}

/** 刷新 Token（用于 Token 过期时自动续期） */
export function handleBridgeRefreshToken(_event: IpcMainEvent, newToken: string): void {
  getBridgeManager().refreshToken(newToken)
}
