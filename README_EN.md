[中文](README.md) | English

# Taco AI

**Taco AI** is a desktop-based intelligent assistant that shares your computer environment. It can read code, execute commands, manipulate files, control browsers, and help you complete development, analysis, debugging, and various other tasks.

---

## Core Capabilities

| Capability | Description |
|------------|-------------|
| Code Reading & Editing | Read project files, edit code, refactor modules, with syntax highlighting for 18+ languages |
| Command Execution | Run build, test, install, Git operations and other commands in the system shell |
| File Management | List directory structure, search files, create/delete/move files |
| Browser Automation | Control external browsers for page navigation, clicking, form filling, and content extraction |
| Image Understanding | Upload screenshots or images for visual analysis and information extraction by LLMs |
| Terminal Integration | Built-in xterm terminal with full command-line interaction support |
| Code Editor | Built-in Monaco Editor with syntax highlighting and diff comparison |
| Plan Management | Automatic multi-step task planning, proposal confirmation, and progress tracking |
| Context Memory | Cross-session memory recall and replay for long conversation continuity |
| Cross-device Sync | Real-time desktop state synchronization to mobile app via WebSocket bridge |

---

## What's New in v0.5.0

### Desktop

| Feature | Description |
|---------|-------------|
| Image Upload Fix | Fixed images disappearing when sending messages: `handleSend` now uses `useRef` instead of `setState` to read the latest attachment state, ensuring images are correctly included in the message body |
| Upload Success Indicator | Green checkmark ✓ appears in the bottom-right corner of image thumbnails after successful upload; failed uploads no longer auto-disappear, allowing users to inspect errors |
| Upload Architecture Unification | Cloud storage configuration migrated to the gateway admin panel; desktop removed local upload config UI; supports hash-based deduplication and cross-region auto-retry |
| Plan Confirmation Fix | Fixed bug where AI continued execution after plan rejection: enforced compliance from system prompt, tool definitions, and runtime feedback layers |
| System Prompt Enhancement | Added verification-driven execution rules, code modification authorization rules, remote debugging principle (instrumentation), user observation priority rules, consecutive error correction downgrade protocol, efficient communication rules, etc., significantly reducing AI misjudgment |
| Bridge Protocol Enhancement | On-demand loading of mobile messages & steps, upload credential proxy channel, streamlined bridge settings |

### Mobile

| Feature | Description |
|---------|-------------|
| Voice Input | Added system speech recognition support — tap the microphone button for voice input |
| Version Check | Automatic latest version check on startup with update prompts |
| Upload Retry Fix | Upload failure retry covers both 400 and 405 status codes, consistent with desktop behavior |

### AI Gateway

| Feature | Description |
|---------|-------------|
| Qiniu Region Fix | Uses UC API to dynamically query the bucket's actual region, replacing unreliable static naming inference, eliminating cross-region 400 errors |
| Domain Validation | Empty Domain now raises an error immediately, preventing invalid upload URLs from being constructed |
| Storage File Management | Added `StorageFile` model and CRUD API; upload records are persisted, with hash-based deduplication to avoid redundant uploads |
| Anthropic Protocol | Native Anthropic Messages API pass-through, allowing Claude and other models to connect directly |
| Timeout Adjustment | HTTP client timeout extended to 10 minutes, preventing interruptions during long conversations |---

## Multi-Model Support

Taco AI integrates with multiple LLM providers, switchable based on task requirements:

- DeepSeek
- Alibaba Qwen
- MiniMax
- Zhipu AI (GLM)
- More models extensible via AI Gateway

---

## Screenshots

### Conversation & Task Execution

<p align="center">
  <img src="1.png" alt="Conversation & Task Execution" width="800" />
</p>

The main AI conversation interface, demonstrating multi-turn task execution records. The AI is executing document update tasks — translating the v0.5.0 changelog into the English README, then removing historical version content per user request. Each task is displayed as a card with elapsed time, execution steps (viewing files, editing files, etc.), completion status (green checkmark ✓), and a summary table of results. User messages appear as bubbles on the right. Dark mode three-column layout:

- **Left Sidebar** — "New Project" button; historical project list with timestamps; user avatar and language selector at the bottom
- **Central Main Area** — AI task execution records: step details + result tables + notes (red vertical bar for warnings)
- **Bottom Input Area** — Message input box (supports pasting images / attachments); current model `deepseek-v4-pro`; send button; token usage statistics

### Model Configuration

<p align="center">
  <img src="2.png" alt="Model Configuration" width="800" />
</p>

The model configuration page in the settings panel, supporting multi-model management with custom parameters. Currently editing the **LongCat-2.0** model, with configurable options:

- **Provider** — Service provider (DeepSeek)
- **Base URL / API Key** — Endpoint and authentication credentials (API Key supports show/hide toggle)
- **Model** — Model identifier
- **Context Length** — Supports up to 1,000,000 tokens ultra-long context
- **Temperature** — Sampling temperature; set to 0 for deterministic output
- **Advanced Toggles** — Visual understanding (off), reasoning_content field pass-through (on)

The "Add Model" button at the top supports integrating new models, and the "Default Model" button designates the preferred model.

### Plan Management

<p align="center">
  <img src="3.png" alt="Plan Management" width="800" />
</p>

The AI agent task planning interface, demonstrating structured execution plan generation with an approval workflow. The AI breaks down the complex task "Implement Risk Operation Authorization for AI Agent Programming System" into 6 technical steps — defining risk levels and operation models, implementing an authorization manager, TTL-based authorization cleanup, updating security configuration, extending Tool interface with risk levels, and writing test cases — each with detailed descriptions. **"Confirm"** and **"Adjust"** buttons at the bottom allow users to review the plan before the AI modifies any code. Token usage statistics are displayed at the top.

### Statistics Dashboard

<p align="center">
  <img src="4.png" alt="Statistics Dashboard" width="800" />
</p>

The token usage statistics dashboard, helping users track LLM API costs and usage trends. Key metric cards display **total tokens (2,266M), input/output tokens, cache hits**, and **conversation rounds (2,035)**. A 7-day consumption trend bar chart visualizes usage changes. The detailed data table below lists daily input, output, cache, totals, and rounds, with multi-dimensional filtering by date, model, and task — ideal for cost analysis and anomaly detection.

### MCP Configuration

<p align="center">
  <img src="5.png" alt="MCP Configuration" width="800" />
</p>

The MCP (Model Context Protocol) configuration page in the settings panel, used to manage external tool services connected to the AI. Currently configured with a **MiniMax (intranet)** server providing image understanding and web search capabilities, status shown as "Stopped". Users can toggle services on/off with a single click, or click "Edit" to modify API Key and other parameters. The "+ Add MCP Server" button at the top supports integrating additional external tools.

### Image Understanding

<p align="center">
  <img src="6.png" alt="Image Understanding" width="800" />
</p>

The AI multimodal visual analysis interface. A user uploads a desk scene photo (containing a smartphone, yellow vitamin D packaging box, keyboard, etc.). The AI automatically identifies and describes key objects in detail — the smartphone (screen on, displaying a WeChat chat interface with links like h5.bjcykj.com), the packaging box ("60 tablets", "Vitamin D", animal silhouette pattern). An original image thumbnail floats in the right panel for convenient comparison. Currently using the `qwen3.6-plus` model.

### Code Editor

<p align="center">
  <img src="7.png" alt="Code Editor" width="800" />
</p>

The built-in Monaco Editor code editing interface, showing a Python project configuration file `pyproject.toml` being edited. The left panel is a directory tree file browser (including `.venv`, `ai_penetration_agent`, etc.), the center features a TOML syntax-highlighted editor (project metadata, dependencies, CLI entry points, build system), and the right panel provides a code outline for quick navigation. Top tabs support multi-file switching, and the bottom status bar displays file type (TOML), size (1.0 KB), line count (54 lines), and current workspace path.

### Automatic Task Planning

<p align="center">
  <img src="8.png" alt="Automatic Task Planning" width="800" />
</p>

The AI automatic task planning and execution interface, demonstrating the complete closed-loop from requirements to delivery. When the user requests "encapsulate a China map component", the AI automatically: installs ECharts dependencies (echarts@4.9.0 + vue-echarts), creates a `ChinaMap.vue` component (with heatmap, hover tooltip, color legend, responsive container), and integrates it into the dashboard page. The right-side execution plan panel displays 75 steps with progress tracking (0h10m31s), and the bottom change summary table lists all 4 modified files with specific changes. Currently using the `deepseek-v4-pro` model.

### Automatic Screenshot Verification

<p align="center">
  <img src="9.png" alt="Automatic Screenshot Verification" width="800" />
</p>

The AI automatic screenshot verification interface after completing web development. The top-left area lists 5 feature requirements (blue heatmap, province labels, color legend, hover tooltip, highlight interaction). The AI automatically opens the browser, takes screenshots, and verifies each feature — map position, province coloring, province labels, color legend, hover tooltip — all marked with green checkmarks ✅. The bottom area displays 8 rendered thumbnail screenshots as visual evidence. No human intervention required: the AI handles everything from writing code to launching the browser for screenshot-based verification in one seamless flow.

---

### Cross-device Sync Demo

<p align="center">
  <a href="49.mp4" target="_blank">Watch Taco AI mobile app operation demo video</a>
</p>

---

## Download & Install

No need to clone the source code — download the installer for your platform directly.

### China Region Users

The following links are hosted on servers in mainland China for high-speed downloads:

| Platform | Download Link | Installation |
|----------|---------------|--------------|
| **macOS** (Apple Silicon) | [Taco AI-0.5.0-arm64.dmg](https://store.bjctykj.com/app-versions/macOS/1783501309_Taco_AI-0.5.0-arm64.dmg) | Double-click the `.dmg`, then drag into the `Applications` folder |
| **Windows** (x64) | [Taco AI-0.5.0-x64.exe](https://store.bjctykj.com/app-versions/Windows/1783501147_Taco_AI-0.5.0-x64.exe) | Double-click the `.exe` and follow the installation wizard |

### International Users

International users should download the installer for your platform from the [GitHub Releases](https://github.com/Fushengfu/tacoai/releases) page.

Current version: **v0.5.0**

> For building from source, see [Quick Start](#quick-start) below.

---

## Tech Stack

### Desktop
- **Framework**: Electron 40 + React 18 + TypeScript
- **Build**: Vite 5 + esbuild
- **Editor**: Monaco Editor
- **Terminal**: xterm.js + node-pty
- **GUI Automation**: @nut-tree-fork/nut-js
- **Markdown**: react-markdown + remark-gfm
- **Code Highlighting**: highlight.js

### AI Gateway
- **Backend**: Go 1.22 + Gin + GORM + MySQL 8.4
- **Frontend Admin**: React 19 + Ant Design 5 + Vite
- **Authentication**: JWT

---

## Quick Start

### Prerequisites

- Node.js >= 18
- macOS / Windows / Linux

### Install & Run

```bash
# Clone the repository
git clone <repository-url>
cd taco/desktop

# Install dependencies
npm install

# Start in development mode (with hot reload)
npm run dev

# Build for distribution
npm run dist
```

### AI Gateway (Optional)

To set up a self-hosted AI proxy service, refer to [ai-gateway/README.md](ai-gateway/README.md).

---

## Project Structure

```
taco/
├── desktop/                    # Electron desktop application
│   ├── src/
│   │   ├── main/               # Main process (Node.js)
│   │   │   ├── sdk/agent/      # AI agent core (LLM, tools, memory, prompts)
│   │   │   │   ├── llm/        # LLM client (multi-protocol adapters)
│   │   │   │   ├── tools/      # Tool definition, registration & execution
│   │   │   │   ├── memory/     # Memory storage, recall & maintenance
│   │   │   │   ├── context/    # Context building & compression
│   │   │   │   └── prompt/     # System prompt builder
│   │   │   ├── services/       # Business service layer
│   │   │   ├── infrastructure/ # Infrastructure (logger, terminal, auth, updater, etc.)
│   │   │   ├── repositories/   # Data persistence (SQLite)
│   │   │   ├── ipc/            # IPC communication handlers
│   │   │   ├── bridge/         # Cross-device sync bridge
│   │   │   └── window/         # Window management and tray
│   │   ├── preload/            # Preload scripts
│   │   └── renderer/           # Renderer process (React UI)
│   │       ├── views/          # View components (chat, editor, settings)
│   │       ├── hooks/          # React Hooks
│   │       ├── styles/         # Stylesheets
│   │       └── lib/            # Utility libraries
│   ├── build/                  # App icon resources
│   └── scripts/                # Build scripts
├── ai-gateway/                 # AI proxy gateway
│   ├── backend/                # Go backend service
│   ├── admin/                  # React admin panel
│   └── docs/                   # API documentation
└── 1.png 2.png 3.png 4.png 5.png 6.png 7.png 8.png 9.png 49.mp4  # Screenshots & demo video
```

---

## Contact & Feedback

- **Author Email**: [shengfu8161980541@qq.com](mailto:shengfu8161980541@qq.com)
- **GitHub Issues**: [github.com/Fushengfu/tacoai/issues](https://github.com/Fushengfu/tacoai/issues)
- **Gitee Issues**: [gitee.com/fushengfu/tacoai/issues](https://gitee.com/fushengfu/tacoai/issues)
- **License**: This project is open-sourced under the [Apache License 2.0](LICENSE)

---

## Version

Current version: **v0.5.0**
