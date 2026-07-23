import type { SkillInfo } from '../types'

export const BUILTIN_SKILLS: SkillInfo[] = [
  {
    id: 'code-review',
    name: '代码审查',
    description: '代码修改后自动检查潜在问题，提供代码审查建议。触发场景：修改代码文件后自动执行检查（无需用户主动要求）',
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
    description: `修改代码后自动运行相关测试并报告结果。

【触发场景】以下任一情况，自动触发此技能：
- 修改了代码文件（.ts/.tsx/.js/.py/.go/.rs 等）后，自动查找并运行相关测试
- 用户要求"跑测试"、"运行测试"、"test"时，使用 run_command 执行测试命令`,
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
    description: `遵循 Git 最佳实践，自动生成规范的 commit message。

【触发场景】以下任一情况，自动触发此技能：
- 执行 git commit 时，自动使用 Conventional Commits 格式生成 commit message
- 执行 git push 前提醒用户确认
- 用户提到"提交"、"commit"、"推送"、"push"时，遵循原子性提交原则`,
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
    id: 'browser-use',
    name: '浏览器使用',
    description: `操控 Taco 内置浏览器面板执行自动化操作：页面导航、元素点击、表单填写、内容提取、UI 验证。

【触发场景】以下任一情况，可查看此技能手册：
- 用户要求打开/访问/查看某个网页、URL 或网站
- 用户要求查看本地前端页面（localhost、127.0.0.1 等）
- 用户要求截取网页、验证网页显示效果
- 用户要求在网页上执行操作（点击、填表、登录、搜索）
- 用户提到"前端页面"、"网页"、"网站"、"URL"、"浏览器"
- 用户要求从网页提取数据或内容`,
    version: '1.0.0',
    author: 'Taco',
    source: 'builtin',
    enabled: true,
    tools: [],
    instructions: `# Skill: 浏览器使用

你可以通过 run_skill_script 工具操控 Taco 内置浏览器面板，执行以下类型的任务。

## 多浏览器窗口管理
Taco 支持同一个项目内同时打开多个独立浏览器窗口，每个窗口有独立的会话（cookie / localStorage / sessionStorage 隔离）。不同项目的浏览器窗口完全隔离，无法互相访问。

- **appId**（可选）：窗口短标识，如 \`"admin"\`、\`"shop"\`。不传则使用项目默认窗口。AI 只需传短名，系统自动限定在当前项目下，不同项目的浏览器完全隔离。
- **windowLabel**（可选）：备注标签，仅在 list 时用于辨认窗口用途。不参与窗口定位。

使用场景：多端后台管理（平台端 + 客户端）、多账号登录、多环境对比测试。

## 适用场景
- **前端开发验证**: 打开本地开发服务器（如 http://localhost:3000），验证 UI 显示效果
- **自动化测试**: 模拟用户操作流程（登录、填写表单、点击按钮），验证功能正确性
- **多端管理**: 同时打开多个独立会话的浏览器窗口，各自维护登录态
- **网页数据提取**: 打开网页，提取页面内容和数据
- **UI 问题排查**: 截图分析页面布局、样式问题
- **网站逆向/复刻**: 分析目标网站的 HTML/CSS/JS 结构、网络请求、组件实现，用于复刻或还原网站

## 分析方式选择
根据任务目标选择合适的分析方式，不要默认只用截图：

| 目标 | 推荐方式 | 说明 |
|------|------|------|
| 验证 UI 显示效果 | 截图 + analyze_image | 视觉确认布局、样式是否正确 |
| 复刻/还原网站结构 | 代码读取分析 | 用 evaluate 提取 DOM 树、CSS 规则、组件结构，效率远高于截图 |
| 分析网络请求/接口 | get_network_requests | 拦截 XHR/fetch，查看请求/响应详情 |
| 提取文本/数据内容 | get_content / evaluate | 直接读取 DOM 内容，无需截图 |
| 排查 JS 错误 | get_console_logs | 查看控制台报错和警告 |
| 读/写/清除 Cookie | get_cookies / set_cookie / clear_cookies | 管理浏览器 Cookie（含 HttpOnly） |
| 识别页面文字坐标 | ocr | 截取当前页面后用 OCR 识别所有文字及其精确像素坐标 |

**原则**: 截图适合"看一眼"验证，代码分析适合"逆向理解"。复刻网站时优先用 evaluate 提取 HTML 结构、CSS 样式、JS 逻辑，再配合 get_network_requests 分析接口，最后才用截图确认视觉效果。

## 操作流程模式
典型的浏览器操作应遵循"目标-操作-验证"的循环：

1. 执行 list 查看当前已打开的浏览器窗口
2. 执行 navigate 打开目标页面，必要时指定 appId 和 windowLabel
3. 执行 get_console_logs / get_info 确认页面状态与错误信息
4. 执行 screenshot 截图，仅在需要视觉确认时使用（必须有明确目标）
5. 执行 click / type 进行具体操作（指定 appId 定位到目标窗口）
6. 使用 analyze_image 分析截图验证操作结果，或执行 get_content 提取内容
7. 重复步骤 4-6 直到完成
8. 不再需要的窗口执行 close 关闭释放资源

## 关键注意事项
- 多窗口操作时始终通过 appId 准确定位目标窗口
- 截图前必须明确目的（例如"验证按钮是否出现"），禁止无目的连续截图
- CSS 选择器应尽量使用稳定的标识（id、name、data-testid）
- 页面跳转或异步加载后使用 wait 等待关键元素
- 遇到错误时优先执行 get_console_logs，再决定是否截图
- 表单填写时注意使用 clear: true 清空后再输入
- 对于需要登录的页面，先完成登录流程再进行后续操作
- 截图后如需分析截图内容，使用 analyze_image 工具，image 参数传 cloudUrl，goal 参数描述分析目的

## 脚本速查
所有脚本通过 run_skill_script('browser-use', '脚本名', {参数}) 执行。

- **list**: 列出当前项目的所有活跃浏览器窗口（含 appId 短名、windowLabel、URL、标题）。参数: {}
- **close**: 关闭当前项目的指定浏览器窗口。参数: { appId: string }（短名，如 "admin"；传 "default" 关闭默认窗口）
- **navigate**: 打开指定 URL。参数: { url: string, appId?: string, windowLabel?: string }
- **screenshot**: 获取页面截图。参数: { appId?: string, goal?: string }
- **click**: 点击页面元素。参数: { selector: string, appId?: string, x?: number, y?: number }
- **type**: 向输入元素输入文本。参数: { selector: string, text: string, appId?: string, clear?: boolean }
- **scroll**: 滚动页面。参数: { direction: 'up'|'down'|'left'|'right', appId?: string, amount?: number, selector?: string }
- **get_content**: 读取页面内容。参数: { selector?: string, appId?: string, includeHtml?: boolean }
- **wait**: 等待元素出现。参数: { selector: string, appId?: string, timeout?: number }
- **evaluate**: 执行 JS 表达式。参数: { code: string, appId?: string }
- **get_info**: 获取页面基础信息（URL/标题/视口）。参数: { appId?: string }
- **get_console_logs**: 读取控制台日志；排查错误时优先使用。参数: { appId?: string, limit?: number, onlyErrors?: boolean }
- **get_network_requests**: 获取网络请求列表（URL、method、状态码、请求/响应头）。首次调用自动启用 CDP Network 域监听，返回最近 N 条请求。参数: { appId?: string, limit?: number }
- **get_cookies**: 读取当前页面所有 Cookie（含 HttpOnly）。参数: { appId?: string, urls?: string[] }
- **set_cookie**: 设置 Cookie。参数: { appId?: string, name: string, value: string, url?: string, domain?: string, path?: string, secure?: boolean, httpOnly?: boolean, sameSite?: string, expires?: number }
- **clear_cookies**: 清除浏览器所有 Cookie。参数: { appId?: string }
- **ocr**: OCR 文字识别，截取当前浏览器页面后识别所有文字及其精确像素坐标。参数: { appId?: string }。返回 words[{text, bbox:{x0,y0,x1,y1}, confidence}]，每个 bbox 中心点即精确点击坐标
- **hover**: 鼠标悬停。参数: { selector: string, appId?: string, x?: number, y?: number }
- **keypress**: 按键操作。参数: { appId?: string, key: string, modifiers?: string[] }
- **drag**: 拖拽元素。参数: { from: {selector} or {x,y}, to: {selector} or {x,y}, appId?: string }
- **select**: 操作下拉框。参数: { selector: string, appId?: string, value?: string, label?: string }`,
  },
  {
    id: 'computer-use',
    name: '电脑使用',
    description: `执行电脑使用操作：屏幕截图、界面识别、鼠标点击、键盘输入、窗口交互。

【核心原则】桌面操作必须先截图识别再行动，禁止不截图直接盲操作（你不知道屏幕当前状态）。

【触发场景】以下任一情况，可查看此技能手册：
- 用户要求截取桌面屏幕、查看桌面内容
- 用户要求点击/操作桌面应用程序界面或系统 UI
- 用户提到"桌面"、"屏幕"、"窗口"、"菜单栏"、"系统托盘"、"Dock"、"任务栏"
- 用户要求执行桌面级键盘快捷键或鼠标操作
- 用户要求操作系统设置、文件管理器等桌面应用`,
    version: '1.0.0',
    author: 'Taco',
    source: 'builtin',
    enabled: true,
    tools: [],
    instructions: `# Skill: 电脑使用

你可以通过 run_skill_script 工具操控系统界面。

## 核心铁律：必须先截图，禁止盲操作

桌面环境没有 DOM 选择器、没有元素树、没有坐标参考系。你不知道屏幕上有什么、窗口是否切换、界面是否变化。不截图就操作等于蒙着眼睛点鼠标，99% 会点错位置。

**即使你认为你知道坐标，也必须先截图确认。** 窗口位置可能变了、分辨率可能不同、系统可能有弹窗遮挡。

## 强制操作流程

每次桌面操作必须严格遵循以下循环，不得跳过任何步骤：

1. 执行 screenshot 截取当前屏幕（第一步就必须截图，不截图不知道屏幕状态）
2. 根据目标类型选择分析方式：
   - **目标带文字**（按钮、菜单项、标签页等）→ 优先用 ocr 识别，返回精确文字+坐标，无需视觉模型猜位置
   - **纯图标/图片** → 使用 analyze_image 视觉模型分析截图
3. 执行 action 根据分析结果进行点击、双击、输入、快捷键等操作
4. 执行 screenshot 再次截图，确认操作结果是否符合预期
5. 如果结果不符，从步骤 2 重新开始

## 何时可以跳过截图

只有以下情况可以不截图直接执行：
- 全局快捷键（如 Cmd+Tab、Cmd+Space）：不受屏幕状态影响
- 用户明确说"按 Cmd+S 保存"之类的全局组合键

任何涉及鼠标点击或坐标的操作，一律必须先截图。

## 关键注意事项
- 用户说"点击保存按钮"→ 你不知道按钮在哪，必须截图找
- 用户说"输入 xxx"→ 你不知道光标在哪，必须先截图确认焦点
- analyze_image 的 image 参数传 cloudUrl（https 链接），视觉模型只支持 data: URL 和 https: 链接，不支持本地文件路径
- 操作完成后必须截图验证，禁止只说"已执行"

## 脚本速查
所有脚本通过 run_skill_script('computer-use', '脚本名', {参数}) 执行。

- **screenshot**: 截取当前桌面屏幕。返回 cloudUrl 与尺寸信息
- **ocr**: OCR 文字识别，识别截图中所有文字及其精确像素坐标。参数: { image?: string }（cloudUrl/dataUrl，不传则自动截屏）。返回 words[{text, bbox:{x0,y0,x1,y1}, confidence}]，每个 bbox 中心点即精确点击坐标。文字类 UI 元素优先用此脚本定位
- **action**: 执行桌面动作。参数: { action: 'click'|'doubleClick'|'type'|'key'|'scroll'|... }, 以及对应的 x/y/text/key/direction 等`,
  },
  {
    id: 'skill-creator',
    name: '技能创建器',
    description: '引导用户通过对话创建新的 Taco 技能。触发场景：用户想要创建、制作、新增一个技能（Skill），或提到"技能创建"、"创建一个技能"、"写个skill"、"制作技能"等。',
    version: '1.0.0',
    author: 'Taco',
    source: 'builtin',
    enabled: true,
    tools: ['write_file', 'read_file', 'install_skill'],
    instructions: `# Skill: 技能创建器

你可以帮助用户通过对话创建新的 Taco 技能。技能是扩展 AI 能力的指令集，创建后会自动注入到每次对话的 system prompt 中。

## 技能文件结构

每个技能是一个 SKILL.md 文件，存放在系统主目录下的 \`.taco/skills/{技能ID}/SKILL.md\`（即 \`{主目录}/.taco/skills/{技能ID}/SKILL.md\`，注意不要用 \`~\`，Node.js 不认识 \`~\`，必须用系统上下文中的实际主目录路径拼出绝对路径），包含 YAML frontmatter 和 Markdown 指令正文。

> ⚠️ 上述路径仅用于创建新技能时的 \`write_file\` 操作。**读取已有技能内容必须用 \`read_skill\` 工具，严禁用 \`read_file\` 直接读取技能目录下的 SKILL.md。**

### Frontmatter 字段说明

\`\`\`yaml
---
name: 技能名称（必填，中文简短，如"API 文档生成器"）
description: 一句话描述技能用途和触发场景（必填）
version: 1.0.0
author: 作者名
enabled: true
tools:
  - read_file
  - write_file
  - run_command

  # 可用的工具名: read_file, write_file, edit_file, delete_file, list_dir, find_file,
  #              run_command, propose_plan, update_plan_progress, read_skill,
  #              read_skill_resource, analyze_image, mcp_call, mcp_list_tools,
  #              upload_file, terminal_create, terminal_run, terminal_list, terminal_close,
  #              run_skill_script, recall_memories, search_skills, install_skill
  # 也可用分组名: files（所有文件操作）, command（run_command）, planning（计划管理）
requires:
  bins:
    - node        # 依赖的命令行工具
  env:
    - API_KEY     # 依赖的环境变量
  config:
    - some.key    # 依赖的配置项
env:
  CUSTOM_VAR: "value"  # 注入的环境变量
resources:
  - scripts/     # 附属资源目录（脚本、模板等）
---
\`\`\`

## 创建流程

按以下步骤引导用户创建技能：

### 步骤 1：了解需求

向用户提问，收集以下信息：
- **技能名称**：简短中文名，如"API 文档生成器"、"Docker 部署助手"
- **用途描述**：一句话说清楚这个技能做什么、什么时候触发
- **需要的工具**：列出这个技能需要用到哪些 agent 工具

如果用户已经明确说了需求（如"我要一个自动生成 commit message 的技能"），直接从描述中提取信息，不必逐项提问。

### 步骤 2：设计 skills 指令

根据用户需求，编写详细的技能指令。指令应该包含：
1. **标题**：\`# Skill: 名称\`
2. **触发场景**：明确什么时候 AI 应该使用这个技能
3. **执行流程**：AI 应该按什么步骤操作
4. **输出格式**：最终产出的格式要求
5. **注意事项**：关键限制和边界条件

指令要具体、可操作，不要写泛泛而谈的建议。

### 步骤 3：生成并安装

1. 将上述内容组装成完整的 SKILL.md 文件
2. 用 \`write_file\` 写入 \`{主目录}/.taco/skills/{技能ID}/SKILL.md\`（从系统上下文找到实际主目录路径拼出绝对路径，不要用 \`~\`）
3. 用 \`install_skill\` 安装（source 参数传 \`{主目录}/.taco/skills/{技能ID}\`，同样是绝对路径）
4. 告知用户安装完成，下次对话即可生效

技能 ID 从名称自动生成：中文转拼音首字母或英文翻译 → 小写 → 空格替换为连字符。如"API 文档生成器" → "api-doc-generator"。

## 示例

以下是几个典型场景的技能指令模板：

### 示例 1：Git 提交助手

\`\`\`markdown
# Skill: Git 提交助手

## 触发场景
用户说"提交"、"commit"、"推送"时自动触发。

## 执行流程
1. 先执行 \`git status\` 查看变更文件
2. 执行 \`git diff --staged\` 查看暂存区差异（如无暂存则用 \`git diff\`）
3. 分析变更内容，生成 Conventional Commits 格式的 commit message
4. 展示给用户确认
5. 确认后执行 \`git commit -m "message"\`

## 输出格式
\`\`\`
type(scope): 简短描述

详细说明（如有必要）
\`\`\`

## 注意事项
- 每次只提交关联的变更（原子提交）
- 不要自动 git push，需要用户确认
- 不提交包含密钥/密码的文件
\`\`\`

### 示例 2：API 文档生成器

\`\`\`markdown
# Skill: API 文档生成器

## 触发场景
用户提到"生成 API 文档"、"接口文档"、"导出文档"时触发。

## 执行流程
1. 扫描项目中的路由/控制器文件
2. 提取每个接口的：路径、方法、参数、返回值、错误码
3. 生成 Markdown 格式的 API 文档
4. 写入项目根目录的 API_DOC.md

## 输出格式
每个接口按以下结构输出：
- 接口名称
- 请求方法与路径
- 请求参数（Query/Body/Path）
- 响应格式（含示例）
- 错误码说明
\`\`\`

## 关键原则

- **一次只创建一个技能**。不要在用户没要求的情况下连续创建多个
- **技能指令要具体**。不要写"要仔细检查代码"这种空话，要写"检查每个函数是否处理了 null 入参"
- **先确认再写入**。生成 SKILL.md 内容后，向用户展示关键部分（名称、描述、工具列表），确认后再写入文件
- **技能 ID 唯一性**。如果 ID 已存在（同名技能已安装），提示用户换个名字或覆盖
- **不要帮用户做决策**。工具列表、环境变量等需要用户确认，不要擅自猜测
- **读取已有技能必须用 \`read_skill\`**，禁止用 \`read_file\` 直接访问 \`.taco/skills/\` 下的文件。你只能通过 \`write_file\` 写入新 SKILL.md（创建时）和 \`install_skill\`（安装时）操作技能目录`,
  },
]
