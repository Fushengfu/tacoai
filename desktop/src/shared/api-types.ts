/**
 * TacoApi 形状定义
 *
 * 暴露给渲染进程的 window.taco 的完整 API 类型。
 * 此文件仅包含 TacoApi 接口，依赖的类型从 ipc-types.ts 导入。
 */

import type {
  AgentStreamPayload,
  AgentEventData,
  AppNotifyPayload,
  AppStateProvidersPayload,
  AppStateSnapshot,
  AppStateThreadsPayload,
  AppUpdateCheckResult,
  BridgeStatusPayload,
  ChatChunkData,
  ChatStoreSessionPatch,
  ChatStoreSessionSummary,
  ChatStoreSessionPage,
  EditorId,
  ExternalBrowserStatus,
  FileTreeEntry,
  GatewayModelsResponse,
  GitFileChange,
  GitWorkingTreeStatus,
  InstallProgress,
  McpServerInfo,
  MemoryScopeExportResult,
  MemoryScopeStats,
  MobileApkInfo,
  ProjectNote,
  ProjectTaskMemory,
  RendererErrorPayload,
  SkillInfo,
  SkillPreview,
  SkillUpdateInfo,
  SystemInfo,
} from './ipc-types'

export type { SystemInfo } from './ipc-types'

export type TacoApi = {
  version: string
  system: SystemInfo
  auth: {
    /** 通过主进程代理登录请求，避免 CORS 问题 */
    login: (username: string, password: string) => Promise<{ token: string; member: Record<string, unknown> }>
    /** 通过主进程代理注册请求 */
    register: (username: string, password: string, nickname?: string, phone?: string, email?: string) => Promise<{ token: string; member: Record<string, unknown> }>
    /** 持久化 Token 到文件系统（~/.taco/auth.json） */
    persistToken: (token: string, expiresAt?: number, memberInfo?: unknown) => Promise<void>
    /** 从文件系统加载持久化的 Token */
    loadPersistedToken: () => Promise<{ token: string; expiresAt?: number; memberInfo?: unknown } | null>
    /** 删除文件系统中持久化的 Token */
    removePersistedToken: () => Promise<void>
  }
  shell: {
    /** 用指定编辑器打开文件 */
    openInEditor: (filePath: string, editor: EditorId) => Promise<void>
    /** 在系统文件管理器中打开日志目录 */
    openLogDir: (scope?: { projectId?: string; workspace?: string }) => Promise<void>
    /** 触发操作系统通知 */
    notify: (payload: AppNotifyPayload) => Promise<boolean>
    /** 上报渲染层异常到主进程日志 */
    reportRendererError: (payload: RendererErrorPayload) => Promise<void>
  }
  updater: {
    /** 检查版本更新；manual=true 时发现新版本会弹窗确认下载 */
    check: (manual?: boolean) => Promise<AppUpdateCheckResult>
    /** 读取最近一次版本检查结果（可能为 null） */
    getStatus: () => Promise<AppUpdateCheckResult | null>
  }
  chat: {
    /** 监听流式数据块，返回取消订阅函数 */
    onChunk: (callback: (data: ChatChunkData) => void) => () => void
  }
  image: {
    /** 上传图片到云存储，返回public URL */
    upload: (dataUrl: string, fileName: string) => Promise<{ publicUrl: string }>
  }
  app: {
    /** 保存上传配置到文件 */
    saveUploadConfig: (config: unknown) => Promise<void>
  }
  chatStore: {
    /** 读取全部持久化会话摘要 */
    list: () => Promise<ChatStoreSessionSummary[]>
    /** 按页读取某个会话的消息尾部或更早历史 */
    loadPage: (sessionId: string, options?: { beforeSeq?: number; limit?: number }) => Promise<ChatStoreSessionPage | null>
    /** 从指定序号开始同步某个会话的消息尾部 */
    save: (patch: ChatStoreSessionPatch) => Promise<void>
    /** 删除某个会话的消息快照 */
    deleteSession: (sessionId: string) => Promise<void>
  }
  agent: {
    /** 发起 agent 流式请求（带工具调用） */
    stream: (payload: AgentStreamPayload) => void
    /** 监听 agent 事件，返回取消订阅函数 */
    onEvent: (callback: (data: AgentEventData) => void) => () => void
    /** 用户对风险操作的确认/拒绝响应 */
    confirmResponse: (confirmId: string, approved: boolean) => void
    /** 用户对可恢复错误的重试响应 */
    retryResponse: (retryId: string, shouldRetry: boolean) => void
    /** 终止当前正在运行的 agent */
    abort: (requestId: string) => void
    /** 设置自动授权分类（不需要用户确认的操作类型） */
    setAutoApprove: (categories: string[]) => void
  }
  dialog: {
    /** 打开目录选择对话框，返回选中的路径或 null */
    selectDirectory: () => Promise<string | null>
    /** 打开附件选择对话框，返回选中的文件绝对路径列表 */
    selectAttachments: () => Promise<string[]>
  }
  workspace: {
    /** 读取工作空间目录树 */
    tree: (cwd: string, force?: boolean) => Promise<FileTreeEntry[]>
    /** 开始监听工作空间变化 */
    watch: (cwd: string) => void
    /** 停止监听工作空间变化 */
    unwatch: () => void
    /** 监听工作空间变化通知 */
    onChanged: (callback: () => void) => () => void
  }
  file: {
    /** 将文件内容恢复为指定内容（用于撤销 Agent 变更） */
    revert: (filePath: string, oldContent: string) => Promise<void>
    /** 删除文件（用于撤销 Agent 新建的文件） */
    delete: (filePath: string) => Promise<void>
    /** 删除目录 */
    deleteDirectory: (dirPath: string) => Promise<void>
    /** 创建目录（自动创建父目录） */
    createDirectory: (dirPath: string) => Promise<void>
    /** 重命名文件或目录 */
    rename: (oldPath: string, newPath: string) => Promise<void>
    /** 读取文件内容（文本文件返回内容字符串，二进制文件返回 null；图片可返回 dataUrl 预览） */
    read: (filePath: string) => Promise<{ content: string | null; size: number; isBinary: boolean; dataUrl?: string; truncated?: boolean }>
    /** 写入文件内容 */
    write: (filePath: string, content: string) => Promise<void>
  }
  terminal: {
    /** 创建终端进程 */
    spawn: (cwd?: string) => void
    /** 向终端发送输入（键盘数据） */
    input: (data: string) => void
    /** 监听终端输出数据 */
    onOutput: (callback: (data: string) => void) => () => void
    /** 监听终端退出 */
    onExit: (callback: (data: { code: number | null }) => void) => () => void
    /** 调整终端大小 */
    resize: (cols: number, rows: number) => void
    /** 关闭终端 */
    kill: () => void
  }
  git: {
    /** 获取 Taco 提交历史 */
    log: (cwd: string) => Promise<{ hash: string; shortHash: string; message: string; timestamp: number; fileCount: number }[]>
    /** 获取工作区暂存状态 */
    status: (cwd: string) => Promise<GitWorkingTreeStatus>
    /** 获取某个文件的 Git 差异（HEAD vs 工作区） */
    fileChange: (cwd: string, filePath: string) => Promise<GitFileChange | null>
    /** 手动创建提交 */
    commit: (cwd: string, message: string) => Promise<string | null>
    /** 暂存指定文件 */
    stageFiles: (cwd: string, filePaths: string[]) => Promise<void>
    /** 暂存全部变更 */
    stageAll: (cwd: string) => Promise<void>
    /** 回退到指定提交 */
    rollback: (cwd: string, hash: string) => Promise<void>
    /** 获取某个提交变更的文件列表 */
    commitFiles: (cwd: string, hash: string) => Promise<string[]>
  }
  skills: {
    /** 列出所有已安装的 skills */
    list: (workspace?: string) => Promise<SkillInfo[]>
    /** 预览 skill（从 URL 或本地路径，不安装） */
    preview: (source: string) => Promise<SkillPreview>
    /** 安装 skill（从 URL 或本地路径，支持进度回调） */
    install: (source: string, onProgress?: (progress: InstallProgress) => void) => Promise<SkillInfo>
    /** 安装预设 skill */
    installPreset: (presetId: string) => Promise<SkillInfo>
    /** 卸载 skill */
    uninstall: (id: string) => Promise<void>
    /** 启用/禁用 skill */
    toggle: (id: string, enabled: boolean) => Promise<void>
    /** 检查 skill 更新 */
    checkUpdate: (id: string) => Promise<SkillUpdateInfo | null>
  }
  notes: {
    /** 列出指定工作空间的所有笔记 */
    list: (workspace: string, projectId?: string) => Promise<ProjectNote[]>
    /** 列出指定工作空间的任务执行记忆 */
    listTaskMemories: (workspace: string, projectId?: string) => Promise<ProjectTaskMemory[]>
    /** 删除任务执行记忆 */
    deleteTaskMemory: (workspace: string, memoryId: string, projectId?: string) => Promise<void>
    /** 保存笔记（新增或更新） */
    save: (workspace: string, note: ProjectNote, projectId?: string) => Promise<ProjectNote>
    /** 删除笔记 */
    delete: (workspace: string, noteId: string, projectId?: string) => Promise<void>
    /** 获取当前作用域记忆库统计 */
    stats: (workspace: string, projectId?: string) => Promise<MemoryScopeStats>
    /** 导出当前作用域记忆库 */
    exportScope: (workspace: string, projectId?: string) => Promise<MemoryScopeExportResult>
  }
  window: {
    /** 开始拖拽窗口（传入鼠标屏幕坐标） */
    dragStart: (screenX: number, screenY: number) => void
    /** 拖拽中，更新窗口位置 */
    dragging: (screenX: number, screenY: number) => void
    /** 拖拽结束 */
    dragEnd: () => void
    /** 双击顶栏切换最大化/还原 */
    toggleMaximize: () => void
    /** 最小化窗口 */
    minimize: () => void
    /** 关闭窗口 */
    close: () => void
  }
  mcp: {
    /** 列出所有 MCP 服务器 */
    list: () => Promise<McpServerInfo[]>
    /** 保存（添加/更新）MCP 服务器 */
    save: (server: McpServerInfo) => Promise<void>
    /** 删除 MCP 服务器 */
    remove: (id: string) => Promise<void>
    /** 启用/禁用 MCP 服务器 */
    toggle: (id: string, enabled: boolean) => Promise<void>
  }
  browser: {
    /** 监听主进程发来的打开 URL 事件 */
    onOpenUrl: (callback: (url: string) => void) => () => void
    /** 设置浏览器调试模式（打开时自动开启 DevTools） */
    setDebugMode: (enabled: boolean) => void
    /** 设置浏览器隐藏窗口模式（打开时隐藏窗口） */
    setHiddenMode: (enabled: boolean) => void
    /** 外部浏览器：打开独立窗口（可指定 appId） */
    openExternal: (url: string, appId?: string) => Promise<void>
    /** 外部浏览器：关闭独立窗口（可指定 appId） */
    closeExternal: (appId?: string) => Promise<void>
    /** 外部浏览器：在已有窗口中导航到新 URL（可指定 appId） */
    navigateExternal: (url: string, appId?: string) => Promise<void>
    /** 外部浏览器：聚焦/显示已有窗口（不重新加载，可指定 appId） */
    focusExternal: (appId?: string) => Promise<void>
    /** 监听外部浏览器状态变化 (opened/closed/navigated) */
    onExternalStatus: (callback: (status: ExternalBrowserStatus) => void) => () => void
  }
  appState: {
    get: () => Promise<AppStateSnapshot>
    saveThreads: (payload: AppStateThreadsPayload) => Promise<AppStateThreadsPayload>
    saveProviders: (payload: AppStateProvidersPayload) => Promise<AppStateProvidersPayload>
    /** 监听 main 进程的退出前保存请求；返回取消监听的函数 */
    onRequestSave: (callback: () => void) => () => void
    /** 渲染层保存完毕后通知 main 进程可安全退出 */
    notifySaveComplete: () => void
  }
  gateway: {
    /** 从 AI 网关获取模型列表（需要已登录） */
    getModels: () => Promise<GatewayModelsResponse>
  }
  bridge: {
    /** 获取手机端 APK 下载信息（从版本检查 API 获取 download_url，失败返回 null） */
    getMobileApkInfo: (packageName: string) => Promise<MobileApkInfo | null>
    /** 使用会员 token 连接 Relay */
    connect: (token: string) => void
    /** 断开桥接连接 */
    disconnect: () => void
    /** 监听桥接状态变更 */
    onStatusChange: (callback: (status: BridgeStatusPayload) => void) => () => void
    /** 获取当前桥接状态 */
    getStatus: () => Promise<BridgeStatusPayload>
    /** 刷新 Token（用于 Token 过期时自动续期） */
    refreshToken: (newToken: string) => void
    /** 监听移动端请求切换项目 */
    onSwitchProject: (callback: (data: { projectId: string; sessionId?: string }) => void) => () => void
    /** 监听移动端请求切换模型 */
    onSwitchModel: (callback: (data: { modelConfigId: string }) => void) => () => void
    /** 通知主进程：移动端请求的项目切换已完成，消息已加载 */
    notifySwitchProjectLoaded: (data: { projectId: string; sessionId: string }) => void
    /** 监听移动端发来的消息（chat-send / agent-confirm / agent-abort 等） */
    onClientMessage: (callback: (msg: Record<string, unknown>) => void) => () => void
    /** 发送状态快照响应给主进程 */
    sendStateSnapshotResponse: (payload: {
      messages: Array<{ id: string; role: string; content: string; hasImages: boolean; streaming: boolean }>
      threadId: string
      sessionId?: string
      workspace?: string
      modelLabel?: string
      modelConfigId?: string
      threadTitle?: string
      activeAgentRequestId?: string
      tokenUsage?: {
        promptTokens?: number
        completionTokens?: number
        totalTokens?: number
        cachedTokens?: number
      }
    }) => void
    /** 监听主进程请求状态快照 */
    onRequestStateSnapshot: (callback: (payload: {
      threadId: string
      sessionId?: string
      workspace?: string
      modelConfigId?: string
      threadTitle?: string
    }) => void) => () => void
  }
}
