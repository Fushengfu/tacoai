/**
 * IPC 通信协议定义
 *
 * 所有 IPC 通道名称、payload 类型、以及暴露给渲染进程的 API 形状
 * 统一在此文件定义，供 main / preload / renderer 三端共享。
 *
 * 此文件为 barrel 文件，实际定义拆分在：
 * - ipc-channels.ts: IpcChannel 通道名称
 * - ipc-types.ts: 所有 payload / event / domain 类型
 * - api-types.ts: TacoApi 接口形状
 */

export { IpcChannel } from './ipc-channels'
export * from './ipc-types'
export * from './api-types'
