# MasterAgent 主代理架构设计方案

## 1. 架构概述

### 1.1 分层代理架构

```
┌─────────────────────────────────────────────────────────────┐
│                        用户输入                              │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                    MasterAgent (主代理)                      │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ • 意图理解与任务分类                                  │   │
│  │ • 自主处理简单任务（直接调用 AI）                      │   │
│  │ • 复杂任务拆解为子任务                                │   │
│  │ • 调度 Worker Agent 执行子任务                       │   │
│  │ • 结果汇总与最终回复                                  │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────┬───────────────────────────────────────┬───────────┘
          │                                       │
          │ 直接处理                               │ 调度执行
          ▼                                       ▼
┌─────────────────────┐               ┌─────────────────────────┐
│      AI (LLM)       │               │    Worker Agent         │
│   (MasterAgent      │               │  ┌───────────────────┐  │
│    自身具备)        │               │  │ • 执行具体子任务   │  │
│                    │               │  │ • 工具权限控制     │  │
└─────────────────────┘               │  │ • 返回执行结果    │  │
                                       └───────────────────┘  │
                                       └───────────┬─────────────┘
                                                   │
                                                   ▼
                                    ┌─────────────────────────┐
                                    │      AI (LLM)           │
                                    │  (Worker Agent 调用)    │
                                    └─────────────────────────┘
```

### 1.2 核心原则

- **MasterAgent 本身就是一个完整的代理**：有自己的 AI 能力，能独立处理任务
- **有需要时才调用 Worker Agent**：通过意图分析判断是否需要子代理
- **MasterAgent 负责调度**：决定何时拆分任务，调度哪个 Worker Agent

### 1.3 分工职责

| 角色 | 职责 | 特点 |
|------|------|------|
| **MasterAgent** | 与用户沟通、意图理解、任务分发、结果汇总 | 主对话通道，实时响应 |
| **Worker Agent** | 异步执行具体子任务、工具调用 | 后台执行，返回结果 |

#### MasterAgent 职责
- 作为与用户对话的唯一入口
- 理解用户输入，解析意图
- 判断任务类型，决定自行处理或拆分
- 实时与用户保持沟通，反馈进度
- 汇总子任务结果，生成最终回复

#### Worker Agent 职责
- 接收 MasterAgent 分发的子任务
- 在后台异步执行任务
- 调用工具完成具体操作
- 将执行结果返回给 MasterAgent
- 不直接与用户通信

---

### 1.4 长期记忆能力

MasterAgent 具备长期记忆能力，能够跨会话持久化存储和检索关键信息。

#### 1.4.1 记忆层次结构

```
┌─────────────────────────────────────────────────────────────┐
│                     MasterAgent 记忆                         │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 短期记忆（Session Memory）                           │   │
│  │  - 当前会话上下文                                     │   │
│  │  - 用户当前意图                                       │   │
│  │  - 进行中的任务状态                                    │   │
│  │  - 最近 N 轮对话内容                                   │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 长期记忆（Persistent Memory）                         │   │
│  │  - 用户偏好设置                                       │   │
│  │  - 项目知识（架构、约定、配置）                         │   │
│  │  - 历史任务执行记录                                    │   │
│  │  - 重要决策与结论                                     │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

#### 1.4.2 记忆存储设计

```typescript
// memory-storage.ts

/**
 * 记忆类型
 */
export enum MemoryType {
  // 用户相关
  USER_PREFERENCE = 'user_preference',      // 用户偏好
  USER_CONTEXT = 'user_context',            // 用户上下文
  
  // 项目相关
  PROJECT_KNOWLEDGE = 'project_knowledge',  // 项目知识
  PROJECT_ARCHITECTURE = 'project_architecture',  // 项目架构
  PROJECT_CONVENTIONS = 'project_conventions',     // 项目约定
  
  // 任务相关
  TASK_HISTORY = 'task_history',            // 任务执行历史
  TASK_RESULT = 'task_result',              // 任务结果
  DECISION_LOG = 'decision_log',            // 决策记录
  
  // 事实相关
  FACT = 'fact',                             // 事实性信息
  INSIGHT = 'insight',                       // 洞察与总结
}

/**
 * 记忆条目
 */
export interface MemoryEntry {
  id: string
  type: MemoryType
  content: string
  metadata: {
    source: 'user' | 'agent' | 'system' | 'task'
    importance: number        // 0-10，重要性评分
    tags: string[]           // 标签，用于检索
    createdAt: number        // 创建时间戳
    updatedAt: number        // 更新时间戳
    expiresAt?: number       // 过期时间戳（可选）
    sessionId?: string       // 关联会话 ID
    taskId?: string          // 关联任务 ID
  }
  // 关联引用
  relatedMemories?: string[]  // 关联记忆 ID
  evidence?: MemoryEvidence[] // 证据片段
}

/**
 * 记忆证据
 */
export interface MemoryEvidence {
  type: 'file' | 'conversation' | 'task' | 'code'
  path?: string
  content: string
  lineRange?: { start: number; end: number }
}

/**
 * 记忆存储配置（SQLite 方式）
 */
export interface MemoryStorageConfig {
  // SQLite 数据库文件路径（跨平台兼容）
  dbPath: {
    macOS: string      // ~/Library/Application Support/TacoAI/memory/master_agent.db
    Windows: string    // %APPDATA%/TacoAI/memory/master_agent.db
    Linux: string      // ~/.config/TacoAI/memory/master_agent.db
  }

  // 数据库表结构
  tables: {
    // 记忆条目表
    memories: `
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,           -- MEMORY_TYPE 枚举值
        content TEXT NOT NULL,        -- 记忆内容（JSON 字符串）
        importance REAL NOT NULL,     -- 重要性评分 0-10
        created_at INTEGER NOT NULL,  -- 创建时间戳
        updated_at INTEGER NOT NULL,  -- 更新时间戳
        expires_at INTEGER,            -- 过期时间戳（可选）
        tags TEXT,                     -- 标签（JSON 数组）
        source TEXT,                   -- 来源：user/agent/system/task
        session_id TEXT,               -- 关联的会话 ID
        embedding_id TEXT               -- 向量 embedding ID（可选）
      );
      CREATE INDEX idx_memories_type ON memories(type);
      CREATE INDEX idx_memories_importance ON memories(importance);
      CREATE INDEX idx_memories_created_at ON memories(created_at);
      CREATE INDEX idx_memories_session_id ON memories(session_id);
    `
  }
  
  // 容量限制
  maxEntries: number           // 最大记忆条目数
  maxMemorySize: number         // 最大存储大小（字节）
  
  // 自动清理策略
  autoCleanup: {
    enabled: boolean
    expiredAfter: number       // 过期时间（毫秒）
    importanceThreshold: number // 重要性阈值，低于此值自动清理
    maxEntriesPerType: Record<MemoryType, number>
  }
  
  // 检索配置
  retrieval: {
    maxResults: number          // 最多返回结果数
    similarityThreshold: number // 相似度阈值
    includeExpired: boolean     // 是否包含过期记忆
  }
}
```

#### 1.4.3 记忆检索机制

```typescript
// memory-retrieval.ts

/**
 * 记忆检索查询
 */
export interface MemoryQuery {
  // 基础筛选
  type?: MemoryType | MemoryType[]   // 记忆类型
  tags?: string[]                     // 标签筛选
  source?: 'user' | 'agent' | 'system' | 'task'
  
  // 时间范围
  createdAfter?: number
  createdBefore?: number
  
  // 内容检索
  keyword?: string           // 关键词
  semanticQuery?: string     // 语义查询（用于向量检索）
  
  // 重要性筛选
  minImportance?: number
  
  // 关联筛选
  relatedTo?: string         // 关联记忆 ID
  
  // 分页
  limit?: number
  offset?: number
}

/**
 * 记忆检索结果
 */
export interface MemoryRetrievalResult {
  entries: MemoryEntry[]
  total: number
  relevanceScores: number[]   // 每个结果的相关度分数
  searchMetadata: {
    queryTime: number
    cacheHit: boolean
    indicesUsed: string[]
  }
}

/**
 * 记忆检索服务
 */
export class MemoryRetrievalService {
  /**
   * 语义检索 - 基于向量相似度
   */
  async semanticSearch(query: string, options?: {
    types?: MemoryType[]
    limit?: number
    threshold?: number
  }): Promise<MemoryRetrievalResult>
  
  /**
   * 关键词检索
   */
  async keywordSearch(keyword: string, options?: {
    types?: MemoryType[]
    tags?: string[]
    limit?: number
  }): Promise<MemoryRetrievalResult>
  
  /**
   * 组合检索 - 语义 + 关键词混合
   */
  async hybridSearch(query: string, options?: {
    types?: MemoryType[]
    tags?: string[]
    limit?: number
    semanticWeight?: number  // 语义权重 (0-1)
    keywordWeight?: number   // 关键词权重 (0-1)
  }): Promise<MemoryRetrievalResult>
  
  /**
   * 上下文感知检索 - 根据当前会话上下文检索相关记忆
   */
  async contextualRetrieval(context: {
    sessionId: string
    userId?: string
    projectPath?: string
    recentTopics?: string[]
  }): Promise<MemoryRetrievalResult>
  
  /**
   * 时间线检索 - 按时间顺序检索记忆
   */
  async timelineRetrieval(options?: {
    after?: number
    before?: number
    types?: MemoryType[]
    limit?: number
  }): Promise<MemoryRetrievalResult>
}
```

#### 1.4.4 记忆更新策略

```typescript
// memory-manager.ts

/**
 * 记忆更新策略
 */
export class MasterAgentMemoryManager {
  /**
   * 自动记忆 - 智能决定是否需要记忆
   */
  async autoRemember(event: {
    type: 'conversation' | 'task' | 'decision' | 'user_feedback'
    content: string
    importance?: number
    tags?: string[]
  }): Promise<MemoryEntry | null>
  
  /**
   * 增量更新 - 更新已有记忆
   */
  async updateMemory(memoryId: string, updates: {
    content?: string
    tags?: string[]
    importance?: number
    relatedMemories?: string[]
  }): Promise<MemoryEntry>
  
  /**
   * 记忆合并 - 合并相似记忆
   */
  async mergeMemories(sourceIds: string[], targetId: string): Promise<MemoryEntry>
  
  /**
   * 记忆衰减 - 根据时间和重要性自动降低权重
   */
  async decayMemories(): Promise<{
    decayed: number
    expired: number
    consolidated: number
  }>
  
  /**
   * 记忆固化 - 将重要短期记忆转为长期记忆
   */
  async consolidateToLongTerm(sessionId: string): Promise<number>
  
  /**
   * 记忆遗忘 - 选择性删除低价值记忆
   */
  async forget(options?: {
    belowImportance?: number
    olderThan?: number
    types?: MemoryType[]
    dryRun?: boolean
  }): Promise<{ deleted: number; freedSpace: number }>
}

/**
 * 记忆优先级策略
 */
export const MEMORY_PRIORITY_STRATEGY = {
  // 高优先级 - 始终保留
  HIGH: [
    MemoryType.USER_PREFERENCE,
    MemoryType.PROJECT_ARCHITECTURE,
    MemoryType.DECISION_LOG,
  ],
  
  // 中优先级 - 定期清理
  MEDIUM: [
    MemoryType.PROJECT_KNOWLEDGE,
    MemoryType.PROJECT_CONVENTIONS,
    MemoryType.TASK_RESULT,
  ],
  
  // 低优先级 - 空间不足时优先清理
  LOW: [
    MemoryType.TASK_HISTORY,
    MemoryType.INSIGHT,
  ],
}
```

#### 1.4.5 上下文构建

MasterAgent 在每次与 AI 交互时，从记忆系统中构建上下文：

```typescript
// context-builder.ts

/**
 * 上下文构建选项
 */
export interface ContextBuildOptions {
  // 会话信息
  sessionId: string
  userId?: string
  projectPath?: string
  
  // 上下文范围
  includeShortTerm: boolean   // 包含短期记忆
  includeLongTerm: boolean   // 包含长期记忆
  maxShortTermItems: number  // 最多短期记忆条数
  maxLongTermItems: number   // 最多长期记忆条数
  
  // 内容过滤
  relevantTypes?: MemoryType[]  // 只包含这些类型
  excludeTypes?: MemoryType[]   // 排除这些类型
  
  // 检索优化
  useSemanticSearch?: boolean
  searchQuery?: string          // 用于语义检索的查询
}

/**
 * 构建 MasterAgent 上下文
 */
export async function buildMasterAgentContext(
  options: ContextBuildOptions
): Promise<{
  // 短期记忆
  shortTermMemories: MemoryEntry[]
  
  // 长期记忆
  longTermMemories: MemoryEntry[]
  
  // 用户画像
  userProfile?: {
    preferences: Record<string, any>
    interactionStyle: string
    expertiseLevel: 'beginner' | 'intermediate' | 'expert'
  }
  
  // 项目画像
  projectProfile?: {
    name: string
    type: string
    conventions: string[]
    architecture: string
  }
  
  // 格式化后的上下文文本
  contextText: string
}> {
  // 实现逻辑：
  // 1. 检索短期记忆（当前会话相关）
  // 2. 检索长期记忆（项目知识、用户偏好等）
  // 3. 构建用户画像
  // 4. 构建项目画像
  // 5. 格式化为 prompt 上下文
}
```

---

## 2. MasterAgent Prompt 模板设计

### 2.1 MasterAgent System Prompt

```typescript
const MASTER_AGENT_SYSTEM_PROMPT = `你是 MasterAgent（主代理），负责协调和管理任务执行。

## 角色定位
你是一个智能任务协调者，能够：
1. 理解用户输入的意图
2. 判断任务复杂度，决定自行处理还是拆分给子代理
3. 调度 Worker Agent 执行特定子任务
4. 汇总各子任务结果，生成最终回复

## 任务分类规则

### 类型 1：简单问答（SIMPLE_QUERY）
- 定义：用户意图明确，无需执行工具，仅需 AI 知识库回答
- 示例："什么是 TypeScript"、"解释一下闭包"
- 处理方式：**直接回复，无需调用 Worker Agent**

### 类型 2：单动作任务（SINGLE_ACTION）
- 定义：需要执行工具，但仅涉及单一工具调用
- 示例："帮我读取这个文件"、"创建一个新文件"
- 处理方式：**MasterAgent 直接处理，调用 AI 执行工具**

### 类型 3：多动作任务（MULTI_ACTION）
- 定义：需要执行多个工具，但这些工具可以串行/并行执行
- 示例："读取这个文件，然后修改里面的代码"
- 处理方式：**MasterAgent 直接处理，循环调用 AI 执行工具**

### 类型 4：复杂任务（COMPLEX_TASK）
- 定义：需要多个独立子任务，或需要不同权限的工具
- 示例：
  - "帮我创建一个登录页面，并写一个测试用例"
  - "重构这个项目，同时更新文档"
- 处理方式：**拆分为子任务，调度 Worker Agent 并行执行**

## 决策流程

当收到用户输入时，按以下流程决策：

1. **意图理解**：分析用户想要什么
2. **复杂度评估**：判断任务属于哪种类型
3. **处理执行**：
   - SIMPLE_QUERY → 直接回复
   - SINGLE_ACTION → MasterAgent 直接处理
   - MULTI_ACTION → MasterAgent 直接处理
   - COMPLEX_TASK → 拆分子任务，调度 Worker Agent

## 输出格式要求

当你需要调度 Worker Agent 时，必须明确输出：

\`\`\`
[MASTER_AGENT_DECISION]
类型: COMPLEX_TASK
子任务列表:
1. [子任务1描述] - Worker Agent 权限: [工具列表]
2. [子任务2描述] - Worker Agent 权限: [工具列表]
[/MASTER_AGENT_DECISION]
\`\`\`

## 重要约束

1. **不要过度拆分**：只有真正复杂的任务才需要 Worker Agent
2. **工具权限最小化**：为每个 Worker Agent 只开放必要的工具权限
3. **结果汇总**：必须汇总各 Worker Agent 的结果再回复用户
4. **错误处理**：某个 Worker Agent 失败时，决定是重试还是跳过

## 工具限制

MasterAgent 默认工具权限：
- `read_file` - 读取文件
- `list_dir` - 列出目录
- `find_file` - 查找文件
- `save_note` - 保存笔记

MasterAgent **不直接执行**以下高风险工具，仅在调度 Worker Agent 时传递：
- `write_file` - 写入文件
- `edit_file` - 编辑文件
- `delete_file` - 删除文件
- `run_command` - 执行命令

### 2.3 MasterAgent 工具权限控制详细设计

与 Worker Agent 类似，MasterAgent 也需要精细的权限控制机制，确保主代理在安全范围内执行任务。

```typescript
// master-agent-permissions.ts

/**
 * MasterAgent 权限级别
 */
export enum MasterAgentPermissionLevel {
  // 基础权限 - 读取类操作
  READ_ONLY = 'read_only',
  
  // 标准权限 - 包含写入但不执行命令
  STANDARD = 'standard',
  
  // 扩展权限 - 包含命令执行
  EXTENDED = 'extended',
  
  // 完整权限 - 所有工具可用
  FULL = 'full',
}

/**
 * MasterAgent 工具权限配置
 */
export interface MasterAgentToolPermission {
  toolName: string
  allowed: boolean
  requiresConfirmation: boolean  // 是否需要用户确认
  maxFileSize?: number          // 文件操作大小限制
  allowedPaths?: string[]      // 允许操作的路径模式
  forbiddenPaths?: string[]    // 禁止操作的路径模式
}

/**
 * MasterAgent 权限配置
 */
export interface MasterAgentPermissions {
  level: MasterAgentPermissionLevel
  allowedTools: string[]
  confirmationRequired: string[]  // 需要确认的工具
  toolLimits: {
    maxFileSize: number
    maxCommandDuration: number
    allowedCommands?: string[]
    forbiddenPaths: string[]
    allowedPaths?: string[]
  }
  // 运行时行为配置
  behavior: {
    autoApproveSafeOperations: boolean   // 自动批准安全操作
    promptBeforeHighRisk: boolean       // 高风险操作前提示
    allowParallelExecution: boolean     // 允许并行执行子任务
    maxConcurrentWorkers: number        // 最大并发 Worker Agent 数量
  }
}

/**
 * MasterAgent 预定义权限级别
 */
export const MASTER_AGENT_PERMISSION_LEVELS: Record<MasterAgentPermissionLevel, MasterAgentPermissions> = {
  [MasterAgentPermissionLevel.READ_ONLY]: {
    level: MasterAgentPermissionLevel.READ_ONLY,
    allowedTools: ['read_file', 'list_dir', 'find_file', 'save_note', 'delete_note'],
    confirmationRequired: [],
    toolLimits: {
      maxFileSize: 10 * 1024 * 1024,  // 10MB
      maxCommandDuration: 0,         // 不允许命令
      forbiddenPaths: ['/etc', '/usr', '/bin', '/sbin', '~/.ssh', '~/.aws'],
    },
    behavior: {
      autoApproveSafeOperations: true,
      promptBeforeHighRisk: false,
      allowParallelExecution: false,
      maxConcurrentWorkers: 0,
    },
  },
  
  [MasterAgentPermissionLevel.STANDARD]: {
    level: MasterAgentPermissionLevel.STANDARD,
    allowedTools: ['read_file', 'write_file', 'edit_file', 'list_dir', 'find_file', 'save_note', 'delete_note'],
    confirmationRequired: ['write_file', 'edit_file'],
    toolLimits: {
      maxFileSize: 50 * 1024 * 1024,  // 50MB
      maxCommandDuration: 0,           // 不允许命令
      forbiddenPaths: ['/etc', '/usr', '/bin', '/sbin', '~/.ssh', '~/.aws'],
      allowedPaths: [],                // 默认允许工作空间
    },
    behavior: {
      autoApproveSafeOperations: true,
      promptBeforeHighRisk: true,
      allowParallelExecution: true,
      maxConcurrentWorkers: 3,
    },
  },
  
  [MasterAgentPermissionLevel.EXTENDED]: {
    level: MasterAgentPermissionLevel.EXTENDED,
    allowedTools: ['read_file', 'write_file', 'edit_file', 'list_dir', 'find_file', 'save_note', 'delete_note', 'run_command'],
    confirmationRequired: ['run_command', 'delete_file'],
    toolLimits: {
      maxFileSize: 100 * 1024 * 1024,  // 100MB
      maxCommandDuration: 300000,       // 5分钟
      allowedCommands: ['npm', 'yarn', 'pnpm', 'git', 'cargo', 'go', 'python'],
      forbiddenPaths: ['/etc', '/usr', '/bin', '/sbin'],
    },
    behavior: {
      autoApproveSafeOperations: true,
      promptBeforeHighRisk: true,
      allowParallelExecution: true,
      maxConcurrentWorkers: 5,
    },
  },
  
  [MasterAgentPermissionLevel.FULL]: {
    level: MasterAgentPermissionLevel.FULL,
    allowedTools: ['*'],  // 所有工具
    confirmationRequired: ['delete_file', 'run_command'],
    toolLimits: {
      maxFileSize: 500 * 1024 * 1024,  // 500MB
      maxCommandDuration: 600000,       // 10分钟
      forbiddenPaths: [],
    },
    behavior: {
      autoApproveSafeOperations: true,
      promptBeforeHighRisk: true,
      allowParallelExecution: true,
      maxConcurrentWorkers: 10,
    },
  },
}

/**
 * 创建 MasterAgent 权限配置
 */
export function createMasterAgentPermissions(
  level: MasterAgentPermissionLevel,
  customOverrides?: Partial<MasterAgentPermissions>
): MasterAgentPermissions {
  const base = MASTER_AGENT_PERMISSION_LEVELS[level]
  
  return {
    ...base,
    ...customOverrides,
    toolLimits: {
      ...base.toolLimits,
      ...customOverrides?.toolLimits,
    },
    behavior: {
      ...base.behavior,
      ...customOverrides?.behavior,
    },
  }
}

/**
 * MasterAgent 权限验证器
 */
export class MasterAgentPermissionValidator {
  private permissions: MasterAgentPermissions
  
  constructor(permissions: MasterAgentPermissions) {
    this.permissions = permissions
  }
  
  /**
   * 检查工具是否可执行
   */
  canExecuteTool(toolName: string): boolean {
    // 通配符表示全部允许
    if (this.permissions.allowedTools.includes('*')) {
      return true
    }
    
    return this.permissions.allowedTools.includes(toolName)
  }
  
  /**
   * 检查是否需要用户确认
   */
  requiresConfirmation(toolName: string): boolean {
    return this.permissions.confirmationRequired.includes(toolName)
  }
  
  /**
   * 验证路径权限
   */
  validatePath(toolName: string, path: string): { valid: boolean; reason?: string } {
    const limits = this.permissions.toolLimits
    
    // 检查禁止路径
    for (const forbidden of limits.forbiddenPaths) {
      if (path.includes(forbidden)) {
        return { valid: false, reason: `路径 ${path} 包含禁止访问的目录 ${forbidden}` }
      }
    }
    
    // 检查允许路径（如果有配置）
    if (limits.allowedPaths && limits.allowedPaths.length > 0) {
      const isAllowed = limits.allowedPaths.some(allowed => 
        path.startsWith(allowed) || path.includes(allowed)
      )
      if (!isAllowed) {
        return { valid: false, reason: `路径 ${path} 不在允许列表中` }
      }
    }
    
    return { valid: true }
  }
  
  /**
   * 验证文件大小
   */
  validateFileSize(toolName: string, fileSize: number): { valid: boolean; reason?: string } {
    if (fileSize > this.permissions.toolLimits.maxFileSize) {
      return { 
        valid: false, 
        reason: `文件大小 ${fileSize} 超过限制 ${this.permissions.toolLimits.maxFileSize}` 
      }
    }
    return { valid: true }
  }
  
  /**
   * 验证命令
   */
  validateCommand(command: string): { valid: boolean; reason?: string } {
    const limits = this.permissions.toolLimits
    
    // 如果不允许命令，直接拒绝
    if (limits.maxCommandDuration === 0) {
      return { valid: false, reason: 'MasterAgent 没有执行命令的权限' }
    }
    
    // 检查允许的命令列表
    if (limits.allowedCommands && limits.allowedCommands.length > 0) {
      const isAllowed = limits.allowedCommands.some(cmd => 
        command.startsWith(cmd) || command.includes(cmd)
      )
      if (!isAllowed) {
        return { valid: false, reason: `命令 ${command} 不在允许列表中` }
      }
    }
    
    return { valid: true }
  }
}

/**
 * MasterAgent 工具权限决策
 */
export async function checkMasterAgentToolPermission(
  toolName: string,
  params: Record<string, any>,
  permissions: MasterAgentPermissions
): Promise<{ allowed: boolean; requiresConfirmation: boolean; reason?: string }> {
  const validator = new MasterAgentPermissionValidator(permissions)
  
  // 1. 检查工具是否允许
  if (!validator.canExecuteTool(toolName)) {
    return { 
      allowed: false, 
      requiresConfirmation: false,
      reason: `工具 ${toolName} 不在允许列表中` 
    }
  }
  
  // 2. 检查是否需要确认
  const needsConfirmation = validator.requiresConfirmation(toolName)
  
  // 3. 根据工具类型验证参数
  if (toolName === 'read_file' || toolName === 'write_file' || toolName === 'edit_file') {
    if (params.path) {
      const pathValidation = validator.validatePath(toolName, params.path)
      if (!pathValidation.valid) {
        return { allowed: false, requiresConfirmation: false, reason: pathValidation.reason }
      }
    }
  }
  
  if (toolName === 'run_command') {
    if (params.command) {
      const cmdValidation = validator.validateCommand(params.command)
      if (!cmdValidation.valid) {
        return { allowed: false, requiresConfirmation: false, reason: cmdValidation.reason }
      }
    }
  }
  
  return { 
    allowed: true, 
    requiresConfirmation: needsConfirmation 
  }
}
```

#### 权限级别选择策略

```typescript
/**
 * 根据任务类型自动选择权限级别
 */
export function inferMasterAgentPermissionLevel(
  taskType: TaskType,
  requiredTools: string[]
): MasterAgentPermissionLevel {
  // 简单问答不需要额外权限
  if (taskType === TaskType.SIMPLE_QUERY) {
    return MasterAgentPermissionLevel.READ_ONLY
  }
  
  // 单动作任务 - 根据工具类型判断
  if (taskType === TaskType.SINGLE_ACTION) {
    const needsWrite = requiredTools.some(t => ['write_file', 'edit_file'].includes(t))
    const needsCommand = requiredTools.includes('run_command')
    
    if (needsCommand) {
      return MasterAgentPermissionLevel.EXTENDED
    }
    if (needsWrite) {
      return MasterAgentPermissionLevel.STANDARD
    }
    return MasterAgentPermissionLevel.READ_ONLY
  }
  
  // 复杂任务需要更高权限
  return MasterAgentPermissionLevel.STANDARD
}
```

#### 与 Worker Agent 权限的关系

MasterAgent 和 Worker Agent 的权限控制是**独立**的，但有关联：

| 维度 | MasterAgent | Worker Agent |
|------|-------------|--------------|
| **定位** | 任务调度与决策 | 具体任务执行 |
| **权限来源** | 系统配置 / 用户授权 | MasterAgent 分配 |
| **权限范围** | 可调度所有工具 | 仅 MasterAgent 分配的部分 |
| **高风险操作** | 默认禁止，仅调度时传递 | 按需授权，可配置 |

**关键区别**：
- MasterAgent 可以直接执行基础工具（read_file 等）
- 高风险工具（write_file、run_command）MasterAgent 不直接执行，而是通过调度 Worker Agent 来执行
- Worker Agent 的权限由 MasterAgent 在调度时动态分配

---

# 运行时工具

以下是当前会话可用的工具：

[RUNTIME_TOOL_PROMPT]
// 工具定义由系统自动注入
[/RUNTIME_TOOL_PROMPT]

[SKILLS_CATALOG]
// 技能目录由系统自动注入
[/SKILLS_CATALOG]
`
```

### 2.2 任务拆分决策 Prompt

使用标准工具调用格式输出任务分析结果，而非 JSON 字符串。

```typescript
// 任务分析工具定义
const TASK_ANALYZE_TOOL = {
  name: 'analyze_task',
  description: '分析用户任务，判断任务类型并拆分子任务',
  parameters: {
    type: 'object',
    properties: {
      taskType: {
        type: 'string',
        enum: ['SIMPLE_QUERY', 'SINGLE_ACTION', 'MULTI_ACTION', 'COMPLEX_TASK'],
        description: '任务类型：简单问答/单动作/多动作/复杂任务',
      },
      reason: {
        type: 'string',
        description: '决策理由，说明为什么判断为该类型',
      },
      subtasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number', description: '子任务 ID' },
            description: { type: 'string', description: '子任务描述' },
            requiredTools: { type: 'array', items: { type: 'string' }, description: '所需工具列表' },
            estimatedComplexity: { type: 'string', enum: ['low', 'medium', 'high'], description: '预估复杂度' },
          },
        },
        description: '子任务列表（COMPLEX_TASK 时才有）',
      },
      canParallelize: {
        type: 'boolean',
        description: '子任务是否可以并行执行',
      },
      recommendedStrategy: {
        type: 'string',
        enum: ['sequential', 'parallel', 'hybrid'],
        description: '推荐执行策略：串行/并行/混合',
      },
    },
    required: ['taskType', 'reason'],
  },
}

const TASK_SPLIT_PROMPT = `## 任务拆分分析

请分析以下用户任务，判断是否需要拆分为子任务。

### 用户任务
{userTask}

### 当前上下文
{context}

### 判断标准
- SIMPLE_QUERY：无需工具，仅需知识库回答
- SINGLE_ACTION：1个工具调用即可完成
- MULTI_ACTION：多个工具调用，但可以串行完成
- COMPLEX_TASK：需要多个独立子任务，或需要不同权限

### 输出要求
请使用 analyze_task 工具输出分析结果。`
```

---

## 3. 任务拆解具体逻辑

### 3.1 任务拆解流程

```typescript
// master-agent.ts

export enum TaskType {
  SIMPLE_QUERY = 'SIMPLE_QUERY',       // 简单问答
  SINGLE_ACTION = 'SINGLE_ACTION',     // 单动作任务
  MULTI_ACTION = 'MULTI_ACTION',       // 多动作任务
  COMPLEX_TASK = 'COMPLEX_TASK',       // 复杂任务
}

export interface SubTask {
  id: number
  description: string
  requiredTools: string[]
  estimatedComplexity: 'low' | 'medium' | 'high'
  status: 'pending' | 'running' | 'completed' | 'failed'
  result?: any
  error?: string
}

export interface TaskAnalysisResult {
  taskType: TaskType
  reason: string
  subtasks: SubTask[]
  canParallelize: boolean
  recommendedStrategy: 'sequential' | 'parallel' | 'hybrid'
}

/**
 * 任务分析主函数
 */
async function analyzeTask(
  userInput: string,
  context: {
    recentMessages: ChatMessage[]
    activeSkills: string[]
    workspace?: string
  }
): Promise<TaskAnalysisResult> {
  // 1. 构建分析 prompt
  const analysisPrompt = buildTaskAnalysisPrompt(userInput, context)
  
  // 2. 调用 AI 进行意图分析
  const analysis = await requestChatCompletion(
    getMasterAgentProvider(),
    analysisPrompt,
    {/* overrides */}
  )
  
  // 3. 解析 AI 响应为结构化结果
  const result = parseTaskAnalysis(analysis)
  
  // 4. 返回分析结果
  return result
}

/**
 * 构建任务分析 Prompt
 */
function buildTaskAnalysisPrompt(
  userInput: string,
  context: {
    recentMessages: ChatMessage[]
    activeSkills: string[]
    workspace?: string
  }
): ChatMessage[] {
  return [
    {
      role: 'system',
      content: MASTER_AGENT_SYSTEM_PROMPT,
    },
    {
      role: 'user',
      content: TASK_SPLIT_PROMPT
        .replace('{userTask}', userInput)
        .replace('{context}', JSON.stringify(context, null, 2)),
    },
  ]
}

/**
 * 解析 AI 响应
 */
function parseTaskAnalysis(aiResponse: string): TaskAnalysisResult {
  // 从 AI 响应中提取 JSON
  const jsonMatch = aiResponse.match(/```json\n([\s\S]*?)\n```/)
  if (!jsonMatch) {
    // 解析失败，默认视为 SINGLE_ACTION
    return {
      taskType: TaskType.SINGLE_ACTION,
      reason: '无法解析 AI 响应，默认视为单动作任务',
      subtasks: [],
      canParallelize: false,
      recommendedStrategy: 'sequential',
    }
  }
  
  return JSON.parse(jsonMatch[1])
}
```

### 3.2 任务执行策略

```typescript
/**
 * MasterAgent 任务执行入口
 */
export async function runMasterAgent(
  input: string,
  context: MasterAgentContext
): Promise<MasterAgentResult> {
  
  // Step 1: 任务分析
  const analysis = await analyzeTask(input, context)
  
  // Step 2: 根据任务类型执行
  switch (analysis.taskType) {
    case TaskType.SIMPLE_QUERY:
      return await handleSimpleQuery(input, context)
    
    case TaskType.SINGLE_ACTION:
    case TaskType.MULTI_ACTION:
      return await handleDirectAction(input, context)
    
    case TaskType.COMPLEX_TASK:
      return await handleComplexTask(input, analysis, context)
    
    default:
      return await handleDirectAction(input, context)
  }
}

/**
 * 处理简单问答
 */
async function handleSimpleQuery(
  input: string,
  context: MasterAgentContext
): Promise<MasterAgentResult> {
  const response = await requestChatCompletion(
    getMasterAgentProvider(),
    [
      { role: 'system', content: '你是一个智能助手，请直接回答用户问题。' },
      { role: 'user', content: input },
    ],
  )
  
  return {
    success: true,
    response,
    handledBy: 'master',
  }
}

/**
 * 处理直接动作（MasterAgent 直接执行）
 */
async function handleDirectAction(
  input: string,
  context: MasterAgentContext
): Promise<MasterAgentResult> {
  // 复用现有的 runAgent 逻辑，但限制工具权限
  const result = await runAgentWithLimitedTools(
    input,
    context,
    MASTER_AGENT_LIMITED_TOOLS
  )
  
  return {
    success: result.success,
    response: result.response,
    handledBy: 'master',
  }
}

/**
 * 处理复杂任务（调度 Worker Agent）
 */
async function handleComplexTask(
  input: string,
  analysis: TaskAnalysisResult,
  context: MasterAgentContext
): Promise<MasterAgentResult> {
  const results: SubTaskResult[] = []
  
  if (analysis.canParallelize && analysis.recommendedStrategy === 'parallel') {
    // 并行执行子任务
    const promises = analysis.subtasks.map(subtask =>
      executeSubTask(subtask, context)
    )
    results.push(...await Promise.all(promises))
  } else if (analysis.recommendedStrategy === 'hybrid') {
    // 混合策略：先并行后串行
    results.push(...await executeHybridStrategy(analysis.subtasks, context))
  } else {
    // 串行执行子任务
    for (const subtask of analysis.subtasks) {
      const result = await executeSubTask(subtask, context)
      results.push(result)
      
      // 如果失败且不可跳过，停止执行
      if (!result.success && !subtask.optional) {
        break
      }
    }
  }
  
  // 汇总结果
  const finalResponse = await summarizeResults(input, results)
  
  return {
    success: results.every(r => r.success),
    response: finalResponse,
    handledBy: 'worker_agents',
    subtaskResults: results,
  }
}
```

---

## 4. Worker Agent 工具权限控制

### 4.1 权限模型设计

```typescript
// worker-agent-permissions.ts

/**
 * 工具权限级别
 */
export enum ToolPermissionLevel {
  // 基础权限 - MasterAgent 固有
  BASIC = 'basic',
  
  // 标准权限 - 默认开放给 Worker Agent
  STANDARD = 'standard',
  
  // 受限权限 - 需要明确授权
  RESTRICTED = 'restricted',
  
  // 高风险权限 - 需要额外确认
  HIGH_RISK = 'high_risk',
}

/**
 * 工具权限配置
 */
export interface ToolPermissionConfig {
  toolName: string
  level: ToolPermissionLevel
  requiresExplicitApproval: boolean
  description: string
  riskFactors?: string[]
}

/**
 * 预定义的权限配置
 */
export const TOOL_PERMISSIONS: Record<string, ToolPermissionConfig> = {
  // 基础权限（低风险）
  read_file: {
    toolName: 'read_file',
    level: ToolPermissionLevel.BASIC,
    requiresExplicitApproval: false,
    description: '读取文件内容',
  },
  
  list_dir: {
    toolName: 'list_dir',
    level: ToolPermissionLevel.BASIC,
    requiresExplicitApproval: false,
    description: '列出目录结构',
  },
  
  find_file: {
    toolName: 'find_file',
    level: ToolPermissionLevel.BASIC,
    requiresExplicitApproval: false,
    description: '查找文件',
  },
  
  save_note: {
    toolName: 'save_note',
    level: ToolPermissionLevel.BASIC,
    requiresExplicitApproval: false,
    description: '保存笔记',
  },
  
  // 标准权限（中等风险）
  write_file: {
    toolName: 'write_file',
    level: ToolPermissionLevel.STANDARD,
    requiresExplicitApproval: true,
    description: '写入/创建文件',
    riskFactors: ['可能覆盖重要文件', '可能创建恶意文件'],
  },
  
  edit_file: {
    toolName: 'edit_file',
    level: ToolPermissionLevel.STANDARD,
    requiresExplicitApproval: true,
    description: '编辑文件内容',
    riskFactors: ['可能破坏代码逻辑', '可能导致数据丢失'],
  },
  
  // 高风险权限
  delete_file: {
    toolName: 'delete_file',
    level: ToolPermissionLevel.HIGH_RISK,
    requiresExplicitApproval: true,
    description: '删除文件',
    riskFactors: ['可能导致数据永久丢失', '可能删除系统关键文件'],
  },
  
  run_command: {
    toolName: 'run_command',
    level: ToolPermissionLevel.HIGH_RISK,
    requiresExplicitApproval: true,
    description: '执行系统命令',
    riskFactors: ['可能导致系统不稳定', '可能执行恶意命令'],
  },
}

/**
 * Worker Agent 权限配置
 */
export interface WorkerAgentPermissions {
  // 允许的工具列表
  allowedTools: string[]
  
  // 禁止的工具列表
  forbiddenTools: string[]
  
  // 需要确认的工具（运行时提示用户）
  approvalRequiredTools: string[]
  
  // 工具使用限制
  toolLimits?: {
    maxFileSize?: number      // 最大文件大小（字节）
    maxCommandDuration?: number // 最大命令执行时间（毫秒）
    allowedCommands?: string[] // 仅允许执行的命令（白名单）
    forbiddenPaths?: string[] // 禁止访问的路径（黑名单）
  }
}

/**
 * 创建 Worker Agent 权限配置
 */
export function createWorkerAgentPermissions(
  requiredTools: string[],
  options?: {
    allowHighRisk?: boolean
    workspace?: string
    taskSpecific?: Partial<WorkerAgentPermissions>
  }
): WorkerAgentPermissions {
  
  const permissions: WorkerAgentPermissions = {
    allowedTools: [],
    forbiddenTools: [],
    approvalRequiredTools: [],
  }
  
  // 基础工具始终允许
  const basicTools = Object.entries(TOOL_PERMISSIONS)
    .filter(([_, config]) => config.level === ToolPermissionLevel.BASIC)
    .map(([name]) => name)
  
  permissions.allowedTools.push(...basicTools)
  
  // 根据需求添加工具
  for (const tool of requiredTools) {
    const config = TOOL_PERMISSIONS[tool]
    
    if (!config) {
      // 未预定义的工具，默认禁止
      permissions.forbiddenTools.push(tool)
      continue
    }
    
    if (config.level === ToolPermissionLevel.HIGH_RISK && !options?.allowHighRisk) {
      // 高风险工具需要额外授权
      permissions.forbiddenTools.push(tool)
      continue
    }
    
    permissions.allowedTools.push(tool)
    
    if (config.requiresExplicitApproval) {
      permissions.approvalRequiredTools.push(tool)
    }
  }
  
  // 工作空间限制
  if (options?.workspace) {
    permissions.toolLimits = {
      ...permissions.toolLimits,
      forbiddenPaths: [
        ...(permissions.toolLimits?.forbiddenPaths || []),
        // 禁止访问工作空间外的路径
      ],
    }
  }
  
  // 任务特定配置
  if (options?.taskSpecific) {
    Object.assign(permissions, options.taskSpecific)
  }
  
  return permissions
}
```

### 4.2 权限验证执行

```typescript
// worker-agent-permissions.ts

/**
 * 权限验证器
 */
export class PermissionValidator {
  private permissions: WorkerAgentPermissions
  
  constructor(permissions: WorkerAgentPermissions) {
    this.permissions = permissions
  }
  
  /**
   * 检查是否可以执行指定工具
   */
  canExecuteTool(toolName: string): boolean {
    // 检查禁止列表
    if (this.permissions.forbiddenTools.includes(toolName)) {
      return false
    }
    
    // 检查允许列表
    if (this.permissions.allowedTools.includes(toolName)) {
      return true
    }
    
    // 不在允许列表中，默认禁止
    return false
  }
  
  /**
   * 检查工具是否需要运行时确认
   */
  requiresApproval(toolName: string): boolean {
    return this.permissions.approvalRequiredTools.includes(toolName)
  }
  
  /**
   * 验证工具调用参数
   */
  validateToolParams(
    toolName: string,
    params: Record<string, any>
  ): { valid: boolean; error?: string } {
    // 检查路径限制
    if (toolName === 'read_file' || toolName === 'write_file') {
      const path = params.path
      if (!path) return { valid: true }
      
      // 检查禁止路径
      if (this.permissions.toolLimits?.forbiddenPaths) {
        for (const forbiddenPath of this.permissions.toolLimits.forbiddenPaths) {
          if (path.startsWith(forbiddenPath)) {
            return {
              valid: false,
              error: `禁止访问路径: ${path}`,
            }
          }
        }
      }
    }
    
    // 检查命令限制
    if (toolName === 'run_command') {
      const command = params.command
      if (!command) return { valid: true }
      
      // 检查白名单
      if (this.permissions.toolLimits?.allowedCommands?.length) {
        const allowed = this.permissions.toolLimits.allowedCommands.some(
          allowedCmd => command.startsWith(allowedCmd)
        )
        if (!allowed) {
          return {
            valid: false,
            error: `命令不在允许列表中: ${command}`,
          }
        }
      }
    }
    
    return { valid: true }
  }
}

/**
 * 在 runAgent 中集成权限验证
 */
export async function runWorkerAgent(
  input: string,
  context: MasterAgentContext,
  permissions: WorkerAgentPermissions
): Promise<AgentResult> {
  const validator = new PermissionValidator(permissions)
  
  // 构建受限的工具列表
  const allowedToolNames = new Set(permissions.allowedTools)
  
  // 在执行工具前验证权限
  const originalExecuteToolCalls = executeToolCalls
  
  // 替换为带权限验证的执行函数
  await runAgent(/* 标准参数 */ {
    // ... 其他参数
    
    // 覆盖工具执行
    beforeToolCall: async (toolName: string, params: any) => {
      // 权限检查
      if (!validator.canExecuteTool(toolName)) {
        throw new Error(`工具 ${toolName} 权限不足`)
      }
      
      // 参数验证
      const validation = validator.validateToolParams(toolName, params)
      if (!validation.valid) {
        throw new Error(validation.error)
      }
      
      // 需要确认的工具
      if (validator.requiresApproval(toolName)) {
        // 可以在这里触发用户确认
        await requestUserApproval(toolName, params)
      }
      
      return true
    },
  })
}
```

### 4.3 预定义权限模板

```typescript
// worker-agent-permissions.ts

/**
 * 预定义的 Worker Agent 权限模板
 */
export const WORKER_AGENT_PERMISSION_TEMPLATES = {
  // 只读操作
  read_only: {
    allowedTools: ['read_file', 'list_dir', 'find_file', 'save_note'],
    forbiddenTools: ['write_file', 'edit_file', 'delete_file', 'run_command'],
    approvalRequiredTools: [],
  },
  
  // 文件操作（不含命令）
  file_operations: {
    allowedTools: ['read_file', 'write_file', 'edit_file', 'list_dir', 'find_file', 'save_note'],
    forbiddenTools: ['delete_file', 'run_command'],
    approvalRequiredTools: ['write_file', 'edit_file'],
  },
  
  // 完整操作（含命令）
  full_access: {
    allowedTools: ['read_file', 'write_file', 'edit_file', 'delete_file', 'run_command', 'list_dir', 'find_file', 'save_note'],
    forbiddenTools: [],
    approvalRequiredTools: ['delete_file', 'run_command'],
  },
  
  // 代码审查
  code_review: {
    allowedTools: ['read_file', 'list_dir', 'find_file', 'save_note'],
    forbiddenTools: ['write_file', 'edit_file', 'delete_file', 'run_command'],
    approvalRequiredTools: [],
  },
  
  // 测试执行
  test_execution: {
    allowedTools: ['read_file', 'write_file', 'list_dir', 'find_file', 'run_command', 'save_note'],
    forbiddenTools: ['delete_file'],
    approvalRequiredTools: ['write_file', 'run_command'],
    toolLimits: {
      allowedCommands: ['npm test', 'npm run', 'yarn test', 'yarn run', 'pnpm test', 'pnpm run'],
    },
  },
}

/**
 * 根据子任务自动推断权限模板
 */
export function inferPermissionTemplate(subtask: SubTask): WorkerAgentPermissions {
  const requiredTools = subtask.requiredTools
  
  // 判断需要哪些权限
  const needsWrite = requiredTools.some(t => ['write_file', 'edit_file'].includes(t))
  const needsDelete = requiredTools.includes('delete_file')
  const needsCommand = requiredTools.includes('run_command')
  
  if (needsDelete) {
    return createWorkerAgentPermissions(requiredTools, { allowHighRisk: true })
  }
  
  if (needsCommand) {
    return createWorkerAgentPermissions(requiredTools, { allowHighRisk: true })
  }
  
  if (needsWrite) {
    return createWorkerAgentPermissions(requiredTools, { allowHighRisk: false })
  }
  
  // 默认只读
  return createWorkerAgentPermissions(requiredTools)
}
```

---

## 5. 文件结构变更

```
desktop/src/main/
├── master-agent.ts          # 新增：MasterAgent 主逻辑
├── master-agent-prompt.ts   # 新增：Prompt 模板
├── task-splitter.ts         # 新增：任务拆解逻辑
├── worker-agent.ts          # 改造：作为 Worker Agent（复用现有 agent.ts）
├── worker-agent-permissions.ts  # 新增：权限控制
└── agent.ts                 # 现有：保留作为底层执行
```

---

## 6. 实现优先级

| 阶段 | 内容 | 产出 |
|------|------|------|
| **Phase 1** | 创建 `master-agent.ts` 基础框架，复用 `runAgent` 结构 | 入口文件 |
| **Phase 2** | 实现任务分类 prompt 和解析逻辑 | `task-splitter.ts` |
| **Phase 3** | 实现 Worker Agent 权限控制 | `worker-agent-permissions.ts` |
| **Phase 4** | 实现任务拆分和调度逻辑 | 集成到 `master-agent.ts` |
| **Phase 5** | 入口切换：用户输入 → MasterAgent | 集成测试 |
