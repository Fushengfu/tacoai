/**
 * 工具系统
 *
 * 定义 Agent 模式下 AI 可调用的工具及其执行器。
 * 使用 OpenAI function calling 兼容格式。
 *
 * 【重要】所有工具执行器都是异步的，避免阻塞 Electron 主进程。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { exec, execFile } from 'node:child_process'
import { desktopCapturer, systemPreferences, screen, nativeImage } from 'electron'
import { log } from './logger'
import { executeBrowserAction, getBrowserConsoleSnapshot } from './browser'
import type { BrowserActionType } from '../shared/ipc'
import { saveScreenshot, getActiveMcpTools, callMcpTool } from './mcp'
import { fileToDataUrl, getGuiPlusConfig, runGuiPlus } from './gui-plus'
import { callDesktopService } from './desktop-service'

type DesktopScreenshotMeta = {
  screenshotPath: string
  screenshotWidth: number
  screenshotHeight: number
  displayId: string
  displayWidth: number
  displayHeight: number
  displayBoundsX: number
  displayBoundsY: number
  displayScaleFactor: number
}

// 用于将 GUI-Plus 的截图内坐标映射到屏幕绝对坐标（按截图路径关联）
const desktopScreenshotMetaByPath = new Map<string, DesktopScreenshotMeta>()

type GuiPlusPoint = { x: number; y: number; source: 'xy' | 'x_array' | 'point' | 'xyxy_center' }
type GuiPlusMappedPoint = {
  action: unknown
  x: number
  y: number
  coordinateSpace: 'screen-absolute' | 'image-local'
  localX: number
  localY: number
  originalWidth: number
  originalHeight: number
  scaledWidth: number
  scaledHeight: number
  minPixels: number
  maxPixels: number
  factor: number
  displayId?: string
  displayBoundsX?: number
  displayBoundsY?: number
  displayWidth?: number
  displayHeight?: number
  displayScaleFactor?: number
}

type GuiPlusClickCandidate = {
  imagePath: string
  x: number
  y: number
  timestamp: number
}

type GuiPlusClickGuard = {
  x: number
  y: number
  unstable: boolean
  reason?: string
  imagePath?: string
  timestamp: number
}

const lastGuiPlusClickByImagePath = new Map<string, GuiPlusClickCandidate>()
const pendingGuiPlusClickGuardByScope = new Map<string, GuiPlusClickGuard>()

/* ------------------------------------------------------------------ */
/*  Tool definitions (OpenAI function calling 格式)                     */
/* ------------------------------------------------------------------ */

export type ToolDefinition = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

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
          maxChars: { type: 'number', description: '最大返回字符数（可选，系统会限制上限，建议 <= 24000）' },
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
      name: 'list_directory',
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
      description: '在用户的系统上执行 shell 命令。用于运行构建工具、包管理器、git 操作、启动脚本等。',
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
            items: { type: 'string' },
            description: '具体的执行步骤列表',
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
          stepIndex: { type: 'number', description: '步骤的索引（从 0 开始，对应 propose_plan 中 steps 数组的下标）' },
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
      name: 'search_files',
      description: '在文件内容中搜索关键词或正则表达式，返回匹配行及上下文。优先使用 rg (ripgrep)，自动尊重 .gitignore。结果按文件分组，紧凑高效。用于在代码中定位函数、变量、配置等。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '搜索关键词或正则表达式' },
          directory: { type: 'string', description: '搜索目录（可选，默认项目根目录）' },
          filePattern: { type: 'string', description: '限定文件类型，如 "*.ts"、"*.{ts,tsx}"（可选）' },
          contextLines: { type: 'number', description: '每个匹配项显示的上下文行数，默认 2' },
          maxResults: { type: 'number', description: '最大返回匹配数，默认 30' },
          caseSensitive: { type: 'boolean', description: '是否区分大小写，默认 false' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_note',
      description: '保存一条项目笔记/记忆到持久化存储。在对话过程中，当你从用户消息、代码文件、执行结果中识别到重要的项目上下文信息时（如代码规范、数据库配置、架构决策、技术栈偏好、团队约定等），应立即且主动调用此工具记录。笔记会在后续所有会话中自动注入系统提示词，让 AI 始终了解项目背景。无需征求用户许可即可调用。',
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
      name: 'gui_plus_analyze',
      description: '调用 GUI-Plus 模型分析截图并返回可执行的 GUI 原子操作 JSON。若传 imagePath 且来源于 desktop_screenshot，返回的 mapped.x/mapped.y 为可直接用于 desktop_action 的屏幕绝对坐标。',
      parameters: {
        type: 'object',
        properties: {
          instruction: { type: 'string', description: '对截图的操作指令（必填）' },
          analysisGoal: { type: 'string', description: '分析目标与成功判定标准（建议填写，减少误判）。例如：定位“登录”按钮并返回可点击坐标。' },
          imageDataUrl: { type: 'string', description: '截图 data URL（与 imagePath 二选一）' },
          imagePath: { type: 'string', description: '截图文件路径（与 imageDataUrl 二选一）' },
          minPixels: { type: 'number', description: '图像最小像素阈值（可选）' },
          maxPixels: { type: 'number', description: '图像最大像素阈值（可选）' },
        },
        required: ['instruction'],
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

function normalizeParametersSchema(parameters: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...parameters }
  if (normalized.type === 'object' && normalized.additionalProperties === undefined) {
    normalized.additionalProperties = false
  }
  return normalized
}

for (const definition of toolDefinitions) {
  definition.function.parameters = normalizeParametersSchema(definition.function.parameters)
}

const TOOL_GUIDE_GROUPS: Array<{ title: string; names: string[] }> = [
  {
    title: '代码开发',
    names: ['list_directory', 'find_file', 'search_files', 'read_file', 'write_file', 'edit_file', 'delete_file', 'run_command'],
  },
  {
    title: '计划与记忆',
    names: ['propose_plan', 'update_plan_progress', 'save_note', 'delete_note'],
  },
  {
    title: '浏览器自动化',
    names: ['browser_navigate', 'browser_wait', 'browser_screenshot', 'browser_click', 'browser_type', 'browser_get_content', 'browser_get_console_logs'],
  },
  {
    title: '桌面自动化',
    names: ['desktop_screenshot', 'gui_plus_analyze', 'desktop_action'],
  },
  {
    title: 'MCP',
    names: ['mcp_list_tools', 'mcp_call'],
  },
]

const TOOL_GUIDE_NOTES: Record<string, string> = {
  read_file: '大文件必须分块读取，优先带 startLine/endLine。',
  write_file: '写入后建议 read_file 回读关键片段做落盘校验。',
  edit_file: '用于精确替换局部内容；若存在多处匹配建议设置 expectedOccurrences。',
  run_command: '用于构建/测试/验证，失败时需回报关键信息与下一步。',
  browser_screenshot: '每次截图必须附带明确目标（goal）。',
  browser_get_console_logs: '页面异常优先读取控制台日志，再决定后续操作。',
  gui_plus_analyze: '建议填写 analysisGoal，避免“看图闲聊”与误点击。',
  mcp_list_tools: '先读取 inputSchema，再调用 mcp_call。',
  mcp_call: 'arguments 必须严格按 inputSchema 组装。',
}

function getDefinition(name: string): ToolDefinition | undefined {
  return toolDefinitions.find((item) => item.function.name === name)
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

export function getToolDesignPromptBlock(): string {
  const lines: string[] = [
    '# 工具能力清单（调用前必须遵守）',
    '- 仅调用与当前 intent 匹配的最小必要工具，避免无目的调用。',
    '- 有可执行工具时优先执行，不输出“命令示例”代替真实执行。',
    '- 声称完成前必须提供工具执行证据。',
  ]

  for (const group of TOOL_GUIDE_GROUPS) {
    lines.push(`## ${group.title}`)
    for (const name of group.names) {
      const definition = getDefinition(name)
      if (!definition) continue
      const signature = buildToolSignature(name, definition.function.parameters)
      const desc = shortDescription(definition.function.description)
      const note = TOOL_GUIDE_NOTES[name]
      if (note) {
        lines.push(`- \`${signature}\`：${desc} 关键要求：${note}`)
      } else {
        lines.push(`- \`${signature}\`：${desc}`)
      }
    }
  }

  return lines.join('\n')
}

/**
 * 获取完整的工具定义列表（静态工具 + 动态 MCP 工具描述）。
 * Agent 每次调用时获取最新的工具列表。
 */
export function getAllToolDefinitions(): ToolDefinition[] {
  // 基础工具始终可用
  return [...toolDefinitions]
}

/* ------------------------------------------------------------------ */
/*  Tool call types                                                    */
/* ------------------------------------------------------------------ */

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
/*  Workspace 安全检查                                                  */
/* ------------------------------------------------------------------ */

type ExecResult = { content: string; success: boolean }

function makeAbortError(): Error {
  const err = new Error('Aborted')
  err.name = 'AbortError'
  return err
}

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return err.name === 'AbortError' || err.message === 'Aborted'
}

/** 解析路径：相对于 workspace，并检查是否在 workspace 内 */
function resolveSafe(workspace: string, filePath: string): { resolved: string } | { error: string } {
  const normalizedWs = path.normalize(workspace)

  // ── 0) 如果是绝对路径且在 workspace 内，直接使用 ──
  if (path.isAbsolute(filePath)) {
    const normalizedFp = path.normalize(filePath)
    if (normalizedFp.startsWith(normalizedWs + path.sep) || normalizedFp === normalizedWs) {
      return { resolved: normalizedFp }
    }
    // 绝对路径但在 workspace 外 → 尝试提取相对部分
    // AI 可能传了完整路径如 "/Users/foo/project/src/a.ts"
    // 对于不在 workspace 的绝对路径，拒绝
  }

  // ── 路径清洗：修正 AI 常见的错误路径格式 ──
  let cleaned = filePath

  // 1) 去掉前导斜杠（AI 经常传 "/mobile" 导致变成系统根目录）
  cleaned = cleaned.replace(/^\/+/, '')

  // 2) 如果 AI 传了工作空间名作为前缀（如 "myproject/src" 但工作空间就是 myproject），去掉重复部分
  const wsName = path.basename(workspace)
  if (cleaned.startsWith(wsName + '/') || cleaned.startsWith(wsName + '\\')) {
    const without = cleaned.slice(wsName.length + 1)
    const testResolved = path.resolve(workspace, without)
    if (testResolved.startsWith(normalizedWs)) {
      cleaned = without
    }
  }

  // 3) 去掉尾部斜杠
  cleaned = cleaned.replace(/\/+$/, '')

  // 空路径视为当前目录
  if (!cleaned) cleaned = '.'

  const resolved = path.resolve(workspace, cleaned)
  const normalized = path.normalize(resolved)
  if (!normalized.startsWith(normalizedWs)) {
    return { error: `安全限制：路径 "${filePath}" 超出工作空间 "${workspace}"（解析为 ${normalized}）` }
  }
  return { resolved: normalized }
}

/**
 * 智能路径解析：先尝试直接路径，如果找不到则在项目中搜索匹配的目录/文件。
 * 解决 AI 经常只传目录名（如 "components"）而非完整相对路径（如 "src/renderer/components"）的问题。
 *
 * @returns { resolved, corrected? } — corrected 为纠正后的相对路径（仅在自动纠正时存在）
 */
async function resolveSmartPath(
  workspace: string,
  filePath: string,
  kind: 'directory' | 'file' | 'any' = 'any',
): Promise<{ resolved: string; corrected?: string } | { error: string }> {
  // 1) 直接解析
  const check = resolveSafe(workspace, filePath)
  if ('error' in check) return check

  // 2) 直接路径存在 → 直接返回
  try {
    const stat = await fs.stat(check.resolved)
    if (kind === 'directory' && !stat.isDirectory()) {
      // 期望目录但拿到了文件，继续搜索
    } else if (kind === 'file' && !stat.isFile()) {
      // 期望文件但拿到了目录，继续搜索
    } else {
      return { resolved: check.resolved }
    }
  } catch {
    // 路径不存在，进入搜索
  }

  // 3) 在项目中搜索匹配的路径
  const searchName = filePath.replace(/^\.\//, '').replace(/\/+$/, '')
  if (!searchName || searchName === '.') return { error: `路径不存在: ${filePath}` }

  let candidates: string[] = []

  try {
    // 优先 git ls-files
    const { stdout } = await execAsync(
      'git ls-files --cached --others --exclude-standard',
      { cwd: workspace, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }
    )
    const allFiles = stdout.trim().split('\n').filter(Boolean)

    if (kind === 'file' || kind === 'any') {
      // 匹配文件：尾部匹配
      candidates = allFiles.filter((f) =>
        f === searchName || f.endsWith('/' + searchName)
      )
    }

    if ((kind === 'directory' || kind === 'any') && candidates.length === 0) {
      // 匹配目录：从文件路径中提取所有目录，找尾部匹配的
      const dirs = new Set<string>()
      for (const f of allFiles) {
        const parts = f.split('/')
        for (let i = 1; i < parts.length; i++) {
          dirs.add(parts.slice(0, i).join('/'))
        }
      }
      candidates = [...dirs].filter((d) =>
        d === searchName || d.endsWith('/' + searchName)
      )
    }
  } catch {
    // git 不可用，回退到 fs 搜索
    try {
      const found: string[] = []
      const IGNORE = new Set(['.git', 'node_modules', '.next', '__pycache__', '.venv', 'dist', '.cache', '.turbo', 'coverage', 'release'])
      async function scan(dir: string, depth: number) {
        if (depth > 8 || found.length >= 5) return
        const items = await fs.readdir(dir, { withFileTypes: true })
        for (const item of items) {
          if (IGNORE.has(item.name)) continue
          const rel = path.relative(workspace, path.join(dir, item.name))
          if (item.isDirectory()) {
            if (rel === searchName || rel.endsWith('/' + searchName) || rel.endsWith(path.sep + searchName)) {
              found.push(rel)
            }
            await scan(path.join(dir, item.name), depth + 1)
          } else if (kind !== 'directory') {
            if (rel === searchName || rel.endsWith('/' + searchName) || rel.endsWith(path.sep + searchName)) {
              found.push(rel)
            }
          }
        }
      }
      await scan(workspace, 0)
      candidates = found
    } catch { /* ignore */ }
  }

  if (candidates.length === 0) {
    // 列出顶层目录帮助 AI 自我纠正
    let topDirs = ''
    try {
      const items = await fs.readdir(workspace, { withFileTypes: true })
      const dirs = items.filter((i) => i.isDirectory() && !i.name.startsWith('.')).map((i) => i.name + '/').slice(0, 20)
      if (dirs.length > 0) topDirs = `\n工作空间顶层目录: ${dirs.join(', ')}`
    } catch { /* ignore */ }
    return { error: `路径不存在: "${filePath}"（在工作空间 "${workspace}" 中未找到匹配的 "${searchName}"）${topDirs}\n请使用相对于工作空间根目录的路径，如 "src/components" 而非 "components"` }
  }

  // 4) 选最短路径（通常最接近用户意图）
  candidates.sort((a, b) => a.length - b.length)
  const best = candidates[0]
  const bestResolved = path.resolve(workspace, best)

  // 安全检查
  if (!path.normalize(bestResolved).startsWith(path.normalize(workspace))) {
    return { error: `安全限制：纠正后路径超出工作空间` }
  }

  // 有多个候选时把所有候选列出来供参考
  const hint = candidates.length > 1
    ? `\n（还有其他匹配: ${candidates.slice(1, 4).join(', ')}${candidates.length > 4 ? '...' : ''}）`
    : ''

  return { resolved: bestResolved, corrected: best + hint }
}

/* ------------------------------------------------------------------ */
/*  异步 exec 包装                                                      */
/* ------------------------------------------------------------------ */

let commandEnvCache: NodeJS.ProcessEnv | null = null
let commandEnvLoadingPromise: Promise<NodeJS.ProcessEnv> | null = null

function parseNulSeparatedEnv(raw: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const item of raw.split('\0')) {
    if (!item) continue
    const eq = item.indexOf('=')
    if (eq <= 0) continue
    const key = item.slice(0, eq)
    const value = item.slice(eq + 1)
    if (!key) continue
    env[key] = value
  }
  return env
}

function mergePathValue(primary: string, secondary: string): string {
  const sep = process.platform === 'win32' ? ';' : ':'
  const seen = new Set<string>()
  const normalize = (p: string) => process.platform === 'win32'
    ? p.toLowerCase().replace(/[/\\]+$/, '')
    : p
  const merged: string[] = []
  for (const raw of `${primary}${sep}${secondary}`.split(sep)) {
    const p = raw.trim()
    if (!p) continue
    const key = normalize(p)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(p)
  }
  return merged.join(sep)
}

async function loadLoginShellEnv(): Promise<NodeJS.ProcessEnv> {
  if (process.platform === 'win32') return {}
  const shell = process.env.SHELL || '/bin/zsh'
  const attempts: Array<{ args: string[]; mode: string }> = [
    { args: ['-ilc', 'env -0'], mode: 'login-interactive' },
    { args: ['-lc', 'env -0'], mode: 'login' },
  ]

  for (const attempt of attempts) {
    try {
      const output = await new Promise<string>((resolve, reject) => {
        execFile(shell, attempt.args, {
          encoding: 'utf8',
          timeout: 8000,
          maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env },
        }, (err, stdout) => {
          if (err) {
            reject(err)
            return
          }
          resolve(stdout ?? '')
        })
      })
      const parsed = parseNulSeparatedEnv(output)
      if (Object.keys(parsed).length > 0) {
        log('RUN_COMMAND_ENV_READY', { mode: attempt.mode, shell, envKeys: Object.keys(parsed).length })
        return parsed
      }
    } catch (err) {
      log('RUN_COMMAND_ENV_LOAD_FAIL', {
        mode: attempt.mode,
        shell,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return {}
}

async function getRunCommandEnv(): Promise<NodeJS.ProcessEnv> {
  if (commandEnvCache) return commandEnvCache
  if (commandEnvLoadingPromise) return commandEnvLoadingPromise

  commandEnvLoadingPromise = (async () => {
    const systemEnv: NodeJS.ProcessEnv = { ...process.env }
    const shellEnv = await loadLoginShellEnv()
    const merged: NodeJS.ProcessEnv = { ...systemEnv, ...shellEnv }

    const shellPath = shellEnv.PATH || shellEnv.Path
    const systemPath = systemEnv.PATH || systemEnv.Path
    if (shellPath && systemPath) {
      const pathValue = mergePathValue(shellPath, systemPath)
      merged.PATH = pathValue
      merged.Path = pathValue
    }

    commandEnvCache = merged
    return merged
  })()

  try {
    return await commandEnvLoadingPromise
  } finally {
    commandEnvLoadingPromise = null
  }
}

/** 异步执行 shell 命令，带超时和输出限制 */
function execAsync(
  command: string,
  options: { cwd: string; timeout: number; maxBuffer?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(makeAbortError())
      return
    }

    let settled = false
    const child = exec(command, {
      cwd: options.cwd,
      timeout: options.timeout,
      maxBuffer: options.maxBuffer ?? 1024 * 1024,
      encoding: 'utf-8',
      env: options.env,
    }, (err, stdout, stderr) => {
      if (settled) return
      settled = true
      cleanup()
      if (err) {
        // exec 错误也带上 stdout/stderr 供调用方使用
        const error = err as Error & { stdout?: string; stderr?: string }
        error.stdout = stdout ?? ''
        error.stderr = stderr ?? ''
        reject(error)
      } else {
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '' })
      }
    })

    // 额外保护：进程退出超时后强制 kill
    const killTimer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* ignore */ }
    }, options.timeout + 5000)

    const onAbort = () => {
      if (settled) return
      settled = true
      try { child.kill('SIGTERM') } catch { /* ignore */ }
      cleanup()
      reject(makeAbortError())
    }

    const cleanup = () => {
      clearTimeout(killTimer)
      if (options.signal) options.signal.removeEventListener('abort', onAbort)
    }

    if (options.signal) options.signal.addEventListener('abort', onAbort, { once: true })

    child.on('exit', cleanup)
    child.on('error', cleanup)
  })
}

/* ------------------------------------------------------------------ */
/*  异步 Tool executors（所有文件操作限制在 workspace 内）                */
/* ------------------------------------------------------------------ */

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  workspace: string,
  signal?: AbortSignal,
  projectId?: string,
  logScope?: string,
): Promise<ExecResult & { fileChange?: FileChange }> {
  try {
    if (signal?.aborted) throw makeAbortError()
    switch (name) {
      case 'read_file':
        return await execReadFile(args, workspace)
      case 'write_file':
        return await execWriteFile(args, workspace)
      case 'edit_file':
        return await execEditFile(args, workspace)
      case 'delete_file':
        return await execDeleteFile(args, workspace)
      case 'list_directory':
        return await execListDirectory(args, workspace)
      case 'run_command':
        return await execRunCommand(args, workspace, signal)
      case 'find_file':
        return await execFindFile(args, workspace)
      case 'search_files':
        return await execSearchFiles(args, workspace)
      case 'save_note':
        return await execSaveNote(args, workspace, projectId)
      case 'delete_note':
        return await execDeleteNote(args, workspace, projectId)
      /* ---- 浏览器自动化 ---- */
      case 'browser_navigate':
        return await execBrowserAction('navigate', args, projectId)
      case 'browser_screenshot':
        return await execBrowserAction('screenshot', args, projectId)
      case 'desktop_screenshot':
        return await execDesktopScreenshot(args, logScope)
      case 'browser_click':
        return await execBrowserAction('click', args, projectId)
      case 'browser_type':
        return await execBrowserAction('type', args, projectId)
      case 'browser_scroll':
        return await execBrowserAction('scroll', args, projectId)
      case 'browser_get_content':
        return await execBrowserAction('get_content', args, projectId)
      case 'browser_wait':
        return await execBrowserAction('wait', args, projectId)
      case 'browser_evaluate':
        return await execBrowserAction('evaluate', args, projectId)
      case 'browser_get_info':
        return await execBrowserAction('get_info', args, projectId)
      case 'browser_get_console_logs':
        return await execBrowserGetConsoleLogs(args, projectId)
      case 'browser_hover':
        return await execBrowserAction('hover', args, projectId)
      case 'browser_keypress':
        return await execBrowserAction('keypress', args, projectId)
      case 'browser_drag':
        return await execBrowserAction('drag', args, projectId)
      case 'browser_select':
        return await execBrowserAction('select', args, projectId)
      case 'gui_plus_analyze':
        return await execGuiPlusAnalyze(args, signal, logScope)
      case 'desktop_action':
        return await execDesktopAction(args, signal, logScope)
      /* ---- MCP ---- */
      case 'mcp_call':
        return await execMcpCall(args, signal)
      case 'mcp_list_tools':
        return await execMcpListTools()
      default:
        return { content: `Unknown tool: ${name}`, success: false }
    }
  } catch (err) {
    if (isAbortError(err)) throw err
    const msg = err instanceof Error ? err.message : String(err)
    return { content: `Error: ${msg}`, success: false }
  }
}

async function execReadFile(args: Record<string, unknown>, workspace: string): Promise<ExecResult> {
  const filePath = String(args.path ?? '')
  if (!filePath) return { content: 'Error: path is required', success: false }
  const rawStartLine = Number(args.startLine)
  const rawEndLine = Number(args.endLine)
  const rawMaxChars = Number(args.maxChars)

  const check = await resolveSmartPath(workspace, filePath, 'file')
  if ('error' in check) return { content: check.error, success: false }
  const resolved = check.resolved
  const correctedNote = check.corrected ? `[自动纠正路径: "${filePath}" → "${check.corrected.split('\n')[0]}"]\n` : ''

  try {
    const stat = await fs.stat(resolved)
    if (!stat.isFile()) return { content: `Error: Not a file: ${resolved}`, success: false }
    if (stat.size > 1024 * 1024) return { content: `Error: File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB), max 1MB`, success: false }
    const fullContent = await fs.readFile(resolved, 'utf-8')
    const lines = fullContent.split('\n')
    const totalLines = lines.length

    const DEFAULT_MAX_CHARS = 24000
    const HARD_MAX_CHARS = 28000
    const maxChars = Number.isFinite(rawMaxChars) && rawMaxChars > 0
      ? Math.min(Math.floor(rawMaxChars), HARD_MAX_CHARS)
      : DEFAULT_MAX_CHARS

    let startLine = Number.isFinite(rawStartLine) && rawStartLine > 0 ? Math.floor(rawStartLine) : 1
    let endLine = Number.isFinite(rawEndLine) && rawEndLine > 0 ? Math.floor(rawEndLine) : totalLines
    startLine = Math.max(1, Math.min(startLine, Math.max(1, totalLines)))
    endLine = Math.max(startLine, Math.min(endLine, Math.max(1, totalLines)))

    let actualEndLine = endLine
    let chunk = lines.slice(startLine - 1, endLine).join('\n')
    let truncatedByChars = false
    if (chunk.length > maxChars) {
      truncatedByChars = true
      let acc = ''
      actualEndLine = startLine - 1
      for (let i = startLine - 1; i < endLine; i++) {
        const line = lines[i] ?? ''
        const next = acc ? `${acc}\n${line}` : line
        if (next.length > maxChars) {
          if (!acc) {
            // 极端情况：单行超长，至少返回一段并标记当前行
            acc = next.slice(0, maxChars)
            actualEndLine = i + 1
          }
          break
        }
        acc = next
        actualEndLine = i + 1
      }
      chunk = acc
    }

    const hasRemainingBefore = startLine > 1
    const hasRemainingAfter = actualEndLine < totalLines
    const partial = hasRemainingBefore || hasRemainingAfter || truncatedByChars

    const nextStartLine = Math.min(totalLines, actualEndLine + 1)
    const nextEndLine = Math.min(totalLines, nextStartLine + 199)
    const prevEndLine = startLine - 1
    const prevStartLine = Math.max(1, prevEndLine - 199)

    const meta: string[] = [
      `[read_file] path: ${resolved}`,
      `[read_file] lines: ${startLine}-${actualEndLine}/${totalLines}`,
      `[read_file] chars: ${chunk.length}/${fullContent.length}`,
      `[read_file] partial: ${partial ? 'yes' : 'no'}`,
    ]
    if (hasRemainingBefore) {
      meta.push(`[read_file] previous_chunk_hint: read_file(path="${filePath}", startLine=${prevStartLine}, endLine=${prevEndLine})`)
    }
    if (hasRemainingAfter) {
      meta.push(`[read_file] next_chunk_hint: read_file(path="${filePath}", startLine=${nextStartLine}, endLine=${nextEndLine})`)
    }

    const guidance = partial
      ? '\n\n[提示] 当前仅返回文件的部分内容。继续编码前，请按需调用 read_file 的 startLine/endLine 分块读取剩余范围。'
      : ''

    return {
      content: correctedNote + meta.join('\n') + '\n\n' + chunk + guidance,
      success: true,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { content: `Error: File not found: ${resolved}`, success: false }
    }
    throw err
  }
}

async function execWriteFile(args: Record<string, unknown>, workspace: string): Promise<ExecResult & { fileChange?: FileChange }> {
  const filePath = String(args.path ?? '')
  const fileContent = String(args.content ?? '')
  if (!filePath) return { content: 'Error: path is required', success: false }
  const check = resolveSafe(workspace, filePath)
  if ('error' in check) return { content: check.error, success: false }
  const resolved = check.resolved

  // 记录旧内容（用于 diff）
  let oldContent: string | null = null
  try {
    const stat = await fs.stat(resolved)
    if (stat.isFile()) {
      oldContent = await fs.readFile(resolved, 'utf-8')
    }
  } catch {
    // 文件不存在 → 新建
  }

  const dir = path.dirname(resolved)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(resolved, fileContent, 'utf-8')

  // 返回相对路径用于前端展示（统一为 /，避免 Windows 下路径分隔符导致树结构展示异常）
  const relPath = toPosixPath(path.relative(workspace, resolved))
  return {
    content: `File written: ${resolved} (${fileContent.length} chars)`,
    success: true,
    fileChange: { filePath: relPath, oldContent, newContent: fileContent },
  }
}

function countTextOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let start = 0
  while (true) {
    const idx = haystack.indexOf(needle, start)
    if (idx < 0) break
    count += 1
    start = idx + needle.length
  }
  return count
}

async function execEditFile(args: Record<string, unknown>, workspace: string): Promise<ExecResult & { fileChange?: FileChange }> {
  const filePath = String(args.path ?? '')
  const oldText = String(args.oldText ?? '')
  const newText = String(args.newText ?? '')
  const replaceAll = Boolean(args.replaceAll ?? false)
  const expectedRaw = Number(args.expectedOccurrences)

  if (!filePath) return { content: 'Error: path is required', success: false }
  if (!oldText) return { content: 'Error: oldText is required and cannot be empty', success: false }

  const check = resolveSafe(workspace, filePath)
  if ('error' in check) return { content: check.error, success: false }
  const resolved = check.resolved

  let oldContent: string
  try {
    const stat = await fs.stat(resolved)
    if (!stat.isFile()) return { content: `Error: Not a file: ${resolved}`, success: false }
    oldContent = await fs.readFile(resolved, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { content: `Error: File not found: ${resolved}`, success: false }
    }
    throw err
  }

  const occurrences = countTextOccurrences(oldContent, oldText)
  if (occurrences === 0) {
    return { content: `Error: oldText not found in file: ${resolved}`, success: false }
  }
  if (Number.isFinite(expectedRaw) && expectedRaw >= 0 && occurrences !== Math.floor(expectedRaw)) {
    return {
      content: `Error: expectedOccurrences mismatch for ${resolved}, expected=${Math.floor(expectedRaw)}, actual=${occurrences}`,
      success: false,
    }
  }

  const replacedCount = replaceAll ? occurrences : 1
  const newContent = replaceAll
    ? oldContent.split(oldText).join(newText)
    : oldContent.replace(oldText, newText)

  if (newContent === oldContent) {
    return { content: `Error: edit produced no changes for ${resolved}`, success: false }
  }

  await fs.writeFile(resolved, newContent, 'utf-8')

  const relPath = toPosixPath(path.relative(workspace, resolved))
  return {
    content: `File edited: ${resolved} (replaced ${replacedCount} occurrence${replacedCount > 1 ? 's' : ''})`,
    success: true,
    fileChange: { filePath: relPath, oldContent, newContent },
  }
}

async function execDeleteFile(args: Record<string, unknown>, workspace: string): Promise<ExecResult & { fileChange?: FileChange }> {
  const filePath = String(args.path ?? '')
  if (!filePath) return { content: 'Error: path is required', success: false }
  const check = resolveSafe(workspace, filePath)
  if ('error' in check) return { content: check.error, success: false }
  const resolved = check.resolved

  // 读取旧内容（用于支持撤销恢复）
  let oldContent: string | null = null
  try {
    const stat = await fs.stat(resolved)
    if (!stat.isFile()) return { content: `Error: Not a file: ${resolved}`, success: false }
    oldContent = await fs.readFile(resolved, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { content: `Error: File not found: ${resolved}`, success: false }
    }
    throw err
  }

  await fs.unlink(resolved)

  // 返回相对路径用于前端展示（统一为 /，避免 Windows 下路径分隔符导致树结构展示异常）
  const relPath = toPosixPath(path.relative(workspace, resolved))
  return {
    content: `File deleted: ${resolved}`,
    success: true,
    fileChange: { filePath: relPath, oldContent, newContent: null },
  }
}

/* ------------------------------------------------------------------ */
/*  共享文件收集工具                                                      */
/* ------------------------------------------------------------------ */

/** fs.readdir 递归时忽略的目录/文件名 */
const FS_IGNORE = new Set([
  '.git', 'node_modules', '.next', '__pycache__', '.venv', 'venv',
  'dist', '.cache', '.turbo', 'coverage', 'release', '.nuxt',
  '.output', '.svelte-kit', '.parcel-cache', '.DS_Store',
])

type WorkspaceEntryKind = 'file' | 'directory'

type WorkspaceEntry = {
  path: string
  name: string
  kind: WorkspaceEntryKind
  depth: number
}

type CollectWorkspaceOptions = {
  maxDepth?: number
  includeHidden?: boolean
  maxEntries?: number
}

type TreeRenderOptions = {
  maxDepth: number
  includeFiles: boolean
  maxLines?: number
}

type TreeRenderResult = {
  text: string
  stats: {
    directoryCount: number
    fileCount: number
    lineCount: number
  }
  truncated: boolean
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.floor(parsed)))
}

function toPosixPath(input: string): string {
  return input.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '').replace(/\/$/, '')
}

function isHiddenPath(relPath: string): boolean {
  return relPath.split('/').some((segment) => segment.startsWith('.'))
}

function shouldSkipName(name: string, includeHidden: boolean): boolean {
  if (FS_IGNORE.has(name)) return true
  if (!includeHidden && name.startsWith('.')) return true
  return false
}

function addDirectoryAncestors(relPath: string, dirSet: Set<string>) {
  const parts = relPath.split('/')
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join('/')
    if (dir) dirSet.add(dir)
  }
}

function buildWorkspaceEntries(fileSet: Set<string>, dirSet: Set<string>): WorkspaceEntry[] {
  const entries: WorkspaceEntry[] = []
  for (const dir of dirSet) {
    const clean = toPosixPath(dir)
    if (!clean) continue
    entries.push({
      path: clean,
      name: clean.split('/').pop() || clean,
      kind: 'directory',
      depth: clean.split('/').length,
    })
  }
  for (const file of fileSet) {
    const clean = toPosixPath(file)
    if (!clean) continue
    entries.push({
      path: clean,
      name: clean.split('/').pop() || clean,
      kind: 'file',
      depth: clean.split('/').length,
    })
  }
  entries.sort((a, b) => a.path.localeCompare(b.path))
  return entries
}

async function hasDirectoryContent(dir: string): Promise<boolean> {
  try {
    const items = await fs.readdir(dir)
    return items.length > 0
  } catch {
    return false
  }
}

/**
 * 统一的工作区索引收集器。
 *
 * 优先使用 git ls-files（快且尊重 .gitignore），失败时回退到 fs.readdir。
 * 返回统一的 file/directory 条目，供 list_directory / find_file 复用。
 */
async function collectWorkspaceEntries(
  rootDir: string,
  options: CollectWorkspaceOptions = {},
): Promise<{ entries: WorkspaceEntry[]; truncated: boolean }> {
  const maxDepth = clampNumber(options.maxDepth, 1, 24, 12)
  const maxEntries = clampNumber(options.maxEntries, 200, 10000, 4000)
  const includeHidden = Boolean(options.includeHidden)
  const fileSet = new Set<string>()
  const dirSet = new Set<string>()
  let truncated = false

  // 方法一：git ls-files
  try {
    await execAsync('git rev-parse --show-toplevel', { cwd: rootDir, timeout: 3000 })
    const { stdout } = await execAsync(
      'git ls-files --cached --others --exclude-standard',
      { cwd: rootDir, timeout: 6000, maxBuffer: 8 * 1024 * 1024 },
    )
    const files = stdout.trim().split('\n').filter(Boolean)
    if (files.length > 0 || !(await hasDirectoryContent(rootDir))) {
      for (const raw of files) {
        if (fileSet.size + dirSet.size >= maxEntries) {
          truncated = true
          break
        }
        const relPath = toPosixPath(raw)
        if (!relPath) continue
        if (!includeHidden && isHiddenPath(relPath)) continue
        if (relPath.split('/').length > maxDepth + 8) {
          truncated = true
          continue
        }
        fileSet.add(relPath)
        addDirectoryAncestors(relPath, dirSet)
      }
      return { entries: buildWorkspaceEntries(fileSet, dirSet), truncated }
    }
  } catch {
    // 非 git 仓库或 git 不可用，回退到 fs.readdir
  }

  // 方法二：fs.readdir 递归
  const scanDepth = Math.min(maxDepth + 8, 24)
  async function scan(absDir: string, relDir: string, depth: number) {
    if (depth > scanDepth || fileSet.size + dirSet.size >= maxEntries) {
      truncated = true
      return
    }
    let items: Array<import('node:fs').Dirent>
    try {
      items = await fs.readdir(absDir, { withFileTypes: true })
    } catch {
      return
    }
    items.sort((a, b) => a.name.localeCompare(b.name))

    for (const item of items) {
      if (shouldSkipName(item.name, includeHidden)) continue

      const relPath = toPosixPath(relDir ? `${relDir}/${item.name}` : item.name)
      if (!relPath) continue

      if (item.isDirectory()) {
        dirSet.add(relPath)
        await scan(path.join(absDir, item.name), relPath, depth + 1)
      } else if (item.isFile()) {
        fileSet.add(relPath)
        addDirectoryAncestors(relPath, dirSet)
      }

      if (fileSet.size + dirSet.size >= maxEntries) {
        truncated = true
        break
      }
    }
  }

  await scan(rootDir, '', 1)
  return { entries: buildWorkspaceEntries(fileSet, dirSet), truncated }
}

function buildDirectoryTree(entries: WorkspaceEntry[], options: TreeRenderOptions): TreeRenderResult {
  type TreeNode = {
    name: string
    path: string
    kind: 'root' | WorkspaceEntryKind
    children: Map<string, TreeNode>
    fileCount: number
    dirCount: number
  }

  const root: TreeNode = {
    name: '.',
    path: '',
    kind: 'root',
    children: new Map(),
    fileCount: 0,
    dirCount: 0,
  }

  for (const entry of entries) {
    const parts = entry.path.split('/')
    let cursor = root
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const isLeaf = i === parts.length - 1
      const childPath = parts.slice(0, i + 1).join('/')
      const expectedKind: WorkspaceEntryKind = isLeaf ? entry.kind : 'directory'
      let child = cursor.children.get(part)
      if (!child) {
        child = {
          name: part,
          path: childPath,
          kind: expectedKind,
          children: new Map(),
          fileCount: 0,
          dirCount: 0,
        }
        cursor.children.set(part, child)
      } else if (child.kind === 'file' && expectedKind === 'directory') {
        child.kind = 'directory'
      }
      cursor = child
    }
  }

  function computeStats(node: TreeNode): { files: number; dirs: number } {
    if (node.kind === 'file') {
      node.fileCount = 1
      node.dirCount = 0
      return { files: 1, dirs: 0 }
    }
    let files = 0
    let dirs = 0
    for (const child of node.children.values()) {
      const sub = computeStats(child)
      files += sub.files
      dirs += sub.dirs + (child.kind === 'directory' ? 1 : 0)
    }
    node.fileCount = files
    node.dirCount = dirs
    return { files, dirs }
  }
  computeStats(root)

  const maxLines = clampNumber(options.maxLines, 20, 1200, 500)
  const lines: string[] = []
  let truncated = false

  function renderChildren(node: TreeNode, prefix: string, depth: number) {
    const children = [...node.children.values()].sort((a, b) => {
      const aIsDir = a.kind === 'directory'
      const bIsDir = b.kind === 'directory'
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })

    for (let i = 0; i < children.length; i++) {
      if (lines.length >= maxLines) {
        truncated = true
        return
      }
      const child = children[i]
      const isLast = i === children.length - 1
      const connector = isLast ? '└── ' : '├── '
      const nextPrefix = prefix + (isLast ? '    ' : '│   ')

      if (child.kind === 'file') {
        if (options.includeFiles) {
          lines.push(`${prefix}${connector}${child.name}`)
        }
        continue
      }

      if (depth >= options.maxDepth) {
        lines.push(
          `${prefix}${connector}${child.name}/ (${child.dirCount} dirs, ${child.fileCount} files)`,
        )
        continue
      }

      lines.push(`${prefix}${connector}${child.name}/`)
      renderChildren(child, nextPrefix, depth + 1)
      if (truncated) return
    }
  }

  renderChildren(root, '', 1)

  return {
    text: lines.join('\n'),
    stats: {
      directoryCount: root.dirCount,
      fileCount: root.fileCount,
      lineCount: lines.length,
    },
    truncated,
  }
}

/* ------------------------------------------------------------------ */
/*  getWorkspaceTree / execListDirectory                                */
/* ------------------------------------------------------------------ */

/**
 * 获取工作空间的紧凑目录树（公共接口，供 agent 启动时注入上下文使用）
 */
export async function getWorkspaceTree(workspace: string, maxDepth = 6, showFiles = true): Promise<string> {
  const depth = clampNumber(maxDepth, 1, 12, 6)
  const { entries, truncated: scanTruncated } = await collectWorkspaceEntries(workspace, {
    maxDepth: depth + 8,
    includeHidden: false,
    maxEntries: 5000,
  })
  const tree = buildDirectoryTree(entries, { maxDepth: depth, includeFiles: showFiles, maxLines: 600 })
  const truncationNote = scanTruncated || tree.truncated ? '\n... (truncated)' : ''
  const body = tree.text.trim() || '(empty)'
  return `./ (${tree.stats.directoryCount} dirs, ${tree.stats.fileCount} files)\n${body}${truncationNote}`
}

async function execListDirectory(args: Record<string, unknown>, workspace: string): Promise<ExecResult> {
  const dirPath = String(args.path ?? '.')
  const maxDepth = clampNumber(args.maxDepth, 1, 12, 4)
  const includeFiles = args.includeFiles === undefined ? args.showFiles !== false : Boolean(args.includeFiles)
  const includeHidden = Boolean(args.includeHidden)
  const maxEntries = clampNumber(args.maxEntries, 200, 10000, 4000)

  const check = await resolveSmartPath(workspace, dirPath, 'directory')
  if ('error' in check) return { content: check.error, success: false }
  const resolved = check.resolved
  const correctedNote = check.corrected
    ? `[自动纠正路径: "${dirPath}" → "${check.corrected.split('\n')[0]}"]\n`
    : ''

  const relDir = path.relative(workspace, resolved) || '.'
  const { entries, truncated: scanTruncated } = await collectWorkspaceEntries(resolved, {
    maxDepth: maxDepth + 8,
    includeHidden,
    maxEntries,
  })
  const tree = buildDirectoryTree(entries, {
    maxDepth,
    includeFiles,
    maxLines: 500,
  })

  if (entries.length === 0) {
    return {
      content: `${correctedNote}${relDir}/\nSummary: 0 dirs, 0 files\n(empty directory or ignored by filters)`,
      success: true,
    }
  }

  const notes: string[] = []
  if (scanTruncated) notes.push(`scan truncated at ${maxEntries} entries`)
  if (tree.truncated) notes.push('output truncated by line limit')

  const lines = [
    `${relDir}/`,
    `Summary: ${tree.stats.directoryCount} dirs, ${tree.stats.fileCount} files`,
    tree.text || '(empty)',
  ]
  if (notes.length > 0) lines.push(`Notes: ${notes.join('; ')}`)

  return { content: correctedNote + lines.join('\n'), success: true }
}

async function execRunCommand(args: Record<string, unknown>, workspace: string, signal?: AbortSignal): Promise<ExecResult> {
  const command = String(args.command ?? '')
  if (!command) return { content: 'Error: command is required', success: false }
  // cwd 默认为 workspace，如果指定了也必须在 workspace 内
  let cwd = workspace
  if (args.cwd) {
    const check = resolveSafe(workspace, String(args.cwd))
    if ('error' in check) return { content: check.error, success: false }
    cwd = check.resolved
  }
  try {
    const env = await getRunCommandEnv()
    const { stdout } = await execAsync(command, {
      cwd,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      signal,
      env,
    })
    return { content: stdout || '(no output)', success: true }
  } catch (err: unknown) {
    if (isAbortError(err)) return { content: '命令执行已取消', success: false }
    const execErr = err as { stderr?: string; stdout?: string; message?: string }
    const stderr = execErr.stderr || ''
    const stdout = execErr.stdout || ''
    return { content: `Exit with error:\n${stderr || stdout || execErr.message || 'Unknown error'}`, success: false }
  }
}

/* ---- find_file：按文件名 / glob 模式快速查找 ---- */

type FindMode = 'auto' | 'fuzzy' | 'glob' | 'exact'

function chooseFindMode(pattern: string, requested: FindMode): Exclude<FindMode, 'auto'> {
  if (requested !== 'auto') return requested
  return /[*?{]/.test(pattern) ? 'glob' : 'fuzzy'
}

function isSubsequence(query: string, text: string): boolean {
  let qi = 0
  let ti = 0
  while (qi < query.length && ti < text.length) {
    if (query[qi] === text[ti]) qi++
    ti++
  }
  return qi === query.length
}

function scoreFindMatch(
  entry: WorkspaceEntry,
  pattern: string,
  mode: Exclude<FindMode, 'auto'>,
  globRe?: RegExp,
): number {
  const p = pattern.toLowerCase()
  const name = entry.name.toLowerCase()
  const full = entry.path.toLowerCase()
  const hasPathSep = p.includes('/')

  if (mode === 'exact') {
    if (name === p) return 1200 - entry.depth * 2
    if (full === p) return 1160 - entry.depth * 2
    if (full.endsWith(`/${p}`)) return 1100 - entry.depth * 2
    return -1
  }

  if (mode === 'glob') {
    const re = globRe ?? globToRegex(pattern)
    const matched = hasPathSep
      ? re.test(full)
      : re.test(name) || re.test(full)
    if (!matched) return -1
    const precisionBonus = full === p ? 80 : name === p ? 60 : 0
    return 900 + precisionBonus - entry.depth * 2
  }

  // fuzzy
  let score = -1
  if (name === p) score = 1000
  else if (full === p) score = 980
  else if (name.startsWith(p)) score = 860
  else if (name.includes(p)) score = 760
  else if (isSubsequence(p, name)) score = 680
  else if (full.includes(p)) score = 620
  else if (isSubsequence(p, full)) score = 520

  if (score < 0) return -1
  // 目录结果略微提高权重，方便目录定位
  if (entry.kind === 'directory') score += 15
  return score - entry.depth * 2
}

async function execFindFile(args: Record<string, unknown>, workspace: string): Promise<ExecResult> {
  const pattern = String(args.pattern ?? '').trim()
  if (!pattern) return { content: 'Error: pattern is required', success: false }
  const directory = String(args.directory ?? '.')
  const searchType = String(args.type ?? 'file') as 'file' | 'directory' | 'all'
  const mode = chooseFindMode(
    pattern,
    (['auto', 'fuzzy', 'glob', 'exact'].includes(String(args.mode))
      ? String(args.mode)
      : 'auto') as FindMode,
  )
  const includeHidden = Boolean(args.includeHidden)
  const maxResults = clampNumber(args.maxResults, 1, 200, 50)

  const check = await resolveSmartPath(workspace, directory, 'directory')
  if ('error' in check) return { content: check.error, success: false }
  const resolved = check.resolved
  const correctedNote = check.corrected
    ? `[自动纠正路径: "${directory}" → "${check.corrected.split('\n')[0]}"]\n`
    : ''

  const { entries, truncated: scanTruncated } = await collectWorkspaceEntries(resolved, {
    maxDepth: 20,
    includeHidden,
    maxEntries: 10000,
  })

  let candidates = entries
  if (searchType === 'file') candidates = candidates.filter((entry) => entry.kind === 'file')
  else if (searchType === 'directory') candidates = candidates.filter((entry) => entry.kind === 'directory')

  const globRe = mode === 'glob' ? globToRegex(pattern) : undefined
  const scored = candidates
    .map((entry) => ({
      entry,
      score: scoreFindMatch(entry, pattern, mode, globRe),
    }))
    .filter((item) => item.score >= 0)
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score
      if (a.entry.path.length !== b.entry.path.length) return a.entry.path.length - b.entry.path.length
      return a.entry.path.localeCompare(b.entry.path)
    })

  if (scored.length === 0) {
    const scope = path.relative(workspace, resolved) || '.'
    return {
      content: correctedNote + `No ${searchType === 'all' ? '' : `${searchType} `}matches for "${pattern}" in ${scope}`,
      success: true,
    }
  }

  const total = scored.length
  const visible = scored.slice(0, maxResults)
  const scope = path.relative(workspace, resolved) || '.'
  const lines = [
    `Scope: ${scope}`,
    `Mode: ${mode} | Type: ${searchType} | Matches: ${total}${total > visible.length ? ` (showing ${visible.length})` : ''}`,
    ...visible.map(({ entry }) => `${entry.kind === 'directory' ? '[D]' : '[F]'} ${entry.path}${entry.kind === 'directory' ? '/' : ''}`),
  ]
  if (scanTruncated) lines.push('Notes: scan truncated at 10000 entries')

  return { content: correctedNote + lines.join('\n'), success: true }
}

/**
 * 将 glob 模式转换为正则表达式。
 * 支持: * (单层任意字符), ** (跨目录任意路径), ? (单字符), {a,b} (可选项)
 */
function globToRegex(glob: string): RegExp {
  let re = ''
  let i = 0
  while (i < glob.length) {
    const ch = glob[i]
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // ** 匹配任意层级目录
        if (glob[i + 2] === '/') {
          re += '(?:.+/)?'   // **/ 匹配零或多层目录
          i += 3
        } else {
          re += '.*'          // ** 后不跟斜杠时匹配任意字符
          i += 2
        }
      } else {
        re += '[^/]*'         // * 仅匹配单层内字符（不跨越 /）
        i++
      }
    } else if (ch === '?') {
      re += '[^/]'            // ? 匹配单个非斜杠字符
      i++
    } else if (ch === '{') {
      const end = glob.indexOf('}', i)
      if (end > i) {
        const alts = glob.slice(i + 1, end)
          .split(',')
          .map((s) => s.replace(/[.+^$|[\]\\()]/g, '\\$&'))
          .join('|')
        re += `(${alts})`
        i = end + 1
      } else {
        re += '\\{'
        i++
      }
    } else if ('.+^$|[]\\()'.includes(ch)) {
      re += '\\' + ch
      i++
    } else {
      re += ch
      i++
    }
  }
  return new RegExp(`^${re}$`, 'i')
}

/* ---- search_files：内容搜索 (ripgrep 优先) ---- */

/** rg 可用性缓存（避免每次调用都 fork 进程检测） */
let _rgAvailable: boolean | null = null

async function execSearchFiles(args: Record<string, unknown>, workspace: string): Promise<ExecResult> {
  const pattern = String(args.pattern ?? '').trim()
  if (!pattern) return { content: 'Error: pattern is required', success: false }
  const directory = String(args.directory ?? '.')
  const filePattern = args.filePattern ? String(args.filePattern) : undefined
  const contextLines = Math.min(Number(args.contextLines) || 2, 5)
  const maxResults = Math.min(Number(args.maxResults) || 30, 80)
  const caseSensitive = Boolean(args.caseSensitive)

  const check = await resolveSmartPath(workspace, directory, 'directory')
  if ('error' in check) return { content: check.error, success: false }
  const resolved = check.resolved
  const correctedNote = check.corrected
    ? `[自动纠正路径: "${directory}" → "${check.corrected.split('\n')[0]}"]\n`
    : ''

  // 转义 shell 单引号
  const safePattern = pattern.replace(/'/g, "'\\''")

  // 缓存 rg 可用性检测
  if (_rgAvailable === null) {
    _rgAvailable = await checkCommand('rg --version')
  }

  try {
    let cmd: string
    const caseFlag = caseSensitive ? '-s' : '-i'

    if (_rgAvailable) {
      const globFlag = filePattern ? `--glob '${filePattern}'` : ''
      cmd = [
        'rg', '-n', '--heading', '--color=never',
        caseFlag,
        `-C ${contextLines}`,
        '--max-count=10',         // 单文件最多 10 个匹配
        '--max-columns=200',      // 截断超长行避免 token 浪费
        '--max-columns-preview',  // 超长行显示截断预览
        globFlag,
        `-- '${safePattern}' '${resolved}'`,
        '2>/dev/null',
        `| head -${Math.min(maxResults * 8, 400)}`,  // 按结果数动态限制总行数
      ].filter(Boolean).join(' ')
    } else {
      // grep 回退
      const defaultIncludes = [
        '*.ts', '*.tsx', '*.js', '*.jsx', '*.json', '*.css',
        '*.html', '*.md', '*.py', '*.go', '*.rs', '*.vue', '*.svelte',
      ]
      const includeFlags = filePattern
        ? `--include='${filePattern}'`
        : defaultIncludes.map((g) => `--include='${g}'`).join(' ')
      cmd = `grep -rn ${caseFlag} -C ${contextLines} ${includeFlags} '${safePattern}' '${resolved}' 2>/dev/null | head -200`
    }

    const { stdout } = await execAsync(cmd, {
      cwd: workspace,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    })

    if (!stdout.trim()) {
      return { content: correctedNote + `No matches found for "${pattern}"`, success: true }
    }

    // 后处理：将绝对路径替换为相对路径，更紧凑
    const output = stdout
      .split('\n')
      .map((line) => {
        if (line.startsWith(resolved)) return line.slice(resolved.length + 1)
        if (line.startsWith(workspace)) return line.slice(workspace.length + 1)
        return line
      })
      .join('\n')

    // 统计匹配文件数
    const fileSet = new Set<string>()
    for (const line of output.split('\n')) {
      const m = line.match(/^([^:]+):\d+[:-]/)
      if (m) fileSet.add(m[1])
    }
    const header = `Found matches in ${fileSet.size || '?'} file(s):\n`

    return { content: correctedNote + header + output, success: true }
  } catch {
    return { content: correctedNote + `No matches found for "${pattern}"`, success: true }
  }
}

/** 检测命令是否可用 */
async function checkCommand(cmd: string): Promise<boolean> {
  try {
    await execAsync(cmd, { cwd: '/tmp', timeout: 5_000 })
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ */
/*  项目笔记工具                                                        */
/* ------------------------------------------------------------------ */

async function execSaveNote(args: Record<string, unknown>, workspace: string, projectId?: string): Promise<ExecResult> {
  const title = String(args.title ?? '').trim()
  const content = String(args.content ?? '').trim()
  const category = String(args.category ?? 'other') as import('../shared/ipc').NoteCategory
  if (!title) return { content: 'Error: title is required', success: false }
  if (!content) return { content: 'Error: content is required', success: false }

  const { saveNote } = await import('./notes')
  const id = `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const now = new Date().toISOString()
  const saved = await saveNote(workspace, {
    id,
    title,
    content,
    category,
    createdAt: now,
    updatedAt: now,
  }, projectId)
  return { content: `项目笔记已保存：「${saved.title}」(${saved.id})`, success: true }
}

async function execDeleteNote(args: Record<string, unknown>, workspace: string, projectId?: string): Promise<ExecResult> {
  const noteId = String(args.noteId ?? '').trim()
  if (!noteId) return { content: 'Error: noteId is required', success: false }

  const { deleteNote } = await import('./notes')
  await deleteNote(workspace, noteId, projectId)
  return { content: `项目笔记已删除：${noteId}`, success: true }
}

/* ------------------------------------------------------------------ */
/*  浏览器自动化执行器                                                    */
/* ------------------------------------------------------------------ */

function scopedBrowserAppId(projectId?: string): string | undefined {
  const raw = String(projectId ?? '').trim()
  if (!raw) return undefined
  const safe = raw.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 64)
  return safe ? `project-${safe}` : undefined
}

async function execBrowserAction(
  action: BrowserActionType,
  args: Record<string, unknown>,
  projectId?: string,
): Promise<ExecResult> {
  const appId = args.appId ? String(args.appId) : scopedBrowserAppId(projectId)
  const mergedArgs = appId ? { ...args, appId } : args
  log(`Browser action: ${action} [appId=${appId || 'default'}]`, mergedArgs)
  const result = await executeBrowserAction({ action, params: mergedArgs }, appId)
  if (result.success) {
    // screenshot：保存图片到本地 + 返回文件路径和页面信息
    if (action === 'screenshot' && result.data) {
      try {
        const parsed = JSON.parse(result.data)
        const pageInfo = parsed.page ?? {}
        const screenshotDataUrl = parsed.screenshot || parsed.dataUrl

        // 保存截图到本地文件
        let screenshotPath = ''
        if (screenshotDataUrl) {
          try {
            screenshotPath = await saveScreenshot(screenshotDataUrl, appId || 'default')
          } catch (err) {
            log('SCREENSHOT_SAVE_FAIL', { error: err instanceof Error ? err.message : String(err) })
          }
        }

        return {
          content: JSON.stringify({
            screenshotPath: screenshotPath || undefined,
            title: pageInfo.title,
            url: pageInfo.url,
            viewport: pageInfo.viewport,
            visibleElements: pageInfo.elements ?? [],
            hint: screenshotPath
              ? '截图已保存到本地。如需调用 MiniMax MCP 分析图片，请先用 mcp_list_tools 确认 understand_image 的参数定义，再用 mcp_call 传入 screenshotPath。'
              : undefined,
          }, null, 2),
          success: true,
        }
      } catch {
        return { content: result.data ?? '截图成功', success: true }
      }
    }
    return { content: result.data ?? '操作成功', success: true }
  }
  return { content: `浏览器操作失败: ${result.error}`, success: false }
}

async function execBrowserGetConsoleLogs(args: Record<string, unknown>, projectId?: string): Promise<ExecResult> {
  const appId = args.appId ? String(args.appId) : (scopedBrowserAppId(projectId) ?? 'default')
  const limit = Number.isFinite(Number(args.limit)) ? Number(args.limit) : undefined
  const onlyErrors = args.onlyErrors === true
  const devOnly = args.devOnly !== false
  const includeCandidates = args.includeCandidates !== false
  const clearAfterRead = args.clearAfterRead !== false
  const levels = Array.isArray(args.levels)
    ? args.levels
      .map((v) => String(v))
      .filter((v): v is 'log' | 'info' | 'warn' | 'error' | 'debug' => ['log', 'info', 'warn', 'error', 'debug'].includes(v))
    : undefined

  const snapshot = getBrowserConsoleSnapshot({
    appId,
    limit,
    levels,
    onlyErrors,
    devOnly,
    includeCandidates,
    clearAfterRead,
  })

  return {
    content: JSON.stringify(snapshot, null, 2),
    success: true,
  }
}

/* ------------------------------------------------------------------ */
/*  MCP 工具执行器                                                      */
/* ------------------------------------------------------------------ */

async function execMcpCall(args: Record<string, unknown>, signal?: AbortSignal): Promise<ExecResult> {
  const serverId = String(args.server_id ?? '').trim()
  const toolName = String(args.tool_name ?? '').trim()
  const toolArgs = (args.arguments ?? {}) as Record<string, unknown>

  if (!serverId) return { content: 'Error: server_id is required', success: false }
  if (!toolName) return { content: 'Error: tool_name is required', success: false }
  if (signal?.aborted) throw makeAbortError()

  try {
    const result = await callMcpTool(serverId, toolName, toolArgs)

    // 将 MCP 响应转为文本
    const texts: string[] = []
    for (const item of result.content ?? []) {
      if (item.type === 'text' && item.text) {
        texts.push(item.text)
      } else if (item.type === 'image' && item.data) {
        // 图片结果，保存并返回路径
        try {
          const imgPath = await saveScreenshot(`data:image/png;base64,${item.data}`)
          texts.push(`[图片已保存: ${imgPath}]`)
        } catch {
          texts.push('[图片数据接收成功但保存失败]')
        }
      } else if (item.type === 'resource') {
        texts.push(`[Resource: ${JSON.stringify(item)}]`)
      }
    }

    const content = texts.join('\n') || '(MCP 工具返回空结果)'
    return { content, success: !result.isError }
  } catch (err) {
    return { content: `MCP 调用失败: ${err instanceof Error ? err.message : String(err)}`, success: false }
  }
}

async function execMcpListTools(): Promise<ExecResult> {
  const mcpTools = getActiveMcpTools()

  if (mcpTools.length === 0) {
    return {
      content: '当前没有已启用的 MCP 服务器或没有可用工具。请在设置中启用 MCP 服务器并配置 API Key。',
      success: true,
    }
  }

  // 按 serverId 分组展示
  const groups: Record<string, Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>> = {}
  for (const tool of mcpTools) {
    if (!groups[tool.serverId]) groups[tool.serverId] = []
    groups[tool.serverId].push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })
  }

  const lines: string[] = ['已启用的 MCP 工具列表：', '']
  for (const [serverId, tools] of Object.entries(groups)) {
    lines.push(`## 服务器: ${serverId}`)
    for (const tool of tools) {
      lines.push(`- **${tool.name}**: ${tool.description ?? '(无描述)'}`)
      if (tool.inputSchema?.properties) {
        const props = tool.inputSchema.properties as Record<string, { type?: string; description?: string }>
        const required = (tool.inputSchema.required ?? []) as string[]
        for (const [key, val] of Object.entries(props)) {
          const req = required.includes(key) ? ' (必需)' : ' (可选)'
          lines.push(`  - \`${key}\` (${val.type ?? 'any'}${req}): ${val.description ?? ''}`)
        }
      }
    }
    lines.push('')
  }

  lines.push('使用 mcp_call 工具来调用上述工具，传入 server_id、tool_name 和 arguments。')

  return { content: lines.join('\n'), success: true }
}

async function execDesktopScreenshot(args: Record<string, unknown>, logScope?: string): Promise<ExecResult> {
  const rawWidth = args.width
  const rawHeight = args.height
  const width = rawWidth === undefined ? undefined : Number(rawWidth)
  const height = rawHeight === undefined ? undefined : Number(rawHeight)
  const displayId = typeof args.displayId === 'string' ? args.displayId : undefined
  const appId = typeof args.appId === 'string' && args.appId.trim() ? args.appId.trim() : 'desktop'

  if ((width !== undefined && !Number.isFinite(width)) || (height !== undefined && !Number.isFinite(height))) {
    return { content: 'Error: width/height must be numbers', success: false }
  }
  if ((width !== undefined && width <= 0) || (height !== undefined && height <= 0)) {
    return { content: 'Error: width/height must be positive', success: false }
  }

  if (process.platform === 'darwin') {
    try {
      const status = systemPreferences.getMediaAccessStatus?.('screen')
      if (status && status !== 'granted') {
        try { systemPreferences.openSystemPreferences?.('privacy', 'ScreenRecording') } catch { /* ignore */ }
        return {
          content:
            `Error: Screen Recording permission is ${status}. ` +
            'Please allow Taco AI in System Settings > Privacy & Security > Screen Recording, then restart the app.',
          success: false,
        }
      }
    } catch {
      // ignore permission check failures
    }
  }

  const displays = screen.getAllDisplays()
  const targetDisplay = displayId
    ? displays.find((d) => String(d.id) === displayId)
    : screen.getPrimaryDisplay()
  const display = targetDisplay ?? displays[0]
  if (!display) {
    return { content: 'Error: no display found', success: false }
  }

  const targetWidth = width ?? display.size.width
  const targetHeight = height ?? display.size.height

  log('DESKTOP_SCREENSHOT_REQUEST', {
    args,
    resolved: {
      displayId,
      width: targetWidth,
      height: targetHeight,
      appId,
      displayWidth: display.size.width,
      displayHeight: display.size.height,
    },
  }, logScope)

  let sources: Electron.DesktopCapturerSource[]
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.max(1, Math.floor(targetWidth)), height: Math.max(1, Math.floor(targetHeight)) },
      fetchWindowIcons: false,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (process.platform === 'darwin') {
      try { systemPreferences.openSystemPreferences?.('privacy', 'ScreenRecording') } catch { /* ignore */ }
    }
    return {
      content: `Error: Failed to get sources. ${msg}\n` +
        'If you are on macOS, enable Screen Recording permission for Taco AI in System Settings > Privacy & Security > Screen Recording, then restart the app.',
      success: false,
    }
  }

  if (sources.length === 0) {
    return { content: 'Error: no screen sources available', success: false }
  }

  const source = displayId
    ? sources.find((s) => s.display_id === displayId)
    : sources.find((s) => String(display.id) === s.display_id) ?? sources[0]

  if (!source) {
    return { content: `Error: displayId not found: ${displayId}`, success: false }
  }

  const dataUrl = source.thumbnail.toDataURL()
  const screenshotPath = await saveScreenshot(dataUrl, appId)
  const size = source.thumbnail.getSize()

  const payload = {
    displayId: source.display_id,
    screenshotPath,
    width: size.width,
    height: size.height,
    displayWidth: display.size.width,
    displayHeight: display.size.height,
    displayBoundsX: display.bounds.x,
    displayBoundsY: display.bounds.y,
    displayScaleFactor: display.scaleFactor,
  }

  desktopScreenshotMetaByPath.set(screenshotPath, {
    screenshotPath,
    screenshotWidth: size.width,
    screenshotHeight: size.height,
    displayId: source.display_id,
    displayWidth: display.size.width,
    displayHeight: display.size.height,
    displayBoundsX: display.bounds.x,
    displayBoundsY: display.bounds.y,
    displayScaleFactor: display.scaleFactor,
  })

  log('DESKTOP_SCREENSHOT_RESULT', {
    success: true,
    displayId: payload.displayId,
    screenshotPath: payload.screenshotPath,
    width: payload.width,
    height: payload.height,
    displayWidth: payload.displayWidth,
    displayHeight: payload.displayHeight,
    displayBoundsX: payload.displayBoundsX,
    displayBoundsY: payload.displayBoundsY,
    displayScaleFactor: payload.displayScaleFactor,
    dataUrlLength: typeof dataUrl === 'string' ? dataUrl.length : 0,
  }, logScope)

  return {
    success: true,
    content: JSON.stringify(payload),
  }
}

async function execGuiPlusAnalyze(args: Record<string, unknown>, signal?: AbortSignal, logScope?: string): Promise<ExecResult> {
  const instruction = String(args.instruction ?? '').trim()
  if (!instruction) return { content: 'Error: instruction is required', success: false }

  const imageDataUrl = typeof args.imageDataUrl === 'string' ? args.imageDataUrl : ''
  const imagePath = typeof args.imagePath === 'string' ? args.imagePath : ''

  let dataUrl = imageDataUrl
  if (!dataUrl && imagePath) {
    try {
      dataUrl = await fileToDataUrl(imagePath)
    } catch (err) {
      return { content: `Error: failed to read imagePath (${imagePath}): ${String(err)}`, success: false }
    }
  }
  if (!dataUrl) return { content: 'Error: imageDataUrl or imagePath is required', success: false }

  const config = await getGuiPlusConfig()
  const reqMinPixels = args.minPixels !== undefined ? Number(args.minPixels) : undefined
  const reqMaxPixels = args.maxPixels !== undefined ? Number(args.maxPixels) : undefined
  const configMinPixels = Number.isFinite(config.minPixels) ? Number(config.minPixels) : undefined
  const configMaxPixels = Number.isFinite(config.maxPixels) ? Number(config.maxPixels) : undefined
  // 映射参数必须与真实请求一致，否则会导致回写坐标偏移
  const effectiveMinPixels = Number.isFinite(reqMinPixels) ? Number(reqMinPixels) : configMinPixels
  const effectiveMaxPixels = Number.isFinite(reqMaxPixels) ? Number(reqMaxPixels) : configMaxPixels

  log('GUI_PLUS_REQUEST', {
    instruction,
    imagePath: imagePath || undefined,
    imageDataUrlLength: dataUrl ? dataUrl.length : 0,
    requestMinPixels: Number.isFinite(reqMinPixels) ? reqMinPixels : undefined,
    requestMaxPixels: Number.isFinite(reqMaxPixels) ? reqMaxPixels : undefined,
    effectiveMinPixels,
    effectiveMaxPixels,
    highResolution: Boolean(config.highResolution),
  }, logScope)

  const result = await runGuiPlus(config, instruction, dataUrl, {
    minPixels: effectiveMinPixels,
    maxPixels: effectiveMaxPixels,
    signal,
    logScope,
  })

  if (result.usage) {
    log('GUI_PLUS_USAGE', {
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      totalTokens: result.usage.totalTokens,
      cachedTokens: result.usage.cachedTokens,
    }, logScope)
  }

  const parsedObj = (result.parsed && typeof result.parsed === 'object')
    ? (result.parsed as { action?: string; parameters?: Record<string, unknown>; thought?: unknown })
    : null
  const extractedPoint = extractGuiPlusPoint(parsedObj?.parameters ?? {})
  const mapped = mapGuiPlusCoordinates(
    result.parsed,
    dataUrl,
    imagePath,
    {
      minPixels: effectiveMinPixels,
      maxPixels: effectiveMaxPixels,
      highResolution: config.highResolution,
    }
  )

  const scopeKey = getGuiPlusScopeKey(logScope)
  const parsedAction = typeof parsedObj?.action === 'string' ? parsedObj.action.toUpperCase() : ''
  let unstableClick = false
  let unstableReason: string | undefined
  if (parsedAction === 'CLICK' && mapped && imagePath) {
    const prev = lastGuiPlusClickByImagePath.get(imagePath)
    if (prev) {
      const distance = Math.hypot(mapped.x - prev.x, mapped.y - prev.y)
      const diagonal = Math.hypot(mapped.originalWidth, mapped.originalHeight)
      const threshold = Math.max(160, diagonal * 0.12)
      if (distance > threshold) {
        unstableClick = true
        unstableReason = `same image click drift ${distance.toFixed(1)}px exceeds threshold ${threshold.toFixed(1)}px`
      }
    }
    lastGuiPlusClickByImagePath.set(imagePath, {
      imagePath,
      x: mapped.x,
      y: mapped.y,
      timestamp: Date.now(),
    })
  }
  if (parsedAction === 'CLICK' && mapped) {
    pendingGuiPlusClickGuardByScope.set(scopeKey, {
      x: mapped.x,
      y: mapped.y,
      unstable: unstableClick,
      reason: unstableReason,
      imagePath: imagePath || undefined,
      timestamp: Date.now(),
    })
  } else {
    pendingGuiPlusClickGuardByScope.delete(scopeKey)
  }

  const rawX = extractedPoint?.x
  const rawY = extractedPoint?.y
  if (mapped || rawX !== undefined || rawY !== undefined || unstableClick) {
    log('GUI_PLUS_COORD_MAP', {
      action: parsedObj?.action ?? null,
      rawX,
      rawY,
      rawSource: extractedPoint?.source,
      unstableClick,
      unstableReason,
      mapped: mapped ?? null,
    }, logScope)
  }

  const warnings: string[] = []
  if (extractedPoint?.source === 'x_array') {
    warnings.push('GUI-Plus returned coordinates as parameters.x array; auto-converted to x/y')
  } else if (extractedPoint?.source === 'xyxy_center') {
    warnings.push('GUI-Plus returned coordinates as [x1,y1,x2,y2]; auto-converted to center point')
  }
  if (unstableClick && unstableReason) warnings.push(`Unstable click candidate: ${unstableReason}`)

  const payload = {
    parsed: compactGuiPlusParsed(result.parsed),
    mapped: compactGuiPlusMapped(mapped),
    rawLength: result.raw.length,
    ...(warnings.length ? { warnings } : {}),
    ...(unstableClick ? { requiresRecheck: true } : {}),
  }

  log('GUI_PLUS_RESULT', {
    parsed: payload.parsed,
    rawLength: result.raw.length,
    usage: result.usage ?? null,
    mapped: payload.mapped ?? null,
    warnings,
    requiresRecheck: unstableClick,
  }, logScope)

  return {
    success: true,
    content: JSON.stringify(payload),
  }
}

async function execDesktopAction(args: Record<string, unknown>, signal?: AbortSignal, logScope?: string): Promise<ExecResult> {
  const rawAction = String(args.action ?? '').trim()
  if (!rawAction) return { content: 'Error: action is required', success: false }
  const normalizedAction = normalizeDesktopAction(rawAction)
  if (!normalizedAction) {
    return {
      content: `Error: unsupported action "${rawAction}". Supported actions: move/click/mouse_down/drag/scroll/type/key`,
      success: false,
    }
  }
  const action = normalizedAction.action

  let dx = Number.isFinite(Number(args.dx)) ? Number(args.dx) : undefined
  let dy = Number.isFinite(Number(args.dy)) ? Number(args.dy) : undefined
  const direction = typeof args.direction === 'string' ? args.direction.toLowerCase() : ''
  if (action === 'scroll' && (dx === undefined || dy === undefined) && direction) {
    const rawAmount = args.amount
    let amount = 240
    if (typeof rawAmount === 'number' && Number.isFinite(rawAmount)) amount = rawAmount
    if (typeof rawAmount === 'string') {
      const lower = rawAmount.toLowerCase()
      if (lower === 'small') amount = 160
      else if (lower === 'medium') amount = 320
      else if (lower === 'large') amount = 520
      else if (Number.isFinite(Number(lower))) amount = Number(lower)
    }
    switch (direction) {
      case 'up': dy = -amount; dx = 0; break
      case 'down': dy = amount; dx = 0; break
      case 'left': dx = -amount; dy = 0; break
      case 'right': dx = amount; dy = 0; break
    }
  }

  const parsedKeyCombo = parseDesktopKeyCombo(typeof args.key === 'string' ? args.key : '')
  const explicitModifiers = normalizeDesktopModifiers(args.modifiers)
  const mergedModifiersSet = new Set<'cmd' | 'ctrl' | 'alt' | 'shift'>([
    ...(parsedKeyCombo.modifiers ?? []),
    ...(explicitModifiers ?? []),
  ])
  const clicks = resolveDesktopClicks(args, action, normalizedAction.impliedClicks)
  const pickNumberArg = (keys: string[]): number | undefined => {
    for (const key of keys) {
      const n = Number(args[key])
      if (Number.isFinite(n)) return n
    }
    return undefined
  }

  const payload = {
    action: action as 'move' | 'click' | 'mouse_down' | 'drag' | 'scroll' | 'type' | 'key',
    x: pickNumberArg(['x', 'fromX', 'startX', 'from_x', 'start_x']),
    y: pickNumberArg(['y', 'fromY', 'startY', 'from_y', 'start_y']),
    toX: pickNumberArg(['toX', 'endX', 'targetX', 'to_x', 'end_x', 'target_x', 'x2']),
    toY: pickNumberArg(['toY', 'endY', 'targetY', 'to_y', 'end_y', 'target_y', 'y2']),
    steps: Number.isFinite(Number(args.steps)) ? Math.max(2, Math.round(Number(args.steps))) : undefined,
    duration_ms: Number.isFinite(Number(args.duration_ms))
      ? Math.max(40, Math.round(Number(args.duration_ms)))
      : (Number.isFinite(Number(args.durationMs)) ? Math.max(40, Math.round(Number(args.durationMs))) : undefined),
    release: (Object.prototype.hasOwnProperty.call(args, 'release') || Object.prototype.hasOwnProperty.call(args, 'keepDown'))
      ? !parseBool(args.keepDown) && parseBool(args.release ?? true)
      : undefined,
    button: typeof args.button === 'string' ? (args.button as 'left' | 'right' | 'middle') : undefined,
    clicks,
    dx,
    dy,
    text: pickDesktopInputText(args),
    key: parsedKeyCombo.key ?? (typeof args.key === 'string' ? args.key.trim() : undefined),
    modifiers: mergedModifiersSet.size > 0 ? [...mergedModifiersSet] : undefined,
    delay_ms: Number.isFinite(Number(args.delay_ms)) ? Number(args.delay_ms) : undefined,
  }

  const scopeKey = getGuiPlusScopeKey(logScope)
  const guard = pendingGuiPlusClickGuardByScope.get(scopeKey)
  if (
    action === 'click' &&
    guard &&
    Date.now() - guard.timestamp < 60_000 &&
    Number.isFinite(payload.x) &&
    Number.isFinite(payload.y)
  ) {
    const distance = Math.hypot(Number(payload.x) - guard.x, Number(payload.y) - guard.y)
    if (distance <= 8 && guard.unstable) {
      log('DESKTOP_ACTION_BLOCKED', {
        reason: 'unstable_gui_plus_click',
        guard,
        payload,
      }, logScope)
      return {
        content: `Error: blocked unstable GUI click candidate (${guard.reason ?? 'coordinate drift too large'}). Please take a new screenshot and re-analyze before clicking.`,
        success: false,
      }
    }
    if (distance <= 8 && !guard.unstable) {
      pendingGuiPlusClickGuardByScope.delete(scopeKey)
    }
  }

  log('DESKTOP_ACTION_REQUEST', {
    action: payload.action,
    x: payload.x,
    y: payload.y,
    toX: payload.toX,
    toY: payload.toY,
    steps: payload.steps,
    duration_ms: payload.duration_ms,
    release: payload.release,
    button: payload.button,
    clicks: payload.clicks,
    dx: payload.dx,
    dy: payload.dy,
    key: payload.key,
    textLength: payload.text ? payload.text.length : 0,
    guiClickGuard: guard ?? null,
  }, logScope)

  const result = await callDesktopService(payload, signal)
  log('DESKTOP_ACTION_RESULT', {
    ok: result.ok,
    error: result.error,
    message: result.message,
    cursorBefore: result.cursorBefore ?? null,
    cursorAfter: result.cursorAfter ?? null,
    target: (Number.isFinite(payload.x) && Number.isFinite(payload.y))
      ? { x: Number(payload.x), y: Number(payload.y) }
      : null,
    targetOffsetAfter: (
      Number.isFinite(payload.x) &&
      Number.isFinite(payload.y) &&
      result.cursorAfter &&
      Number.isFinite(result.cursorAfter.x) &&
      Number.isFinite(result.cursorAfter.y)
    ) ? {
      dx: Number(result.cursorAfter.x) - Number(payload.x),
      dy: Number(result.cursorAfter.y) - Number(payload.y),
    } : null,
  }, logScope)
  if (!result.ok) {
    return { content: `Error: ${result.error ?? 'desktop action failed'}`, success: false }
  }

  const needsEnter = Boolean(args.needs_enter)
  if (action === 'type' && needsEnter) {
    const enterResult = await callDesktopService({ action: 'key', key: 'enter' }, signal)
    if (!enterResult.ok) {
      return { content: `Error: ${enterResult.error ?? 'enter key failed'}`, success: false }
    }
    return { content: JSON.stringify({ ...result, followUp: enterResult }), success: true }
  }

  return { content: JSON.stringify(result), success: true }
}

function normalizeDesktopAction(action: string): { action: 'move' | 'click' | 'mouse_down' | 'drag' | 'scroll' | 'type' | 'key'; impliedClicks?: number } | null {
  const normalized = action.trim().toUpperCase().replace(/[\s-]+/g, '_')
  const map: Record<string, { action: 'move' | 'click' | 'mouse_down' | 'drag' | 'scroll' | 'type' | 'key'; impliedClicks?: number }> = {
    MOVE: { action: 'move' },
    HOVER: { action: 'move' },
    CLICK: { action: 'click' },
    TAP: { action: 'click' },
    DOUBLE_CLICK: { action: 'click', impliedClicks: 2 },
    DOUBLECLICK: { action: 'click', impliedClicks: 2 },
    DBLCLICK: { action: 'click', impliedClicks: 2 },
    DOUBLE_TAP: { action: 'click', impliedClicks: 2 },
    MOUSE_DOWN: { action: 'mouse_down' },
    MOUSEDOWN: { action: 'mouse_down' },
    PRESS: { action: 'mouse_down' },
    PRESS_DOWN: { action: 'mouse_down' },
    DRAG: { action: 'drag' },
    DRAG_TO: { action: 'drag' },
    DRAG_SLIDER: { action: 'drag' },
    SCROLL: { action: 'scroll' },
    TYPE: { action: 'type' },
    INPUT: { action: 'type' },
    TEXT: { action: 'type' },
    TYPE_TEXT: { action: 'type' },
    INPUT_TEXT: { action: 'type' },
    KEY: { action: 'key' },
    KEY_PRESS: { action: 'key' },
    PRESS_KEY: { action: 'key' },
    HOTKEY: { action: 'key' },
    KEYBOARD_INPUT: { action: 'key' },
    KEYBOARD: { action: 'key' },
  }
  return map[normalized] ?? null
}

function parseBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'y'
  }
  if (typeof value === 'number') return value !== 0
  return false
}

function resolveDesktopClicks(
  args: Record<string, unknown>,
  action: 'move' | 'click' | 'mouse_down' | 'drag' | 'scroll' | 'type' | 'key',
  impliedClicks?: number,
): number | undefined {
  if (action !== 'click') return undefined
  const clicksRaw = Number(args.clicks)
  const clickCountRaw = Number(args.clickCount)
  const clicks = Number.isFinite(clicksRaw) ? Math.max(1, Math.round(clicksRaw)) : undefined
  const clickCount = Number.isFinite(clickCountRaw) ? Math.max(1, Math.round(clickCountRaw)) : undefined
  const isDouble =
    parseBool(args.double) ||
    parseBool(args.double_click) ||
    parseBool(args.dblclick)
  if (isDouble) return 2
  return clicks ?? clickCount ?? impliedClicks
}

function pickDesktopInputText(args: Record<string, unknown>): string | undefined {
  const candidates = [args.text, args.input, args.value, args.content, args.message]
  for (const item of candidates) {
    if (typeof item !== 'string') continue
    if (!item.trim()) continue
    return item
  }
  return undefined
}

function normalizeDesktopModifier(mod: string): 'cmd' | 'ctrl' | 'alt' | 'shift' | null {
  const m = mod.trim().toLowerCase()
  if (m === 'cmd' || m === 'command' || m === 'meta' || m === 'win' || m === 'windows' || m === 'super') return 'cmd'
  if (m === 'ctrl' || m === 'control' || m === 'ctl') return 'ctrl'
  if (m === 'alt' || m === 'option' || m === 'opt') return 'alt'
  if (m === 'shift') return 'shift'
  return null
}

function normalizeDesktopModifiers(raw: unknown): Array<'cmd' | 'ctrl' | 'alt' | 'shift'> | undefined {
  if (!Array.isArray(raw)) return undefined
  const set = new Set<'cmd' | 'ctrl' | 'alt' | 'shift'>()
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const normalized = normalizeDesktopModifier(item)
    if (normalized) set.add(normalized)
  }
  return set.size > 0 ? [...set] : undefined
}

function parseDesktopKeyCombo(raw: string): {
  key?: string
  modifiers?: Array<'cmd' | 'ctrl' | 'alt' | 'shift'>
} {
  const text = raw.trim()
  if (!text) return {}

  const tokens = text
    .replace(/[＋]/g, '+')
    .split(/[+\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)

  if (tokens.length === 0) return {}

  const mods: Array<'cmd' | 'ctrl' | 'alt' | 'shift'> = []
  const keys: string[] = []
  for (const token of tokens) {
    const mod = normalizeDesktopModifier(token)
    if (mod) mods.push(mod)
    else keys.push(token)
  }

  const key = keys.length > 0 ? keys[keys.length - 1] : (mods.length === tokens.length ? undefined : tokens[tokens.length - 1])
  return {
    ...(key ? { key } : {}),
    ...(mods.length > 0 ? { modifiers: [...new Set(mods)] } : {}),
  }
}

function getGuiPlusScopeKey(logScope?: string): string {
  const key = (logScope ?? '').trim()
  return key || '__global__'
}

function asNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => Number(item))
    .filter((num) => Number.isFinite(num))
}

function extractGuiPlusPoint(parameters: Record<string, unknown>): GuiPlusPoint | null {
  const x = parameters.x
  const y = parameters.y
  if (typeof x === 'number' && typeof y === 'number') {
    return { x, y, source: 'xy' }
  }

  const xArray = asNumberArray(x)
  if (xArray.length >= 4) {
    return {
      x: (xArray[0] + xArray[2]) / 2,
      y: (xArray[1] + xArray[3]) / 2,
      source: 'xyxy_center',
    }
  }
  if (xArray.length >= 2) {
    return { x: xArray[0], y: xArray[1], source: 'x_array' }
  }

  const pointCandidate = (
    (parameters.point && typeof parameters.point === 'object' ? parameters.point : null) ??
    (parameters.position && typeof parameters.position === 'object' ? parameters.position : null) ??
    (parameters.coordinate && typeof parameters.coordinate === 'object' ? parameters.coordinate : null)
  ) as Record<string, unknown> | null

  if (pointCandidate) {
    const px = Number(pointCandidate.x)
    const py = Number(pointCandidate.y)
    if (Number.isFinite(px) && Number.isFinite(py)) {
      return { x: px, y: py, source: 'point' }
    }
  }

  return null
}

function compactGuiPlusParsed(parsed: unknown): Record<string, unknown> | null {
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as { action?: unknown; thought?: unknown; parameters?: unknown }
  const out: Record<string, unknown> = {}

  if (typeof obj.action === 'string') out.action = obj.action.toUpperCase()
  if (typeof obj.thought === 'string' && obj.thought.trim()) {
    const thought = obj.thought.trim()
    out.thought = thought.length > 160 ? `${thought.slice(0, 160)}...` : thought
  }

  if (obj.parameters && typeof obj.parameters === 'object') {
    const p = obj.parameters as Record<string, unknown>
    const keepKeys = ['x', 'y', 'text', 'needs_enter', 'direction', 'amount', 'key', 'description', 'message', 'reason']
    const compactParams: Record<string, unknown> = {}
    for (const key of keepKeys) {
      if (p[key] !== undefined) compactParams[key] = p[key]
    }
    if (Object.keys(compactParams).length > 0) out.parameters = compactParams
  }

  return Object.keys(out).length > 0 ? out : null
}

function compactGuiPlusMapped(mapped: GuiPlusMappedPoint | null): Record<string, unknown> | null {
  if (!mapped) return null
  return {
    action: mapped.action ?? null,
    x: mapped.x,
    y: mapped.y,
    coordinateSpace: mapped.coordinateSpace,
    localX: mapped.localX,
    localY: mapped.localY,
    ...(mapped.displayId ? { displayId: mapped.displayId } : {}),
    ...(mapped.displayBoundsX !== undefined ? { displayBoundsX: mapped.displayBoundsX } : {}),
    ...(mapped.displayBoundsY !== undefined ? { displayBoundsY: mapped.displayBoundsY } : {}),
  }
}

function getImageSize(dataUrl: string, imagePath?: string): { width: number; height: number } | null {
  if (dataUrl) {
    try {
      const img = nativeImage.createFromDataURL(dataUrl)
      const size = img.getSize()
      if (size.width > 0 && size.height > 0) return { width: size.width, height: size.height }
    } catch {
      // ignore
    }
  }
  if (imagePath) {
    try {
      const img = nativeImage.createFromPath(imagePath)
      const size = img.getSize()
      if (size.width > 0 && size.height > 0) return { width: size.width, height: size.height }
    } catch {
      // ignore
    }
  }
  return null
}

function computeScaledSize(
  width: number,
  height: number,
  minPixels?: number,
  maxPixels?: number,
  highResolution?: boolean,
  factor = 28,
) {
  const minPx = minPixels ?? (4 * 28 * 28)
  const maxPx = highResolution ? (16384 * 28 * 28) : (maxPixels ?? 1003520)

  let hBar = Math.round(height / factor) * factor
  let wBar = Math.round(width / factor) * factor

  if (hBar * wBar > maxPx) {
    const beta = Math.sqrt((height * width) / maxPx)
    hBar = Math.floor(height / beta / factor) * factor
    wBar = Math.floor(width / beta / factor) * factor
  } else if (hBar * wBar < minPx) {
    const beta = Math.sqrt(minPx / (height * width))
    hBar = Math.ceil(height * beta / factor) * factor
    wBar = Math.ceil(width * beta / factor) * factor
  }

  return { width: wBar, height: hBar, minPixels: minPx, maxPixels: maxPx, factor }
}

function mapGuiPlusCoordinates(
  parsed: unknown,
  dataUrl: string,
  imagePath: string,
  options: { minPixels?: number; maxPixels?: number; highResolution?: boolean },
): GuiPlusMappedPoint | null {
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as { action?: string; parameters?: Record<string, unknown> }
  const params = obj.parameters ?? {}
  const point = extractGuiPlusPoint(params)
  if (!point) return null

  const size = getImageSize(dataUrl, imagePath)
  if (!size) return null

  const scaled = computeScaledSize(size.width, size.height, options.minPixels, options.maxPixels, options.highResolution)
  if (scaled.width <= 0 || scaled.height <= 0) return null

  const clampedX = Math.max(0, Math.min(point.x, Math.max(0, scaled.width - 1)))
  const clampedY = Math.max(0, Math.min(point.y, Math.max(0, scaled.height - 1)))
  const mappedX = Math.max(0, Math.min(size.width - 1, Math.floor((clampedX / Math.max(1, scaled.width)) * size.width)))
  const mappedY = Math.max(0, Math.min(size.height - 1, Math.floor((clampedY / Math.max(1, scaled.height)) * size.height)))

  const meta = imagePath ? desktopScreenshotMetaByPath.get(imagePath) : undefined
  let absoluteX = mappedX
  let absoluteY = mappedY
  if (meta && meta.screenshotWidth > 0 && meta.screenshotHeight > 0 && meta.displayWidth > 0 && meta.displayHeight > 0) {
    const screenshotXSpan = Math.max(1, meta.screenshotWidth - 1)
    const screenshotYSpan = Math.max(1, meta.screenshotHeight - 1)
    const displayXSpan = Math.max(0, meta.displayWidth - 1)
    const displayYSpan = Math.max(0, meta.displayHeight - 1)
    const rx = mappedX / screenshotXSpan
    const ry = mappedY / screenshotYSpan
    absoluteX = Math.round(meta.displayBoundsX + rx * displayXSpan)
    absoluteY = Math.round(meta.displayBoundsY + ry * displayYSpan)
    absoluteX = Math.max(meta.displayBoundsX, Math.min(meta.displayBoundsX + displayXSpan, absoluteX))
    absoluteY = Math.max(meta.displayBoundsY, Math.min(meta.displayBoundsY + displayYSpan, absoluteY))
  }

  return {
    action: obj.action ?? null,
    x: absoluteX,
    y: absoluteY,
    coordinateSpace: meta ? 'screen-absolute' : 'image-local',
    localX: mappedX,
    localY: mappedY,
    originalWidth: size.width,
    originalHeight: size.height,
    scaledWidth: scaled.width,
    scaledHeight: scaled.height,
    minPixels: scaled.minPixels,
    maxPixels: scaled.maxPixels,
    factor: scaled.factor,
    ...(meta ? {
      displayId: meta.displayId,
      displayBoundsX: meta.displayBoundsX,
      displayBoundsY: meta.displayBoundsY,
      displayWidth: meta.displayWidth,
      displayHeight: meta.displayHeight,
      displayScaleFactor: meta.displayScaleFactor,
    } : {}),
  }
}

/* ------------------------------------------------------------------ */
/*  风险评估                                                            */
/* ------------------------------------------------------------------ */

export type RiskLevel = 'safe' | 'warning' | 'danger'

export type RiskInfo = {
  toolCallId: string
  toolName: string
  level: RiskLevel
  reason: string
  /** 触发风险的关键信息（如命令内容） */
  detail: string
}

/** 风险分类 ID */
export type RiskCategory =
  | 'package_install'  // 安装依赖
  | 'privilege_cmd'    // 权限提升
  | 'destructive_cmd'  // 文件系统危险操作
  | 'system_modify'    // 系统修改
  | 'git_force'        // Git 强制操作
  | 'network_script'   // 网络脚本
  | 'git_ops'          // Git 常规操作
  | 'docker_ops'       // Docker 操作
  | 'browser_ops'      // 浏览器操作
  | 'desktop_ops'      // 桌面操作

/** 风险分类信息（供 UI 展示用） */
export const RISK_CATEGORY_INFO: { id: RiskCategory; label: string; description: string; level: 'danger' | 'warning' }[] = [
  { id: 'package_install', label: '安装依赖', description: 'npm install, pip install 等包管理器操作', level: 'danger' },
  { id: 'privilege_cmd', label: '权限提升', description: 'sudo, su 等需要 root 权限的命令', level: 'danger' },
  { id: 'destructive_cmd', label: '删除/权限操作', description: 'rm -rf, chmod, chown 等破坏性命令', level: 'danger' },
  { id: 'system_modify', label: '系统修改', description: 'mkfs, dd 等磁盘级操作', level: 'danger' },
  { id: 'git_force', label: 'Git 强制操作', description: 'git push --force, git reset --hard', level: 'danger' },
  { id: 'network_script', label: '网络脚本', description: 'curl | sh 等下载并执行的命令', level: 'danger' },
  { id: 'git_ops', label: 'Git 操作', description: 'git push, git merge, git rebase 等', level: 'warning' },
  { id: 'docker_ops', label: 'Docker 操作', description: 'docker run, docker build 等容器操作', level: 'warning' },
  { id: 'browser_ops', label: '浏览器操作', description: 'AI 操控浏览器执行自动化', level: 'warning' },
  { id: 'desktop_ops', label: '桌面操作', description: 'AI 操控鼠标/键盘/输入等桌面自动化', level: 'warning' },
]

/** 危险命令关键词匹配表：[正则, 描述, 分类] */
const DANGER_PATTERNS: [RegExp, string, RiskCategory][] = [
  // 包安装
  [/\b(npm|pnpm|yarn|bun)\s+(install|add|i)\b/i, '安装 npm 包', 'package_install'],
  [/\bpip3?\s+install\b/i, '安装 Python 包', 'package_install'],
  [/\b(brew|apt|apt-get|yum|dnf|pacman|apk)\s+install\b/i, '安装系统软件', 'package_install'],
  [/\bcargo\s+(install|add)\b/i, '安装 Rust 包', 'package_install'],
  [/\bgo\s+(install|get)\b/i, '安装 Go 包', 'package_install'],
  [/\bgem\s+install\b/i, '安装 Ruby Gem', 'package_install'],
  // 权限提升
  [/\bsudo\b/i, '使用 sudo 提权', 'privilege_cmd'],
  [/\bsu\s/i, '切换用户', 'privilege_cmd'],
  // 破坏性操作
  [/\brm\s+(-[a-zA-Z]*r|-[a-zA-Z]*f|--recursive|--force)/i, '递归/强制删除文件', 'destructive_cmd'],
  [/\brm\s+-rf\b/i, '递归强制删除', 'destructive_cmd'],
  [/\brmdir\b/i, '删除目录', 'destructive_cmd'],
  // 系统修改
  [/\bchmod\b/i, '修改文件权限', 'system_modify'],
  [/\bchown\b/i, '修改文件所有者', 'system_modify'],
  [/\bmkfs\b/i, '格式化磁盘', 'system_modify'],
  [/\bdd\s+if=/i, '磁盘级写入', 'system_modify'],
  // Git 危险操作
  [/\bgit\s+(push\s+(-[a-zA-Z]*f|--force)|reset\s+--hard)/i, 'Git 强制操作', 'git_force'],
  // 网络相关
  [/\bcurl\b.*\|\s*(sh|bash)\b/i, '下载并执行脚本', 'network_script'],
  [/\bwget\b.*\|\s*(sh|bash)\b/i, '下载并执行脚本', 'network_script'],
]

/** 警告级别的命令模式：[正则, 描述, 分类] */
const WARNING_PATTERNS: [RegExp, string, RiskCategory][] = [
  [/\bgit\s+push\b/i, 'Git push', 'git_ops'],
  [/\bgit\s+checkout\s+(-b|--orphan)/i, 'Git 创建分支', 'git_ops'],
  [/\bgit\s+merge\b/i, 'Git merge', 'git_ops'],
  [/\bgit\s+rebase\b/i, 'Git rebase', 'git_ops'],
  [/\bdocker\s+(run|build|pull|push)\b/i, 'Docker 操作', 'docker_ops'],
]

/** 浏览器操作工具名前缀 */
const BROWSER_TOOL_PREFIX = 'browser_'
/** 桌面操作工具名前缀 */
const DESKTOP_TOOL_PREFIX = 'desktop_'

/** 是否已在本次会话中确认过浏览器接管 */
let browserAutoApproved = false
/** 是否已在本次会话中确认过桌面接管 */
let desktopAutoApproved = false

/** 外部可调用：设置浏览器全局接管（从设置页面调用） */
export function setBrowserAutoApproved(approved: boolean) {
  browserAutoApproved = approved
}

/** 获取浏览器接管状态 */
export function isBrowserAutoApproved() {
  return browserAutoApproved
}

export function setDesktopAutoApproved(approved: boolean) {
  desktopAutoApproved = approved
}

export function isDesktopAutoApproved() {
  return desktopAutoApproved
}

/** 已自动授权的风险分类集合 */
const autoApproveCategories = new Set<RiskCategory>()

/** 设置自动授权分类列表（从设置页面调用） */
export function setAutoApproveCategories(categories: RiskCategory[]) {
  autoApproveCategories.clear()
  for (const cat of categories) autoApproveCategories.add(cat)
  // browser_ops 同步到 browserAutoApproved
  if (autoApproveCategories.has('browser_ops')) {
    browserAutoApproved = true
  }
  // desktop_ops 同步到 desktopAutoApproved
  if (autoApproveCategories.has('desktop_ops')) {
    desktopAutoApproved = true
  }
}

/** 获取当前自动授权分类列表 */
export function getAutoApproveCategories(): RiskCategory[] {
  return [...autoApproveCategories]
}

/** 评估一批工具调用的风险等级 */
export function assessToolCallsRisk(toolCalls: ToolCall[]): RiskInfo[] {
  const risks: RiskInfo[] = []

  for (const tc of toolCalls) {
    let args: Record<string, unknown> = {}
    try { args = JSON.parse(tc.function.arguments) } catch { continue }

    const toolName = tc.function.name

    // 浏览器工具：首次需要确认，确认后本次会话自动放行
    if (toolName.startsWith(BROWSER_TOOL_PREFIX) && !browserAutoApproved && !autoApproveCategories.has('browser_ops')) {
      const url = String(args.url ?? args.selector ?? args.expression ?? '')
      risks.push({
        toolCallId: tc.id,
        toolName,
        level: 'warning',
        reason: `浏览器操作: ${toolName.replace(BROWSER_TOOL_PREFIX, '')}`,
        detail: url || '(无参数)',
      })
      continue
    }

    if (toolName.startsWith(DESKTOP_TOOL_PREFIX) && !desktopAutoApproved && !autoApproveCategories.has('desktop_ops')) {
      const info = String(args.action ?? args.key ?? args.text ?? '')
      risks.push({
        toolCallId: tc.id,
        toolName,
        level: 'warning',
        reason: `桌面操作: ${toolName.replace(DESKTOP_TOOL_PREFIX, '')}`,
        detail: info || '(无参数)',
      })
      continue
    }

    if (toolName === 'run_command') {
      const command = String(args.command ?? '')
      if (!command) continue

      // 先检查危险级别
      for (const [pattern, reason, category] of DANGER_PATTERNS) {
        if (pattern.test(command)) {
          // 如果该分类已自动授权，跳过
          if (autoApproveCategories.has(category)) break
          risks.push({
            toolCallId: tc.id,
            toolName,
            level: 'danger',
            reason,
            detail: command,
          })
          break // 一个命令只报最高级别
        }
      }

      // 未命中 danger 则检查 warning
      if (!risks.some((r) => r.toolCallId === tc.id)) {
        for (const [pattern, reason, category] of WARNING_PATTERNS) {
          if (pattern.test(command)) {
            // 如果该分类已自动授权，跳过
            if (autoApproveCategories.has(category)) break
            risks.push({
              toolCallId: tc.id,
              toolName,
              level: 'warning',
              reason,
              detail: command,
            })
            break
          }
        }
      }
    }
  }

  return risks
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/** 异步执行一批 tool calls，返回结果。workspace 为安全边界。 */
export async function executeToolCalls(
  toolCalls: ToolCall[],
  workspace: string,
  signal?: AbortSignal,
  logScope?: string,
  projectId?: string,
): Promise<ToolResult[]> {
  const results: ToolResult[] = []

  for (const tc of toolCalls) {
    if (signal?.aborted) break
    let args: Record<string, unknown> = {}
    try {
      args = JSON.parse(tc.function.arguments)
    } catch {
      results.push({
        tool_call_id: tc.id,
        name: tc.function.name,
        content: `Error: Invalid JSON arguments: ${tc.function.arguments}`,
        success: false,
      })
      continue
    }

    log('TOOL_CALL', { id: tc.id, name: tc.function.name, arguments: args, workspace }, logScope)

    let result: ExecResult & { fileChange?: FileChange }
    try {
      result = await executeTool(tc.function.name, args, workspace, signal, projectId, logScope)
    } catch (err) {
      if (isAbortError(err)) break
      const msg = err instanceof Error ? err.message : String(err)
      result = { content: `Error: ${msg}`, success: false }
    }

    log('TOOL_RESULT', { id: tc.id, name: tc.function.name, success: result.success, content: result.content }, logScope)

    results.push({
      tool_call_id: tc.id,
      name: tc.function.name,
      ...result,
    })
  }

  return results
}
