/**
 * 工具定义（OpenAI function calling 兼容格式）
 *
 * 包含所有工具的 JSON Schema 定义、使用指南手册、以及 Prompt 构建器。
 */

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type ToolDefinition = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export type ToolCall = {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

/** 文件变更信息（write_file / edit_file / delete_file 时自动记录） */
export type FileChange = {
  filePath: string
  oldContent: string | null  // null 表示新建文件
  newContent: string | null  // null 表示文件被删除
}

export type ToolResult = {
  tool_call_id: string
  name: string
  content: string
  success: boolean
  /** write_file / edit_file / delete_file 操作时记录文件变更 */
  fileChange?: FileChange
}

/* ------------------------------------------------------------------ */
/*  Tool definitions                                                   */
/* ------------------------------------------------------------------ */

export const toolDefinitions: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取指定路径文件内容。支持按行范围读取（startLine/endLine）与分块读取，适合查看大文件代码并逐段分析。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件的绝对路径或相对路径' },
          startLine: { type: 'number', description: '起始行号（1-based，可选）' },
          endLine: { type: 'number', description: '结束行号（1-based，包含，可选）' },
          maxChars: { type: 'number', description: '最大返回字符数（可选，系统会限制上限，建议 <= 2400000）' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '将内容写入指定路径的文件。如果文件不存在则创建，存在则覆盖。用于创建或修改代码文件、配置文件等。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件的绝对路径或相对路径' },
          content: { type: 'string', description: '要写入的完整文件内容' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: '编辑已有文件内容：将 oldText 替换为 newText。默认只替换首次命中；可通过 replaceAll=true 替换全部命中。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件的绝对路径或相对路径' },
          oldText: { type: 'string', description: '需要被替换的原文本（必须精确匹配）' },
          newText: { type: 'string', description: '替换后的新文本' },
          replaceAll: { type: 'boolean', description: '是否替换全部匹配项，默认 false' },
          expectedOccurrences: { type: 'number', description: '期望 oldText 在文件中出现的次数（可选，不匹配则报错）' },
        },
        required: ['path', 'oldText', 'newText'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: '查看目录结构（树形）。支持深度控制、隐藏文件过滤和目录/文件数量摘要。适合先整体理解项目结构再定位目标文件。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目标目录（相对工作区或绝对路径），默认 "."' },
          maxDepth: { type: 'number', description: '树形展示深度，默认 4，范围 1-12' },
          includeFiles: { type: 'boolean', description: '是否显示文件。false 时仅显示目录骨架，默认 true' },
          showFiles: { type: 'boolean', description: '兼容参数，等价于 includeFiles' },
          includeHidden: { type: 'boolean', description: '是否包含隐藏文件/目录（以 . 开头），默认 false' },
          maxEntries: { type: 'number', description: '扫描上限，默认 4000，范围 200-10000' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: '在用户的系统上执行 shell 命令。用于执行命令行、运行构建工具、包管理器、git 操作、启动脚本等。（例如：使用rg命令查找文件）',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的 shell 命令' },
          cwd: { type: 'string', description: '命令执行的工作目录（可选）' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: '删除指定路径的文件。用于清理不需要的文件。删除前会自动保存旧内容以支持撤销。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '要删除的文件的绝对路径或相对路径' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_plan',
      description: '向用户提出执行计划并等待确认。当需要执行多步骤的任务（如创建项目、重构代码、架构变更等）时，必须先调用此工具展示计划，得到用户确认后才能开始执行。单个简单操作（如读取文件、搜索代码）不需要调用此工具。',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: '计划的简要概述（一句话）' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                index: { type: 'number', description: '步骤序号（从 1 开始递增，必须唯一）' },
                title: { type: 'string', description: '步骤标题（简短概括，不超过 20 字）' },
                content: { type: 'string', description: '步骤详细描述（具体要做什么、预期结果是什么）' },
                status: { type: 'string', enum: ['pending'], description: '步骤初始状态，固定为 "pending"' },
              },
              required: ['index', 'title', 'content'],
              additionalProperties: false,
            },
            minItems: 1,
            description: '执行步骤列表。必须为数组，每个步骤是包含 index/title/content 的对象。示例：[{"index":1,"title":"读取配置","content":"读取 package.json 了解项目依赖"},{"index":2,"title":"修改代码","content":"修改 src/index.ts 中的启动逻辑"}]',
          },
          reasoning: { type: 'string', description: '选择此方案的理由（可选）' },
        },
        required: ['summary', 'steps'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_plan_progress',
      description: '更新当前执行计划中某个步骤的状态。在执行计划的每一步之前调用（设为 in_progress），完成后再次调用（设为 done 或 failed）。此工具自动执行，无需用户确认。',
      parameters: {
        type: 'object',
        properties: {
          stepIndex: { type: 'number', description: '步骤的 index 值（对应 propose_plan 中 steps 数组里每个对象的 index 字段，从 1 开始）' },
          status: {
            type: 'string',
            enum: ['in_progress', 'done', 'failed'],
            description: '步骤的新状态：in_progress=正在执行，done=已完成，failed=执行失败',
          },
          note: { type: 'string', description: '可选的进度备注，如完成摘要或失败原因' },
        },
        required: ['stepIndex', 'status'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_file',
      description: '按文件名或相对路径查找文件/目录。支持 fuzzy、glob、exact 三种匹配模式，并按相关性排序。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '搜索模式，如 "App.tsx"、"src/**/App.tsx"、"agent"（必填）' },
          directory: { type: 'string', description: '限定搜索目录，默认 "."' },
          type: { type: 'string', enum: ['file', 'directory', 'all'], description: '搜索类型，默认 file' },
          mode: { type: 'string', enum: ['auto', 'fuzzy', 'glob', 'exact'], description: '匹配模式。auto 会自动识别（含 * ? {} 走 glob，否则 fuzzy）' },
          includeHidden: { type: 'boolean', description: '是否包含隐藏文件/目录，默认 false' },
          maxResults: { type: 'number', description: '最大返回条数，默认 50，范围 1-200' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_skill',
      description: '读取指定技能的完整 SKILL.md 内容。**这是读取技能内容的唯一正确方式，严禁用 read_file / list_dir 替代。** 应先根据系统注入的 SKILLS_CATALOG 判断需要哪个技能，再调用此工具查看完整技能说明。',
      parameters: {
        type: 'object',
        properties: {
          skill_id: { type: 'string', description: '技能 ID，必须来自当前请求注入的 SKILLS_CATALOG' },
        },
        required: ['skill_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_skill_resource',
      description: '读取某个技能目录中的附属资源文件。适用于按需查看 references/scripts/assets/templates 下的具体内容。',
      parameters: {
        type: 'object',
        properties: {
          skill_id: { type: 'string', description: '技能 ID，必须已在当前任务中通过 read_skill 成功读取过' },
          resource_path: { type: 'string', description: '技能目录内的相对路径，例如 "references/api.md"、"scripts/check.sh"' },
        },
        required: ['skill_id', 'resource_path'],
      },
    },
  },
  /* ---- 视觉分析工具 ---- */
  {
    type: 'function',
    function: {
      name: 'analyze_image',
      description: '使用视觉模型分析图片内容。image 参数接受 data: URL（base64）或 https: 链接。用于分析截图内容，不要用于分析用户直接在对话中上传的图片（用户自传图片由主AI直接识别）。',
      parameters: {
        type: 'object',
        properties: {
          image: { type: 'string', description: '图片 data: URL（base64）或 https: 链接，视觉模型直接识别' },
          goal: { type: 'string', description: '分析目的（如"确认登录按钮是否可见"、"识别错误提示内容"）。视觉模型会根据此目的针对性分析。' },
        },
        required: ['image', 'goal'],
      },
    },
  },
  /* ---- MCP 工具调用 ---- */
  {
    type: 'function',
    function: {
      name: 'mcp_call',
      description: '调用 MCP (Model Context Protocol) 服务器提供的工具。调用前必须先通过 mcp_list_tools 读取最新 inputSchema 并按 schema 组装 arguments。禁止凭记忆猜参数，禁止跳过 mcp_list_tools 直接调用。调用失败先检查 schema、参数和值类型，再决定是否重试。',
      parameters: {
        type: 'object',
        properties: {
          server_id: { type: 'string', description: 'MCP 服务器 ID（如 "minimax"）' },
          tool_name: { type: 'string', description: '要调用的 MCP 工具名称（如 "web_search", "understand_image"）' },
          arguments: {
            type: 'object',
            description: '传递给 MCP 工具的参数（JSON 对象）',
          },
        },
        required: ['server_id', 'tool_name', 'arguments'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mcp_list_tools',
      description: '列出所有已启用的 MCP 服务器及其提供的工具。MCP 调用前必须先执行此工具确认可用工具及参数 schema，禁止凭记忆猜参数。必要时可用 server_id 限定范围。',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'upload_file',
      description: '上传本地文件到云存储并返回下载链接。支持 APK、ZIP、图片、文档等任意文件类型。需要先在设置中配置云存储（七牛云/阿里云OSS）。常用于编译产物（APK/IPA/DMG/EXE）上传获取下载链接、分发文件、远程下载安装等场景。',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: '本地文件路径（绝对路径或相对工作空间）' },
          objectPrefix: { type: 'string', description: '对象存储前缀路径（如 "apk/"、"builds/"），不指定则使用云存储配置中的默认前缀' },
        },
        required: ['filePath'],
      },
    },
  },
  /* ---- 终端工具 ---- */
  {
    type: 'function',
    function: {
      name: 'terminal_create',
      description: '创建一个持久终端会话。与 run_command 不同，终端会话的命令间状态会保持（cd、export、后台进程等）。适用于需要多步命令操作、构建、启动开发服务器等场景。一次性命令仍用 run_command。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '终端会话名称（可选），如"前端开发"、"后端构建"。不传则自动命名' },
          cwd: { type: 'string', description: '工作目录（可选），只能是项目工作目录或其子目录。不传则默认使用项目工作目录。不能超出项目工作空间。' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'terminal_run',
      description: '在指定终端会话中执行命令，返回命令输出。命令在持久会话中执行，所以 cd 切换的目录、export 设置的环境变量、启动的后台进程都会保持到后续命令。\n\n两种模式：\n1. 普通模式（默认）：命令执行完成后返回完整输出，适用于 ls、cat、grep、构建等一次性命令\n2. stream 模式（stream=true）：写入命令后在 streamMs 毫秒内收集输出并返回，命令继续在后台运行。适用于：\n   - 启动长时间运行的服务（npm run dev、top -c、tail -f）\n   - 间歇性检查编译/运行进度：反复调用 terminal_run({ command: "", stream: true, streamMs: 5000 }) 收集最近 N 秒输出',
      parameters: {
        type: 'object',
        properties: {
          terminalId: { type: 'string', description: '终端会话 ID（从 terminal_create 或 terminal_list 获取）' },
          command: { type: 'string', description: '要执行的 shell 命令。stream 模式下可为空字符串，表示只观察最近输出不写入新命令' },
          timeout: { type: 'number', description: '超时毫秒数（仅普通模式），默认 120000（2 分钟）' },
          stream: { type: 'boolean', description: '是否启用流模式。true 时不等待命令完成，在 streamMs 毫秒后返回已收集输出，命令继续后台运行。默认 false' },
          streamMs: { type: 'number', description: 'stream 模式下输出收集时长（毫秒），默认 3000' },
        },
        required: ['terminalId', 'command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'terminal_list',
      description: '列出当前所有 AI 终端会话（包含 terminalId、名称、工作目录、创建时间）。用于了解已有哪些终端、各终端当前目录和用途，再决定操作哪个。',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'terminal_close',
      description: '关闭并销毁指定终端会话，释放系统资源。终端不再需要时应主动关闭。传入 terminalId 指定要关闭哪个终端（可通过 terminal_list 查看所有终端）。',
      parameters: {
        type: 'object',
        properties: {
          terminalId: { type: 'string', description: '要关闭的终端会话 ID，从 terminal_list 获取' },
        },
        required: ['terminalId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_skill_script',
      description: '统一技能脚本执行入口。browser-use 和 computer-use 为内置技能，由系统内部接口直接执行；其他技能通过子进程执行对应的脚本文件。调用前必须先通过 read_skill 读取技能手册确认可用脚本。',
      parameters: {
        type: 'object',
        properties: {
          skill_id: { type: 'string', description: '技能 ID（如 browser-use、computer-use）' },
          script_name: { type: 'string', description: '脚本名称（如 navigate、click、screenshot、action）' },
          params: { type: 'object', description: '传递给脚本的参数（JSON 对象，可选）' },
        },
        required: ['skill_id', 'script_name'],
      },
    },
  },
  /* ---- 记忆回想工具 ---- */
  {
    type: 'function',
    function: {
      name: 'recall_memories',
      description: '搜索历史任务记忆。当你需要回忆之前是否处理过类似问题、查找历史修复方案、或理解项目演进上下文时使用。纯关键词匹配，返回相关记忆的标题、时间、涉及文件、工具和摘要。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词，如"bridge 通信遗漏"、"语音识别 bug"、"版本号". 支持中英文混合' },
          limit: { type: 'number', description: '最多返回条数，默认 5，最大 50' },
          timeRange: { type: 'string', description: '时间范围，AI 自由描述，如"昨天"、"上周"、"上个月"、"最近3天"、"2025年6月"等。不传则搜索全部时间。' },
        },
        required: ['query'],
      },
    },
  },
  /* ---- 技能搜索与安装工具 ---- */
  {
    type: 'function',
    function: {
      name: 'search_skills',
      description: '从 ClawHub 技能市场（clawhub.ai）和腾讯 SkillHub（skillhub.cloud.tencent.com）搜索可安装的 Taco 技能。两个技能库共 148K+ 公共技能，返回技能名称、描述、slug、作者、下载量等信息。搜索结果包含 slug 字段，可直接用于 install_skill 安装。默认同时搜索两个源，也可通过 source 参数指定单一源。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词，如"api documentation"、"pdf 处理"、"图片编辑"、"git commit"等' },
          source: { type: 'string', description: '数据源：clawhub（仅 ClawHub）、skillhub（仅腾讯 SkillHub）、all（两个源合并，默认）。SkillHub 中文优化更好，ClawHub 国际技能更多。', enum: ['clawhub', 'skillhub', 'all'] },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'install_skill',
      description: '安装一个 Taco 技能到本地。支持三种来源格式：1) ClawHub/SkillHub slug（如"skill-creator"，搜索结果的 slug 字段）；2) GitHub 仓库 URL（如"https://github.com/xxx/yyy"）；3) 本地路径。安装时会自动下载 ZIP 并解压到本地技能库。安装前自动进行安全审核：低/中风险直接安装，高风险暂停并展示风险报告（需用户确认后 force=true 强制安装），致命风险直接拒绝。安装完成后技能立即生效，下次任务自动加载。',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: '技能来源。可以是 ClawHub slug（如"skill-creator"或"@chindden/skill-creator"，即搜索结果的 slug 字段）、GitHub 仓库 URL（如"https://github.com/xxx/yyy"）、SKILL.md 的 Raw URL、或本地路径' },
          force: { type: 'boolean', description: '是否跳过安全预览强制安装。仅当用户明确看到风险报告并确认"安装"/"继续"后才设为 true。默认为 false' },
        },
        required: ['source'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'uninstall_skill',
      description: '卸载一个已安装的非内置 Taco 技能。只能卸载从 ClawHub 或外部安装的技能，内置技能不可卸载。卸载后会删除技能目录并刷新技能列表。',
      parameters: {
        type: 'object',
        properties: {
          skill_id: { type: 'string', description: '要卸载的技能 ID（如"code-review"、"skill-creator"）。可通过已安装技能列表确认 ID。' },
        },
        required: ['skill_id'],
      },
    },
  },
]

/* ------------------------------------------------------------------ */
/*  Tool guide manual                                                  */
/* ------------------------------------------------------------------ */

type ToolGuideManual = {
  usage: string[]
  cautions?: string[]
}

const TOOL_NAME_ALIASES: Record<string, string> = {
  list_directory: 'list_dir',
}

export function normalizeToolName(name: string): string {
  return TOOL_NAME_ALIASES[name] ?? name
}

const TOOL_GUIDE_MANUAL: Record<string, ToolGuideManual> = {
  read_file: {
    usage: [
      '读取策略按文件大小智能选择：小文件（< 500 行）直接全文读取，不指定 startLine/endLine；大文件（>= 500 行）按行范围读取，每次至少读取 1000 行。',
      '禁止 200-300 行的小块连续读取。如果需要读取大文件的多个区段，应合并为单次大范围读取（如 startLine=1, endLine=2000），而非多次小范围调用。',
      '当需要全局理解文件结构、查找跨区段引用、或文件被用户手动附加时，优先全文读取。',
      '仅当明确知道目标代码所在行号范围（如修改某个具体函数）时，才使用精确的行范围读取。',
      '当用户提供的文件路径在工作空间之外但任务确需读取时，必须直接调用 read_file；系统会在执行前触发授权确认，禁止先口头拒绝访问。',
      '注意：避免连续使用相同参数调用此工具，以免造成重复读取。',
    ],
    cautions: [
      '小文件禁止分块读取，直接全文读取更高效。',
      '大文件读取时，单次范围过小会导致多次往返调用，显著降低效率。',
      '工作空间外文件读取属于高风险动作，必须等待用户授权确认后才能继续。',
      '禁止用 read_file 读取技能目录下的文件（如 ~/.taco/skills/*/SKILL.md），技能内容必须通过 read_skill 工具获取。',
    ],
  },
  write_file: {
    usage: [
      '仅在"需要重写整个文件"时使用；局部变更优先使用 edit_file。',
      '写入前先通过 read_file 确认目标文件当前结构，避免覆盖无关内容。',
      '写入后必须回读关键片段验证落盘结果。',
    ],
    cautions: ['严禁在未确认路径和内容时覆盖核心文件。'],
  },
  edit_file: {
    usage: [
      '先 read_file 定位并确认 oldText 与上下文完全一致后再替换。',
      '默认只替换首个命中；多处命中场景需显式设置 replaceAll 或 expectedOccurrences。',
      '替换后再次 read_file 校验函数/变量/语法是否保持正确。',
    ],
    cautions: ['避免使用过短 oldText，防止误改到非目标位置。'],
  },
  list_dir: {
    usage: [
      '用于快速理解目录结构，优先以较小 maxDepth 查看骨架。',
      '当只需目录骨架时将 includeFiles 设为 false，减少无关噪声。',
      '定位目标后再配合 find_file/read_file 深入；内容搜索统一优先 run_command + grep。',
    ],
    cautions: [
      '禁止用 list_dir 浏览技能目录（~/.taco/skills/），已安装的技能信息通过 技能目录 获取。',
    ],
  },
  run_command: {
    usage: [
      '用于构建、测试、运行和验证真实结果，优先执行最小必要命令。',
      '明确设置 cwd 到目标项目目录，避免在错误目录执行。',
      '代码搜索默认优先使用 grep；定位文件名可配合 find 命令，搜索不到再拆分关键词继续 grep。',
      '命令失败时返回关键 stdout/stderr，并给出下一步处理动作。',
      '注意：在同一轮询中，避免连续执行同一个命令，如果尝试执行失败请更换别的方式或者别的命令。',
    ],
    cautions: ['未获用户明确授权时，禁止执行高风险破坏性命令。'],
  },
  delete_file: {
    usage: [
      '仅在用户明确要求删除，或任务步骤明确要求清理时使用。',
      '删除前确认路径属于当前任务目标，避免误删。',
      '删除后给出已删除文件清单，必要时提示可恢复路径。',
    ],
    cautions: ['禁止批量删除与任务无关文件。'],
  },
  propose_plan: {
    usage: [
      '多步骤或高不确定任务先提出计划，摘要必须清晰可执行。',
      'steps 必须按可落地顺序编排，避免抽象空话。',
      '提出计划后等待用户确认，再进入执行阶段。',
    ],
    cautions: [
      'steps 数组至少包含 1 个步骤，空数组会导致用户看到空白计划窗口。',
      '每个步骤必须包含 index、title、content 三个字段，缺一不可。',
      '被用户拒绝后必须立即停止所有执行类工具调用，只允许只读操作。',
      '被拒绝后只输出询问文本（如"方案被拒绝，你希望怎么调整？"），等待用户明确回复后再重新制定方案。',
      '禁止以"简化版""快速版""直接开始"为理由跳过 propose_plan 直接执行。',
    ],
  },
  update_plan_progress: {
    usage: [
      '开始某一步前标记 in_progress，完成后标记 done，失败标记 failed。',
      'stepIndex 参数必须传入 propose_plan 中 steps 数组里对应步骤的 index 字段值（从 1 开始），而不是数组下标。',
      'note 只写关键进度或失败原因，不写冗余描述。',
      '确保状态与真实执行一致，不允许"先报完成后再执行"。',
    ],
  },
  find_file: {
    usage: [
      '当已知文件名/路径特征时优先使用，快速定位目标文件。',
      'pattern 默认沿用用户原词；只有明显更优时才改写。',
      '大范围匹配时通过 directory/type/mode 缩小范围。',
    ],
  },
  read_skill: {
    usage: [
      '先查看系统注入的 `SKILLS_CATALOG`，确认需要的技能 ID 后再调用。',
      '该工具只返回当前已开启且当前环境可用的技能详情。',
      '读取技能全文后，再按技能规则继续执行任务。',
    ],
    cautions: [
      '禁止凭经验假设技能全文，必须先读取。',
      '若技能不在当前目录清单中，不允许调用。',
      '这是读取技能内容的唯一方式。严禁用 read_file 或 list_dir 替代 read_skill 访问技能目录。',
    ],
  },
  read_skill_resource: {
    usage: [
      '仅在某个技能已经通过 `read_skill` 读取后，再按需读取该技能的附属资源文件。',
      'resource_path 必须是技能目录内的相对路径，优先读取具体文件而不是整个目录。',
      '读取 references/scripts/assets/templates 时，读完后要回到任务本身，不要把资源全文反复回灌。',
    ],
    cautions: [
      '如果当前任务还没有成功读取该技能详情，此调用必须被视为无效。',
      '禁止传绝对路径或越界路径。',
    ],
  },
  mcp_list_tools: {
    usage: [
      '任何 MCP 调用前必须先执行此工具，禁止凭记忆猜参数。',
      '确认可用工具清单和 inputSchema 后再决定调用哪个工具。',
      '结合当前任务目标选择合适工具，避免泛化调用。',
    ],
  },
  mcp_call: {
    usage: [
      '必须在 mcp_list_tools 之后调用，严格按 schema 组装 arguments。',
      'arguments 字段类型必须与 inputSchema 一致，不允许猜字段名。',
      '调用前明确目标和成功判定标准。',
      '调用失败先检查 schema、参数和值类型，再决定是否重试。',
      'MCP 返回的是外部能力结果，必须结合当前任务目标再做判断，不可机械转述。',
    ],
    cautions: [
      '禁止跳过 mcp_list_tools 直接调用 mcp_call。',
    ],
  },
  /* ---- 终端工具 ---- */
  terminal_create: {
    usage: [
      '用于创建持久终端会话，命令间状态保持（cd / export / 后台进程）。',
      '一次性简单命令（ls、cat、grep）仍用 run_command；需要多步交互时用终端。',
      '建议传 name 参数标明终端用途（如"前端服务"、"后端构建"）。',
      '不传 cwd 则默认用户主目录。',
    ],
    cautions: [
      '不要为单次命令创建终端，run_command 更适合一次性命令。',
      '终端是系统资源，不再需要时用 terminal_close 清理。',
    ],
  },
  terminal_run: {
    usage: [
      '在持久终端中执行命令，cd / export 等状态会保留到后续命令。',
      '命令执行完成后返回完整输出（已去掉 ANSI 转义码和提示符）。',
      '输出超过 24000 字符会自动截断并提示。',
      '对于需要交互确认的命令（如 npx create-xxx），终端会卡住直到超时，避免使用。',
    ],
    cautions: [
      '禁止在终端中执行交互式命令（如需要用户输入确认的命令）。',
      '如果命令长时间无输出，检查是否卡在交互提示上。',
    ],
  },
  terminal_list: {
    usage: [
      '列出当前所有 AI 终端会话，包含 terminalId / name / cwd / 创建时间。',
      '用于了解已有哪些终端、各终端当前目录和用途，再决定操作哪个。',
    ],
  },
  terminal_close: {
    usage: [
      '关闭并销毁指定终端，释放 PTY 进程和内存。',
      '终端不再需要时应主动关闭，避免资源泄露。',
      '临时任务终端任务完成后立即关闭；开发服务器等长期任务可保留。',
    ],
    cautions: [
      '关闭终端后其中启动的后台进程（如开发服务器）也会被终止。',
    ],
  },
  run_skill_script: {
    usage: [
      '统一技能脚本执行入口。browser-use 和 computer-use 为内置技能，由系统内部接口直接处理。',
      '其他技能通过子进程执行 skills/{skill_id}/scripts/{script_name} 脚本文件。',
      '调用前必须先通过 read_skill 读取技能手册，了解可用脚本及其参数。',
      'params 作为命令行参数或 stdin JSON 传递给脚本。',
    ],
    cautions: [
      '未读取技能手册前，禁止调用此工具。',
      '仅支持已开启的技能。',
    ],
  },
  recall_memories: {
    usage: [
      '当需要回忆之前是否处理过类似问题、查找历史修复方案时调用。',
      'query 参数传入搜索关键词，如"bridge 遗漏"、"语音识别"、"版本号"等。',
      'limit 参数控制返回条数，默认 5，最大 50。',
      'timeRange 参数自由描述时间范围，如"昨天"、"上周"、"上个月"、"最近3天"、"去年"等。不传则搜索全部时间。',
      '结果按相关性降序排列，同分按时间降序。',
      '纯关键词匹配，不需要额外 LLM 调用。',
    ],
    cautions: [
      '此工具只搜索任务记忆（成功/失败/中止的任务记录），不包含项目规则。',
      '不要在一次对话中连续调用多次——先用一个精准的 query 试试。',
    ],
  },
  search_skills: {
    usage: [
      '当用户需要寻找、发现新的技能时调用。同时搜索 ClawHub 技能市场（69.5K+ 技能）和腾讯 SkillHub（78.5K+ 技能，中文优化）。',
      'query 参数传入功能描述关键词，如"api 文档生成"、"pdf 处理"、"图片压缩"等。',
      'source 参数可选：clawhub（仅 ClawHub）、skillhub（仅腾讯 SkillHub）、all（默认，两个源合并去重）。',
      '搜索结果返回技能名称、描述、slug、作者、下载量、来源，用户可选择感兴趣的安装。',
      '优先建议用户安装下载量高、描述清晰、更新活跃的技能。SkillHub 的中文技能更多、描述更详细。',
    ],
    cautions: [
      '两个 API 均免费无需认证，ClawHub 限流 3000 次/分钟，SkillHub 无限制。',
      '仅搜索公共技能市场，不包含私有技能。',
    ],
  },
  install_skill: {
    usage: [
      '安装用户指定的技能到本地技能库，安装后自动刷新技能列表立即生效。',
      'source 参数支持三种格式：ClawHub/SkillHub slug（如"skill-creator"或"@chindden/skill-creator"，直接使用搜索结果的 slug 字段）、GitHub 仓库 URL、本地文件路径。',
      '从技能市场安装时，自动下载 ZIP 包并解压，包含 SKILL.md 及附属资源（scripts/references/templates 等）。会先尝试 ClawHub，失败后自动回退到 SkillHub。',
      '安装前自动进行安全审核：low/medium 直接安装；high 暂停并展示风险报告等用户确认（用户确认后 force=true 重新调用）；critical 直接拒绝。',
      '当首次调用返回高风险警告时，必须向用户展示具体的风险项，等用户说"安装"或"继续"后再用 force=true 调用。',
      '安装完成后告知用户技能已可用，下次任务自动加载。',
    ],
    cautions: [
      '仅安装用户明确选择或同意的技能，不要自作主张安装。',
      '高风险技能必须等用户看了风险报告并确认后才能 force=true 安装，禁止自动 force。',
      '如果安装失败，向用户说明失败原因并建议重试或换 source。',
    ],
  },
  uninstall_skill: {
    usage: [
      '卸载用户指定的非内置技能。只能卸载从 ClawHub 或外部通过 GitHub/本地路径安装的技能。',
      'skill_id 参数传入技能 ID（如"skill-creator"），通过已安装技能列表获取。',
      '内置技能（source 为 builtin）不可卸载，调用会返回错误。',
      '卸载成功后技能立即从列表中移除，无需重启。',
    ],
    cautions: [
      '卸载前应先告知用户并等待确认，不要擅自卸载。',
      '内置技能不可卸载，如果用户要求卸载内置技能，直接告知不可卸载。',
      '卸载后相关技能目录会被删除，不可恢复。',
    ],
  },
  /* ---- 文件上传到云存储 ---- */
};

/* ------------------------------------------------------------------ */
/*  Prompt builders                                                    */
/* ------------------------------------------------------------------ */

function normalizeParametersSchema(parameters: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...parameters }
  if (normalized.type === 'object' && normalized.additionalProperties === undefined) {
    normalized.additionalProperties = false
  }
  return normalized
}

// Normalize all definitions on import
for (const definition of toolDefinitions) {
  definition.function.parameters = normalizeParametersSchema(definition.function.parameters)
}

function getSchemaKeys(parameters: Record<string, unknown>): { required: string[]; optional: string[] } {
  const required = new Set<string>()
  const optional = new Set<string>()
  const requiredRaw = parameters.required
  if (Array.isArray(requiredRaw)) {
    for (const key of requiredRaw) {
      if (typeof key === 'string' && key.trim()) required.add(key.trim())
    }
  }

  const propertiesRaw = parameters.properties
  if (propertiesRaw && typeof propertiesRaw === 'object') {
    for (const key of Object.keys(propertiesRaw as Record<string, unknown>)) {
      if (required.has(key)) continue
      optional.add(key)
    }
  }

  return {
    required: Array.from(required),
    optional: Array.from(optional),
  }
}

function shortDescription(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  const firstStop = normalized.search(/[。.!?]/)
  if (firstStop <= 0) return normalized
  return normalized.slice(0, firstStop + 1)
}

function buildToolSignature(name: string, parameters: Record<string, unknown>): string {
  const keys = getSchemaKeys(parameters)
  const requiredPart = keys.required.join(', ')
  const optionalPart = keys.optional.map((key) => `${key}?`).join(', ')
  const args = [requiredPart, optionalPart].filter(Boolean).join(', ')
  return `${name}(${args})`
}

function filterToolDefinitions(allowedToolNames?: Iterable<string>): ToolDefinition[] {
  if (!allowedToolNames) return [...toolDefinitions]
  const allowed = new Set<string>()
  for (const name of allowedToolNames) {
    const normalized = normalizeToolName(String(name ?? '').trim())
    if (normalized) allowed.add(normalized)
  }
  return toolDefinitions.filter((definition) => allowed.has(normalizeToolName(definition.function.name)))
}

export function buildToolDesignPromptBlock(allowedToolNames: Iterable<string>): string {
  const lines: string[] = [
    '# 工具定义与调用规范（逐个工具，强制执行）',
    '## 工具调用规则',
    '1. 必须严格按照指定格式调用工具，确保提供所有必填参数。',
    '2. 对话中可能提及已失效工具，绝不调用未明确提供的工具。',
    '3. 与用户沟通时，永远不要提及工具名称，用自然语言描述工具行为即可。',
    '4. 只使用标准工具调用格式与已提供的工具。',
    '5. 尽量寻找可并行执行多个工具的机会，提前规划哪些操作可同时运行。',
    '6. 文件编辑工具禁止并行执行，必须串行以保证一致性。',
    '7. run_command 禁止并行执行，命令必须串行以确保执行顺序、避免竞争条件。',
    '',
    '8. 必须严格按照参数 schema 调用。',
    '9. 如果文件过大，则分多次读取，每次读取后必须判断已获取信息是否足够完成当前任务，并记录尚未覆盖的区段。',
    '10. 有可执行工具时必须真实调用，禁止只输出"命令示例"或口头描述。',
    '11. 工具调用必须与当前 intent 对齐，避免无目的重复调用。',
    '12. 声称"已完成/已修复"前，必须已有对应工具执行证据。',
    '13. 禁止输出 [TOOL_CALL]、<invoke> 等伪调用文本，工具调用只能通过标准 tool_calls。',
    '14. 参数必须严格匹配工具 schema，不允许猜字段名。',
    '15. 当用户提供了明确文件路径且请求读取时，必须优先调用 read_file；若路径在工作空间外，系统会触发授权确认，禁止直接口头拒绝。',
    '16. 能直接回答时可以直接输出最终答复；只有确实需要外部操作、读取或验证时再调用工具。',
    '17. 若本轮无需工具，直接输出完整最终答复，不要再包一层伪工具调用、JSON 包装或控制指令。',
    '',
    '## 工具清单（每个工具都要遵守对应规范）',
  ]

  for (const definition of filterToolDefinitions(allowedToolNames)) {
    const name = definition.function.name
    const signature = buildToolSignature(name, definition.function.parameters)
    const desc = shortDescription(definition.function.description)
    const schemaKeys = getSchemaKeys(definition.function.parameters)
    const manual = TOOL_GUIDE_MANUAL[name]

    lines.push(`### ${name}`)
    lines.push(`描述：${desc}`)
    lines.push(`调用签名：\`${signature}\``)
    lines.push(`参数（必填）：${schemaKeys.required.length ? schemaKeys.required.map((item) => `\`${item}\``).join('、') : '无'}`)
    lines.push(`参数（可选）：${schemaKeys.optional.length ? schemaKeys.optional.map((item) => `\`${item}\``).join('、') : '无'}`)

    if (manual?.usage.length) {
      lines.push('使用规则：')
      manual.usage.forEach((rule, index) => lines.push(`${index + 1}. ${rule}`))
    }

    if (manual?.cautions?.length) {
      lines.push('注意事项：')
      manual.cautions.forEach((item) => lines.push(`- ${item}`))
    }

    if (!manual) {
      lines.push('使用规则：')
      lines.push('1. 严格按照参数 schema 调用。')
      lines.push('2. 调用后基于返回结果再决定下一步。')
    }
    lines.push('')
  }

  return lines.join('\n').trim()
}

/**
 * 获取完整的工具定义列表（静态工具 + 动态 MCP 工具描述）。
 * Agent 每次调用时获取最新的工具列表。
 */
export function getAllToolDefinitions(): ToolDefinition[] {
  return [...toolDefinitions]
}

export function getFilteredToolDefinitions(allowedToolNames?: Iterable<string>): ToolDefinition[] {
  return filterToolDefinitions(allowedToolNames)
}

/** 向后兼容别名 */
export function getToolDesignPromptBlock(allowedToolNames: Iterable<string>): string {
  return buildToolDesignPromptBlock(allowedToolNames)
}
