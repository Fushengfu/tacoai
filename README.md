# Taco AI

**Taco AI** 是一款运行在桌面端的智能编程助手，与您共享同一台计算机环境，能够阅读代码、执行命令、操作文件、操控浏览器，帮助您完成开发、分析、排查等各类任务。

---

## 核心能力

| 能力 | 说明 |
|------|------|
| 代码阅读与修改 | 读取项目文件、编辑代码、重构模块，支持 18 种编程语言高亮 |
| 命令执行 | 在系统 Shell 中执行构建、测试、安装、Git 操作等命令 |
| 文件管理 | 列出目录结构、搜索文件、创建/删除/移动文件 |
| 浏览器自动化 | 操控外部浏览器进行页面导航、点击、表单填写、内容提取 |
| 图片理解 | 上传截图或图片，由大模型进行视觉分析与信息提取 |
| 终端集成 | 内嵌 xterm 终端，支持完整命令行交互 |
| 代码编辑器 | 内嵌 Monaco Editor，支持语法高亮与 Diff 对比 |
| 计划管理 | 多步骤任务自动规划、提案确认、进度跟踪 |
| 上下文记忆 | 跨会话记忆召回与回放，保持长对话连贯性 |
| 跨端同步 | 通过 WebSocket 桥接，桌面端状态实时同步到移动端 App |

---

## 多模型支持

Taco AI 接入多家大模型服务商，可根据任务需求灵活切换：

- DeepSeek
- 阿里千问 (Qwen)
- MiniMax
- 智谱 AI (GLM)
- 更多模型通过 AI Gateway 扩展

---

## 界面预览

### 对话分析

<p align="center">
  <img src="1.png" alt="对话分析界面" width="800" />
</p>

AI 对话主界面，展示了多模态分析能力。用户上传一张血液生化检验报告单照片，AI 自动提取数据并整理为结构化 Markdown 表格，结合产科背景给出异常指标解读（如 GGT 升高提示妊娠期肝内胆汁淤积症风险）。右上角悬浮原始图片缩略图方便随时比对。

深色模式三栏布局：

- **左侧侧边栏** — "新建项目"按钮；历史会话列表按时间排序（`agent`、`测试`、`ai-gateway`、`Xuanwu` 等）；底部上下文用量进度条与设置入口
- **中央主区域** — 项目标题与窗口控制按钮；AI 响应支持 Markdown 表格、代码高亮；右上角悬浮原图缩略图；响应耗时标注（`0h0m20s`）
- **底部输入区** — 消息输入框（支持粘贴图片 / 添加附件）；附件按钮；模型选择器；蓝色圆形发送按钮

### 模型配置

<p align="center">
  <img src="2.png" alt="模型配置界面" width="800" />
</p>

设置面板中的模型配置页，支持多模型管理与自定义参数。左侧模型列表包含 `mimo-v2.5-pro`、`kimi-k2.6`、`MiniMax-M2.7-highspeed`、`deepseek-v4-pro`、`qwen3.6-plus` 等已集成模型。右侧详情面板可配置：

- **Provider / Base URL / API Key** — 服务商与接口配置
- **Model ID** — 模型标识
- **上下文长度** — 支持 200,000 tokens 超长上下文
- **Temperature** — 采样温度调节
- **高级开关** — 视觉理解、reasoning_content 推理字段控制

右上角工具栏提供终端、统计面板、插件管理、资源监控等快捷入口。

### 上传配置

<p align="center">
  <img src="3.png" alt="上传配置界面" width="800" />
</p>

设置面板中的上传配置页，用于将本地图片等媒体文件上传至云端供 AI 访问。支持阿里云 OSS 和七牛云两种云存储服务，配置项包括：

- **AccessKey / SecretKey** — 云存储认证密钥
- **Bucket** — 存储桶名称
- **上传地址** — 可选自定义上传端点
- **公网访问前缀** — 文件对外访问 URL 前缀
- **对象前缀 / Token 有效期** — 目录组织与凭证过期时间

底部提示"有未保存修改，仅本机保存"，保存后即可在对话中粘贴或选择图片上传。

---

## 下载安装

无需克隆源码，直接下载对应平台安装包即可使用。

| 平台 | 下载链接 | 安装说明 |
|------|---------|---------|
| **macOS** (Apple Silicon) | [Taco AI-0.3.10-arm64.dmg](https://store.huiyuanjia.net/Taco%20AI-0.3.10-arm64.dmg) | 双击 `.dmg` 挂载后拖入 `Applications` 文件夹 |
| **Windows** (x64) | [Taco AI Setup 0.3.10.exe](https://store.huiyuanjia.net/Taco%20AI%20Setup%200.3.10.exe) | 双击 `.exe` 按安装向导完成安装 |

当前版本：**v0.3.10**

> 源码构建请参考下方 [快速开始](#快速开始)。

---

## 技术栈

### 桌面端
- **框架**: Electron 40 + React 18 + TypeScript
- **构建**: Vite 5 + esbuild
- **编辑器**: Monaco Editor
- **终端**: xterm.js + node-pty
- **GUI 自动化**: @nut-tree-fork/nut-js
- **Markdown**: react-markdown + remark-gfm
- **代码高亮**: highlight.js

### AI 网关
- **后端**: Go 1.22 + Gin + GORM + MySQL 8.4
- **前端管理**: React 19 + Ant Design 5 + Vite
- **认证**: JWT

---

## 快速开始

### 环境要求

- Node.js >= 18
- macOS / Windows / Linux

### 安装与运行

```bash
# 克隆仓库
git clone <仓库地址>
cd taco/desktop

# 安装依赖
npm install

# 开发模式启动（支持热更新）
npm run dev

# 打包发布
npm run dist
```

### AI Gateway（可选）

如果需要自建 AI 代理服务，参考 [ai-gateway/README.md](ai-gateway/README.md)。

---

## 项目结构

```
taco/
├── desktop/                    # Electron 桌面应用
│   ├── src/
│   │   ├── main/               # 主进程（Node.js）
│   │   │   ├── agent/          # AI 代理核心
│   │   │   ├── ai/             # LLM 客户端
│   │   │   ├── automation/     # 浏览器/桌面自动化
│   │   │   ├── bridge/         # 跨端同步桥接
│   │   │   ├── infrastructure/ # 基础设施（日志、终端、认证等）
│   │   │   ├── ipc/            # IPC 通信处理
│   │   │   ├── services/       # 业务服务（Agent 循环、记忆、工具等）
│   │   │   ├── tools/          # 工具定义与执行
│   │   │   └── window/         # 窗口管理与托盘
│   │   ├── preload/            # 预加载脚本
│   │   └── renderer/           # 渲染进程（React UI）
│   │       ├── views/          # 视图组件
│   │       ├── hooks/          # React Hooks
│   │       ├── styles/         # 样式文件
│   │       └── lib/            # 工具库
│   ├── build/                  # 应用图标资源
│   └── scripts/                # 构建脚本
├── ai-gateway/                 # AI 代理网关
│   ├── backend/                # Go 后端服务
│   ├── admin/                  # React 管理后台
│   └── docs/                   # API 文档
└── 1.png 2.png 3.png           # 应用截图
```

---

## 版本

当前版本：**v0.3.10**
