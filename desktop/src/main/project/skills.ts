/**
 * Skills 管理器
 *
 * 目标：
 * 1) 分层加载：workspace > global > builtin
 * 2) 门控加载：supports requires.bins / requires.env / requires.config
 * 3) 运行时注入：每轮任务可临时注入 skill env，结束后恢复
 */

import * as fs from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import type { Dirent } from 'node:fs'
import * as path from 'node:path'
import { app } from 'electron'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import type { SkillInfo } from '../../shared/ipc'
import { log } from '../system/logger'

const execFile = promisify(execFileCb)

/* ------------------------------------------------------------------ */
/*  路径常量                                                            */
/* ------------------------------------------------------------------ */

const HOME_DIR = app.getPath('home')
const TACO_DIR = path.join(HOME_DIR, '.taco')
const SKILLS_DIR = path.join(TACO_DIR, 'skills')
const SKILLS_JSON = path.join(TACO_DIR, 'skills.json')
const SKILLS_CONFIG_JSON = path.join(TACO_DIR, 'skills-config.json')
const OPENCLAW_SKILLS_DIR = path.join(HOME_DIR, '.openclaw', 'skills')

const DEFAULT_SKILL_RESOURCE_DIRS = ['references', 'scripts', 'assets', 'templates']
const SKILL_TOOL_GROUPS: Record<string, string[]> = {
  browser: [
    'browser_navigate',
    'browser_screenshot',
    'browser_click',
    'browser_type',
    'browser_scroll',
    'browser_get_content',
    'browser_wait',
    'browser_evaluate',
    'browser_get_info',
    'browser_get_console_logs',
    'browser_hover',
    'browser_keypress',
    'browser_drag',
    'browser_select',
  ],
  desktop: ['desktop_screenshot', 'gui_plus_analyze', 'desktop_action'],
  mcp: ['mcp_list_tools', 'mcp_call'],
  files: ['read_file', 'write_file', 'edit_file', 'delete_file', 'list_dir', 'find_file'],
  command: ['run_command'],
  planning: ['propose_plan', 'update_plan_progress'],
  notes: ['save_note', 'delete_note'],
}

/* ------------------------------------------------------------------ */
/*  内置 Skills                                                        */
/* ------------------------------------------------------------------ */

const BUILTIN_SKILLS: SkillInfo[] = [
  {
    id: 'code-review',
    name: '代码审查',
    description: '在修改代码后自动检查潜在问题，提供代码审查建议',
    version: '1.0.0',
    author: 'Taco',
    source: 'builtin',
    enabled: true,
    tools: ['read_file', 'find_file'],
    instructions: `# Skill: 代码审查
当你修改了代码文件后，主动对改动进行简要的代码审查：
- 检查是否有明显的 bug 或逻辑错误
- 检查是否有未处理的边界情况
- 检查是否有安全隐患（如 SQL 注入、XSS 等）
- 检查代码风格是否与项目一致
如果发现问题，在最终回复中简要说明。不需要对每次修改都长篇大论，只在发现明显问题时提醒。`,
  },
  {
    id: 'auto-test',
    name: '自动测试',
    description: '修改代码后自动运行相关测试并报告结果',
    version: '1.0.0',
    author: 'Taco',
    source: 'builtin',
    enabled: false,
    tools: ['run_command'],
    instructions: `# Skill: 自动测试
当你修改了代码文件后，检查项目中是否有对应的测试文件：
- 如果有，在修改完成后用 run_command 执行相关测试
- 如果测试失败，分析失败原因并尝试修复
- 在最终回复中报告测试执行结果
常见测试框架检测：
- Node.js: 检查 package.json 中的 test script，使用 npm test / jest / vitest
- Python: 检查 pytest / unittest
- Go: go test
- Rust: cargo test`,
  },
  {
    id: 'git-best-practice',
    name: 'Git 最佳实践',
    description: '遵循 Git 最佳实践，自动生成规范的 commit message',
    version: '1.0.0',
    author: 'Taco',
    source: 'builtin',
    enabled: false,
    tools: ['run_command'],
    instructions: `# Skill: Git 最佳实践
在执行 Git 操作时遵循以下规范：
- Commit message 使用 Conventional Commits 格式：type(scope): description
  - feat: 新功能
  - fix: Bug 修复
  - refactor: 重构
  - docs: 文档
  - style: 代码格式
  - test: 测试
  - chore: 构建/工具
- 每次修改尽量保持原子性，一个 commit 只做一件事
  - 在执行 git push 前提醒用户确认`,
  },
  {
    id: 'browser-automation',
    name: '浏览器自动化',
    description: '操控外部浏览器执行自动化操作：页面导航、元素点击、表单填写、内容提取、UI 验证等',
    version: '1.0.0',
    author: 'Taco',
    source: 'builtin',
    enabled: true,
    tools: SKILL_TOOL_GROUPS.browser,
    instructions: `# Skill: 浏览器自动化

你可以通过浏览器自动化工具操控外部浏览器，执行以下类型的任务：

## 适用场景
- **前端开发验证**: 打开本地开发服务器（如 http://localhost:3000），验证 UI 显示效果
- **自动化测试**: 模拟用户操作流程（登录、填写表单、点击按钮），验证功能正确性
- **网页数据提取**: 打开网页，提取页面内容和数据
- **UI 问题排查**: 截图分析页面布局、样式问题

## 操作流程模式
典型的浏览器操作应遵循“目标-操作-验证”的循环：

1. **browser_navigate** → 打开目标页面
2. **browser_get_console_logs / browser_get_info** → 先确认页面状态与错误信息
3. **browser_screenshot** → 仅在需要视觉确认时截图（必须有明确目标）
4. **browser_click / browser_type** → 执行具体操作
5. **browser_screenshot / browser_get_content** → 验证操作结果
6. 重复步骤 3-5 直到完成

## 关键注意事项
- 截图前必须明确目的（例如“验证按钮是否出现”），禁止无目的连续截图
- CSS 选择器应尽量使用稳定的标识（id、name、data-testid）
- 页面跳转或异步加载后使用 browser_wait 等待关键元素
- 遇到错误时优先查看 browser_get_console_logs，再决定是否截图
- 表单填写时注意使用 clear: true 清空后再输入
- 对于需要登录的页面，先完成登录流程再进行后续操作
- 截图会自动上传到云存储,返回cloudUrl字段,可直接让AI分析图片,无需使用MCP工具

## 工具速查
- **browser_navigate**: 打开指定 URL；需要隔离浏览器会话时传 appId
- **browser_screenshot**: 获取页面截图和页面基础信息；调用时必须填写 goal
- **browser_click**: 点击页面元素或指定坐标；优先使用稳定 selector
- **browser_type**: 向输入元素输入文本；需要覆盖旧值时使用 clear: true
- **browser_scroll**: 滚动页面或指定可滚动元素；通过 direction、amount 和 selector 控制范围
- **browser_get_content**: 读取页面或指定元素的 text、html、value 内容
- **browser_wait**: 等待关键 selector 出现；异步加载或跳转后优先使用
- **browser_evaluate**: 在页面上下文执行最小必要的 JavaScript 表达式
- **browser_get_info**: 读取当前页面 URL、标题、视口等基础状态
- **browser_get_console_logs**: 读取控制台日志；排查错误时优先使用
- **browser_hover**: 将鼠标悬停到元素或指定坐标
- **browser_keypress**: 触发单键或组合键操作；组合键通过 key 和 modifiers 指定
- **browser_drag**: 执行页面拖拽；可用 selector 或起止坐标描述目标
- **browser_select**: 操作原生 <select> 元素；按 value 或 label 选择选项`,
  },
  {
    id: 'desktop-automation',
    name: '桌面自动化',
    description: '执行桌面级自动化操作：屏幕截图、界面识别、鼠标点击、键盘输入、窗口交互等',
    version: '1.0.0',
    author: 'Taco',
    source: 'builtin',
    enabled: true,
    tools: SKILL_TOOL_GROUPS.desktop,
    instructions: `# Skill: 桌面自动化

你可以通过桌面自动化工具操控系统界面，执行以下类型的任务：

## 适用场景
- **桌面软件操作**: 点击按钮、输入文本、切换窗口、操作系统级弹窗
- **界面排查**: 对当前屏幕截图，识别界面元素并验证状态
- **系统设置操作**: 通过桌面交互完成系统或应用设置变更
- **视觉定位任务**: 在未知坐标时先截图分析，再执行点击或输入

## 操作流程模式
典型的桌面操作应遵循“截图-识别-执行-校验”的循环：

1. **desktop_screenshot** → 获取当前屏幕截图
2. **gui_plus_analyze** → 分析截图，定位目标元素或生成下一步动作
3. **desktop_action** → 执行点击、双击、输入、快捷键、拖拽等动作
4. **desktop_screenshot** → 再次截图复核界面状态变化

## 关键注意事项
- 如果用户已经明确提供坐标、按键或输入内容，可直接使用 desktop_action
- 如果目标只是语义描述（例如“点击保存按钮”），必须先截图再识别
- 点击后若需要立即输入，先确认焦点已切换成功
- 关键动作后必须复核结果，避免只报告“已执行”
- 桌面操作不要混用浏览器 DOM 工具，桌面任务只使用桌面相关工具

## 工具速查
- **desktop_screenshot**: 截取当前桌面屏幕,返回本地图片路径、cloudUrl与尺寸信息
- **gui_plus_analyze**: 分析截图并返回结构化识别结果；instruction 必须明确识别目标
- **desktop_action**: 执行点击、双击、输入、快捷键、拖拽、滚动等桌面动作；按 action 类型填写参数`,
  },
  {
    id: 'mcp-tooling',
    name: 'MCP 工具调用',
    description: '调用外部 MCP 服务器提供的工具能力，例如图片理解、网络检索、专业工具链等',
    version: '1.0.0',
    author: 'Taco',
    source: 'builtin',
    enabled: true,
    tools: SKILL_TOOL_GROUPS.mcp,
    instructions: `# Skill: MCP 工具调用

当任务需要使用外部 MCP (Model Context Protocol) 服务提供的能力时，遵循以下流程：

## 适用场景
- **外部专业工具**: 需要使用 MCP 服务端提供的专用能力，而不是本地内置工具
- **动态工具发现**: 当前不知道 MCP 工具的参数结构，需要先读取 schema
- **根据搜索查询执行网页搜索**: 需要使用 MCP 服务端提供的 \`minimax:web_search\` 工具进行网页搜索


## 操作流程模式
1. **mcp_list_tools** → 先读取当前可用 MCP 工具清单与 inputSchema
2. **确认目标工具** → 根据工具名、用途和参数 schema 选出正确工具
3. **mcp_call** → 严格按 schema 组装 arguments 调用
4. **核对返回结果** → 用返回结果继续任务，不得凭猜测补字段

## 关键注意事项
- 任何 MCP 调用前，都必须先执行 mcp_list_tools，禁止凭记忆猜参数
- 图片分析类工具必须提供明确目标和成功判定标准，避免泛化描述
- 调用失败先检查 schema、参数和值类型，再决定是否重试
- MCP 返回的是外部能力结果，必须结合当前任务目标再做判断，不可机械转述

## 工具速查
- **mcp_list_tools**: 列出已启用 MCP 服务器、工具清单与输入 schema；必要时用 server_id 限定范围
- **mcp_call**: 调用指定 MCP 服务器上的目标工具；arguments 必须严格符合目标 schema`,
  },
]

/* ------------------------------------------------------------------ */
/*  类型与缓存                                                          */
/* ------------------------------------------------------------------ */

type PersistedSkill = Omit<SkillInfo, 'instructions'> & { instructionsFile?: string }

type SkillRequires = {
  bins: string[]
  env: string[]
  config: string[]
}

type ParsedSkillMeta = {
  name?: string
  description?: string
  version?: string
  author?: string
  enabled?: boolean
  requires: SkillRequires
  env: Record<string, string>
  tools: string[]
  resources: string[]
}

type SkillScope = 'builtin' | 'global' | 'workspace'

type SkillEntry = {
  skill: SkillInfo
  scope: SkillScope
  requires: SkillRequires
  env: Record<string, string>
  rootDir?: string
  tools: string[]
  resources: string[]
}

type GitHubSkillSource = {
  owner: string
  repo: string
  ref: string
  skillRootPath: string
  skillMdPath: string
}

let allSkills: SkillInfo[] = []
let activeSkillInstructions: string[] = []
let activeSkillEnv: Record<string, string> = {}
let activeSkills: SkillInfo[] = []
let activeSkillEntries = new Map<string, SkillEntry>()
let lastWorkspaceForRefresh = ''
let refreshSeq = 0

const binCheckCache = new Map<string, boolean>()

const EMPTY_REQUIRES: SkillRequires = { bins: [], env: [], config: [] }

/* ------------------------------------------------------------------ */
/*  对外 API                                                            */
/* ------------------------------------------------------------------ */

export async function initSkills() {
  await ensureDirs()
  await refreshSkills()
}

export async function refreshSkills(workspace?: string): Promise<void> {
  const seq = ++refreshSeq
  const normalizedWorkspace = normalizeWorkspace(workspace)
  lastWorkspaceForRefresh = normalizedWorkspace

  const persisted = await loadPersistedSkills()
  const persistedById = new Map<string, PersistedSkill>()
  for (const item of persisted) persistedById.set(item.id, item)

  const merged = new Map<string, SkillEntry>()

  for (const builtin of BUILTIN_SKILLS) {
    const saved = persistedById.get(builtin.id)
    merged.set(builtin.id, {
      scope: 'builtin',
      requires: EMPTY_REQUIRES,
      env: {},
      skill: {
        ...builtin,
        enabled: typeof saved?.enabled === 'boolean' ? saved.enabled : builtin.enabled,
        tools: resolveSkillToolNames(builtin.tools ?? []),
        resources: dedupeList(builtin.resources ?? []),
      },
      tools: resolveSkillToolNames(builtin.tools ?? []),
      resources: dedupeList(builtin.resources ?? []),
    })
  }

  const globalEntries = await loadSkillsFromDirs([SKILLS_DIR, OPENCLAW_SKILLS_DIR], 'global', persistedById)
  for (const entry of globalEntries) merged.set(entry.skill.id, entry)

  if (normalizedWorkspace) {
    const workspaceEntries = await loadSkillsFromDirs(resolveWorkspaceSkillDirs(normalizedWorkspace), 'workspace', persistedById)
    for (const entry of workspaceEntries) merged.set(entry.skill.id, entry)
  }

  for (const p of persisted) {
    if (p.source === 'builtin') continue
    if (merged.has(p.id)) continue
    const instructions = await loadSkillInstructionsFromPersisted(p)
    if (!instructions.trim()) continue
    merged.set(p.id, {
      scope: 'global',
      requires: EMPTY_REQUIRES,
      env: {},
      skill: {
        id: p.id,
        name: p.name,
        description: p.description,
        version: p.version,
        author: p.author,
        source: p.source,
        sourceUrl: p.sourceUrl,
        enabled: p.enabled,
        instructions,
        tools: resolveSkillToolNames(p.tools ?? []),
        resources: dedupeList(p.resources ?? []),
      },
      rootDir: path.join(SKILLS_DIR, p.id),
      tools: resolveSkillToolNames(p.tools ?? []),
      resources: dedupeList(p.resources ?? []),
    })
  }

  const runtimeConfig = await loadRuntimeConfig()
  const resolvedSkills = sortSkillsForDisplay(Array.from(merged.values()))
  const nextAllSkills = resolvedSkills.map((entry) => ({ ...entry.skill }))
  const nextInstructions: string[] = []
  const nextEnv: Record<string, string> = {}
  const nextActiveSkills: SkillInfo[] = []
  const nextActiveEntries = new Map<string, SkillEntry>()

  for (const entry of resolvedSkills) {
    const { skill } = entry
    if (!skill.enabled || !skill.instructions.trim()) continue
    const unavailable = await resolveUnavailableReason(entry.requires, runtimeConfig)
    if (unavailable) continue
    nextInstructions.push(skill.instructions)
    nextActiveSkills.push({ ...skill })
    nextActiveEntries.set(skill.id, {
      ...entry,
      skill: { ...skill },
      tools: resolveSkillToolNames(entry.tools ?? skill.tools ?? []),
      resources: dedupeList(entry.resources ?? skill.resources ?? []),
    })
    for (const [k, v] of Object.entries(entry.env)) {
      const key = String(k ?? '').trim()
      if (!key) continue
      nextEnv[key] = interpolateEnv(String(v ?? ''))
    }
  }

  if (seq !== refreshSeq) return

  allSkills = nextAllSkills
  activeSkillInstructions = nextInstructions
  activeSkillEnv = nextEnv
  activeSkills = nextActiveSkills
  activeSkillEntries = nextActiveEntries
}

export async function listSkills(workspace?: string): Promise<SkillInfo[]> {
  await refreshSkills(workspace || lastWorkspaceForRefresh || undefined)
  return allSkills.map((s) => ({ ...s }))
}

export function getActiveSkillInstructions(): string[] {
  return [...activeSkillInstructions]
}

export function getActiveSkillEnv(): Record<string, string> {
  return { ...activeSkillEnv }
}

export function getActiveSkills(): SkillInfo[] {
  return activeSkills.map((skill) => ({ ...skill }))
}

export function getSkillAllowedTools(skillId: string): string[] {
  const normalizedId = String(skillId ?? '').trim()
  if (!normalizedId) return []
  const entry = activeSkillEntries.get(normalizedId)
  if (!entry) return []
  return resolveSkillToolNames(entry.tools ?? [])
}

export function getAllowedToolsForSkills(skillIds: Iterable<string>): string[] {
  const merged: string[] = []
  for (const skillId of skillIds) {
    for (const tool of getSkillAllowedTools(skillId)) {
      if (!merged.includes(tool)) merged.push(tool)
    }
  }
  return merged
}

export function buildActiveSkillsCatalogBlock(): string {
  if (activeSkills.length === 0) return ''

  const lines: string[] = ['[SKILLS_CATALOG]']
  for (const skill of activeSkills) {
    const summary = buildSkillSummary(skill)
    lines.push(`- id: ${skill.id}`)
    lines.push(`  name: ${skill.name}`)
    lines.push(`  summary: ${summary}`)
  }
  lines.push('[/SKILLS_CATALOG]')
  lines.push('规则：以上只包含当前已开启且当前环境可用的技能目录。')
  lines.push('当本轮任务需要使用某个技能时，必须先调用 `read_skill` 查看该技能的完整内容。')
  lines.push('若技能详情提到了 references/scripts/assets/templates 等附属资源，请在读取该技能详情后使用 `read_skill_resource` 按需查看具体文件。')
  lines.push('未读取完整技能内容前，不得按该技能协议执行。')
  return lines.join('\n')
}

export function readActiveSkillDetail(skillId: string): { content: string; skill: SkillInfo } | null {
  const normalizedId = String(skillId ?? '').trim()
  if (!normalizedId) return null
  const skill = activeSkills.find((item) => item.id === normalizedId)
  if (!skill) return null

  const detailLines = [
    `[SKILL_DETAIL id="${skill.id}"]`,
    `name: ${skill.name}`,
    `description: ${buildSkillSummary(skill)}`,
    ...(skill.tools?.length ? ['', '[SKILL_ALLOWED_TOOLS]', ...skill.tools.map((tool) => `- ${tool}`), '[/SKILL_ALLOWED_TOOLS]'] : []),
    ...(skill.resources?.length ? ['', '[SKILL_RESOURCES]', ...skill.resources.map((item) => `- ${item}`), '[/SKILL_RESOURCES]'] : []),
    '',
    skill.instructions.trim(),
    '[/SKILL_DETAIL]',
  ]

  return {
    skill: { ...skill },
    content: detailLines.join('\n'),
  }
}

export async function readActiveSkillResource(
  skillId: string,
  relativePath: string,
): Promise<{ content: string; resolvedPath: string; skill: SkillInfo } | null> {
  const normalizedId = String(skillId ?? '').trim()
  const requested = normalizeSkillResourcePath(relativePath)
  if (!normalizedId || !requested) return null

  const entry = activeSkillEntries.get(normalizedId)
  if (!entry?.rootDir) return null

  if (!isSkillResourceAllowed(requested, entry.resources ?? [])) return null

  const resolvedPath = path.resolve(entry.rootDir, requested)
  const normalizedRoot = path.resolve(entry.rootDir)
  if (!resolvedPath.startsWith(normalizedRoot + path.sep) && resolvedPath !== normalizedRoot) return null

  try {
    const stat = await fs.stat(resolvedPath)
    if (!stat.isFile()) return null
    if (stat.size > 256 * 1024) return null
    const content = await fs.readFile(resolvedPath, 'utf-8')
    return {
      content,
      resolvedPath,
      skill: { ...entry.skill },
    }
  } catch {
    return null
  }
}

export function applySkillEnvironment(envVars: Record<string, string>): () => void {
  const backups = new Map<string, string | undefined>()
  for (const [rawKey, rawValue] of Object.entries(envVars ?? {})) {
    const key = String(rawKey ?? '').trim()
    if (!key) continue
    backups.set(key, process.env[key])
    process.env[key] = String(rawValue ?? '')
  }

  return () => {
    for (const [key, value] of backups.entries()) {
      if (typeof value === 'undefined') delete process.env[key]
      else process.env[key] = value
    }
  }
}

export async function toggleSkill(id: string, enabled: boolean) {
  const current = allSkills.find((s) => s.id === id)
  if (!current) throw new Error(`Skill not found: ${id}`)
  const persisted = await loadPersistedSkills()
  const next = upsertPersistedSkill(persisted, {
    id,
    name: current.name,
    description: current.description,
    version: current.version,
    author: current.author,
    source: current.source,
    sourceUrl: current.sourceUrl,
    enabled,
  })
  await savePersistedSkills(next)
  await refreshSkills(lastWorkspaceForRefresh || undefined)
}

export async function uninstallSkill(id: string) {
  const current = allSkills.find((s) => s.id === id)
  if (!current) throw new Error(`Skill not found: ${id}`)
  if (current.source === 'builtin') throw new Error('Cannot uninstall builtin skill')

  const persisted = await loadPersistedSkills()
  const filtered = persisted.filter((s) => s.id !== id)
  await savePersistedSkills(filtered)

  const dir = path.join(SKILLS_DIR, id)
  try {
    await fs.rm(dir, { recursive: true })
  } catch {
    // ignore
  }

  await refreshSkills(lastWorkspaceForRefresh || undefined)
}

export async function installSkill(source: string): Promise<SkillInfo> {
  let instructions: string
  let meta: ParsedSkillMeta = {
    requires: { ...EMPTY_REQUIRES },
    env: {},
    tools: [],
    resources: [],
  }
  let localSkillRoot = ''
  let remoteGitHubSource: GitHubSkillSource | null = null

  if (source.startsWith('http://') || source.startsWith('https://')) {
    remoteGitHubSource = parseGitHubSkillSource(source)
    if (remoteGitHubSource) {
      instructions = await downloadGitHubTextFile(remoteGitHubSource, remoteGitHubSource.skillMdPath)
      meta = parseSkillMeta(instructions)
      
      // 安全审核: 检查远程 Skill 是否包含危险操作
      const securityCheck = auditSkillSecurity(instructions, meta)
      if (securityCheck.riskLevel === 'critical') {
        throw new Error(`拒绝安装高风险 Skill: ${securityCheck.warnings.join('; ')}`)
      }
      if (securityCheck.riskLevel === 'high') {
        log('SKILL_SECURITY_WARNING', {
          source,
          riskLevel: securityCheck.riskLevel,
          warnings: securityCheck.warnings,
        }, 'skills')
        // 高风险 Skill 需要用户确认,此处仅记录警告
      }
    } else {
      const rawUrl = toRawGitHubUrl(source)
      const resp = await fetch(rawUrl)
      if (!resp.ok) throw new Error(`Failed to fetch skill: ${resp.status} ${resp.statusText}`)
      instructions = await resp.text()
      meta = parseSkillMeta(instructions)
      
      // 安全审核
      const securityCheck = auditSkillSecurity(instructions, meta)
      if (securityCheck.riskLevel === 'critical') {
        throw new Error(`拒绝安装高风险 Skill: ${securityCheck.warnings.join('; ')}`)
      }
      if (securityCheck.riskLevel === 'high') {
        log('SKILL_SECURITY_WARNING', {
          source: rawUrl,
          riskLevel: securityCheck.riskLevel,
          warnings: securityCheck.warnings,
        }, 'skills')
      }
    }
  } else {
    const filePath = source.endsWith('SKILL.md') ? source : path.join(source, 'SKILL.md')
    try {
      instructions = await fs.readFile(filePath, 'utf-8')
      meta = parseSkillMeta(instructions)
      localSkillRoot = path.dirname(filePath)
      
      // 本地 Skill 也进行安全审核
      const securityCheck = auditSkillSecurity(instructions, meta)
      if (securityCheck.riskLevel === 'critical') {
        throw new Error(`拒绝安装高风险 Skill: ${securityCheck.warnings.join('; ')}`)
      }
      if (securityCheck.riskLevel === 'high') {
        log('SKILL_SECURITY_WARNING', {
          source: filePath,
          riskLevel: securityCheck.riskLevel,
          warnings: securityCheck.warnings,
        }, 'skills')
      }
    } catch {
      throw new Error(`Cannot read skill file: ${filePath}`)
    }
  }

  const id = toSkillId(meta.name || `skill-${Date.now()}`)
  const persisted = await loadPersistedSkills()

  if (localSkillRoot) {
    await installSkillPackageFromLocalRoot(id, localSkillRoot, instructions, meta.resources)
  } else if (remoteGitHubSource) {
    await installSkillPackageFromGitHub(id, remoteGitHubSource, instructions, meta.resources)
  } else {
    await saveSkillInstructions(id, instructions)
  }

  const existing = persisted.find((s) => s.id === id)
  const nextItem: PersistedSkill = {
    id,
    name: meta.name || existing?.name || id,
    description: meta.description || existing?.description || '',
    version: meta.version || existing?.version || '1.0.0',
    author: meta.author || existing?.author || 'Unknown',
    source: source.startsWith('http') ? 'remote' : 'local',
    sourceUrl: source.startsWith('http') ? source : undefined,
    enabled: true,
    instructionsFile: `${id}/SKILL.md`,
    tools: dedupeList(meta.tools),
    resources: dedupeList(meta.resources),
  }
  const next = upsertPersistedSkill(persisted, nextItem)
  await savePersistedSkills(next)
  await refreshSkills(lastWorkspaceForRefresh || undefined)

  const latest = allSkills.find((s) => s.id === id)
  return latest ? { ...latest } : {
    id: nextItem.id,
    name: nextItem.name,
    description: nextItem.description,
    version: nextItem.version,
    author: nextItem.author,
    source: nextItem.source,
    sourceUrl: nextItem.sourceUrl,
    enabled: nextItem.enabled,
    instructions,
  }
}

/* ------------------------------------------------------------------ */
/*  加载流程辅助                                                        */
/* ------------------------------------------------------------------ */

async function ensureDirs() {
  await fs.mkdir(SKILLS_DIR, { recursive: true })
}

async function loadPersistedSkills(): Promise<PersistedSkill[]> {
  try {
    const data = await fs.readFile(SKILLS_JSON, 'utf-8')
    const parsed = JSON.parse(data)
    return Array.isArray(parsed) ? parsed as PersistedSkill[] : []
  } catch {
    return []
  }
}

async function savePersistedSkills(skills: PersistedSkill[]) {
  await ensureDirs()
  await fs.writeFile(SKILLS_JSON, JSON.stringify(skills, null, 2), 'utf-8')
}

function upsertPersistedSkill(items: PersistedSkill[], item: PersistedSkill): PersistedSkill[] {
  const next = [...items]
  const idx = next.findIndex((s) => s.id === item.id)
  if (idx >= 0) next[idx] = item
  else next.push(item)
  return next
}

async function loadSkillInstructionsFromPersisted(skill: PersistedSkill): Promise<string> {
  if (skill.instructionsFile) {
    const p = path.resolve(SKILLS_DIR, skill.instructionsFile)
    try {
      return await fs.readFile(p, 'utf-8')
    } catch {
      // fall through
    }
  }
  return loadSkillInstructions(skill.id)
}

async function loadSkillInstructions(skillId: string): Promise<string> {
  const filePath = path.join(SKILLS_DIR, skillId, 'SKILL.md')
  try {
    return await fs.readFile(filePath, 'utf-8')
  } catch {
    return ''
  }
}

async function saveSkillInstructions(skillId: string, content: string) {
  const dir = path.join(SKILLS_DIR, skillId)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'SKILL.md'), content, 'utf-8')
}

async function installSkillPackageFromLocalRoot(
  skillId: string,
  sourceRoot: string,
  instructions: string,
  declaredResources: string[],
) {
  const targetRoot = path.join(SKILLS_DIR, skillId)
  await fs.rm(targetRoot, { recursive: true, force: true })
  await fs.mkdir(targetRoot, { recursive: true })
  await fs.writeFile(path.join(targetRoot, 'SKILL.md'), instructions, 'utf-8')

  const copyTargets = new Set<string>(DEFAULT_SKILL_RESOURCE_DIRS)
  for (const item of declaredResources) {
    const normalized = normalizeSkillResourcePath(item)
    const topLevel = normalized.split('/').filter(Boolean)[0]
    if (topLevel && topLevel !== 'SKILL.md') copyTargets.add(topLevel)
  }

  for (const entryName of copyTargets) {
    const sourcePath = path.join(sourceRoot, entryName)
    if (!(await fileExists(sourcePath))) continue
    await fs.cp(sourcePath, path.join(targetRoot, entryName), { recursive: true, force: true })
  }
}

async function installSkillPackageFromGitHub(
  skillId: string,
  sourceInfo: GitHubSkillSource,
  instructions: string,
  declaredResources: string[],
) {
  const targetRoot = path.join(SKILLS_DIR, skillId)
  await fs.rm(targetRoot, { recursive: true, force: true })
  await fs.mkdir(targetRoot, { recursive: true })
  await fs.writeFile(path.join(targetRoot, 'SKILL.md'), instructions, 'utf-8')

  const copyTargets = new Set<string>(DEFAULT_SKILL_RESOURCE_DIRS)
  for (const item of declaredResources) {
    const normalized = normalizeSkillResourcePath(item)
    const topLevel = normalized.split('/').filter(Boolean)[0]
    if (topLevel && topLevel !== 'SKILL.md') copyTargets.add(topLevel)
  }

  for (const entryName of copyTargets) {
    const remotePath = joinPosixPath(sourceInfo.skillRootPath, entryName)
    await downloadGitHubPathToLocal(sourceInfo, remotePath, path.join(targetRoot, entryName), true)
  }
}

function resolveWorkspaceSkillDirs(workspace: string): string[] {
  const base = normalizeWorkspace(workspace)
  if (!base) return []
  return [
    path.join(base, '.taco', 'skills'),
    path.join(base, '.openclaw', 'skills'),
  ]
}

async function loadSkillsFromDirs(
  dirs: string[],
  scope: SkillScope,
  persistedById: Map<string, PersistedSkill>,
): Promise<SkillEntry[]> {
  const merged = new Map<string, SkillEntry>()

  for (const dir of dirs) {
    const files = await findSkillFiles(dir)
    for (const filePath of files) {
      let content = ''
      try {
        content = await fs.readFile(filePath, 'utf-8')
      } catch {
        continue
      }
      if (!content.trim()) continue

      const parsed = parseSkillMeta(content)
      const fallbackName = path.basename(path.dirname(filePath))
      const id = toSkillId(parsed.name || fallbackName || `skill-${Date.now()}`)
      const persisted = persistedById.get(id)

      const source = resolveSkillSource(scope, filePath, persisted)
      const enabled = typeof persisted?.enabled === 'boolean'
        ? persisted.enabled
        : (typeof parsed.enabled === 'boolean' ? parsed.enabled : true)

      const skill: SkillInfo = {
        id,
        name: parsed.name || persisted?.name || id,
        description: parsed.description || persisted?.description || '',
        version: parsed.version || persisted?.version || '1.0.0',
        author: parsed.author || persisted?.author || 'Unknown',
        source,
        sourceUrl: source === 'remote' ? persisted?.sourceUrl : undefined,
        enabled,
        instructions: content,
        tools: resolveSkillToolNames(parsed.tools.length > 0 ? parsed.tools : (persisted?.tools ?? [])),
        resources: dedupeList(parsed.resources.length > 0 ? parsed.resources : (persisted?.resources ?? [])),
      }

      merged.set(id, {
        scope,
        skill,
        requires: parsed.requires,
        env: parsed.env,
        rootDir: path.dirname(filePath),
        tools: resolveSkillToolNames(parsed.tools.length > 0 ? parsed.tools : (persisted?.tools ?? [])),
        resources: dedupeList(parsed.resources.length > 0 ? parsed.resources : (persisted?.resources ?? [])),
      })
    }
  }

  return Array.from(merged.values())
}

function resolveSkillSource(scope: SkillScope, filePath: string, persisted?: PersistedSkill): SkillInfo['source'] {
  if (scope === 'workspace') return 'local'
  const normalizedFile = path.resolve(filePath)
  const normalizedBase = path.resolve(SKILLS_DIR)
  if (normalizedFile.startsWith(normalizedBase) && persisted && persisted.source !== 'builtin') {
    return persisted.source
  }
  return 'local'
}

async function findSkillFiles(dir: string): Promise<string[]> {
  try {
    const st = await fs.stat(dir)
    if (!st.isDirectory()) return []
  } catch {
    return []
  }

  const files: string[] = []
  const directFile = path.join(dir, 'SKILL.md')
  if (await fileExists(directFile)) files.push(directFile)

  let entries: Dirent[] = []
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return files
  }

  const sorted = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'zh-CN'))

  for (const name of sorted) {
    const file = path.join(dir, name, 'SKILL.md')
    if (await fileExists(file)) files.push(file)
  }

  return files
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

function sortSkillsForDisplay(entries: SkillEntry[]): SkillEntry[] {
  const score = (entry: SkillEntry): number => {
    if (entry.scope === 'workspace') return 0
    if (entry.scope === 'global') return 1
    return 2
  }
  return [...entries].sort((a, b) => {
    const sa = score(a)
    const sb = score(b)
    if (sa !== sb) return sa - sb
    return a.skill.name.localeCompare(b.skill.name, 'zh-CN')
  })
}

/* ------------------------------------------------------------------ */
/*  需求门控                                                            */
/* ------------------------------------------------------------------ */

async function loadRuntimeConfig(): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(SKILLS_CONFIG_JSON, 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // ignore
  }
  return {}
}

async function resolveUnavailableReason(
  requires: SkillRequires,
  runtimeConfig: Record<string, unknown>,
): Promise<string | null> {
  const missingBins: string[] = []
  const missingEnv: string[] = []
  const missingConfig: string[] = []

  for (const bin of requires.bins) {
    if (!(await hasBinary(bin))) missingBins.push(bin)
  }

  for (const key of requires.env) {
    if (!String(process.env[key] ?? '').trim()) missingEnv.push(key)
  }

  for (const key of requires.config) {
    const value = getConfigValue(runtimeConfig, key)
    if (!isTruthyConfigValue(value)) missingConfig.push(key)
  }

  if (missingBins.length === 0 && missingEnv.length === 0 && missingConfig.length === 0) return null
  return [
    missingBins.length > 0 ? `缺少命令: ${missingBins.join(', ')}` : '',
    missingEnv.length > 0 ? `缺少环境变量: ${missingEnv.join(', ')}` : '',
    missingConfig.length > 0 ? `缺少配置: ${missingConfig.join(', ')}` : '',
  ].filter(Boolean).join(' | ')
}

async function hasBinary(bin: string): Promise<boolean> {
  const key = String(bin ?? '').trim()
  if (!key) return false
  if (binCheckCache.has(key)) return Boolean(binCheckCache.get(key))

  let ok = false
  try {
    if (isPathLikeCommand(key)) {
      await fs.access(key, fsConstants.X_OK)
      ok = true
    } else {
      const cmd = process.platform === 'win32' ? 'where' : 'which'
      await execFile(cmd, [key], { windowsHide: true })
      ok = true
    }
  } catch {
    ok = false
  }
  binCheckCache.set(key, ok)
  return ok
}

function isPathLikeCommand(input: string): boolean {
  return input.includes('/') || input.includes('\\') || path.isAbsolute(input)
}

function getConfigValue(obj: Record<string, unknown>, keyPath: string): unknown {
  const parts = String(keyPath ?? '').split('.').map((s) => s.trim()).filter(Boolean)
  if (parts.length === 0) return undefined
  let current: unknown = obj
  for (const part of parts) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function isTruthyConfigValue(v: unknown): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase()
    return t !== '' && t !== '0' && t !== 'false' && t !== 'off' && t !== 'no'
  }
  return Boolean(v)
}

/* ------------------------------------------------------------------ */
/*  Frontmatter 解析                                                     */
/* ------------------------------------------------------------------ */

function parseSkillMeta(content: string): ParsedSkillMeta {
  const meta: ParsedSkillMeta = {
    requires: { bins: [], env: [], config: [] },
    env: {},
    tools: [],
    resources: [],
  }

  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/)
  if (fmMatch) {
    parseFrontmatterBlock(fmMatch[1], meta)
  }

  if (!meta.name) {
    const titleMatch = content.match(/^#\s+(.+)$/m)
    if (titleMatch) meta.name = titleMatch[1].trim()
  }

  return meta
}

function parseGitHubSkillSource(source: string): GitHubSkillSource | null {
  let url: URL
  try {
    url = new URL(source)
  } catch {
    return null
  }

  const host = url.hostname.toLowerCase()
  const parts = url.pathname.split('/').filter(Boolean)

  if (host === 'raw.githubusercontent.com') {
    if (parts.length < 4) return null
    const [owner, repo, ref, ...rest] = parts
    const remotePath = rest.join('/')
    if (!remotePath) return null
    const skillMdPath = remotePath.endsWith('SKILL.md') ? remotePath : joinPosixPath(remotePath, 'SKILL.md')
    return {
      owner,
      repo,
      ref,
      skillMdPath,
      skillRootPath: dirnamePosix(skillMdPath),
    }
  }

  if (host !== 'github.com') return null
  if (parts.length < 2) return null

  const [owner, repo, mode, ref, ...rest] = parts
  if (!mode) {
    return {
      owner,
      repo,
      ref: 'main',
      skillMdPath: 'SKILL.md',
      skillRootPath: '',
    }
  }

  if ((mode === 'blob' || mode === 'tree') && ref) {
    const remotePath = rest.join('/')
    const skillMdPath = mode === 'blob'
      ? (remotePath.endsWith('SKILL.md') ? remotePath : '')
      : (remotePath ? joinPosixPath(remotePath, 'SKILL.md') : 'SKILL.md')
    if (!skillMdPath) return null
    return {
      owner,
      repo,
      ref,
      skillMdPath,
      skillRootPath: dirnamePosix(skillMdPath),
    }
  }

  return {
    owner,
    repo,
    ref: 'main',
    skillMdPath: 'SKILL.md',
    skillRootPath: '',
  }
}

function parseFrontmatterBlock(block: string, out: ParsedSkillMeta) {
  const lines = block.split(/\r?\n/)

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const indent = leadingSpaces(raw)
    const kv = trimmed.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/)
    if (!kv) continue
    const key = kv[1].toLowerCase()
    const value = kv[2].trim()

    if (key === 'env' && !value) {
      const consumed = consumeIndentedBlock(lines, i + 1, indent)
      mergeEnvMap(out.env, parseKeyValueBlock(consumed.block))
      i = consumed.nextIndex - 1
      continue
    }
    if (key === 'requires' && !value) {
      const consumed = consumeIndentedBlock(lines, i + 1, indent)
      mergeRequires(out.requires, parseRequiresBlock(consumed.block))
      i = consumed.nextIndex - 1
      continue
    }
    if (key === 'tools' && !value) {
      const consumed = consumeIndentedBlock(lines, i + 1, indent)
      out.tools = dedupeList([...out.tools, ...parseListBlock(consumed.block)])
      i = consumed.nextIndex - 1
      continue
    }
    if (key === 'resources' && !value) {
      const consumed = consumeIndentedBlock(lines, i + 1, indent)
      out.resources = dedupeList([...out.resources, ...parseListBlock(consumed.block)])
      i = consumed.nextIndex - 1
      continue
    }

    if (key === 'name') out.name = stripQuotes(value)
    else if (key === 'description') out.description = stripQuotes(value)
    else if (key === 'version') out.version = stripQuotes(value)
    else if (key === 'author') out.author = stripQuotes(value)
    else if (key === 'enabled') out.enabled = parseBoolean(value)
    else if (key === 'requires_bins' || key === 'requires.bin' || key === 'requires.bins') out.requires.bins = dedupeList(parseStringList(value))
    else if (key === 'requires_env' || key === 'requires.environment' || key === 'requires.env') out.requires.env = dedupeList(parseStringList(value))
    else if (key === 'requires_config' || key === 'requires.config') out.requires.config = dedupeList(parseStringList(value))
    else if (key === 'tools' || key === 'allowed_tools' || key === 'tool_names') out.tools = dedupeList([...out.tools, ...parseStringList(value)])
    else if (key === 'resources' || key === 'resource_paths') out.resources = dedupeList([...out.resources, ...parseStringList(value)])
    else if (key.startsWith('env.')) out.env[key.slice(4)] = stripQuotes(value)
    else if (key === 'env_json') mergeEnvMap(out.env, parseInlineMap(value))
  }
}

function consumeIndentedBlock(
  lines: string[],
  startIndex: number,
  parentIndent: number,
): { block: string[]; nextIndex: number } {
  const block: string[] = []
  let i = startIndex
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()
    const indent = leadingSpaces(line)
    if (trimmed && indent <= parentIndent) break
    if (!trimmed) {
      block.push('')
      i++
      continue
    }
    const offset = Math.min(line.length, parentIndent + 2)
    block.push(line.slice(offset))
    i++
  }
  return { block, nextIndex: i }
}

function parseRequiresBlock(lines: string[]): SkillRequires {
  const out: SkillRequires = { bins: [], env: [], config: [] }
  let currentListKey: keyof SkillRequires | null = null
  for (const raw of lines) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    const listItem = trimmed.match(/^-\s*(.+)$/)
    if (listItem && currentListKey) {
      const value = stripQuotes(listItem[1].trim())
      if (value) out[currentListKey] = dedupeList([...out[currentListKey], value])
      continue
    }
    const kv = trimmed.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/)
    if (!kv) {
      currentListKey = null
      continue
    }
    const key = kv[1].toLowerCase()
    const value = kv[2].trim()
    const normalizedKey: keyof SkillRequires | null =
      key === 'bins' || key === 'bin'
        ? 'bins'
        : (key === 'env' || key === 'environment'
            ? 'env'
            : (key === 'config' ? 'config' : null))
    if (!normalizedKey) {
      currentListKey = null
      continue
    }
    if (value) out[normalizedKey] = dedupeList(parseStringList(value))
    currentListKey = normalizedKey
  }
  return out
}

function parseKeyValueBlock(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of lines) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    const kv = trimmed.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/)
    if (!kv) continue
    out[kv[1]] = stripQuotes(kv[2].trim())
  }
  return out
}

function parseListBlock(lines: string[]): string[] {
  const out: string[] = []
  for (const raw of lines) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    const listItem = trimmed.match(/^-\s*(.+)$/)
    if (listItem) {
      const value = stripQuotes(listItem[1].trim())
      if (value) out.push(value)
      continue
    }
    const kv = trimmed.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/)
    if (!kv) continue
    const inlineValues = parseStringList(kv[2].trim())
    for (const value of inlineValues) out.push(value)
  }
  return dedupeList(out)
}

function parseInlineMap(raw: string): Record<string, string> {
  const text = String(raw ?? '').trim()
  if (!text) return {}
  if (text.startsWith('{') && text.endsWith('}')) {
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const out: Record<string, string> = {}
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          out[k] = String(v ?? '')
        }
        return out
      }
    } catch {
      // ignore
    }
  }
  const out: Record<string, string> = {}
  for (const pair of text.split(',')) {
    const [k, ...rest] = pair.split('=')
    const key = String(k ?? '').trim()
    if (!key) continue
    out[key] = stripQuotes(rest.join('=').trim())
  }
  return out
}

function mergeRequires(base: SkillRequires, next: SkillRequires) {
  base.bins = dedupeList([...base.bins, ...next.bins])
  base.env = dedupeList([...base.env, ...next.env])
  base.config = dedupeList([...base.config, ...next.config])
}

function mergeEnvMap(base: Record<string, string>, next: Record<string, string>) {
  for (const [k, v] of Object.entries(next)) {
    const key = String(k ?? '').trim()
    if (!key) continue
    base[key] = String(v ?? '')
  }
}

function parseStringList(raw: string): string[] {
  const text = String(raw ?? '').trim()
  if (!text) return []
  let body = text
  if ((body.startsWith('[') && body.endsWith(']')) || (body.startsWith('(') && body.endsWith(')'))) {
    body = body.slice(1, -1)
  }
  const parts = body.includes(',') ? body.split(',') : body.split(/\s+/)
  return dedupeList(parts.map((s) => stripQuotes(s.trim())).filter(Boolean))
}

function dedupeList(items: string[]): string[] {
  const out: string[] = []
  for (const item of items) {
    const val = String(item ?? '').trim()
    if (!val || out.includes(val)) continue
    out.push(val)
  }
  return out
}

function buildSkillSummary(skill: SkillInfo): string {
  const description = String(skill.description ?? '').replace(/\s+/g, ' ').trim()
  if (description) return description
  const firstLine = String(skill.instructions ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean)
  return firstLine || skill.id
}

function normalizeSkillResourcePath(input: string): string {
  const normalized = String(input ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
  return normalized
}

function isSkillResourceAllowed(relativePath: string, declared: string[]): boolean {
  const normalized = normalizeSkillResourcePath(relativePath)
  if (!normalized || normalized.includes('..')) return false
  const prefixes = new Set<string>(DEFAULT_SKILL_RESOURCE_DIRS.map((item) => `${item}/`))
  for (const item of dedupeList(declared)) {
    const normalizedItem = normalizeSkillResourcePath(item).replace(/\*+$/, '')
    if (!normalizedItem) continue
    prefixes.add(normalizedItem.endsWith('/') ? normalizedItem : `${normalizedItem}${normalizedItem.includes('.') ? '' : '/'}`)
  }
  for (const prefix of prefixes) {
    if (normalized === prefix.replace(/\/$/, '') || normalized.startsWith(prefix)) return true
  }
  return false
}

function resolveSkillToolNames(rawTools: string[]): string[] {
  const out: string[] = []
  for (const item of rawTools) {
    const normalized = String(item ?? '').trim().toLowerCase()
    if (!normalized) continue
    if (SKILL_TOOL_GROUPS[normalized]) {
      for (const toolName of SKILL_TOOL_GROUPS[normalized]) {
        if (!out.includes(toolName)) out.push(toolName)
      }
      continue
    }
    const canonical = normalized === 'list_directory' ? 'list_dir' : normalized
    if (!out.includes(canonical)) out.push(canonical)
  }
  return out
}

function joinPosixPath(...parts: string[]): string {
  return parts
    .map((part) => String(part ?? '').replace(/\\/g, '/'))
    .filter(Boolean)
    .join('/')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '')
}

function dirnamePosix(filePath: string): string {
  const normalized = String(filePath ?? '').replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index >= 0 ? normalized.slice(0, index) : ''
}

function getGitHubAuthHeaders(): Record<string, string> {
  const token = String(process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '').trim()
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'taco-ai-agent',
  }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

function buildGitHubContentsApiUrl(sourceInfo: GitHubSkillSource, remotePath: string): string {
  const encodedPath = remotePath
    .split('/')
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/')
  const base = `https://api.github.com/repos/${sourceInfo.owner}/${sourceInfo.repo}/contents`
  const pathPart = encodedPath ? `/${encodedPath}` : ''
  return `${base}${pathPart}?ref=${encodeURIComponent(sourceInfo.ref)}`
}

async function fetchGitHubContents(
  sourceInfo: GitHubSkillSource,
  remotePath: string,
): Promise<{ ok: true; payload: unknown } | { ok: false; status: number; statusText: string }> {
  const resp = await fetch(buildGitHubContentsApiUrl(sourceInfo, remotePath), {
    headers: getGitHubAuthHeaders(),
  })
  if (!resp.ok) {
    return { ok: false, status: resp.status, statusText: resp.statusText }
  }
  return { ok: true, payload: await resp.json() }
}

async function downloadGitHubTextFile(sourceInfo: GitHubSkillSource, remotePath: string): Promise<string> {
  const result = await fetchGitHubContents(sourceInfo, remotePath)
  if (!result.ok) {
    throw new Error(`Failed to fetch GitHub skill file: ${result.status} ${result.statusText}`)
  }
  const payload = result.payload as Record<string, unknown>
  if (payload.type !== 'file') {
    throw new Error(`GitHub path is not a file: ${remotePath}`)
  }
  return (await readGitHubFileBuffer(payload)).toString('utf-8')
}

async function downloadGitHubPathToLocal(
  sourceInfo: GitHubSkillSource,
  remotePath: string,
  targetPath: string,
  optional = false,
): Promise<boolean> {
  const result = await fetchGitHubContents(sourceInfo, remotePath)
  if (!result.ok) {
    if (optional && result.status === 404) return false
    throw new Error(`Failed to fetch GitHub skill resource: ${remotePath} (${result.status} ${result.statusText})`)
  }

  const payload = result.payload
  if (Array.isArray(payload)) {
    await fs.mkdir(targetPath, { recursive: true })
    for (const entry of payload) {
      const item = entry as Record<string, unknown>
      const childPath = String(item.path ?? '').trim()
      const childName = String(item.name ?? '').trim()
      const childType = String(item.type ?? '').trim()
      if (!childPath || !childName || !childType || childType === 'symlink' || childType === 'submodule') continue
      await downloadGitHubPathToLocal(sourceInfo, childPath, path.join(targetPath, childName), false)
    }
    return true
  }

  const item = payload as Record<string, unknown>
  if (item.type !== 'file') {
    if (optional) return false
    throw new Error(`Unsupported GitHub skill resource type at ${remotePath}: ${String(item.type ?? 'unknown')}`)
  }
  await fs.mkdir(path.dirname(targetPath), { recursive: true })
  await fs.writeFile(targetPath, await readGitHubFileBuffer(item))
  return true
}

async function readGitHubFileBuffer(payload: Record<string, unknown>): Promise<Buffer> {
  const content = payload.content
  const encoding = String(payload.encoding ?? '').trim()
  if (typeof content === 'string' && encoding === 'base64') {
    return Buffer.from(content.replace(/\n/g, ''), 'base64')
  }
  const downloadUrl = String(payload.download_url ?? '').trim()
  if (downloadUrl) {
    const resp = await fetch(downloadUrl, {
      headers: getGitHubAuthHeaders(),
    })
    if (!resp.ok) {
      throw new Error(`Failed to download GitHub file: ${resp.status} ${resp.statusText}`)
    }
    return Buffer.from(await resp.arrayBuffer())
  }
  throw new Error('GitHub file payload does not contain readable content')
}

function parseBoolean(raw: string): boolean | undefined {
  const text = String(raw ?? '').trim().toLowerCase()
  if (text === 'true' || text === 'yes' || text === 'on' || text === '1') return true
  if (text === 'false' || text === 'no' || text === 'off' || text === '0') return false
  return undefined
}

function stripQuotes(input: string): string {
  const text = String(input ?? '').trim()
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith('\'') && text.endsWith('\''))) {
    return text.slice(1, -1)
  }
  return text
}

function leadingSpaces(line: string): number {
  const m = line.match(/^\s*/)
  return m ? m[0].length : 0
}

function toSkillId(input: string): string {
  const slug = String(input ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || `skill-${Date.now()}`
}

/* ------------------------------------------------------------------ */
/*  安全审核                                                            */
/* ------------------------------------------------------------------ */

type SkillSecurityCheck = {
  safe: boolean
  warnings: string[]
  riskLevel: 'low' | 'medium' | 'high' | 'critical'
}

/**
 * 安全审核 Skill 内容
 * 
 * 检测潜在的危险操作:
 * - 执行任意命令
 * - 删除文件/目录
 * - 修改系统配置
 * - 网络请求
 * - 敏感文件访问
 */
function auditSkillSecurity(instructions: string, meta: ParsedSkillMeta): SkillSecurityCheck {
  const warnings: string[] = []
  let riskScore = 0

  const text = instructions.toLowerCase()
  const combinedTools = [...meta.tools, ...meta.requires.bins].map(t => t.toLowerCase())

  // 1. 检查危险命令执行
  const dangerousCommands = [
    { pattern: /rm\s+-rf|rm\s+-f|rmdir\s+\/s|del\s+\/f/g, weight: 10, msg: '包含强制删除命令' },
    { pattern: /chmod\s+[0-7]{3,4}|chown|icacls/g, weight: 8, msg: '包含权限修改命令' },
    { pattern: /sudo\s+|runas\s+/g, weight: 9, msg: '包含提权操作' },
    { pattern: /mkfs|fdisk|diskpart|format\s+/g, weight: 10, msg: '包含磁盘格式化命令' },
    { pattern: /curl\s.*\|.*sh|wget.*\|.*bash/g, weight: 10, msg: '包含管道执行网络脚本' },
    { pattern: /eval\s*\(|exec\s*\(/g, weight: 9, msg: '包含动态代码执行' },
  ]

  for (const { pattern, weight, msg } of dangerousCommands) {
    if (pattern.test(text)) {
      warnings.push(msg)
      riskScore += weight
    }
  }

  // 2. 检查危险工具使用
  const dangerousTools = {
    run_command: 5,
    delete_file: 6,
    write_file: 4,
    edit_file: 3,
  }

  for (const [tool, weight] of Object.entries(dangerousTools)) {
    if (combinedTools.includes(tool.toLowerCase())) {
      warnings.push(`使用了高危工具: ${tool}`)
      riskScore += weight
    }
  }

  // 3. 检查敏感文件路径访问
  const sensitivePaths = [
    { pattern: /\/etc\/passwd|\/etc\/shadow/g, weight: 8, msg: '尝试访问系统敏感文件' },
    { pattern: /\.ssh\/|\.gitconfig|\.npmrc|\.pypirc/g, weight: 7, msg: '尝试访问凭证文件' },
    { pattern: /\/root\/|\/home\/[^/]+\/Documents/g, weight: 6, msg: '尝试访问用户私有目录' },
    { pattern: /node_modules\/.*\.env|\.env\.local/g, weight: 7, msg: '尝试访问环境变量文件' },
  ]

  for (const { pattern, weight, msg } of sensitivePaths) {
    if (pattern.test(text)) {
      warnings.push(msg)
      riskScore += weight
    }
  }

  // 4. 检查网络请求
  const networkPatterns = [
    { pattern: /https?:\/\/[^\s]+/g, weight: 2, msg: '包含外部网络请求' },
    { pattern: /fetch\s*\(|axios\s*\(|request\s*\(/g, weight: 4, msg: '包含 HTTP 请求调用' },
  ]

  for (const { pattern, weight, msg } of networkPatterns) {
    if (pattern.test(text)) {
      warnings.push(msg)
      riskScore += weight
    }
  }

  // 5. 检查环境变量注入
  if (Object.keys(meta.env).length > 5) {
    warnings.push(`注入大量环境变量 (${Object.keys(meta.env).length} 个)`)
    riskScore += 3
  }

  for (const [key, value] of Object.entries(meta.env)) {
    if (key.toLowerCase().includes('token') || key.toLowerCase().includes('secret') || key.toLowerCase().includes('key')) {
      warnings.push(`注入敏感环境变量: ${key}`)
      riskScore += 5
    }
    if (value.includes('$(') || value.includes('`')) {
      warnings.push(`环境变量包含命令替换: ${key}`)
      riskScore += 6
    }
  }

  // 确定风险等级
  let riskLevel: 'low' | 'medium' | 'high' | 'critical'
  if (riskScore >= 15) {
    riskLevel = 'critical'
  } else if (riskScore >= 10) {
    riskLevel = 'high'
  } else if (riskScore >= 5) {
    riskLevel = 'medium'
  } else {
    riskLevel = 'low'
  }

  const safe = riskLevel !== 'critical' && riskLevel !== 'high'

  return {
    safe,
    warnings,
    riskLevel,
  }
}

/* ------------------------------------------------------------------ */
/*  其他                                                                */
/* ------------------------------------------------------------------ */

function normalizeWorkspace(workspace?: string): string {
  const raw = String(workspace ?? '').trim()
  if (!raw) return ''
  return path.resolve(raw)
}

function interpolateEnv(value: string): string {
  return String(value ?? '').replace(/\$\{([A-Za-z_]\w*)\}/g, (_, name: string) => {
    return process.env[name] ?? ''
  })
}

function toRawGitHubUrl(url: string): string {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/(?:blob\/)?(.+)/)
  if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`
  return url
}

export function debugDumpSkillsState() {
  log('SKILLS_STATE', {
    total: allSkills.length,
    activeCount: activeSkillInstructions.length,
    activeEnvKeys: Object.keys(activeSkillEnv),
    workspace: lastWorkspaceForRefresh || null,
    ids: allSkills.map((s) => s.id),
  })
}
