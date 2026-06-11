/**
 * IPC 通道名称定义
 *
 * 所有 IPC 通道名称枚举，供 main / preload / renderer 三端共享。
 */

export const IpcChannel = {
  /** renderer → main (invoke/handle, 非流式请求) */
  CHAT_SEND: 'chat:send',
  /** renderer → main (send/on, 发起流式请求) */
  CHAT_STREAM: 'chat:stream',
  /** renderer → main (send/on, 终止当前 chat 流式请求) */
  CHAT_ABORT: 'chat:abort',
  /** main → renderer (send/on, 流式数据推送) */
  CHAT_CHUNK: 'chat:chunk',
  /** renderer → main (invoke/handle, 图片上传到云存储) */
  IMAGE_UPLOAD: 'image:upload',
  /** renderer → main (invoke/handle, 保存上传配置到文件) */
  UPLOAD_CONFIG_SAVE: 'upload-config:save',

  /** renderer → main (invoke/handle, 列出持久化会话摘要) */
  CHAT_STORE_LIST: 'chat-store:list',
  /** renderer → main (invoke/handle, 按页读取某个会话的持久化消息) */
  CHAT_STORE_LOAD_PAGE: 'chat-store:load-page',
  /** renderer → main (invoke/handle, 保存某会话完整消息快照) */
  CHAT_STORE_SAVE: 'chat-store:save',
  /** renderer → main (invoke/handle, 删除某会话消息快照) */
  CHAT_STORE_DELETE_SESSION: 'chat-store:delete-session',

  /** renderer → main (send/on, 发起 agent 流式请求) */
  AGENT_STREAM: 'agent:stream',
  /** main → renderer (send/on, agent 事件推送) */
  AGENT_EVENT: 'agent:event',
  /** main → renderer (send/on, agent 事件分块推送) */
  AGENT_EVENT_CHUNK: 'agent:event-chunk',
  /** renderer → main (send/on, 用户对风险操作的确认响应) */
  AGENT_CONFIRM: 'agent:confirm',
  /** renderer → main (send/on, 用户对可恢复错误的重试响应) */
  AGENT_RETRY_RESPONSE: 'agent:retry-response',
  /** renderer → main (send/on, 终止当前 agent 执行) */
  AGENT_ABORT: 'agent:abort',

  /** renderer → main (invoke/handle, 选择目录对话框) */
  SELECT_DIRECTORY: 'dialog:select-directory',
  /** renderer → main (invoke/handle, 选择附件文件) */
  SELECT_ATTACHMENTS: 'dialog:select-attachments',
  /** renderer → main (invoke/handle, 用编辑器打开文件) */
  OPEN_IN_EDITOR: 'shell:open-in-editor',

  /** renderer → main (invoke/handle, 文件撤销/恢复) */
  FILE_REVERT: 'file:revert',
  /** renderer → main (invoke/handle, 删除新建的文件) */
  FILE_DELETE: 'file:delete',
  /** renderer → main (invoke/handle, 删除目录) */
  DIRECTORY_DELETE: 'directory:delete',
  /** renderer → main (invoke/handle, 读取文件内容) */
  FILE_READ: 'file:read',
  /** renderer → main (invoke/handle, 写入文件内容) */
  FILE_WRITE: 'file:write',

  /** 终端 — renderer ↔ main 双向通信 */
  TERMINAL_SPAWN: 'terminal:spawn',
  TERMINAL_INPUT: 'terminal:input',
  TERMINAL_OUTPUT: 'terminal:output',
  TERMINAL_RESIZE: 'terminal:resize',
  TERMINAL_KILL: 'terminal:kill',
  TERMINAL_EXIT: 'terminal:exit',

  /** 工作区目录树 */
  WORKSPACE_TREE: 'workspace:tree',
  /** renderer → main, 开始监听工作区文件变化 */
  WORKSPACE_WATCH: 'workspace:watch',
  /** renderer → main, 停止监听工作区文件变化 */
  WORKSPACE_UNWATCH: 'workspace:unwatch',
  /** main → renderer, 工作区文件发生变化 */
  WORKSPACE_CHANGED: 'workspace:changed',

  /** Git 版本控制 */
  GIT_LOG: 'git:log',
  GIT_COMMIT: 'git:commit',
  GIT_ROLLBACK: 'git:rollback',
  GIT_COMMIT_FILES: 'git:commit-files',
  GIT_STATUS: 'git:status',
  GIT_FILE_CHANGE: 'git:file-change',
  GIT_STAGE_FILES: 'git:stage-files',
  GIT_STAGE_ALL: 'git:stage-all',

  /** Skills 管理 */
  SKILLS_LIST: 'skills:list',
  SKILLS_INSTALL: 'skills:install',
  SKILLS_UNINSTALL: 'skills:uninstall',
  SKILLS_TOGGLE: 'skills:toggle',

  /** Agent 自动授权分类设置 */
  AGENT_AUTO_APPROVE: 'agent:auto-approve',

  /** 项目笔记/记忆 */
  NOTES_LIST: 'notes:list',
  NOTES_TASK_MEMORIES_LIST: 'notes:task-memories:list',
  NOTES_TASK_MEMORY_DELETE: 'notes:task-memory:delete',
  NOTES_SAVE: 'notes:save',
  NOTES_DELETE: 'notes:delete',
  NOTES_STATS: 'notes:stats',
  NOTES_EXPORT: 'notes:export',

  /** MCP 管理 */
  MCP_LIST: 'mcp:list',
  MCP_SAVE: 'mcp:save',
  MCP_REMOVE: 'mcp:remove',
  MCP_TOGGLE: 'mcp:toggle',

  /** main → renderer, 在内嵌浏览器中打开 URL */
  OPEN_URL: 'app:open-url',

  /** 浏览器自动化（已废弃：统一使用外部 BrowserWindow + CDP） */
  BROWSER_ACTION: 'browser:action',
  /** renderer → main, 设置浏览器全局接管模式 */
  BROWSER_AUTO_TAKEOVER: 'browser:auto-takeover',
  /** renderer → main, 设置浏览器调试模式（是否打开 DevTools） */
  BROWSER_DEBUG_MODE: 'browser:debug-mode',
  /** renderer → main, 设置浏览器隐藏窗口模式（打开时是否隐藏窗口） */
  BROWSER_HIDDEN_MODE: 'browser:hidden-mode',

  /** 外部浏览器窗口 (BrowserWindow 模式) */
  EXTERNAL_BROWSER_OPEN: 'browser:ext-open',
  EXTERNAL_BROWSER_CLOSE: 'browser:ext-close',
  EXTERNAL_BROWSER_NAVIGATE: 'browser:ext-navigate',
  EXTERNAL_BROWSER_FOCUS: 'browser:ext-focus',
  /** main → renderer, 外部浏览器窗口状态变更 */
  EXTERNAL_BROWSER_STATUS: 'browser:ext-status',
  /** renderer → main, 同步浏览器模式设置 */
  BROWSER_MODE: 'browser:mode',

  /** renderer → main, 打开日志目录 */
  OPEN_LOG_DIR: 'app:open-log-dir',
  /** renderer → main, 获取应用版本号（来自 app.getVersion()） */
  APP_GET_VERSION: 'app:get-version',
  /** renderer → main, 保存上传配置到文件 */
  APP_SAVE_UPLOAD_CONFIG: 'app:save-upload-config',
  /** renderer → main, 检查版本更新（内部会先登录获取 token） */
  APP_CHECK_UPDATE: 'app:check-update',
  /** renderer → main, 获取最近一次版本检查结果（启动自动检查/手动检查） */
  APP_GET_UPDATE_STATUS: 'app:get-update-status',
  /** renderer → main, 触发系统通知 */
  APP_NOTIFY: 'app:notify',
  /** renderer → main, 上报渲染层异常诊断 */
  APP_RENDERER_ERROR: 'app:renderer-error',
  /** renderer → main, 用户登录（通过主进程代理，避免 CORS） */
  MEMBER_LOGIN: 'member:login',
  MEMBER_REGISTER: 'member:register',

  /** renderer → main, 持久化登录 Token 到文件（~/.taco/auth.json） */
  AUTH_TOKEN_SAVE: 'auth:token-save',
  /** renderer → main, 从文件加载持久化的 Token */
  AUTH_TOKEN_LOAD: 'auth:token-load',
  /** renderer → main, 删除持久化的 Token 文件 */
  AUTH_TOKEN_REMOVE: 'auth:token-remove',

  /** renderer → main, 会员登录桥接（使用 token 连接 Relay） */
  BRIDGE_CONNECT: 'bridge:connect',
  /** renderer → main, 断开桥接连接 */
  BRIDGE_DISCONNECT: 'bridge:disconnect',
  /** renderer → main, 获取当前桥接状态 */
  BRIDGE_GET_STATUS: 'bridge:get-status',
  /** main → renderer, 桥接状态变更推送 */
  BRIDGE_STATUS_CHANGED: 'bridge:status-changed',
  /** main → renderer, 配对码更新 */
  BRIDGE_PAIRING_CODE: 'bridge:pairing-code',
  /** renderer → main, 手动刷新配对码 */
  BRIDGE_REFRESH_PAIRING: 'bridge:refresh-pairing',
  /** renderer → main, 刷新 Token（用于 Token 过期时自动续期） */
  BRIDGE_REFRESH_TOKEN: 'bridge:refresh-token',
  /** main → renderer, 移动端发来的消息（chat-send / agent-confirm / agent-abort） */
  BRIDGE_CLIENT_MESSAGE: 'bridge:client-message',
  /** renderer → main, 获取配对码策略模式 */
  BRIDGE_GET_PAIRING_MODE: 'bridge:get-pairing-mode',
  /** renderer → main, 设置配对码策略模式 */
  BRIDGE_SET_PAIRING_MODE: 'bridge:set-pairing-mode',


  /** 渲染层核心状态（文件持久化） */
  APP_STATE_GET: 'app-state:get',
  APP_STATE_SAVE_THREADS: 'app-state:save-threads',
  APP_STATE_SAVE_PROVIDERS: 'app-state:save-providers',
  /** Prompt 配置（可选文件覆盖） */
  PROMPT_CONFIG_GET: 'prompt-config:get',
  PROMPT_CONFIG_SAVE: 'prompt-config:save',

  /** renderer → main, 获取 AI 网关模型列表 */
  GATEWAY_GET_MODELS: 'gateway:get-models',

  /** 窗口拖拽 — 手动实现以获取自定义光标控制 */
  WINDOW_DRAG_START: 'window:drag-start',
  WINDOW_DRAGGING: 'window:dragging',
  WINDOW_DRAG_END: 'window:drag-end',
  /** renderer → main, 双击顶栏切换最大化 */
  WINDOW_TOGGLE_MAXIMIZE: 'window:toggle-maximize',
  /** renderer → main, 最小化主窗口 */
  WINDOW_MINIMIZE: 'window:minimize',
  /** renderer → main, 关闭主窗口 */
  WINDOW_CLOSE: 'window:close',
} as const
