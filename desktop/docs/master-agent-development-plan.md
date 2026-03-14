# MasterAgent 开发计划

## 1. 开发阶段总览

| 阶段 | 周期 | 主要目标 | 产出文件 |
|------|------|----------|----------|
| **Phase 1** | 第1-2周 | 基础框架搭建 | `master-agent.ts`, `master-agent-context.ts` |
| **Phase 2** | 第3周 | 任务拆解逻辑 | `task-splitter.ts`, `task-analyze-tool.ts` |
| **Phase 3** | 第4周 | 权限控制系统 | `worker-agent-permissions.ts`, `master-agent-permissions.ts` |
| **Phase 4** | 第5周 | 调度与执行 | `worker-agent.ts`, `task-scheduler.ts` |
| **Phase 5** | 第6周 | 长期记忆 | `memory-storage.ts`, `memory-manager.ts`, `memory-retrieval.ts` |
| **Phase 6** | 第7周 | 集成与入口 | 主入口切换、集成测试 |
| **Phase 7** | 第8周 | 优化与验收 | 性能优化、Bug修复、验收 |

---

## 2. Phase 1：基础框架搭建（第1-2周）

### 2.1 目标
- 创建 MasterAgent 入口文件
- 定义核心数据结构
- 复用现有 `agent.ts` 能力

### 2.2 任务清单

#### 2.2.1 创建 `master-agent-context.ts`

```typescript
// desktop/src/main/master-agent-context.ts

/**
 * MasterAgent 上下文
 */
export interface MasterAgentContext {
  sessionId: string
  userId?: string
  projectPath?: string
  recentMessages: ChatMessage[]
  activeSkills: string[]
  workspace: string
  permissions: MasterAgentPermissions
  memory?: MasterAgentMemoryContext
}

/**
 * MasterAgent 执行结果
 */
export interface MasterAgentResult {
  success: boolean
  response: string
  handledBy: 'master' | 'worker_agents' | 'hybrid'
  subtaskResults?: SubTaskResult[]
  memoryUpdates?: MemoryUpdate[]
}

/**
 * 子任务结果
 */
export interface SubTaskResult {
  subtaskId: number
  success: boolean
  result?: any
  error?: string
  duration: number
}
```

#### 2.2.2 创建 `master-agent.ts`

```typescript
// desktop/src/main/master-agent.ts

import { runAgent } from './agent'
import { analyzeTask } from './task-splitter'
import { createMasterAgentPermissions } from './master-agent-permissions'
import { buildMasterAgentContext } from './context-builder'

/**
 * MasterAgent 主入口
 */
export async function runMasterAgent(
  input: string,
  context: MasterAgentContext
): Promise<MasterAgentResult> {
  // 1. 构建上下文（包含记忆）
  const fullContext = await buildMasterAgentContext(context)
  
  // 2. 任务分析（判断类型）
  const analysis = await analyzeTask(input, fullContext)
  
  // 3. 根据任务类型执行
  switch (analysis.taskType) {
    case TaskType.SIMPLE_QUERY:
      return handleSimpleQuery(input, fullContext)
    
    case TaskType.SINGLE_ACTION:
    case TaskType.MULTI_ACTION:
      return handleDirectAction(input, fullContext)
    
    case TaskType.COMPLEX_TASK:
      return handleComplexTask(input, analysis, fullContext)
  }
}
```

### 2.3 验证方式
- [ ] 单元测试：`runMasterAgent` 基本调用
- [ ] 日志验证：确认任务类型判断正确

---

## 3. Phase 2：任务拆解逻辑（第3周）

### 3.1 目标
- 实现任务分类 Prompt
- 实现 `analyze_task` 工具定义
- 解析 AI 响应为结构化结果

### 3.2 任务清单

#### 3.2.1 创建 `master-agent-prompt.ts`

```typescript
// desktop/src/main/master-agent-prompt.ts

export const MASTER_AGENT_SYSTEM_PROMPT = `你是 MasterAgent（主代理），负责协调和管理任务执行。

## 角色定位
...

## 任务分类规则
- SIMPLE_QUERY：简单问答
- SINGLE_ACTION：单动作任务
- MULTI_ACTION：多动作任务
- COMPLEX_TASK：复杂任务
`

export const TASK_SPLIT_PROMPT = `## 任务拆分分析

请分析以下用户任务，判断任务类型并拆分子任务。

### 用户任务
{userTask}

### 判断标准
- SIMPLE_QUERY：无需工具，仅需知识库回答
- SINGLE_ACTION：1个工具调用即可完成
- MULTI_ACTION：多个工具调用，但可以串行完成
- COMPLEX_TASK：需要多个独立子任务

### 输出要求
请使用 analyze_task 工具输出分析结果。`
```

#### 3.2.2 创建 `task-analyze-tool.ts`

```typescript
// desktop/src/main/task-analyze-tool.ts

export const TASK_ANALYZE_TOOL = {
  name: 'analyze_task',
  description: '分析用户任务，判断任务类型并拆分子任务',
  parameters: {
    type: 'object',
    properties: {
      taskType: {
        type: 'string',
        enum: ['SIMPLE_QUERY', 'SINGLE_ACTION', 'MULTI_ACTION', 'COMPLEX_TASK'],
      },
      reason: { type: 'string' },
      subtasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number' },
            description: { type: 'string' },
            requiredTools: { type: 'array', items: { type: 'string' } },
            estimatedComplexity: { type: 'string', enum: ['low', 'medium', 'high'] },
          },
        },
      },
      canParallelize: { type: 'boolean' },
      recommendedStrategy: { type: 'string', enum: ['sequential', 'parallel', 'hybrid'] },
    },
    required: ['taskType', 'reason'],
  },
}
```

#### 3.2.3 创建 `task-splitter.ts`

```typescript
// desktop/src/main/task-splitter.ts

export enum TaskType {
  SIMPLE_QUERY = 'SIMPLE_QUERY',
  SINGLE_ACTION = 'SINGLE_ACTION',
  MULTI_ACTION = 'MULTI_ACTION',
  COMPLEX_TASK = 'COMPLEX_TASK',
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
export async function analyzeTask(
  userInput: string,
  context: MasterAgentContext
): Promise<TaskAnalysisResult> {
  // 1. 构建分析 prompt
  const prompt = buildTaskAnalysisPrompt(userInput, context)
  
  // 2. 调用 AI（使用 TASK_ANALYZE_TOOL）
  const response = await requestChatCompletion(getMasterAgentProvider(), prompt)
  
  // 3. 解析工具调用结果
  const result = parseTaskAnalysis(response)
  
  // 4. 返回分析结果
  return result
}

function buildTaskAnalysisPrompt(userInput: string, context: MasterAgentContext): ChatMessage[] {
  // 构建 prompt
}

function parseTaskAnalysis(aiResponse: string): TaskAnalysisResult {
  // 解析 analyze_task 工具调用
}
```

### 3.3 验证方式
- [ ] 单元测试：4种任务类型的分类
- [ ] 集成测试：复杂任务拆分正确性

---

## 4. Phase 3：权限控制系统（第4周）

### 4.1 目标
- 实现 MasterAgent 权限控制
- 实现 Worker Agent 权限控制
- 权限验证与拦截

### 4.2 任务清单

#### 4.2.1 创建 `master-agent-permissions.ts`

```typescript
// desktop/src/main/master-agent-permissions.ts

export enum MasterAgentPermissionLevel {
  READ_ONLY = 'read_only',
  STANDARD = 'standard',
  EXTENDED = 'extended',
  FULL = 'full',
}

export interface MasterAgentPermissions {
  level: MasterAgentPermissionLevel
  allowedTools: string[]
  confirmationRequired: string[]
  toolLimits: {
    maxFileSize: number
    maxCommandDuration: number
    forbiddenPaths: string[]
  }
  behavior: {
    autoApproveSafeOperations: boolean
    promptBeforeHighRisk: boolean
    allowParallelExecution: boolean
    maxConcurrentWorkers: number
  }
}

export const MASTER_AGENT_PERMISSION_LEVELS: Record<MasterAgentPermissionLevel, MasterAgentPermissions> = {
  // ... 4个级别的定义
}

export class MasterAgentPermissionValidator {
  canExecuteTool(toolName: string): boolean
  requiresConfirmation(toolName: string): boolean
  validatePath(toolName: string, path: string): { valid: boolean; reason?: string }
  validateCommand(command: string): { valid: boolean; reason?: string }
}
```

#### 4.2.2 创建 `worker-agent-permissions.ts`

```typescript
// desktop/src/main/worker-agent-permissions.ts

export enum ToolPermissionLevel {
  BASIC = 'basic',
  STANDARD = 'standard',
  RESTRICTED = 'restricted',
  HIGH_RISK = 'high_risk',
}

export interface WorkerAgentPermissions {
  allowedTools: string[]
  forbiddenTools: string[]
  approvalRequiredTools: string[]
  toolLimits?: {
    maxFileSize?: number
    maxCommandDuration?: number
    allowedCommands?: string[]
    forbiddenPaths?: string[]
  }
}

export const TOOL_PERMISSIONS: Record<string, ToolPermissionConfig> = {
  // ... 工具权限映射
}

export const WORKER_AGENT_PERMISSION_TEMPLATES = {
  read_only: { ... },
  file_operations: { ... },
  full_access: { ... },
  code_review: { ... },
  test_execution: { ... },
}

export function inferPermissionTemplate(subtask: SubTask): WorkerAgentPermissions {
  // 根据子任务自动推断权限
}

export class PermissionValidator {
  canExecuteTool(toolName: string): boolean
  requiresApproval(toolName: string): boolean
  validateToolParams(toolName: string, params: any): { valid: boolean; error?: string }
}
```

### 4.3 验证方式
- [ ] 单元测试：权限验证逻辑
- [ ] 集成测试：权限拦截正确性

---

## 5. Phase 4：调度与执行（第5周）

### 5.1 目标
- 实现 Worker Agent 封装
- 实现任务调度逻辑
- 实现结果汇总

### 5.2 任务清单

#### 5.2.1 创建 `worker-agent.ts`

```typescript
// desktop/src/main/worker-agent.ts

import { runAgent } from './agent'
import { PermissionValidator, inferPermissionTemplate } from './worker-agent-permissions'

/**
 * Worker Agent 执行器
 */
export async function runWorkerAgent(
  input: string,
  context: MasterAgentContext,
  subtask: SubTask
): Promise<SubTaskResult> {
  const startTime = Date.now()
  
  try {
    // 1. 推断权限
    const permissions = inferPermissionTemplate(subtask)
    const validator = new PermissionValidator(permissions)
    
    // 2. 构建工具过滤
    const allowedTools = new Set(permissions.allowedTools)
    
    // 3. 执行（复用 runAgent，传入权限验证）
    const result = await runAgent(input, context, {
      allowedTools,
      beforeToolCall: async (toolName, params) => {
        if (!validator.canExecuteTool(toolName)) {
          throw new Error(`权限不足: ${toolName}`)
        }
        const validation = validator.validateToolParams(toolName, params)
        if (!validation.valid) {
          throw new Error(validation.error)
        }
        return true
      },
    })
    
    return {
      subtaskId: subtask.id,
      success: true,
      result,
      duration: Date.now() - startTime,
    }
  } catch (error) {
    return {
      subtaskId: subtask.id,
      success: false,
      error: error.message,
      duration: Date.now() - startTime,
    }
  }
}
```

#### 5.2.2 创建 `task-scheduler.ts`

```typescript
// desktop/src/main/task-scheduler.ts

/**
 * 任务调度器
 */
export class TaskScheduler {
  private maxConcurrent: number
  
  constructor(maxConcurrent: number = 3) {
    this.maxConcurrent = maxConcurrent
  }
  
  /**
   * 串行执行
   */
  async executeSequential(
    subtasks: SubTask[],
    context: MasterAgentContext
  ): Promise<SubTaskResult[]> {
    const results: SubTaskResult[] = []
    for (const subtask of subtasks) {
      const result = await runWorkerAgent(subtask.description, context, subtask)
      results.push(result)
      if (!result.success && !subtask.optional) {
        break  // 失败且不可跳过
      }
    }
    return results
  }
  
  /**
   * 并行执行
   */
  async executeParallel(
    subtasks: SubTask[],
    context: MasterAgentContext
  ): Promise<SubTaskResult[]> {
    const promises = subtasks.map(subtask =>
      runWorkerAgent(subtask.description, context, subtask)
    )
    return Promise.all(promises)
  }
  
  /**
   * 混合执行（先并行后串行）
   */
  async executeHybrid(
    subtasks: SubTask[],
    context: MasterAgentContext
  ): Promise<SubTaskResult[]> {
    // 按依赖关系分组
    // ...
  }
}
```

#### 5.2.3 更新 `master-agent.ts` 执行逻辑

```typescript
// master-agent.ts 新增

import { TaskScheduler } from './task-scheduler'

async function handleComplexTask(
  input: string,
  analysis: TaskAnalysisResult,
  context: MasterAgentContext
): Promise<MasterAgentResult> {
  const scheduler = new TaskScheduler(context.permissions.behavior.maxConcurrentWorkers)
  
  let results: SubTaskResult[]
  
  switch (analysis.recommendedStrategy) {
    case 'parallel':
      results = await scheduler.executeParallel(analysis.subtasks, context)
      break
    case 'hybrid':
      results = await scheduler.executeHybrid(analysis.subtasks, context)
      break
    default:
      results = await scheduler.executeSequential(analysis.subtasks, context)
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

async function summarizeResults(
  input: string,
  results: SubTaskResult[]
): Promise<string> {
  // 调用 AI 汇总结果
}
```

### 5.3 验证方式
- [ ] 单元测试：调度器逻辑
- [ ] 集成测试：复杂任务执行正确性

---

## 6. Phase 5：长期记忆（第6周）

### 6.1 目标
- 实现 SQLite 存储
- 实现记忆检索
- 实现上下文构建

### 6.2 任务清单

#### 6.2.1 创建 `memory-storage.ts`

```typescript
// desktop/src/main/memory-storage.ts

import betterSqlite3 from 'better-sqlite3'

export enum MemoryType {
  USER_PREFERENCE = 'user_preference',
  USER_CONTEXT = 'user_context',
  PROJECT_KNOWLEDGE = 'project_knowledge',
  PROJECT_ARCHITECTURE = 'project_architecture',
  PROJECT_CONVENTIONS = 'project_conventions',
  TASK_HISTORY = 'task_history',
  TASK_RESULT = 'task_result',
  DECISION_LOG = 'decision_log',
  FACT = 'fact',
  INSIGHT = 'insight',
}

export interface MemoryEntry {
  id: string
  type: MemoryType
  content: string
  metadata: {
    source: 'user' | 'agent' | 'system' | 'task'
    importance: number
    tags: string[]
    createdAt: number
    updatedAt: number
    expiresAt?: number
    sessionId?: string
    taskId?: string
  }
  relatedMemories?: string[]
  evidence?: MemoryEvidence[]
}

export class MemoryStorage {
  private db: betterSqlite3.Database
  
  constructor(dbPath: string) {
    this.db = new betterSqlite3(dbPath)
    this.initialize()
  }
  
  private initialize() {
    // 创建表和索引
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        importance REAL NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER,
        tags TEXT,
        source TEXT,
        session_id TEXT,
        embedding_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
      CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);
      CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at);
      CREATE INDEX IF NOT EXISTS idx_memories_session_id ON memories(session_id);
    `)
  }
  
  async save(entry: MemoryEntry): Promise<void> {
    // 插入或更新
  }
  
  async query(filter: MemoryQuery): Promise<MemoryEntry[]> {
    // 查询
  }
  
  async delete(id: string): Promise<void> {
    // 删除
  }
}
```

#### 6.2.2 创建 `memory-retrieval.ts`

```typescript
// desktop/src/main/memory-retrieval.ts

export interface MemoryQuery {
  type?: MemoryType | MemoryType[]
  tags?: string[]
  source?: 'user' | 'agent' | 'system' | 'task'
  createdAfter?: number
  createdBefore?: number
  keyword?: string
  semanticQuery?: string
  minImportance?: number
  relatedTo?: string
  limit?: number
  offset?: number
}

export class MemoryRetrievalService {
  async semanticSearch(query: string, options?: {...}): Promise<MemoryRetrievalResult>
  async keywordSearch(keyword: string, options?: {...}): Promise<MemoryRetrievalResult>
  async hybridSearch(query: string, options?: {...}): Promise<MemoryRetrievalResult>
  async contextualRetrieval(context: {...}): Promise<MemoryRetrievalResult>
  async timelineRetrieval(options?: {...}): Promise<MemoryRetrievalResult>
}
```

#### 6.2.3 创建 `memory-manager.ts`

```typescript
// desktop/src/main/memory-manager.ts

export class MasterAgentMemoryManager {
  async autoRemember(event: {...}): Promise<MemoryEntry | null>
  async updateMemory(memoryId: string, updates: {...}): Promise<MemoryEntry>
  async mergeMemories(sourceIds: string[], targetId: string): Promise<MemoryEntry>
  async decayMemories(): Promise<{...}>
  async consolidateToLongTerm(sessionId: string): Promise<number>
  async forget(options?: {...}): Promise<{...}>
}
```

#### 6.2.4 创建 `context-builder.ts`

```typescript
// desktop/src/main/context-builder.ts

export async function buildMasterAgentContext(
  options: ContextBuildOptions
): Promise<{
  shortTermMemories: MemoryEntry[]
  longTermMemories: MemoryEntry[]
  userProfile?: {...}
  projectProfile?: {...}
  contextText: string
}> {
  // 1. 检索短期记忆
  // 2. 检索长期记忆
  // 3. 构建画像
  // 4. 格式化上下文
}
```

### 6.3 验证方式
- [ ] 单元测试：存储 CRUD
- [ ] 集成测试：记忆检索准确率

---

## 7. Phase 6：集成与入口（第7周）

### 7.1 目标
- 主入口切换
- IPC 集成
- 完整流程测试

### 7.2 任务清单

#### 7.2.1 修改主入口

```typescript
// 现有入口文件（如 desktop/src/main/index.ts 或类似）

// 旧：
// const result = await runAgent(input, context)

// 新：
const result = await runMasterAgent(input, context)
```

#### 7.2.2 IPC 集成

```typescript
// desktop/src/main/ipc-handlers.ts

ipcMain.handle('master-agent:run', async (event, input: string, context: MasterAgentContext) => {
  return await runMasterAgent(input, context)
})

ipcMain.handle('master-agent:analyze', async (event, input: string) => {
  return await analyzeTask(input, context)
})
```

#### 7.2.3 配置初始化

```typescript
// desktop/src/main/config.ts

export const MASTER_AGENT_CONFIG = {
  permissions: {
    defaultLevel: MasterAgentPermissionLevel.STANDARD,
  },
  memory: {
    dbPath: getPlatformPath('TacoAI/memory/master_agent.db'),
    maxEntries: 10000,
    retrieval: {
      maxResults: 20,
      similarityThreshold: 0.7,
    },
  },
  scheduler: {
    maxConcurrentWorkers: 3,
  },
}
```

### 7.3 验证方式
- [ ] 集成测试：完整对话流程
- [ ] UI 测试：用户体验

---

## 8. Phase 7：优化与验收（第8周）

### 8.1 目标
- 性能优化
- Bug 修复
- 验收测试

### 8.2 任务清单

| 任务 | 描述 |
|------|------|
| 性能分析 | 分析 token 消耗、响应时间 |
| 缓存优化 | 记忆检索缓存、Prompt 缓存 |
| 错误处理 | 完善异常捕获与恢复 |
| 单元测试补全 | 覆盖率提升至 80% |
| E2E 测试 | 自动化测试用例 |
| 文档更新 | API 文档、使用指南 |

### 8.3 验收标准

| 指标 | 目标 |
|------|------|
| 任务分类准确率 | > 90% |
| 复杂任务拆分正确率 | > 85% |
| 记忆检索准确率 | > 80% |
| 权限拦截准确率 | 100% |
| 平均响应时间 | < 5s（简单任务）|
| 代码覆盖率 | > 80% |

---

## 9. 文件变更清单

### 9.1 新增文件

| 文件路径 | 描述 |
|----------|------|
| `desktop/src/main/master-agent.ts` | MasterAgent 主入口 |
| `desktop/src/main/master-agent-context.ts` | 核心数据结构 |
| `desktop/src/main/master-agent-prompt.ts` | Prompt 模板 |
| `desktop/src/main/task-analyze-tool.ts` | analyze_task 工具定义 |
| `desktop/src/main/task-splitter.ts` | 任务拆解逻辑 |
| `desktop/src/main/master-agent-permissions.ts` | MasterAgent 权限 |
| `desktop/src/main/worker-agent-permissions.ts` | Worker Agent 权限 |
| `desktop/src/main/worker-agent.ts` | Worker Agent 执行器 |
| `desktop/src/main/task-scheduler.ts` | 任务调度器 |
| `desktop/src/main/memory-storage.ts` | 记忆存储（SQLite）|
| `desktop/src/main/memory-retrieval.ts` | 记忆检索服务 |
| `desktop/src/main/memory-manager.ts` | 记忆管理器 |
| `desktop/src/main/context-builder.ts` | 上下文构建器 |
| `desktop/src/main/config.ts` | 配置文件 |

### 9.2 修改文件

| 文件路径 | 修改内容 |
|----------|----------|
| `desktop/src/main/agent.ts` | 保持底层执行能力，可选择重构为内部函数 |
| 主入口文件 | 切换为 runMasterAgent |

---

## 10. 依赖项

```json
{
  "dependencies": {
    "better-sqlite3": "^9.0.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0"
  }
}
```

---

## 11. 风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| 任务分类不准确 | 用户体验下降 | 持续优化 prompt，增加人工标注数据 |
| 记忆检索性能 | 响应慢 | 加入缓存、分页、索引优化 |
| 权限漏洞 | 安全风险 | 严格测试，定期安全审计 |
| Worker Agent 并发 | 资源竞争 | 限制并发数，资源隔离 |

---

*文档版本: v1.0*  
*创建日期: 2026-03-14*
