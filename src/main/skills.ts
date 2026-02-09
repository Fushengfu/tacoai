/**
 * Skills 管理器
 *
 * 管理 Agent 的 skills（能力插件），支持：
 * - 内置 skills（随应用分发）
 * - 本地安装（从文件路径读取 SKILL.md）
 * - 远程安装（从 GitHub 仓库 URL 拉取 SKILL.md）
 *
 * 持久化：已安装 skills 列表保存在 ~/.taco/skills.json
 * Skill 内容：~/.taco/skills/<id>/SKILL.md
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { app } from 'electron'
import type { SkillInfo } from '../shared/ipc'

/* ------------------------------------------------------------------ */
/*  路径常量                                                            */
/* ------------------------------------------------------------------ */

const TACO_DIR = path.join(app.getPath('home'), '.taco')
const SKILLS_DIR = path.join(TACO_DIR, 'skills')
const SKILLS_JSON = path.join(TACO_DIR, 'skills.json')

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
    description: '操控内嵌浏览器执行自动化操作：页面导航、元素点击、表单填写、内容提取、UI 验证等',
    version: '1.0.0',
    author: 'Taco',
    source: 'builtin',
    enabled: true,
    instructions: `# Skill: 浏览器自动化

你可以通过浏览器自动化工具操控内嵌浏览器，执行以下类型的任务：

## 适用场景
- **前端开发验证**: 打开本地开发服务器（如 http://localhost:3000），验证 UI 显示效果
- **自动化测试**: 模拟用户操作流程（登录、填写表单、点击按钮），验证功能正确性
- **网页数据提取**: 打开网页，提取页面内容和数据
- **UI 问题排查**: 截图分析页面布局、样式问题

## 操作流程模式
典型的浏览器操作应遵循"观察-操作-验证"的循环：

1. **browser_navigate** → 打开目标页面
2. **browser_screenshot** → 观察当前页面状态，了解可用的交互元素
3. **browser_click / browser_type** → 执行具体操作
4. **browser_screenshot** → 验证操作结果
5. 重复步骤 3-4 直到完成

## 关键注意事项
- 每次操作之前都应先 screenshot 了解页面状态
- CSS 选择器应尽量使用稳定的标识（id、name、data-testid）
- 页面跳转或异步加载后使用 browser_wait 等待关键元素
- 遇到错误时先截图分析再重试，不要盲目重复操作
- 表单填写时注意使用 clear: true 清空后再输入
- 对于需要登录的页面，先完成登录流程再进行后续操作`,
  },
]

/* ------------------------------------------------------------------ */
/*  持久化                                                              */
/* ------------------------------------------------------------------ */

type PersistedSkill = Omit<SkillInfo, 'instructions'> & { instructionsFile?: string }

async function ensureDirs() {
  await fs.mkdir(SKILLS_DIR, { recursive: true })
}

/** 从 JSON 文件读取已安装的 skills 配置 */
async function loadPersistedSkills(): Promise<PersistedSkill[]> {
  try {
    const data = await fs.readFile(SKILLS_JSON, 'utf-8')
    return JSON.parse(data)
  } catch {
    return []
  }
}

/** 保存 skills 配置到 JSON 文件 */
async function savePersistedSkills(skills: PersistedSkill[]) {
  await ensureDirs()
  await fs.writeFile(SKILLS_JSON, JSON.stringify(skills, null, 2), 'utf-8')
}

/** 读取 skill 的 instructions 内容 */
async function loadSkillInstructions(skillId: string): Promise<string> {
  const filePath = path.join(SKILLS_DIR, skillId, 'SKILL.md')
  try {
    return await fs.readFile(filePath, 'utf-8')
  } catch {
    return ''
  }
}

/** 保存 skill 的 instructions 内容 */
async function saveSkillInstructions(skillId: string, content: string) {
  const dir = path.join(SKILLS_DIR, skillId)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'SKILL.md'), content, 'utf-8')
}

/* ------------------------------------------------------------------ */
/*  核心管理                                                            */
/* ------------------------------------------------------------------ */

/** 内存中的完整 skills 列表 */
let allSkills: SkillInfo[] = []

/** 初始化：合并内置 + 已安装的 skills */
export async function initSkills() {
  await ensureDirs()
  const persisted = await loadPersistedSkills()

  // 先加载内置 skills，应用持久化的 enabled 状态
  const result: SkillInfo[] = BUILTIN_SKILLS.map((builtin) => {
    const saved = persisted.find((p) => p.id === builtin.id)
    return { ...builtin, enabled: saved ? saved.enabled : builtin.enabled }
  })

  // 加载用户安装的 skills
  for (const p of persisted) {
    if (p.source === 'builtin') continue // 内置的已处理
    const instructions = await loadSkillInstructions(p.id)
    result.push({ ...p, instructions })
  }

  allSkills = result
}

/** 获取所有 skills */
export function listSkills(): SkillInfo[] {
  return allSkills.map((s) => ({ ...s }))
}

/** 获取所有启用的 skills 的 instructions（用于注入 system prompt） */
export function getActiveSkillInstructions(): string[] {
  return allSkills
    .filter((s) => s.enabled && s.instructions.trim())
    .map((s) => s.instructions)
}

/** 启用/禁用 skill */
export async function toggleSkill(id: string, enabled: boolean) {
  const skill = allSkills.find((s) => s.id === id)
  if (!skill) throw new Error(`Skill not found: ${id}`)
  skill.enabled = enabled
  await persistAll()
}

/** 卸载 skill（仅非内置） */
export async function uninstallSkill(id: string) {
  const idx = allSkills.findIndex((s) => s.id === id)
  if (idx === -1) throw new Error(`Skill not found: ${id}`)
  if (allSkills[idx].source === 'builtin') throw new Error('Cannot uninstall builtin skill')

  allSkills.splice(idx, 1)
  // 删除文件
  const dir = path.join(SKILLS_DIR, id)
  try { await fs.rm(dir, { recursive: true }) } catch { /* ignore */ }
  await persistAll()
}

/** 安装 skill（从 URL 或本地路径） */
export async function installSkill(source: string): Promise<SkillInfo> {
  let instructions: string
  let meta: { name?: string; description?: string; version?: string; author?: string } = {}

  if (source.startsWith('http://') || source.startsWith('https://')) {
    // 远程安装：从 GitHub URL 下载 SKILL.md
    const rawUrl = toRawGitHubUrl(source)
    const resp = await fetch(rawUrl)
    if (!resp.ok) throw new Error(`Failed to fetch skill: ${resp.status} ${resp.statusText}`)
    instructions = await resp.text()
    meta = parseSkillMeta(instructions)
  } else {
    // 本地安装：从文件路径读取
    const filePath = source.endsWith('SKILL.md') ? source : path.join(source, 'SKILL.md')
    try {
      instructions = await fs.readFile(filePath, 'utf-8')
      meta = parseSkillMeta(instructions)
    } catch {
      throw new Error(`Cannot read skill file: ${filePath}`)
    }
  }

  // 生成 ID
  const id = meta.name
    ? meta.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    : `skill-${Date.now()}`

  // 检查是否已安装
  if (allSkills.some((s) => s.id === id)) {
    // 更新已有的
    const existing = allSkills.find((s) => s.id === id)!
    existing.instructions = instructions
    existing.version = meta.version || existing.version
    existing.description = meta.description || existing.description
    await saveSkillInstructions(id, instructions)
    await persistAll()
    return { ...existing }
  }

  const skill: SkillInfo = {
    id,
    name: meta.name || id,
    description: meta.description || '',
    version: meta.version || '1.0.0',
    author: meta.author || 'Unknown',
    source: source.startsWith('http') ? 'remote' : 'local',
    sourceUrl: source.startsWith('http') ? source : undefined,
    enabled: true,
    instructions,
  }

  allSkills.push(skill)
  await saveSkillInstructions(id, instructions)
  await persistAll()

  return { ...skill }
}

/* ------------------------------------------------------------------ */
/*  辅助函数                                                            */
/* ------------------------------------------------------------------ */

/** 持久化所有 skills 到 JSON */
async function persistAll() {
  const data: PersistedSkill[] = allSkills.map((s) => {
    const { instructions: _, ...rest } = s
    return { ...rest, instructionsFile: `${s.id}/SKILL.md` }
  })
  await savePersistedSkills(data)
}

/** 将 GitHub URL 转为 raw 内容 URL */
function toRawGitHubUrl(url: string): string {
  // https://github.com/user/repo/blob/main/path/SKILL.md
  // → https://raw.githubusercontent.com/user/repo/main/path/SKILL.md
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/(?:blob\/)?(.+)/)
  if (m) {
    return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`
  }
  // 如果已经是 raw URL 或其他格式，直接返回
  return url
}

/** 从 SKILL.md 内容解析元数据（简单的 frontmatter 或首行标题） */
function parseSkillMeta(content: string): { name?: string; description?: string; version?: string; author?: string } {
  const meta: Record<string, string> = {}

  // 尝试 YAML frontmatter
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (fmMatch) {
    for (const line of fmMatch[1].split('\n')) {
      const kv = line.match(/^(\w+)\s*:\s*(.+)/)
      if (kv) meta[kv[1].toLowerCase()] = kv[2].trim()
    }
  }

  // 没有 frontmatter 时，从首行 # 标题取名称
  if (!meta.name) {
    const titleMatch = content.match(/^#\s+(.+)/m)
    if (titleMatch) meta.name = titleMatch[1].trim()
  }

  return meta
}
