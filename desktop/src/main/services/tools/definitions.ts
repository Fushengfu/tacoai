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
      description: '读取当前已开启技能目录中的某个技能的完整内容。应先根据系统注入的 SKILLS_CATALOG 判断需要哪个技能，再调用此工具查看完整技能说明。',
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
      description: '读取某个已激活技能目录中的附属资源文件。适用于按需查看 references/scripts/assets/templates 下的具体内容。',
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
  {
    type: 'function',
    function: {
      name: 'save_note',
      description: '保存或追加项目关键信息到持久化存储。仅记录核心信息（如代码规范、数据库配置、架构决策、编码规则），禁止记录任务日志、临时状态或一次性修改记录。采用追加模式，将所有关键信息维护在同一条主记录中（如项目知识库），避免碎片化创建新笔记。无需征求用户许可即可调用。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '笔记标题（简洁概括）' },
          content: { type: 'string', description: '笔记正文内容（详细描述）' },
          category: {
            type: 'string',
            enum: ['convention', 'credential', 'architecture', 'config', 'other'],
            description: '分类：convention(代码规范), credential(凭证/账号), architecture(架构设计), config(配置信息), other(其他)',
          },
        },
        required: ['title', 'content', 'category'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_note',
      description: '删除一条项目笔记/记忆。当用户要求删除某条笔记或某项记忆已过时时使用。',
      parameters: {
        type: 'object',
        properties: {
          noteId: { type: 'string', description: '要删除的笔记 ID' },
        },
        required: ['noteId'],
      },
    },
  },

  /* ---- 浏览器自动化工具 ---- */
  {
    type: 'function',
    function: {
      name: 'browser_navigate',
      description: '在外部浏览器窗口中打开/导航到指定 URL。如果浏览器未打开会自动打开。可通过 appId 指定操作哪个浏览器实例（不同 appId 拥有独立的指纹和会话）。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要导航到的 URL（支持 http/https）' },
          appId: { type: 'string', description: '浏览器实例标识。不同 appId 对应独立的浏览器窗口、会话和指纹。不指定则使用 "default"' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description: '截取当前浏览器页面并返回结构化页面信息（标题、URL、可见元素、截图路径）。调用前应先明确本次截图目标，避免无目的连续截图。',
      parameters: {
        type: 'object',
        properties: {
          appId: { type: 'string', description: '浏览器实例标识，不指定则使用 "default"' },
          goal: { type: 'string', description: '本次截图的目标（例如：确认登录按钮可见/验证提交后提示是否出现）' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'desktop_screenshot',
      description: '截取当前桌面屏幕截图。默认使用实际屏幕分辨率，仅返回本地文件路径与尺寸元信息，供后续视觉识别使用。',
      parameters: {
        type: 'object',
        properties: {
          displayId: { type: 'string', description: '指定屏幕 ID（可选），不传则使用主屏' },
          width: { type: 'number', description: '截图宽度（可选，传入时应为实际屏幕宽度）' },
          height: { type: 'number', description: '截图高度（可选，传入时应为实际屏幕高度）' },
          appId: { type: 'string', description: '截图保存目录标识（可选，默认 "desktop"）' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'desktop_action',
      description: '调用本地 Node 原生桌面能力执行鼠标/键盘/文本输入等操作。用户明确给出坐标、按键或输入内容时应直接调用此工具，无需先截图。兼容动作别名（如 INPUT/TYPE_TEXT/KEY_PRESS）。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['move', 'click', 'double_click', 'mouse_down', 'drag', 'scroll', 'type', 'key'], description: '操作类型（double_click 会自动映射为 click + clicks=2）' },
          x: { type: 'number', description: '屏幕坐标 X（move/click/mouse_down/drag 起点）' },
          y: { type: 'number', description: '屏幕坐标 Y（move/click/mouse_down/drag 起点）' },
          toX: { type: 'number', description: '拖动目标坐标 X（drag）' },
          toY: { type: 'number', description: '拖动目标坐标 Y（drag）' },
          steps: { type: 'number', description: '拖动分步数（drag，可选，默认自动）' },
          duration_ms: { type: 'number', description: '拖动总时长毫秒（drag，可选，默认自动）' },
          release: { type: 'boolean', description: 'drag 完成后是否自动松开鼠标，默认 true' },
          button: { type: 'string', enum: ['left', 'right', 'middle'], description: '鼠标按键（click/mouse_down/drag）' },
          clicks: { type: 'number', description: '点击次数（click），默认 1' },
          clickCount: { type: 'number', description: '兼容字段，等价于 clicks' },
          double: { type: 'boolean', description: '是否双击（兼容字段，true 时等价 clicks=2）' },
          dx: { type: 'number', description: '水平滚动像素（scroll）' },
          dy: { type: 'number', description: '垂直滚动像素（scroll）' },
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: '滚动方向（scroll）' },
          amount: { type: 'string', description: '滚动幅度（small/medium/large 或数字像素）' },
          text: { type: 'string', description: '输入文本（type）。兼容 input/value/content/message 字段作为回退。' },
          needs_enter: { type: 'boolean', description: '输入后是否回车（type，可选）' },
          key: { type: 'string', description: '按键（key），如 enter/tab/esc/left/right/up/down/f4。支持组合写法，如 "cmd+s"、"command s"。' },
          modifiers: { type: 'array', items: { type: 'string', enum: ['cmd', 'ctrl', 'alt', 'shift'] }, description: '修饰键（key）' },
          delay_ms: { type: 'number', description: '操作前延迟毫秒（可选）' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_click',
      description: '通过 CDP 模拟鼠标点击页面上指定的元素。支持 CSS 选择器或直接坐标两种定位方式。会模拟鼠标移动→按下→释放的完整操作。可选双击、右键点击。',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS 选择器定位元素，如 "#login-btn", ".submit"。与 x/y 坐标二选一' },
          x: { type: 'number', description: '直接指定点击的 X 坐标（视口像素）。需与 y 配合使用' },
          y: { type: 'number', description: '直接指定点击的 Y 坐标（视口像素）。需与 x 配合使用' },
          button: { type: 'string', enum: ['left', 'right', 'middle'], description: '鼠标按键，默认 left' },
          clickCount: { type: 'number', description: '点击次数，2 为双击，默认 1' },
          appId: { type: 'string', description: '浏览器实例标识，不指定则使用 "default"' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_type',
      description: '通过 CDP 模拟键盘逐字符输入文字到指定输入框。模拟完整流程：鼠标移动到元素 → 点击聚焦 → 清空旧内容 → 逐字符按键输入（带随机延迟模拟真人打字节奏）。支持中文等非 ASCII 字符。',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS 选择器，用于定位输入元素，如 "#username", "input[name=email]", "#kw"' },
          text: { type: 'string', description: '要输入的文字' },
          clear: { type: 'boolean', description: '是否在输入前清空已有内容，默认 true' },
          submit: { type: 'boolean', description: '输入完成后是否模拟按下 Enter 键提交（适用于搜索框等场景），默认 false' },
          appId: { type: 'string', description: '浏览器实例标识，不指定则使用 "default"' },
        },
        required: ['selector', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_scroll',
      description: '通过 CDP 模拟鼠标滚轮滚动浏览器页面或指定元素。会分多步平滑滚动模拟真实滚轮操作。可指定元素进行局部滚动。',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: '滚动方向，默认 down' },
          amount: { type: 'number', description: '滚动像素数，默认 300' },
          selector: { type: 'string', description: '可选，指定鼠标移到该元素上方再滚动（用于局部可滚动容器）。不提供则在页面中心滚动' },
          appId: { type: 'string', description: '浏览器实例标识，不指定则使用 "default"' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_get_content',
      description: '获取页面或指定元素的文本/HTML 内容。用于提取页面数据、验证显示内容。',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: '可选的 CSS 选择器。不提供则获取 body 内容' },
          type: { type: 'string', enum: ['text', 'html', 'value'], description: '内容类型：text(纯文本)、html(HTML源码)、value(表单值)，默认 text' },
          appId: { type: 'string', description: '浏览器实例标识，不指定则使用 "default"' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_wait',
      description: '等待指定的 CSS 选择器对应的元素出现在页面中。用于等待动态内容加载。',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS 选择器，等待该元素出现' },
          timeout: { type: 'number', description: '超时毫秒数，默认 5000' },
          appId: { type: 'string', description: '浏览器实例标识，不指定则使用 "default"' },
        },
        required: ['selector'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_evaluate',
      description: '在浏览器页面中执行任意 JavaScript 代码。返回执行结果。用于复杂的页面交互、数据提取、或验证操作。',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: '要执行的 JavaScript 表达式或代码' },
          appId: { type: 'string', description: '浏览器实例标识，不指定则使用 "default"' },
        },
        required: ['expression'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_get_info',
      description: '获取当前浏览器页面的基本信息，包括 URL、标题、视口大小等。',
      parameters: {
        type: 'object',
        properties: {
          appId: { type: 'string', description: '浏览器实例标识，不指定则使用 "default"' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_get_console_logs',
      description: '获取外部浏览器控制台日志（按需给 AI）。默认仅返回开发环境日志，并附带最高权重的异常候选（最多 3 条）。',
      parameters: {
        type: 'object',
        properties: {
          appId: { type: 'string', description: '浏览器实例标识，不指定则使用 "default"' },
          limit: { type: 'number', description: '返回日志条数，默认 50，范围 1-200' },
          levels: {
            type: 'array',
            items: { type: 'string', enum: ['log', 'info', 'warn', 'error', 'debug'] },
            description: '日志级别过滤（可选）',
          },
          onlyErrors: { type: 'boolean', description: '仅返回 error 级日志，默认 false' },
          devOnly: { type: 'boolean', description: '仅返回开发环境日志，默认 true' },
          includeCandidates: { type: 'boolean', description: '是否返回高权重异常候选，默认 true' },
          clearAfterRead: { type: 'boolean', description: '读取后清理已返回日志，避免重复读取，默认 true' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_hover',
      description: '通过 CDP 模拟鼠标移动并悬停在页面上指定的元素上。触发该元素的 hover 效果（如 tooltip、下拉菜单等）。支持 CSS 选择器或坐标。',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS 选择器定位元素。与 x/y 二选一' },
          x: { type: 'number', description: '直接指定悬停的 X 坐标' },
          y: { type: 'number', description: '直接指定悬停的 Y 坐标' },
          appId: { type: 'string', description: '浏览器实例标识，不指定则使用 "default"' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_keypress',
      description: '通过 CDP 模拟键盘按键操作。在当前聚焦的元素上按下键盘按键。支持特殊键（Tab、Escape、Enter、ArrowUp/Down/Left/Right、Backspace、Delete 等）和组合键（Ctrl+C、Cmd+V 等）。模拟完整的 keyDown + keyUp 序列。',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: '按键名称，如 "Enter", "Tab", "Escape", "ArrowDown", "ArrowUp", "Backspace", "Delete", "Space", "a", "1" 等。对应 KeyboardEvent.key',
          },
          modifiers: {
            type: 'array',
            items: { type: 'string', enum: ['ctrl', 'alt', 'shift', 'meta'] },
            description: '修饰键列表，如 ["ctrl", "shift"] 表示 Ctrl+Shift 组合键。meta 在 macOS 上是 Cmd 键',
          },
          appId: { type: 'string', description: '浏览器实例标识，不指定则使用 "default"' },
        },
        required: ['key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_drag',
      description: '通过 CDP 模拟鼠标拖拽操作：鼠标移到起点 → 按下 → 多步平滑移动到终点 → 释放。可用选择器或坐标指定起点和终点。',
      parameters: {
        type: 'object',
        properties: {
          fromSelector: { type: 'string', description: '起点元素 CSS 选择器。与 fromX/fromY 二选一' },
          fromX: { type: 'number', description: '起点 X 坐标' },
          fromY: { type: 'number', description: '起点 Y 坐标' },
          toSelector: { type: 'string', description: '终点元素 CSS 选择器。与 toX/toY 二选一' },
          toX: { type: 'number', description: '终点 X 坐标' },
          toY: { type: 'number', description: '终点 Y 坐标' },
          steps: { type: 'number', description: '拖拽插值步数（越多越平滑），默认 10' },
          appId: { type: 'string', description: '浏览器实例标识，不指定则使用 "default"' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_select',
      description: '通过 CDP 模拟操作选择 <select> 下拉框中的选项。模拟流程：鼠标移动到下拉框 → 点击打开 → 键盘上下箭头导航 → 回车确认选择。通过 value 或显示文本匹配选项。',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS 选择器定位 <select> 元素' },
          value: { type: 'string', description: '选项的 value 属性值（优先匹配）' },
          label: { type: 'string', description: '选项的显示文本（value 未匹配时使用）' },
          appId: { type: 'string', description: '浏览器实例标识，不指定则使用 "default"' },
        },
        required: ['selector'],
      },
    },
  },

  /* ---- MCP 工具调用 ---- */
  {
    type: 'function',
    function: {
      name: 'mcp_call',
      description: '调用 MCP (Model Context Protocol) 服务器提供的工具。调用前必须先通过 mcp_list_tools 读取最新 inputSchema 并按 schema 组装 arguments。',
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
      description: '列出所有已启用的 MCP 服务器及其提供的工具。用于发现可用的 MCP 工具。',
      parameters: {
        type: 'object',
        properties: {},
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
      '定位目标后再配合 find_file/read_file 深入；内容搜索统一优先 run_command + rg。',
    ],
  },
  run_command: {
    usage: [
      '用于构建、测试、运行和验证真实结果，优先执行最小必要命令。',
      '明确设置 cwd 到目标项目目录，避免在错误目录执行。',
      '代码搜索默认优先使用 rg；定位文件名可配合 find 命令，搜索不到再拆分关键词继续 rg。',
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
    ],
  },
  read_skill_resource: {
    usage: [
      '仅在某个技能已经通过 `read_skill` 激活后，再按需读取该技能的附属资源文件。',
      'resource_path 必须是技能目录内的相对路径，优先读取具体文件而不是整个目录。',
      '读取 references/scripts/assets/templates 时，读完后要回到任务本身，不要把资源全文反复回灌。',
    ],
    cautions: [
      '如果当前任务还没有成功读取该技能详情，此调用必须被视为无效。',
      '禁止传绝对路径或越界路径。',
    ],
  },
  save_note: {
    usage: [
      '仅记录对后续任务稳定有价值的项目知识（约定、架构、关键配置）。',
      '内容必须可执行、可复用，避免记录闲聊或一次性噪声。',
      '标题简洁、正文具体，分类必须准确。',
    ],
  },
  delete_note: {
    usage: [
      '当用户要求删除或笔记确认过时时调用。',
      '必须使用准确 noteId，删除前确认目标笔记。',
      '删除后给出已删除项，避免用户误解。 ',
    ],
  },
}

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
