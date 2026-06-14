[English](README_EN.md) | 中文

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

AI 对话主界面，展示多模态分析能力。用户上传一张血液生化检验报告单照片，AI 自动识别 OCR 提取数据，整理为结构化 Markdown 表格，并结合作者产科背景给出异常指标解读——如 GGT 167.5（约 3 倍上限）提示妊娠期肝内胆汁淤积症 (ICP) 风险、直接胆红素 14.8 偏高等。右上角悬浮原始图片缩略图方便随时比对。

深色模式三栏布局：

- **左侧边栏** — "新建项目"按钮；历史会话列表（含 `11h`、`agent`、`测试`、`分析一下这张图` 等时间标签）；底部上下文用量进度条、语言选择器（中文）、设置入口
- **中央主区域** — AI 结构化响应：异常指标汇总表 + 深度病理解读；顶部工具栏（代码视图、表格视图、分屏对比、清空）
- **底部输入区** — 消息输入框（支持粘贴图片 / 附件）；当前模型 `qwen3.7-plus`；蓝色圆形发送按钮

### 任务执行与终端

<p align="center">
  <img src="4.png" alt="任务执行与终端" width="800" />
</p>

AI 工作台任务执行界面，展示完整的自动化工作流。AI 读取中文 README 并翻译生成英文版 `README_EN.md`，耗时 0h0m43s，详细记录了每一步操作（查看文件、新建文件等）的路径与状态。结果以表格形式对比中英文两版的核心章节（核心能力、多模型支持、技术栈等）。AI 在任务完成后主动询问是否需要推送到 GitHub 和 Gitee。

下部内嵌终端实时输出 Git 推送日志（`gitee.com:fushengfu/tacoai.git` 的 `main` 分支）。底部模型选择器已切换为 `deepseek-v4-pro`，底部状态栏显示语言选择、当前工作空间（`taco`）和版本号 `v0.3.10`。

### 模型配置

<p align="center">
  <img src="2.png" alt="模型配置界面" width="800" />
</p>

设置面板中的模型配置页，支持多模型管理与自定义参数。左侧模型列表包含 `mimo-v2.5-pro`（默认）、`kimi-k2.6`、`MiniMax-M2.7-highspeed`、`deepseek-v4-pro`、`qwen3.6-plus` 等已集成模型，每个条目显示提供商名称和 API Key 配置状态。右侧详情面板可逐项配置：

- **Provider / Base URL / API Key** — 服务商与接口配置
- **Model ID** — 模型标识符
- **上下文长度** — 支持 200,000 tokens 超长上下文
- **Temperature** — 采样温度，设为 0 表示确定性输出
- **高级能力开关** — 视觉理解、reasoning_content 推理字段控制

顶部 "添加模型" 按钮支持接入新模型，右上角工具栏提供终端、统计面板等快捷入口。

### 上传配置

<p align="center">
  <img src="3.png" alt="上传配置界面" width="800" />
</p>

设置面板中的上传配置页，用于将本地媒体文件上传至对象存储并生成 HTTPS URL 供 AI 模型访问。当前选中七牛云，配置项包括：

- **AccessKey / SecretKey** — 云存储认证密钥（SecretKey 支持显隐切换）
- **Bucket** — 空间名称
- **上传地址** — 可选自定义上传端点
- **公网访问前缀** — CDN 或访问域名
- **对象前缀 / Token 有效期** — 目录组织与凭证过期时间（默认 3600 秒）

底部提示"有未保存修改，仅本机保存"，保存后即可在对话中粘贴或选择图片上传。

### 记忆管理

<p align="center">
  <img src="5.png" alt="记忆管理界面" width="800" />
</p>

设置面板中的记忆管理页，管理 AI 的长期和短期项目知识记忆。存储引擎为 SQLite，库大小 239.1 MB，统计信息一览：手工记忆 3 条、自动记忆活动中 134 条 / 归档 0 条、软删除 251 条，最近更新时间 2026 年 6 月。

记忆列表分为两类：

- **手工记忆** — 用户或 AI 显式保存的核心知识（如密码加密规则 SHA-256 + bcrypt、桌面端共享模块架构重构进度、LLM 请求 user_id 字段注入设计等），每条带分类标签和展开按钮
- **自动记忆** — 系统根据对话自动提取的任务要点（如"增加英文版 README"完成总结），支持查看详情

顶部 "+ 新增记忆" 按钮可手动添加项目知识。

---

### 跨端同步演示

<p align="center">
  <a href="49.mp4" target="_blank">点击观看 Taco AI 移动端 App 操作演示视频</a>
</p>

---

## 下载安装

无需克隆源码，直接下载对应平台安装包即可使用。

| 平台 | 下载链接 | 安装说明 |
|------|---------|---------|
| **macOS** (Apple Silicon) | [Taco AI-0.4.3-arm64.dmg](https://store.bjctykj.com/2026-06-14/752f6318-de87-4431-aa8d-adb7124ad384.dmg) | 双击 `.dmg` 挂载后拖入 `Applications` 文件夹 |
| **Windows** (x64) | [Taco AI Setup 0.4.3.exe](https://store.bjctykj.com/desktop/2026-06-14/32bd9baf-1448-4a45-aa90-fb122ebe299b.exe) | 双击 `.exe` 按安装向导完成安装 |

当前版本：**v0.4.3**

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
└── 1.png 2.png 3.png 4.png 5.png 49.mp4  # 截图与演示视频
```

---

## 联系与反馈

- **作者邮箱**：[shengfu8161980541@qq.com](mailto:shengfu8161980541@qq.com)
- **GitHub Issues**：[github.com/Fushengfu/tacoai/issues](https://github.com/Fushengfu/tacoai/issues)
- **Gitee Issues**：[gitee.com/fushengfu/tacoai/issues](https://gitee.com/fushengfu/tacoai/issues)
- **许可证**：本项目基于 [Apache License 2.0](LICENSE) 开源

---

## 版本

当前版本：**v0.4.3**
